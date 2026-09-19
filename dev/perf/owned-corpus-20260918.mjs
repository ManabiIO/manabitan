import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {Worker} from 'node:worker_threads';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import JSZip from 'jszip';

const [dictionary, mode, destination] = process.argv.slice(2);
assert.ok(dictionary && ['baseline', 'private-owned'].includes(mode) && destination);
const root = process.cwd();
const lockBytes = await readFile('test/perf/dictionaries.lock.json');
const fixture = JSON.parse(lockBytes).dictionaries[dictionary];
assert.ok(fixture);
const archive = await readFile(path.join('builds/e2e-dictionary-cache', fixture.cacheFile));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
assert.equal(archive.byteLength, fixture.sizeBytes);
assert.equal(sha(archive), fixture.sha256);
const zip = await JSZip.loadAsync(archive);
const names = Object.keys(zip.files).filter(name => /^term_bank_\d+\.json$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
assert.ok(names.length > 0);
const wasmBytes = await readFile('ext/lib/term-bank-parser.wasm');
const module = await WebAssembly.compile(wasmBytes);
const url = pathToFileURL(path.join(root, 'ext/js/dictionary/term-bank-wasm-parser-worker.js')).href;
const adapter = `import {parentPort} from 'node:worker_threads';
    globalThis.self = {addEventListener: (_, handler) => parentPort.on('message', data => handler({data})),
    postMessage: (data, transfer) => parentPort.postMessage(data, transfer)};
    await import(${JSON.stringify(url)});
    parentPort.postMessage({type: 'loaded'});`;
const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(adapter)}`));
function request(message, transfer = []) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error('Worker corpus request timed out')), 120000);
        const cleanup = () => {
            clearTimeout(timer);
            worker.off('message', receive);
            worker.off('error', fail);
            worker.off('exit', exit);
        };
        const receive = value => { cleanup(); resolve(value); };
        const fail = error => { cleanup(); reject(error); };
        const exit = code => fail(new Error(`Worker exited ${code}`));
        worker.once('message', receive);
        worker.once('error', fail);
        worker.once('exit', exit);
        if (message !== null) worker.postMessage(message, transfer);
    });
}
function chunkDigest(chunk) {
    const h = createHash('sha256');
    const visit = value => {
        if (ArrayBuffer.isView(value)) {
            h.update(`${value.constructor.name}:${value.byteLength}:`);
            h.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
        } else if (value instanceof Map) {
            for (const [k, v] of value) { visit(k); visit(v); }
        } else if (value !== null && typeof value === 'object') {
            for (const [k, v] of Object.entries(value)) { visit(k); visit(v); }
        } else h.update(`${typeof value}:${String(value)};`);
    };
    visit(chunk.rowCount);
    visit(chunk.termRecordPreinternedPlan);
    visit(chunk.readingEqualsExpressionList);
    visit(chunk.scoreList);
    visit(chunk.sequenceList);
    visit(chunk.contentHash1List);
    visit(chunk.contentHash2List);
    visit(chunk.contentUniqueIndexList);
    visit(chunk.mediaRows);
    assert.ok(chunk.contentBytesBuffer && chunk.contentMetaList && chunk.preparedLookupIndexes instanceof Map);
    const bytes = chunk.contentBytesBuffer;
    const meta = chunk.contentMetaList;
    for (let row = 0; row < chunk.rowCount; row++) {
        const offset = chunk.contentBytesBaseOffset + meta[row * 4];
        const length = meta[row * 4 + 1];
        assert.ok(Number.isSafeInteger(offset) && offset >= 0 && offset + length <= bytes.byteLength);
        visit(bytes.subarray(offset, offset + length));
        visit(meta.subarray(row * 4 + 1, row * 4 + 4));
    }
    for (const [key, entry] of chunk.preparedLookupIndexes) {
        visit(key);
        visit(entry.bytes);
        visit(entry.preinternedPlan);
    }
    return h.digest('hex');
}
const result = {dictionary, mode, archiveSha256: fixture.sha256, wasmSha256: sha(wasmBytes),
    workerSha256: sha(await readFile('ext/js/dictionary/term-bank-wasm-parser-worker.js')),
    lockSha256: sha(lockBytes), rows: 0, groups: [], maxWasmHeapBytes: 0, status: 'running'};
let previous = null;
try {
    assert.equal((await request(null)).type, 'loaded');
    assert.equal((await request({type: 'initialize', module})).type, 'ready');
    for (let start = 0; start < names.length; start += 2) {
        const group = names.slice(start, start + 2);
        const buffers = [];
        for (const name of group) {
            const bytes = await zip.file(name).async('uint8array');
            buffers.push(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        }
        const response = await request({type: 'parse', id: start + 1, version: 3, sourceBuffers: buffers,
            options: {singleChunk: true, emitTermByteLists: false, computeContentHashes: true,
                emitContentSlab: true, emitTokenBinaryContent: true, mediaHintFastScan: true, prepareLookupIndexes: true}}, buffers);
        assert.ok(buffers.every(b => b.byteLength === 0));
        assert.equal(response.type, 'result', JSON.stringify(response.error));
        assert.equal(response.id, start + 1);
        if (mode === 'private-owned') {
            assert.equal(response.borrowsWorkerMemory, false);
            if (previous) assert.equal(chunkDigest(previous.chunk), previous.digest, 'Retained owning output changed');
        }
        const chunk = response.chunk;
        const digest = chunkDigest(chunk);
        result.rows += chunk.rowCount;
        result.maxWasmHeapBytes = Math.max(result.maxWasmHeapBytes, response.profile.maxWasmHeapBytes);
        result.groups.push({banks: group, rows: chunk.rowCount, digest, mediaRows: chunk.mediaRows.length});
        previous = mode === 'private-owned' ? {chunk, digest} : null;
        console.log(`${dictionary} ${mode}: ${start + 1}/${names.length}, rows=${result.rows}`);
    }
    assert.equal(result.rows, fixture.termRows);
    result.status = 'success';
} catch (error) {
    result.status = 'failed';
    result.error = error.stack;
    throw error;
} finally {
    await worker.terminate();
    await writeFile(destination, JSON.stringify(result, null, 2));
}
