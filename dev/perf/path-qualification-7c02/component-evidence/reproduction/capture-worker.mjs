import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {parentPort, workerData} from 'node:worker_threads';
import {gzipSync} from 'node:zlib';

const {projectOneForExperiment} = await import(workerData.baselineProbe);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function rawDigest(mediaRows) {
    const digest = createHash('sha256');
    for (const {index, row} of mediaRows) {
        const bytes = row.glossaryJsonBytes;
        digest.update(JSON.stringify([index, row.glossaryJson, bytes?.byteOffset ?? null, bytes?.byteLength ?? null]));
        if (bytes instanceof Uint8Array) digest.update(bytes);
    }
    return digest.digest('hex');
}

globalThis.__capturePathFixture = (chunk, source, request, copied) => {
    assert(source && request.sourceMetadata);
    const files = request.sourceMetadata.map(({filename}) => filename);
    assert(files.every((file) => /^term_bank_\d+\.json$/.test(file)));
    const groupKey = Number(files[0].slice(10, -5));
    const {wasm, jsonPtr, jsonLength} = source;
    const memory = wasm.memory.buffer;
    const memoryBytes = memory.byteLength;
    const heapEnd = wasm.wasm_alloc(0);
    const before = rawDigest(chunk.mediaRows);
    assert.equal(copied.mediaRows.length, chunk.mediaRows.length);
    const counts = {
        mediaRows: chunk.mediaRows.length, sourceRows: chunk.rowCount, sourceBackedRows: 0,
        nonemptyContentRows: 0, rawGlossaryBytes: 0, observerNativeCalls: 0,
        nativeSpanRows: 0, acceptedNativeRows: 0, nativeFallbackRows: 0,
        unescapedAsciiRows: 0, asciiTokenBytes: 0, copiedProjectedRows: 0,
    };
    let lastSpan = 0n;
    const facade = {...source, wasm: {...wasm, project_single_glossary_image_path: (pointer, length) => {
        ++counts.observerNativeCalls;
        lastSpan = wasm.project_single_glossary_image_path(pointer, length);
        return lastSpan;
    }}};
    const rows = [];
    const expectedNative = [];
    const expectedCopied = [];
    for (let i = 0; i < chunk.mediaRows.length; ++i) {
        const {index, row} = chunk.mediaRows[i];
        const bytes = row.glossaryJsonBytes;
        const native = bytes instanceof Uint8Array && bytes.buffer === memory;
        const backing = !(bytes instanceof Uint8Array) ? 'missing' : native ? 'wasm' :
            bytes.buffer instanceof ArrayBuffer ? 'private' : 'shared';
        const contentLength = row.termEntryContentBytes.length;
        if (contentLength > 0) ++counts.nonemptyContentRows;
        if (native) ++counts.sourceBackedRows;
        counts.rawGlossaryBytes += bytes?.byteLength ?? 0;
        rows.push([index, contentLength, row.glossaryJson, native ? bytes.byteOffset : null,
            bytes instanceof Uint8Array ? Buffer.from(bytes).toString('base64') : null, backing]);
        lastSpan = 0n;
        const projected = contentLength > 0 ? projectOneForExperiment(row, facade) : null;
        if (lastSpan !== 0n) {
            ++counts.nativeSpanRows;
            const start = Number((lastSpan >> 32n) & 0xffffffffn);
            const length = Number(lastSpan & 0xffffffffn);
            assert(bytes instanceof Uint8Array && length >= 2 && start + length <= bytes.byteLength);
            assert.equal(bytes[start], 0x22);
            assert.equal(bytes[start + length - 1], 0x22);
            let ascii = length > 2 && length - 2 <= 65536;
            for (let p = start + 1; ascii && p < start + length - 1; ++p) {
                if (bytes[p] >= 0x80 || bytes[p] === 0x5c) ascii = false;
            }
            if (ascii) {
                ++counts.unescapedAsciiRows;
                counts.asciiTokenBytes += length - 2;
            }
        }
        const copyPaths = copied.mediaRows[i].imagePaths ?? null;
        assert.equal(copied.mediaRows[i].index, index);
        if (projected !== null) {
            ++counts.acceptedNativeRows;
            assert.deepEqual(projected, copyPaths);
        } else ++counts.nativeFallbackRows;
        if (copyPaths !== null) ++counts.copiedProjectedRows;
        expectedNative.push(projected);
        expectedCopied.push(copyPaths);
    }
    assert.equal(rawDigest(chunk.mediaRows), before);
    assert.equal(wasm.memory.buffer, memory);
    assert.equal(wasm.memory.buffer.byteLength, memoryBytes);
    assert.equal(wasm.wasm_alloc(0), heapEnd);
    const fixture = {
        schemaVersion: 1, groupKey, id: request.id, files, jsonPtr, jsonLength,
        sourceRows: chunk.rowCount, sourceShared: memory instanceof SharedArrayBuffer,
        counts, rawSpanSha256: before, rows, expectedNative, expectedCopied,
        nativeOutputSha256: sha(JSON.stringify(expectedNative)),
        copiedOutputSha256: sha(JSON.stringify(expectedCopied)),
        unchangedSourceBytesAndNativeHeap: true,
    };
    const serialized = Buffer.from(JSON.stringify(fixture));
    const name = 'group-' + String(groupKey).padStart(6, '0') + '.json.gz';
    writeFileSync(join(workerData.fixtureRoot, name), gzipSync(serialized), {flag: 'wx'});
};

// Same transport-only adapter as test/fixtures/parser-settlement/worker-node.mjs.
globalThis.self = globalThis;
globalThis.addEventListener = (type, listener) => {
    if (type === 'message') parentPort.on('message', (data) => listener({data}));
};
globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
await import(workerData.url);
