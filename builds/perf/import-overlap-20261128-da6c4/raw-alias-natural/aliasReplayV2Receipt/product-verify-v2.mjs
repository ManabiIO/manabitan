// SPDX-License-Identifier: GPL-3.0-or-later
// Streaming full-row/definition proof. Also accepts a cold browser OPFS export.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, stat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {createNodeOpfs, assertNodeOpfsQuiescent} from './archived/raw-alias-node-opfs.mjs';
import {sha, asBytes, readRange, fileInventory, rowDigest, definitionDigest, referenceKey, saveJson, verifyBindings, utf8} from './product-common.mjs';

const config = JSON.parse(await readFile(process.argv[2]));
assert.equal(sha(await readFile(new URL(import.meta.url))), config.verifierSourceSha256, 'Verifier source changed');
const pipeline = JSON.parse(await readFile(config.pipelineReport));
assert(pipeline.complete && pipeline.groups.length === 170 && pipeline.rows === 6648310);
const root = config.root, rootPath = config.opfsDirectory;
const load = (file) => import(pathToFileURL(path.join(root, file)));
const report = {schemaVersion: 1, complete: false, pipelineReport: config.pipelineReport,
    pipelineSha256: sha(await readFile(config.pipelineReport)), rootPath,
    verifierSourceSha256: config.verifierSourceSha256, verifierConfigSha256: sha(await readFile(process.argv[2])),
    priorVerifierFailure: config.priorVerifierFailure ?? null,
    scope: 'Untimed complete streaming decode of all record/index rows and referenced logical definitions; independent persisted framing/fields checks plus actual cold runtime reader probes. No performance claim.',
    chunks: [], groups: [], failures: [],
};
await saveJson(config.reportPath, report);
let filesystem = null;

function fieldsLength(header, rows, format) {
    if (format === 1) { return rows * 12; }
    if (format === 3) { return rows * 16; }
    assert.equal(format, 2);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    assert.equal(view.getUint32(0, true), 0x3246524d); assert.equal(view.getUint32(4, true), rows);
    assert.equal(view.getUint32(12, true), 2);
    const scores = view.getUint32(8, true); assert(scores > 0 && scores < 65535);
    return 16 + scores * 4 + rows * 8;
}
function parseFields(bytes, rows, format, base) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(fieldsLength(bytes, rows, format), bytes.length);
    const scoreCount = format === 2 ? view.getUint32(8, true) : 0;
    const offsetsStart = 16 + scoreCount * 4, lengthsStart = offsetsStart + rows * 4, keysStart = lengthsStart + rows * 2;
    return (row) => {
        assert(row >= 0 && row < rows);
        let delta, length, score;
        if (format === 2) {
            delta = view.getUint32(offsetsStart + row * 4, true); length = view.getUint16(lengthsStart + row * 2, true);
            const key = view.getUint16(keysStart + row * 2, true); assert(key < scoreCount); score = view.getInt32(16 + key * 4, true);
        } else {
            const at = row * (format === 3 ? 16 : 12);
            delta = view.getUint32(at, true); length = view.getUint32(at + 4, true);
            score = format === 3 ? view.getFloat64(at + 8, true) : view.getInt32(at + 8, true);
        }
        assert(delta !== 0xffffffff && length > 0 && length !== 0xffffffff);
        assert(Number.isSafeInteger(base + delta));
        return {offset: base + delta, length, score};
    };
}
function contentName(file) {
    const match = /^manabitan-term-records\/dict-(\d+)\|(.+)\.mbtr\.mbti$/.exec(file); assert(match);
    const encodedLength = Number(match[1]), dictionary = pipeline.configuration.dictionaryTitle;
    assert.equal(decodeURIComponent(match[2].slice(0, encodedLength)), dictionary);
    const name = decodeURIComponent(match[2].slice(encodedLength)); assert(name.length > 0);
    return name;
}

