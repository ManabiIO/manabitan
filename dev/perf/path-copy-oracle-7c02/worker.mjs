import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {parentPort, workerData} from 'node:worker_threads';

const {copyWasmBackedColumnChunk: copyPublicCandidate} = await import(workerData.candidateProbe);
const {copyWasmBackedColumnChunk: copyFrozenBaseline} = await import(workerData.baselineParser);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixtureBytes = readFileSync(workerData.fixtureManifestPath);
assert.equal(sha(fixtureBytes), workerData.fixtureManifestSha256);
const expectedGroups = new Map(JSON.parse(fixtureBytes).groups.map((group) => [group.groupKey, group]));

// Include every scalar, collection, column, byte view and alias relationship.
// For the raw parser chunk, contentBytesBuffer is a whole-heap view; only its
// declared content region belongs to this value. Never hash unused heap slack.
function semanticDigest(chunk) {
    const bytes = chunk.contentBytesBuffer;
    const length = chunk.contentBytesLength;
    const baseOffset = chunk.contentBytesBaseOffset ?? 0;
    assert(Number.isSafeInteger(length) && length >= 0);
    assert(Number.isSafeInteger(baseOffset) && baseOffset >= 0);
    assert(bytes instanceof Uint8Array);
    assert(baseOffset <= bytes.byteLength && length <= bytes.byteLength - baseOffset);
    const digest = createHash('sha256');
    const objects = new WeakMap();
    const buffers = new WeakMap();
    let nextObject = 0;
    let nextBuffer = 0;
    let byteViewBytes = 0;
    const token = (text) => { digest.update(text); digest.update('\0'); };
    const bufferId = (buffer) => {
        if (!buffers.has(buffer)) buffers.set(buffer, nextBuffer++);
        return buffers.get(buffer);
    };
    const visit = (item) => {
        if (item === null) { token('null'); return; }
        if (typeof item !== 'object') { token(typeof item + ':' + String(item)); return; }
        if (objects.has(item)) { token('ref:' + objects.get(item)); return; }
        objects.set(item, nextObject++);
        if (ArrayBuffer.isView(item)) {
            token('view:' + item.constructor.name + ':' + item.byteOffset + ':' + item.byteLength + ':' + bufferId(item.buffer) + ':' + (item.buffer instanceof ArrayBuffer ? 'private' : 'shared'));
            // Keep the exact original view/object and backing identities even
            // when this view is reached through an alias before its root key.
            const start = item === bytes ? baseOffset : 0;
            const size = item === bytes ? length : item.byteLength;
            token('hashed-range:' + start + ':' + size);
            digest.update(new Uint8Array(item.buffer, item.byteOffset + start, size));
            byteViewBytes += size;
        } else if (item instanceof ArrayBuffer || item instanceof SharedArrayBuffer) {
            token('buffer:' + bufferId(item) + ':' + item.byteLength);
            digest.update(new Uint8Array(item));
            byteViewBytes += item.byteLength;
        } else if (item instanceof Map) {
            token('map:' + item.size);
            for (const [key, child] of item) { visit(key); visit(child); }
        } else if (Array.isArray(item)) {
            token('array:' + item.length);
            for (const child of item) visit(child);
        } else {
            const keys = Object.keys(item).sort();
            token('object:' + keys.length);
            for (const key of keys) { token(key); visit(item[key]); }
        }
    };
    visit(chunk);
    return {sha256: digest.digest('hex'), byteViewBytes, objectCount: nextObject, backingBufferCount: nextBuffer};
}

