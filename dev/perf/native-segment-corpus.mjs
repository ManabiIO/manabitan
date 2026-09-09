import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';

const [baselineRoot, candidateRoot, output] = process.argv.slice(2);
assert(baselineRoot && candidateRoot && output);
const require = createRequire(path.join(candidateRoot, 'package.json'));
const JSZip = require('jszip');
async function modules(root) {
    const load = file => import(pathToFileURL(path.join(root, file)).href);
    const parser = await load('ext/js/dictionary/term-bank-wasm-parser.js');
    const preparation = await load('ext/js/dictionary/term-lookup-index-preparation.js');
    parser.setTermBankWasmModule(await WebAssembly.compile(await fs.readFile(path.join(root, 'ext/lib/term-bank-parser.wasm'))));
    return {parser, preparation};
}
const baseline = await modules(baselineRoot);
const candidate = await modules(candidateRoot);
assert.deepEqual(await fs.readFile(path.join(baselineRoot, 'ext/lib/term-bank-parser.wasm')), await fs.readFile(path.join(candidateRoot, 'ext/lib/term-bank-parser.wasm')));
async function parse(api, sources, version) {
    let result;
    await api.parser.parseTermBankWithWasmColumnChunks(sources, version, chunk => {
        assert.equal(result, undefined);
        result = api.parser.copyWasmBackedColumnChunk(chunk);
    }, 262144, {singleChunk: true, emitContentSlab: true, emitTokenBinaryContent: true, emitTermByteLists: false, prepareLookupIndexes: true});
    assert(result);
    return result;
}
const lock = JSON.parse(await fs.readFile(path.join(baselineRoot, 'test/perf/dictionaries.lock.json'), 'utf8'));
const report = {status: 'incomplete', dictionaries: [], rowCount: 0, bankCount: 0, nativeSegmentedGroups: 0};
await fs.mkdir(path.dirname(output), {recursive: true});
try {
    for (const name of ['jmnedict', 'jmdict', 'jitendex']) {
        const fixture = lock.dictionaries[name];
        const file = await fs.readFile(path.join(baselineRoot, 'builds/e2e-dictionary-cache', fixture.cacheFile));
        const fixtureSha256 = createHash('sha256').update(file).digest('hex');
        assert.equal(fixtureSha256, fixture.sha256);
        assert.equal(file.byteLength, fixture.sizeBytes);
        const archive = await JSZip.loadAsync(file, {checkCRC32: true});
        const index = JSON.parse(await archive.file('index.json').async('string'));
        assert.equal(index.title, fixture.expectedTitle);
        assert.equal(index.revision, fixture.revision);
        const banks = Object.keys(archive.files).filter(n => /^term_bank_\d+\.json$/.test(n)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
        const item = {name, fixtureSha256, banks: banks.length, rows: 0, segmentedGroups: 0, groups: []};
        for (let start = 0; start < banks.length; start += 8) {
            const names = banks.slice(start, start + 8);
            const sources = await Promise.all(names.map(n => archive.file(n).async('uint8array')));
            const expected = await parse(baseline, sources, index.format ?? index.version);
            const actual = await parse(candidate, sources, index.format ?? index.version);
            assert.equal(actual.rowCount, expected.rowCount);
            for (const key of ['readingEqualsExpressionList', 'scoreList', 'sequenceList', 'contentBytesBuffer', 'contentMetaList', 'contentHash1List', 'contentHash2List']) {
                assert.deepEqual(actual[key], expected[key], key);
            }
            for (const key of ['stringLengths', 'stringsBuffer', 'expressionIndexes', 'readingIndexes']) {
                assert.deepEqual(actual.termRecordPreinternedPlan[key], expected.termRecordPreinternedPlan[key], key);
            }
            const reference = baseline.preparation.prepareTermLookupIndexesFromPreinternedPlan(expected);
            assert(reference);
            const native = actual.preparedLookupIndexes;
            const indexes = native ?? candidate.preparation.prepareTermLookupIndexesFromPreinternedPlan(actual)?.indexes;
            assert(indexes);
            assert.deepEqual([...indexes.keys()], [...reference.indexes.keys()]);
            const digest = createHash('sha256');
            for (const [key, result] of indexes) {
                const other = reference.indexes.get(key);
                assert(other);
                assert.deepEqual(result.bytes, other.bytes, key);
                for (const field of ['stringLengths', 'stringsBuffer', 'expressionIndexes', 'readingIndexes']) {
                    assert.deepEqual(result.preinternedPlan[field], other.preinternedPlan[field], field);
                }
                digest.update(result.bytes);
            }
            const segmented = native instanceof Map && native.size > 1;
            if (segmented) { ++item.segmentedGroups; ++report.nativeSegmentedGroups; }
            item.rows += actual.rowCount;
            item.groups.push({banks: names, rows: actual.rowCount, segments: indexes.size, nativeSegmented: segmented, indexSha256: digest.digest('hex')});
            console.log(name, start, actual.rowCount, segmented, 'byte-identical');
        }
        assert.equal(item.rows, fixture.termRows);
        report.dictionaries.push(item); report.rowCount += item.rows; report.bankCount += banks.length;
        await fs.writeFile(output, JSON.stringify(report, null, 2));
    }
    assert(report.nativeSegmentedGroups > 0);
    report.status = 'success';
} catch (error) {
    report.error = String(error?.stack ?? error);
    throw error;
} finally {
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