try {
    await verifyBindings(pipeline.configuration);
    filesystem = await createNodeOpfs({rootPath, create: false});
    Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {hardwareConcurrency: 4, deviceMemory: 8, storage: {getDirectory: async () => filesystem.root}}});
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, options) => {
        const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
        if (url.protocol !== 'file:') { return originalFetch(input, options); }
        return new Response(await readFile(url), {headers: {'Content-Type': url.pathname.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'}});
    };
    // No worker transport is used during cold decoding. Initialize the unchanged owner codec explicitly.
    globalThis.Worker = undefined;
    const codec = await load('ext/js/dictionary/zstd-term-content.js');
    await codec.initializeTermContentZstd();
    const lookup = await load('ext/js/dictionary/term-lookup-index.js');
    const raw = await load('ext/js/dictionary/raw-term-content.js');
    const {DictionaryDatabase} = await load('ext/js/dictionary/dictionary-database.js');
    const {TermRecordOpfsStore} = await load('ext/js/dictionary/term-record-opfs-store.js');
    const db = new DictionaryDatabase();
    const contentStore = db._termContentStore, blockStore = db._termContentBlockStore;
    await contentStore.prepare();
    report.fileInventory = await fileInventory(rootPath);
    assert.deepEqual(report.fileInventory.map(({file, bytes, normalizedSha256}) => ({file, bytes, normalizedSha256})),
        pipeline.fileInventory.map(({file, bytes, normalizedSha256}) => ({file, bytes, normalizedSha256})), 'Physical layout differs from its source-bound arm');
    for (const item of report.fileInventory) {
        if (!item.file.endsWith('.mbti')) { continue; }
        const file = path.join(rootPath, item.file), descriptor = await readFile(file.slice(0, -5));
        const header = await readRange(file, 0, 40), view = new DataView(header.buffer);
        assert.equal(Buffer.from(header.subarray(0, 8)).toString(), 'MBTIDX11');
        assert.equal(descriptor.subarray(0, 8).toString(), 'MBTRD16X');
        assert.equal(Number(view.getBigUint64(8, true)), descriptor.length);
        assert.deepEqual(header.subarray(24, 40), new Uint8Array(descriptor.subarray(8, 24)));
        let cursor = 40, rows = 0, count = 0;
        const name = contentName(item.file);
        while (cursor < item.bytes) {
            const bytes = await readRange(file, cursor, 40), fields = new DataView(bytes.buffer);
            const firstId = fields.getUint32(0, true), rowCount = fields.getUint32(4, true), base = Number(fields.getBigUint64(8, true));
            const payloadBytes = fields.getUint32(16, true), baseBytes = fields.getUint32(20, true), format = fields.getUint32(36, true);
            assert(firstId > 0 && rowCount > 0 && payloadBytes > baseBytes && baseBytes > 0);
            const start = cursor + 40 + payloadBytes;
            const fieldHeader = format === 2 ? await readRange(file, start, 16) : new Uint8Array(0);
            const recordBytes = fieldsLength(fieldHeader, rowCount, format);
            assert(start + recordBytes <= item.bytes);
            report.chunks.push({file: item.file, start: cursor, firstId, rows: rowCount, name, base, payloadBytes, baseBytes,
                baseHash: fields.getUint32(24, true), derivedHash: fields.getUint32(28, true), fieldsHash: fields.getUint32(32, true),
                fieldsBytes: recordBytes, fieldsFormat: format});
            cursor = start + recordBytes; rows += rowCount; ++count;
        }
        assert.equal(cursor, item.bytes); assert.equal(count, view.getUint32(16, true)); assert.equal(rows, view.getUint32(20, true));
    }
    report.chunks.sort((a, b) => a.firstId - b.firstId);
    const expectedRuns = pipeline.groups.flatMap((group) => group.recordRuns).sort((a, b) => a.firstId - b.firstId);
    assert.equal(report.chunks.length, expectedRuns.length);
    for (let index = 0; index < expectedRuns.length; ++index) {
        const expected = expectedRuns[index], actual = report.chunks[index];
        assert.equal(actual.file, 'manabitan-term-records/' + expected.file + '.mbti');
        for (const key of ['firstId', 'rows', 'name', 'base', 'payloadBytes', 'fieldsBytes', 'fieldsFormat']) { assert.equal(actual[key], expected[key], key); }
    }
    const probeTerms = new Set(['__manabitan_absent_raw_alias_product_da6c4__']);
    const probeIds = new Set();
    for (const group of pipeline.groups) {
        for (const probe of group.probes) { probeIds.add(probe.id); probeTerms.add(probe.expression); if (probe.reading !== null) { probeTerms.add(probe.reading); } }
        for (const id of group.recordEntry.aliasRows) { probeIds.add(id); }
    }
    const queries = new Map([...probeTerms].map((term) => [term, {expression: [], reading: []}]));
    const expectedProbeRecords = new Map(), contentHashes = new Map();
    const aliasPairs = pipeline.groups.flatMap(({recordEntry}) => recordEntry.aliases);
    const inputDigest = createHash('sha256');
    let nextId = 1, groupIndex = 0, groupRows = 0, digest = rowDigest(), nativePreparedGroups = 0;
    for (let runIndex = 0; runIndex < report.chunks.length; ++runIndex) {
        const chunk = report.chunks[runIndex], group = pipeline.groups[groupIndex];
        assert.equal(chunk.firstId, nextId); assert(chunk.firstId + chunk.rows <= group.firstId + group.rows);
        const bytes = await readRange(path.join(rootPath, chunk.file), chunk.start + 40, chunk.payloadBytes + chunk.fieldsBytes);
        const payload = bytes.subarray(0, chunk.payloadBytes), fields = bytes.subarray(chunk.payloadBytes);
        const sections = lookup.splitPersistedTermLookupIndex(payload);
        assert.equal(sections.base.length, chunk.baseBytes);
        assert.equal(lookup.hashTermLookupKeyBytes(sections.base), chunk.baseHash);
        assert.equal(lookup.hashTermLookupKeyBytes(sections.derived), chunk.derivedHash);
        assert.equal(lookup.hashTermLookupKeyBytes(fields), chunk.fieldsHash);
        assert.equal(sha(payload), expectedRuns[runIndex].payloadSha256);
        const parsed = lookup.parsePersistedTermLookupIndex(payload);
        assert.equal(parsed.expressionKeys.length, chunk.rows);
        const getFields = parseFields(fields, chunk.rows, chunk.fieldsFormat, chunk.base);
        const unique = new Map();
        for (let row = 0; row < chunk.rows; ++row) {
            const value = {...getFields(row), name: chunk.name}, key = referenceKey(value);
            if (!contentHashes.has(key)) { unique.set(key, value); }
        }
        const missing = [...unique];
        for (let start = 0; start < missing.length; start += 128) {
            const slice = missing.slice(start, start + 128);
            const results = await blockStore.readDetailedBatch(slice.map(([, value]) => ({contentOffset: value.offset, contentLength: value.length, contentDictName: value.name})));
            for (let index = 0; index < slice.length; ++index) {
                const result = results[index];
                assert.equal(result.status, 'ok', JSON.stringify({reference: slice[index][1], result, lastError: blockStore._lastError}));
                assert.equal(result.bytes.length, slice[index][1].length);
                contentHashes.set(slice[index][0], definitionDigest(result.bytes, raw));
            }
        }
        if (chunk.firstId === group.firstId && chunk.rows === group.rows) {
            const native = group.input.prepared.find(({range}) => range === '0:' + chunk.rows); assert(native);
            assert.equal(sha(payload), native.sha256, 'Whole native prepared payload was changed'); ++nativePreparedGroups;
        } else { assert.equal(pipeline.configuration.arm, 'A', 'Product unexpectedly discarded a native whole map'); }
        for (let row = 0; row < chunk.rows; ++row) {
            const id = chunk.firstId + row, fields = getFields(row);
            const expression = lookup.getPersistedTermKeyBytes(parsed, row, 'expression'); assert(expression !== null);
            const reading = lookup.getPersistedTermKeyBytes(parsed, row, 'reading');
            const sequence = lookup.getPersistedTermSequence(parsed, row);
            const reference = {...fields, name: chunk.name}, content = contentHashes.get(referenceKey(reference)); assert(content);
            digest.add({id, score: fields.score, sequence, expression, reading, content});
            const expressionText = utf8.decode(expression), readingText = reading === null ? expressionText : utf8.decode(reading);
            queries.get(expressionText)?.expression.push(id);
            if (reading !== null) { queries.get(readingText)?.reading.push(id); }
            if (probeIds.has(id)) { expectedProbeRecords.set(id, {id, expression: expressionText, reading: readingText, score: fields.score,
                sequence, entryContentOffset: fields.offset, entryContentLength: fields.length, entryContentDictName: chunk.name}); }
        }
        nextId += chunk.rows; groupRows += chunk.rows;
        if (groupRows === group.rows) {
            const actual = digest.finish(); assert.equal(actual, group.input.logicalSha256, 'Logical source/output mismatch in group ' + group.index);
            report.groups.push({group: group.index, rows: groupRows, logicalSha256: actual}); inputDigest.update(actual + '\n');
            ++groupIndex; groupRows = 0; digest = rowDigest();
            if (groupIndex % 10 === 0 || groupIndex === 170) { await saveJson(config.reportPath, report); console.log(JSON.stringify({verifiedGroups: groupIndex, verifiedRows: nextId - 1})); }
        }
    }
    assert.equal(groupIndex, 170); assert.equal(groupRows, 0); assert.equal(nextId - 1, pipeline.rows);
    report.inputLogicalSha256 = inputDigest.digest('hex'); assert.equal(report.inputLogicalSha256, pipeline.inputLogicalSha256);
    report.verifiedRows = nextId - 1; report.nativePreparedGroups = nativePreparedGroups;
    report.distinctPersistedReferences = contentHashes.size;
    report.aliasProofs = [];
    for (const pair of aliasPairs) {
        const requests = [pair.original, pair.actual].map(({offset, length, name}) => ({contentOffset: offset, contentLength: length, contentDictName: name}));
        const [original, alias] = await blockStore.readDetailedBatch(requests);
        assert.equal(original.status, 'ok'); assert.equal(alias.status, 'ok'); assert.deepEqual(original.bytes, alias.bytes);
        report.aliasProofs.push({...pair, rawBytesSha256: sha(original.bytes), logicalSha256: definitionDigest(original.bytes, raw).toString('hex')});
    }
    // A new runtime reader, with no in-memory records, import route or source graphs.
    const reopened = new TermRecordOpfsStore(); await reopened.prepare();
    const dictionary = pipeline.configuration.dictionaryTitle;
    await reopened.ensureDictionariesLoaded([dictionary]);
    assert.equal(reopened.size, pipeline.rows); assert.equal(reopened.getDictionaryHealth(dictionary).status, 'available');
    for (const [term, expected] of queries) {
        for (const field of ['expression', 'reading']) {
            assert.deepEqual(reopened.findTermIds(dictionary, term, field).sort((a, b) => a - b), expected[field].sort((a, b) => a - b));
        }
    }
    for (let start = 0, ids = [...probeIds]; start < ids.length; start += 128) {
        const slice = ids.slice(start, start + 128), records = await reopened.getByIdsAsync(slice);
        assert.equal(records.size, slice.length);
        for (const id of slice) {
            const record = records.get(id); assert.equal(record.dictionary, dictionary);
            const expected = expectedProbeRecords.get(id); assert(expected);
            for (const [key, value] of Object.entries(expected)) { assert.equal(record[key], value, 'Cold record mismatch: ' + key); }
        }
    }
    report.coldLookupProbes = queries.size * 2; report.coldRecordProbes = probeIds.size;
    report.maximumRssKiB = process.resourceUsage().maxRSS;
    report.quiescenceAfterRead = await assertNodeOpfsQuiescent(filesystem);
    report.fileInventoryAfterReads = await fileInventory(rootPath);
    assert.deepEqual(report.fileInventoryAfterReads, report.fileInventory, 'Cold verification mutated persisted files');
    await verifyBindings(pipeline.configuration);
    report.complete = true; await saveJson(config.reportPath, report);
} catch (error) {
    report.complete = false; report.failures.push({message: String(error), stack: error?.stack ?? null});
    await saveJson(config.reportPath, report); throw error;
} finally {
    if (filesystem) {
        try { await filesystem.dispose({remove: false}); }
        catch (error) {
            report.complete = false; report.failures.push({stage: 'dispose', message: String(error), stack: error?.stack ?? null});
            await saveJson(config.reportPath, report);
        }
    }
}
assert(report.complete, 'Verifier did not finish cleanly');
console.log(JSON.stringify({complete: report.complete, rows: report.verifiedRows, logicalSha256: report.inputLogicalSha256,
    groups: report.groups.length, nativePreparedGroups: report.nativePreparedGroups, aliases: report.aliasProofs.length,
    coldLookupProbes: report.coldLookupProbes, coldRecordProbes: report.coldRecordProbes, maximumRssKiB: report.maximumRssKiB}));
