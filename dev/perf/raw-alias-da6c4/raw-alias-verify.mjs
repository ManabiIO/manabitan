// SPDX-License-Identifier: GPL-3.0-or-later
// Untimed exhaustive record/content verification for the immutable alias component.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {SEED, CAPTURE_GROUPS, MIXED_GROUPS} from './raw-alias-capture.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const utf8 = new TextDecoder('utf-8', {ignoreBOM: true});
const asBytes = (view) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

export function inputWitness(groups) {
    const seen = new Map(), digest = createHash('sha256');
    function visit(value) {
        if (value === undefined) { digest.update('undefined;'); return; }
        if (value === null || typeof value !== 'object') { digest.update(JSON.stringify(value) + ';'); return; }
        if (seen.has(value)) { digest.update('ref:' + seen.get(value) + ';'); return; }
        seen.set(value, seen.size);
        digest.update('node:' + (seen.size - 1) + ':');
        if (value instanceof ArrayBuffer) { digest.update('buffer:' + value.byteLength + ':'); digest.update(new Uint8Array(value)); }
        else if (ArrayBuffer.isView(value)) {
            digest.update(value.constructor.name + ':' + value.byteOffset + ':' + value.byteLength + ':');
            visit(value.buffer);
        } else if (value instanceof Map) {
            digest.update('map:' + value.size + ':');
            for (const [key, item] of value) { visit(key); visit(item); }
        } else if (Array.isArray(value)) {
            digest.update('array:' + value.length + ':');
            for (const item of value) { visit(item); }
        } else {
            assert.equal(Object.getPrototypeOf(value), Object.prototype);
            for (const [key, item] of Object.entries(value)) { digest.update(key + ':'); visit(item); }
        }
    }
    for (const group of groups) {
        visit({
            index: group.index, firstId: group.firstId, chunk: group.chunk,
            references: group.references, contentOffsets: group.contentOffsets,
            contentLengths: group.contentLengths, contentDictNames: group.contentDictNames,
        });
    }
    return digest.digest('hex');
}

function planOffsets(plan) {
    if (plan.stringOffsets instanceof Uint32Array) { return plan.stringOffsets; }
    const offsets = new Uint32Array(plan.stringLengths.length);
    let cursor = 0;
    for (let key = 0; key < offsets.length; ++key) { offsets[key] = cursor; cursor += plan.stringLengths[key]; }
    assert.equal(cursor, plan.stringsBuffer.byteLength);
    return offsets;
}
function keyAt(plan, offsets, id) {
    assert(Number.isInteger(id) && id >= 0 && id < offsets.length);
    return plan.stringsBuffer.subarray(offsets[id], offsets[id] + plan.stringLengths[id]);
}
function originalName(group, row) {
    return typeof group.contentDictNames === 'string' ? group.contentDictNames : group.contentDictNames[row];
}
function referenceFor(chunk, names, row) {
    const refs = chunk.resolvedContentReferences;
    const unique = refs.uniqueIndexList[row];
    return {
        offset: refs.offsets[unique], length: refs.lengths[unique],
        name: typeof names === 'string' ? names : names[row],
    };
}
function referenceKey(reference) { return reference.name + ':' + reference.offset + ':' + reference.length; }
function expectedSequence(value) { return typeof value === 'number' && value >= 0 ? value : null; }
function normalizedFile(bytes, relative) {
    const result = Uint8Array.from(bytes);
    if (relative.endsWith('.mbtr')) {
        assert.equal(Buffer.from(bytes.subarray(0, 8)).toString(), 'MBTRD16X');
        result.fill(0, 8, 24);
    } else if (relative.endsWith('.mbti')) {
        assert.equal(Buffer.from(bytes.subarray(0, 8)).toString(), 'MBTIDX11');
        result.fill(0, 24, 40);
    }
    return result;
}
async function listFiles(root, relative = '') {
    const result = [];
    for (const entry of await readdir(path.join(root, relative), {withFileTypes: true})) {
        const name = relative ? relative + '/' + entry.name : entry.name;
        if (entry.isDirectory()) { result.push(...await listFiles(root, name)); }
        else { assert(entry.isFile()); result.push(name); }
    }
    return result.sort();
}
function recordFieldsLength(bytes, start, rows, format) {
    if (format === 1) { return rows * 12; }
    if (format === 3) { return rows * 16; }
    assert.equal(format, 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset + start, 16);
    assert.equal(view.getUint32(0, true), 0x3246524d);
    assert.equal(view.getUint32(4, true), rows);
    assert.equal(view.getUint32(12, true), 2);
    const scores = view.getUint32(8, true);
    assert(scores > 0 && scores < 65535);
    return 16 + scores * 4 + rows * 8;
}

