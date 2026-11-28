#!/usr/bin/env node
/* Copyright (C) 2026 Manabitan authors; SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {openAsBlob, createReadStream, createWriteStream} from 'node:fs';
import {once} from 'node:events';
import {crc32, inflateRawSync} from 'node:zlib';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import path from 'node:path';
import {ZipReader, BlobReader} from '@zip.js/zip.js';

const {values} = parseArgs({options: {
    baseline: {type: 'string'}, candidate: {type: 'string'}, output: {type: 'string'},
    dictionary: {type: 'string'}, cache: {type: 'string'}, 'synthetic-only': {type: 'boolean'},
}});
assert(values.baseline && values.candidate && values.output);
const roots = {baseline: path.resolve(values.baseline), candidate: path.resolve(values.candidate)};
const output = path.resolve(values.output);
await mkdir(output, {recursive: true});
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const encoder = new TextEncoder();
const metadataWords = 17;
const exportsToCheck = ['parse_term_bank', 'parse_term_bank_with_media_hints'];
const sources = {};
const natives = {};
for (const [arm, root] of Object.entries(roots)) {
    const bytes = await readFile(path.join(root, 'ext/lib/term-bank-parser.wasm'));
    const instance = await WebAssembly.instantiate(bytes, {});
    natives[arm] = instance.instance.exports;
    for (const name of [...exportsToCheck, 'wasm_alloc', 'wasm_reset_heap', 'wasm_get_last_parse_capacity']) {
        assert.equal(typeof natives[arm][name], 'function', `${arm} lacks ${name}`);
    }
    assert(natives[arm].memory instanceof WebAssembly.Memory);
    sources[arm] = {root, wasmSha256: sha(bytes), wasmBytes: bytes.length,
        sourceSha256: sha(await readFile(path.join(root, 'ext/js/dictionary/wasm/term-bank-parser.c')))};
}
const report = {schema: 1, complete: false, scope: 'Untimed raw native metadata parity, every one of 17 words for every valid locked row; all prefilled metadata words on synthetic failures. Both hinted and unhinted strict exports.',
    node: process.version, oracleSha256: sha(await readFile(fileURLToPath(import.meta.url))), sources,
    dictionary: values.dictionary ?? null, synthetic: {cases: 0, exportComparisons: 0},
    corpus: Object.fromEntries(exportsToCheck.map((name) => [name, {banks: 0, rows: 0}])), failures: []};
const recordsPath = path.join(output, 'native-oracle-records.jsonl');
const records = createWriteStream(recordsPath);
const recordsHash = createHash('sha256');
async function record(value) {
    const line = JSON.stringify(value) + '\n';
    recordsHash.update(line);
    if (!records.write(line)) { await once(records, 'drain'); }
}

function parseNative(native, bytes, exportName, initialCapacity, synthetic) {
    const attempts = [];
    for (let capacity = initialCapacity; capacity <= 1048576; capacity *= 2) {
        native.wasm_reset_heap();
        const sourcePointer = native.wasm_alloc(Math.max(1, bytes.length)) >>> 0;
        const metadataPointer = native.wasm_alloc(capacity * metadataWords * 4) >>> 0;
        assert(sourcePointer && metadataPointer, 'Native allocation failed');
        new Uint8Array(native.memory.buffer, sourcePointer, bytes.length).set(bytes);
        new Uint32Array(native.memory.buffer, metadataPointer, capacity * metadataWords).fill(0xa5a5a5a5);
        const result = native[exportName](sourcePointer, bytes.length, metadataPointer, capacity, 0, 0, 1);
        const reportedCapacity = native.wasm_get_last_parse_capacity() >>> 0;
        const words = result >= 0 ? result * metadataWords : capacity * metadataWords;
        if (synthetic) { assert(reportedCapacity <= capacity, 'Synthetic fixture unexpectedly grew metadata'); }
        const metadata = Uint32Array.from(new Uint32Array(native.memory.buffer, metadataPointer, words));
        attempts.push({capacity, reportedCapacity, result, words, digest: sha(metadata)});
        if (result !== -2) { return {result, metadata, attempts}; }
    }
    throw new Error('Native metadata capacity exceeded bounded retries');
}

async function compare(bytes, name, exportName, synthetic = false, expected = null) {
    const first = parseNative(natives.baseline, bytes, exportName, synthetic ? 32 : 1024, synthetic);
    const second = parseNative(natives.candidate, bytes, exportName, synthetic ? 32 : 1024, synthetic);
    const details = {kind: synthetic ? 'synthetic' : 'lockedBank', name, exportName,
        bytes: bytes.length, sourceSha256: sha(bytes), baseline: first.attempts, candidate: second.attempts};
    if (first.result !== second.result || first.metadata.length !== second.metadata.length ||
        Buffer.compare(Buffer.from(first.metadata.buffer), Buffer.from(second.metadata.buffer)) !== 0) {
        let differingWord = 0;
        while (differingWord < Math.min(first.metadata.length, second.metadata.length) && first.metadata[differingWord] === second.metadata[differingWord]) { ++differingWord; }
        details.firstDifference = {word: differingWord, row: Math.floor(differingWord / metadataWords), field: differingWord % metadataWords,
            baseline: Array.from(first.metadata.slice(Math.max(0, differingWord - 17), differingWord + 18)),
            candidate: Array.from(second.metadata.slice(Math.max(0, differingWord - 17), differingWord + 18))};
        if (synthetic) { details.inputUtf8 = new TextDecoder().decode(bytes); }
        await record(details);
        throw new Error(`Native metadata mismatch: ${name}, ${exportName}, word ${differingWord}`);
    }
    if (expected === 'valid') { assert(first.result >= 0, `${name}: valid fixture rejected`); }
    if (expected === 'invalid') { assert(first.result < 0, `${name}: malformed fixture accepted`); }
    await record(details);
    return first;
}

const row = (glossary, expression = 'entry') => `[${JSON.stringify(expression)},"","noun","",-5,${glossary},17,"common"]`;
const composites = [
    ['strings', '["text","  spaced  ","\\nline\\t","\\u3000wide\\u00a0"]'],
    ['text', '[{"type":"text","text":"  space \\n"}]'],
    ['image', '[{"type":"image","path":"image.png","width":12,"height":20}]'],
    ['structured', '[{"type":"structured-content","content":[{"tag":"span","content":"  spaced  "},{"tag":"img","path":"a.png"}]}]'],
    ['escaped-members', '[{"ty\\u0070e":"text","te\\u0078t":"  spaced  "}]'],
    ['duplicate-type-text-image', '[{"type":"text","text":"  spaced  ","type":"image","path":"a.png"}]'],
    ['duplicate-type-image-text', '[{"type":"image","path":"a.png","type":"text","text":"  spaced  "}]'],
    ['duplicate-text', '[{"type":"text","text":"first","text":"  last  "}]'],
    ['nested-unknown', '[{"type":"structured-content","content":{"tag":"span","data":{"type":"image","path":"unused.png"},"content":"x"}}]'],
    ['formatted', '[ { "type" : "text", "text" : "  spaced  " }, "tail" ]'],
];
const syntheticDigest = createHash('sha256');
const corpusDigests = Object.fromEntries(exportsToCheck.map((name) => [name, createHash('sha256')]));

try {
    for (const [label, glossary] of composites) {
        const complete = `[${row(glossary)}]`;
        const fixtures = [[`${label}:complete`, complete, 'valid'],
            [`${label}:after-good-row`, `[${row('["first"]')},${row(glossary, 'next')}]`, 'valid'],
            [`${label}:after-bad-row`, `[${row('["first"]')},${row(glossary, 'next')},["broken"]]`, 'invalid'],
            [`${label}:extra-field`, `[${row(glossary).slice(0, -1)},true]]`, 'invalid'],
            [`${label}:trailing-token`, complete + ' null', 'invalid']];
        for (let end = 0; end < complete.length; ++end) {
            fixtures.push([`${label}:truncated:${end}`, complete.slice(0, end), 'invalid']);
        }
        for (const [name, text, expected] of fixtures) {
            const bytes = encoder.encode(text);
            ++report.synthetic.cases;
            for (const exportName of exportsToCheck) {
                const result = await compare(bytes, name, exportName, true, expected);
                syntheticDigest.update(name + exportName);
                syntheticDigest.update(Buffer.from(result.metadata.buffer));
                ++report.synthetic.exportComparisons;
            }
        }
    }
    for (const [name, text, expected] of [
        ['empty', '[]', 'valid'],
        ['valid-after-errors', `[${row('[{"type":"text","text":"fresh"}]')}]`, 'valid'],
        ['media-before-invalid-escape', `[${row('[{"type":"image","path":"a.png"},"bad\\x"]')}]`, 'invalid'],
        ['text-before-invalid-object', `[${row('[{"type":"text","text":"  trim  "},{"type":false}]')}]`, 'invalid'],
        ['nested-truncation', `[${row('[{"type":"structured-content","content":{"tag":"div","content":[{"tag":"span","content":"  text  "}]}')}]`, 'invalid'],
    ]) {
        ++report.synthetic.cases;
        for (const exportName of exportsToCheck) {
            const result = await compare(encoder.encode(text), name, exportName, true, expected);
            syntheticDigest.update(name + exportName);
            syntheticDigest.update(Buffer.from(result.metadata.buffer));
            ++report.synthetic.exportComparisons;
        }
    }
    report.synthetic.digest = syntheticDigest.digest('hex');

    if (!values['synthetic-only']) {
        assert(values.dictionary && values.cache, 'A locked dictionary and cache are required');
        const tooling = fileURLToPath(new URL('../../../', import.meta.url));
        const lockBytes = await readFile(path.join(tooling, 'test/perf/dictionaries.lock.json'));
        const fixture = JSON.parse(lockBytes).dictionaries[values.dictionary];
        assert(fixture, 'Dictionary is absent from lock');
        report.fixtureLockSha256 = sha(lockBytes);
        const archivePath = path.join(values.cache, fixture.cacheFile);
        const archiveHash = createHash('sha256');
        for await (const bytes of createReadStream(archivePath)) { archiveHash.update(bytes); }
        report.archiveSha256 = archiveHash.digest('hex');
        assert.equal(report.archiveSha256, fixture.sha256, 'Locked archive SHA-256 mismatch');
        const archive = await openAsBlob(archivePath);
        const {readDenseZipDirectory} = await import(pathToFileURL(path.join(roots.baseline, 'ext/js/dictionary/dense-zip-directory.js')));
        const {RawZipPayloadReader} = await import(pathToFileURL(path.join(roots.baseline, 'ext/js/dictionary/term-bank-source-pipeline.js')));
        let entries = await readDenseZipDirectory(archive);
        if (!entries) {
            const reader = new ZipReader(new BlobReader(archive));
            try { entries = await reader.getEntries(); } finally { await reader.close(); }
        }
        const banks = entries.filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
            .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)));
        entries = null;
        const sourceReader = new RawZipPayloadReader(archive);
        for (const bank of banks) {
            const compressed = await sourceReader.read(bank, new AbortController().signal, true);
            assert([0, 8].includes(bank.compressionMethod), 'Unexpected ZIP compression method');
            const bytes = bank.compressionMethod === 8 ? inflateRawSync(compressed) : compressed;
            assert.equal(bytes.length, bank.uncompressedSize, 'ZIP uncompressed size mismatch');
            assert.equal(crc32(bytes), bank.signature >>> 0, 'ZIP CRC mismatch');
            for (const exportName of exportsToCheck) {
                const result = await compare(bytes, bank.filename, exportName, false, 'valid');
                const digest = corpusDigests[exportName];
                digest.update(bank.filename);
                digest.update(Buffer.from(result.metadata.buffer));
                ++report.corpus[exportName].banks;
                report.corpus[exportName].rows += result.result;
            }
        }
        for (const exportName of exportsToCheck) {
            assert.equal(report.corpus[exportName].rows, fixture.termRows, 'Locked row count mismatch');
            report.corpus[exportName].digest = corpusDigests[exportName].digest('hex');
        }
    }
    report.complete = true;
} catch (error) {
    report.failures.push({message: String(error), stack: error.stack});
    throw error;
} finally {
    records.end();
    await once(records, 'finish');
    report.recordsSha256 = recordsHash.digest('hex');
    report.maxRssKiB = process.resourceUsage().maxRSS;
    await writeFile(path.join(output, 'native-oracle.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('HINTS_NATIVE_ORACLE ' + JSON.stringify(report));
}