globalThis.__beforePathCopy = (chunk, source) => {
    assert(source);
    const {wasm, jsonPtr, jsonLength} = source;
    return {memory: wasm.memory.buffer, memoryBytes: wasm.memory.buffer.byteLength,
        heapEnd: wasm.wasm_alloc(0), rawSourceSha256: sha(new Uint8Array(wasm.memory.buffer, jsonPtr, jsonLength)),
        rawColumns: semanticDigest(chunk)};
};
function verifySnapshot(chunk, source, snapshot) {
    assert.equal(source.wasm.memory.buffer, snapshot.memory);
    assert.equal(source.wasm.memory.buffer.byteLength, snapshot.memoryBytes);
    assert.equal(source.wasm.wasm_alloc(0), snapshot.heapEnd);
    assert.equal(sha(new Uint8Array(snapshot.memory, source.jsonPtr, source.jsonLength)), snapshot.rawSourceSha256);
    assert.deepEqual(semanticDigest(chunk), snapshot.rawColumns);
}

globalThis.__verifyPathCopy = (chunk, shareContentBytes, projectImagePaths, prepareLookupRoute, source, candidate, request, snapshot) => {
    assert(source && projectImagePaths && prepareLookupRoute);
    const files = request.sourceMetadata.map(({filename}) => filename);
    const groupKey = Number(files[0].slice(10, -5));
    const expected = expectedGroups.get(groupKey);
    assert(expected);
    assert.deepEqual(files, expected.files);
    assert.equal(chunk.rowCount, expected.sourceRows);
    assert.equal(chunk.mediaRows.length, expected.counts.mediaRows);
    verifySnapshot(chunk, source, snapshot);
    const publicCopy = copyPublicCandidate(chunk, shareContentBytes, projectImagePaths, prepareLookupRoute, source);
    assert.deepEqual(candidate, publicCopy, 'Same-module public and batched copies must match every value and byte');
    const candidateDigest = semanticDigest(candidate);
    assert.deepEqual(candidateDigest, semanticDigest(publicCopy), 'Every nonempty and empty view/buffer alias relationship must match');
    verifySnapshot(chunk, source, snapshot);
    const baseline = copyFrozenBaseline(chunk, shareContentBytes, projectImagePaths, prepareLookupRoute, source);
    assert.deepEqual(candidate, baseline, 'Frozen baseline must match every property, column, key plan, prepared route and media path');
    verifySnapshot(chunk, source, snapshot);
    const candidatePaths = candidate.mediaRows.map(({imagePaths}) => imagePaths ?? null);
    assert.equal(sha(JSON.stringify(candidatePaths)), expected.copiedOutputSha256);
    const prepared = [...(candidate.preparedLookupIndexes?.values() ?? [])];
    const routeCount = prepared.filter((entry) => entry.routeFilter !== undefined).length;
    assert.equal(prepared.length, 1, 'Each production VNDB group must have one prepared lookup index');
    assert.equal(routeCount, 1, 'Each production VNDB group must have one prepared lookup route');
    const receipt = {
        complete: true, groupKey, id: request.id, files, sourceRows: chunk.rowCount,
        mediaRows: chunk.mediaRows.length, shareContentBytes, projectImagePaths, prepareLookupRoute,
        sourceShared: snapshot.memory instanceof SharedArrayBuffer, rawSourceBytes: source.jsonLength,
        rawSourceSha256: snapshot.rawSourceSha256, rawColumns: snapshot.rawColumns,
        output: candidateDigest, copiedOutputSha256: expected.copiedOutputSha256,
        preparedIndexes: prepared.length, preparedRoutes: routeCount,
        sameModulePublicCopyFullAliasParity: true, frozenBaselineFullValueByteParity: true,
        exactFullObjectParity: true, exactRawSourceAndColumnsUnchanged: true, nativeHeapAndBufferUnchanged: true,
        aliasNormalization: false,
    };
    writeFileSync(join(workerData.receiptRoot, 'group-' + String(groupKey).padStart(6, '0') + '.json'), JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'});
};

globalThis.self = globalThis;
globalThis.addEventListener = (type, listener) => {
    if (type === 'message') parentPort.on('message', (data) => listener({data}));
};
globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
await import(workerData.url);