export async function verifyAliasObservation({
    rootPath, groups, outputs, arm, store, contentStore, blockStore, load,
}) {
    const lookup = await load('ext/js/dictionary/term-lookup-index.js');
    const routeModule = await load('ext/js/dictionary/term-lookup-route.js');
    const {TermRecordOpfsStore} = await load('ext/js/dictionary/term-record-opfs-store.js');
    const files = await listFiles(rootPath);
    const seedBytes = await readFile(path.join(rootPath, SEED.file));
    assert(seedBytes.length >= SEED.bytes);
    assert.equal(sha(seedBytes.subarray(0, SEED.bytes)), SEED.sha256);
    const byFirstId = new Map(groups.map((group) => [group.firstId, group]));
    const expectedByGroup = new Map(groups.map((group) => [group.index, {
        ...group, keyOffsets: planOffsets(group.chunk.termRecordPreinternedPlan),
    }]));
    const routeByFirstId = new Map();
    const route = store._exactLookupRoute;
    assert(route && !store._exactLookupRouteAbandoned);
    for (const shard of route.shards.values()) {
        for (const chunk of shard.chunks) { routeByFirstId.set(chunk.firstId, chunk); }
    }

    const physical = createHash('sha256'), fileReceipts = [], chunks = [];
    let lookupPayloadBytes = 0, descriptorBytes = 0, indexBytes = 0;
    for (const relative of files) {
        assert(relative === SEED.file || /^manabitan-term-records\/.+\.mbtr(?:\.mbti)?$/.test(relative), 'Unexpected persisted file: ' + relative);
        const bytes = await readFile(path.join(rootPath, relative));
        const normalized = normalizedFile(bytes, relative);
        const receipt = {file: relative, bytes: bytes.length, sha256: sha(bytes), normalizedSha256: sha(normalized)};
        fileReceipts.push(receipt);
        physical.update(relative + '\n'); physical.update(normalized);
        if (relative.endsWith('.mbtr')) { descriptorBytes += bytes.length; }
        if (!relative.endsWith('.mbti')) { continue; }
        indexBytes += bytes.length;
        const descriptor = await readFile(path.join(rootPath, relative.slice(0, -5)));
        assert.deepEqual(bytes.subarray(24, 40), descriptor.subarray(8, 24), 'Generation IDs disagree before normalization');
        const header = new DataView(bytes.buffer, bytes.byteOffset, 40);
        const declaredDescriptorBytes = Number(header.getBigUint64(8, true));
        assert.equal(declaredDescriptorBytes, descriptor.length);
        const declaredChunks = header.getUint32(16, true), declaredRows = header.getUint32(20, true);
        let cursor = 40, observedChunks = 0, observedRows = 0;
        while (cursor < bytes.length) {
            const view = new DataView(bytes.buffer, bytes.byteOffset + cursor, 40);
            const firstId = view.getUint32(0, true), rows = view.getUint32(4, true);
            const contentOffsetBase = Number(view.getBigUint64(8, true));
            const payloadLength = view.getUint32(16, true), fieldsFormat = view.getUint32(36, true);
            assert(rows > 0 && payloadLength > 0);
            const payload = Uint8Array.from(bytes.subarray(cursor + 40, cursor + 40 + payloadLength));
            const parsed = lookup.parsePersistedTermLookupIndex(payload);
            assert.equal(parsed.expressionKeys.length, rows);
            const group = groups.find((item) => firstId >= item.firstId && firstId < item.firstId + item.chunk.rowCount);
            assert(group && firstId + rows <= group.firstId + group.chunk.rowCount);
            const expected = expectedByGroup.get(group.index);
            const plan = expected.chunk.termRecordPreinternedPlan;
            const start = firstId - group.firstId;
            const routeChunk = routeByFirstId.get(firstId);
            assert(routeChunk && routeChunk.count === rows);
            const native = byFirstId.get(firstId)?.chunk.preparedLookupIndexes.get('0:' + rows);
            const mustBeNative = arm === 'B' || group.index === 0 || group.index === 2;
            if (mustBeNative) {
                assert.equal(start, 0); assert.equal(rows, group.chunk.rowCount);
                assert(native);
                assert.deepEqual(payload, native.bytes);
                if (native.routeFilter instanceof Uint32Array) { assert.deepEqual(routeChunk.filter, native.routeFilter); }
            }
            for (let row = 0; row < rows; ++row) {
                const sourceRow = start + row;
                const expression = keyAt(plan, expected.keyOffsets, plan.expressionIndexes[sourceRow]);
                assert.deepEqual(lookup.getPersistedTermKeyBytes(parsed, row, 'expression'), expression);
                const equal = group.chunk.readingEqualsExpressionList[sourceRow] === true || group.chunk.readingEqualsExpressionList[sourceRow] === 1;
                const reading = lookup.getPersistedTermKeyBytes(parsed, row, 'reading');
                if (equal) { assert.equal(reading, null); }
                else { assert.deepEqual(reading, keyAt(plan, expected.keyOffsets, plan.readingIndexes[sourceRow])); }
                assert.equal(lookup.getPersistedTermSequence(parsed, row), expectedSequence(group.chunk.sequenceList[sourceRow]));
            }
            for (let key = 0; key < parsed.keyOffsets.length - 1; ++key) {
                const value = parsed.keyBytes.subarray(parsed.keyOffsets[key], parsed.keyOffsets[key + 1]);
                assert(routeModule.termLookupFilterMayContain(routeChunk.filter, lookup.hashTermLookupKeyBytes(value)), 'Route filter rejected a persisted key');
            }
            const fieldsLength = recordFieldsLength(bytes, cursor + 40 + payloadLength, rows, fieldsFormat);
            chunks.push({
                file: relative, firstId, rows, group: group.index, sourceRowStart: start,
                contentOffsetBase, payloadBytes: payloadLength, payloadSha256: sha(payload), fieldsBytes: fieldsLength,
                routeFilterSha256: sha(asBytes(routeChunk.filter)), nativePrepared: mustBeNative,
            });
            lookupPayloadBytes += payloadLength;
            cursor += 40 + payloadLength + fieldsLength;
            ++observedChunks; observedRows += rows;
        }
        assert.equal(cursor, bytes.length);
        assert.equal(observedChunks, declaredChunks); assert.equal(observedRows, declaredRows);
    }
    chunks.sort((a, b) => a.firstId - b.firstId);
    assert.equal(chunks.reduce((sum, chunk) => sum + chunk.rows, 0), 400000);
    assert.equal(chunks.length, arm === 'B' ? 10 : 32);
    const affectedPayloadBytes = chunks.filter(({group}) => MIXED_GROUPS.includes(group)).reduce((sum, chunk) => sum + chunk.payloadBytes, 0);
    assert.equal(affectedPayloadBytes, arm === 'B' ? 16876960 : 17306784);

    // New reader instance: no in-memory records or lookup indexes from append.
    const reopened = new TermRecordOpfsStore();
    await reopened.prepare();
    const dictionary = groups[0].chunk.dictionary;
    await reopened.ensureDictionariesLoaded([dictionary]);
    assert.equal(reopened.size, 400000);
    const probes = new Set();
    for (const group of groups) {
        const expected = expectedByGroup.get(group.index), plan = group.chunk.termRecordPreinternedPlan;
        const rows = new Set([0, group.chunk.rowCount - 1]);
        if (Array.isArray(group.contentDictNames)) {
            const raw = group.contentDictNames.findIndex((name) => name === 'raw-v6');
            if (raw >= 0) { rows.add(raw); }
        }
        const distinctReading = group.chunk.readingEqualsExpressionList.findIndex((value) => value !== true && value !== 1);
        if (distinctReading >= 0) { rows.add(distinctReading); }
        for (const row of rows) {
            probes.add(utf8.decode(keyAt(plan, expected.keyOffsets, plan.expressionIndexes[row])));
            if (group.chunk.readingEqualsExpressionList[row] !== true && group.chunk.readingEqualsExpressionList[row] !== 1) {
                probes.add(utf8.decode(keyAt(plan, expected.keyOffsets, plan.readingIndexes[row])));
            }
        }
    }
    probes.add('__manabitan_absent_raw_alias_probe_da6c4__');
    const expectedQueries = new Map([...probes].map((query) => [query, {expression: [], reading: []}]));
    const metadataDigest = createHash('sha256'), contentPairs = new Map();
    let verifiedRows = 0;
    for (const group of groups) {
        const expected = expectedByGroup.get(group.index), plan = group.chunk.termRecordPreinternedPlan;
        const output = outputs.get(group.index);
        assert(output);
        for (let start = 0; start < group.chunk.rowCount; start += 512) {
            const count = Math.min(512, group.chunk.rowCount - start);
            const ids = Array.from({length: count}, (_, index) => group.firstId + start + index);
            const records = await reopened.getByIdsAsync(ids);
            assert.equal(records.size, count);
            for (let local = 0; local < count; ++local) {
                const row = start + local, id = ids[local], record = records.get(id);
                const expressionBytes = keyAt(plan, expected.keyOffsets, plan.expressionIndexes[row]);
                const equal = group.chunk.readingEqualsExpressionList[row] === true || group.chunk.readingEqualsExpressionList[row] === 1;
                const readingBytes = equal ? expressionBytes : keyAt(plan, expected.keyOffsets, plan.readingIndexes[row]);
                const expression = utf8.decode(expressionBytes), reading = utf8.decode(readingBytes);
                assert.equal(record.id, id); assert.equal(record.dictionary, dictionary);
                assert.equal(record.expression, expression); assert.equal(record.reading, reading);
                assert.equal(record.score, group.chunk.scoreList[row] ?? 0);
                assert.equal(record.sequence, expectedSequence(group.chunk.sequenceList[row]));
                const original = referenceFor(group.chunk, group.contentDictNames, row);
                const actual = referenceFor(output.chunk, output.contentDictNames, row);
                assert.equal(record.entryContentOffset, actual.offset);
                assert.equal(record.entryContentLength, actual.length);
                assert.equal(record.entryContentDictName, actual.name);
                assert.equal(actual.length, original.length);
                if (originalName(group, row) !== 'raw-v6' || !output.promoted) { assert.deepEqual(actual, original); }
                const originalKey = referenceKey(original), actualKey = referenceKey(actual);
                const pairKey = originalKey + '=>' + actualKey;
                contentPairs.set(pairKey, {original, actual, originalKey, actualKey});
                metadataDigest.update(JSON.stringify([
                    id, Buffer.from(expressionBytes).toString('hex'),
                    equal ? null : Buffer.from(readingBytes).toString('hex'),
                    record.score, record.sequence, originalKey,
                ]) + '\n');
                expectedQueries.get(expression)?.expression.push(id);
                if (!equal) { expectedQueries.get(reading)?.reading.push(id); }
                ++verifiedRows;
            }
            // Verification-only memory bound; the persistent reader remains loaded.
            reopened._recordsById.clear();
            reopened._recordIdsByDictionary.clear();
        }
    }
    assert.equal(verifiedRows, 400000);
    let lookupProbes = 0;
    for (const [query, expected] of expectedQueries) {
        for (const field of ['expression', 'reading']) {
            const actual = reopened.findTermIds(dictionary, query, field).sort((a, b) => a - b);
            assert.deepEqual(actual, expected[field].sort((a, b) => a - b));
            ++lookupProbes;
        }
    }

    // Read every distinct referenced canonical definition through the unchanged
    // block decoder; changed references additionally decode the physical alias.
    await contentStore.prepare();
    blockStore.clearCache();
    const contentHashes = new Map();
    const pairs = [...contentPairs.values()];
    for (let first = 0; first < pairs.length; first += 128) {
        const part = pairs.slice(first, first + 128);
        const requests = [];
        const mapping = [];
        for (const pair of part) {
            const originalIndex = requests.length;
            requests.push({contentOffset: pair.original.offset, contentLength: pair.original.length, contentDictName: pair.original.name});
            const actualIndex = pair.actualKey === pair.originalKey ? originalIndex : requests.length;
            if (actualIndex !== originalIndex) { requests.push({contentOffset: pair.actual.offset, contentLength: pair.actual.length, contentDictName: pair.actual.name}); }
            mapping.push({pair, originalIndex, actualIndex});
        }
        const results = await blockStore.readDetailedBatch(requests);
        for (const {pair, originalIndex, actualIndex} of mapping) {
            const original = results[originalIndex], actual = results[actualIndex];
            assert.equal(original.status, 'ok'); assert.equal(actual.status, 'ok');
            assert.equal(original.bytes.byteLength, pair.original.length);
            assert.deepEqual(actual.bytes, original.bytes);
            const digest = sha(actual.bytes);
            if (contentHashes.has(pair.originalKey)) { assert.equal(contentHashes.get(pair.originalKey), digest); }
            contentHashes.set(pair.originalKey, digest);
        }
    }
    const contentsDigest = createHash('sha256');
    for (const [key, digest] of [...contentHashes].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) { contentsDigest.update(JSON.stringify([key, digest]) + '\n'); }
    const metadataSha256 = metadataDigest.digest('hex'), contentSha256 = contentsDigest.digest('hex');
    const aliases = [...outputs.values()].flatMap((item) => item.aliases);
    const promotedGroups = [...outputs].filter(([, output]) => output.promoted).map(([group]) => group);
    assert.deepEqual(promotedGroups, arm === 'B' ? MIXED_GROUPS : []);
    assert.equal(aliases.length, arm === 'B' ? 8 : 0);
    assert.equal(aliases.reduce((sum, item) => sum + item.rows, 0), arm === 'B' ? 175 : 0);
    assert.equal(aliases.reduce((sum, item) => sum + item.canonicalLength, 0), arm === 'B' ? 2983 : 0);
    assert.equal(seedBytes.length - SEED.bytes, [...outputs.values()].reduce((sum, item) => sum + (item.promoted ? item.blockProfile.compressedBytes + item.aliases.length * 20 : 0), 0));
    return {
        verifiedRows, lookupProbes, referencedCanonicalDefinitions: contentHashes.size,
        metadataSha256, contentSha256, logicalSha256: sha(metadataSha256 + ':' + contentSha256),
        normalizedPhysicalSha256: physical.digest('hex'),
        physicalNormalization: 'Only actual fresh generation nonces: descriptor bytes8..23 and paired index header bytes24..39. Each pair matched before normalization; every other persisted byte participates.',
        fileReceipts, chunks, descriptorBytes, indexBytes, lookupPayloadBytes, affectedPayloadBytes,
        seedPrefixSha256: SEED.sha256, seedPrefixBytes: SEED.bytes,
        addedContentBytes: seedBytes.length - SEED.bytes, aliases, promotedGroups,
        sourceGroups: CAPTURE_GROUPS,
    };
}
