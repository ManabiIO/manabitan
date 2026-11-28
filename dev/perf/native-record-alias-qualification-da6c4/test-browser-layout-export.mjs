// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    CHUNK_BYTES, CURRENT_BASE, PROTOCOL_BLOB, TERM_FILES, acquireAndCloseTermHandles,
    browserBegin, browserRead, browserFinish, canonicalPhysicalProbes, checkChunkReceipt,
    exportBrowserTermLayout, inspectHeader, normalizedChunk, probeReceipts, proveNoTermWriterLeases, validateHeaderLinks,
} from './browser-layout-export.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixture = {sha256: 'a'.repeat(64), termRows: 528299, expectedTitle: 'JMdict [2026-11-22]'};
function samples(offset = 10) {
    return Array.from({length: 12}, (_, index) => ({term: 'term' + index, probes: [{term: 'term' + index,
        totalLength: 500, rowSampleCount: 1, inBoundsRowCount: 1, outOfBoundsRowCount: 0,
        glossaryReadyRowCount: 1, readablePreviewRowCount: 1,
        diagnostics: {offscreenState: {rowSample: [{rawEntryContentOffset: offset + index,
            rawEntryContentLength: 23, glossaryLength: 1, rawContentPreview: 'definition' + index}]}},
    }]}));
}
function fileBytes(generation = 7) {
    const descriptor = Buffer.alloc(26); descriptor.write('MBTRD16X'); descriptor.fill(generation, 8, 24);
    const index = Buffer.alloc(65); index.write('MBTIDX11'); index.writeBigUInt64LE(26n, 8);
    index.writeUInt32LE(1, 16); index.writeUInt32LE(fixture.termRows, 20); index.fill(generation, 24, 40); index.fill(3, 40);
    return new Map([[TERM_FILES.jmdict[0], Buffer.alloc(CHUNK_BYTES + 17, 91)],
        [TERM_FILES.jmdict[1], descriptor], [TERM_FILES.jmdict[2], index]]);
}
function fakeDirectory(files, options = {}) {
    const events = [];
    const fileHandle = (pathname) => ({kind: 'file',
        async getFile() { const bytes = files.get(pathname); assert(bytes); return new File([bytes], pathname); },
        async createSyncAccessHandle() {
            events.push(['acquire', pathname]);
            if (options.failAcquire === pathname) { throw new Error('exclusive lock held'); }
            return {getSize() { if (options.failSize === pathname) { throw new Error('size failed'); } return files.get(pathname).length; },
                close() { events.push(['close', pathname]); },
                write() { throw new Error('Forbidden write'); }, truncate() { throw new Error('Forbidden truncate'); }, flush() { throw new Error('Forbidden flush'); }};
        },
    });
    const directory = (prefix = '') => ({kind: 'directory',
        async getDirectoryHandle(name) { assert([...files.keys()].some((key) => key.startsWith(prefix + name + '/'))); return directory(prefix + name + '/'); },
        async getFileHandle(name) { const pathname = prefix + name; assert(files.has(pathname)); return fileHandle(pathname); },
        async *entries() {
            const children = new Set();
            for (const name of files.keys()) { if (name.startsWith(prefix)) { children.add(name.slice(prefix.length).split('/')[0]); } }
            for (const child of children) { yield [child, files.has(prefix + child) ? fileHandle(prefix + child) : directory(prefix + child + '/')]; }
        },
    });
    return {root: directory(), events};
}
async function withFs(files, action, options) {
    const old = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), fs = fakeDirectory(files, options);
    Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {storage: {getDirectory: async () => fs.root}}});
    try { return await action(fs); }
    finally { if (old) { Object.defineProperty(globalThis, 'navigator', old); } else { delete globalThis.navigator; }
        delete globalThis.testLayout; delete globalThis.__manabitanAliasLayoutProofDa6c4; }
}

test('original physical probe digest is retained and only two declared location fields are omitted from semantic projection', () => {
    const before = samples(), digest = hash(JSON.stringify(canonicalPhysicalProbes(before)));
    const receipt = probeReceipts(before, structuredClone(before), digest);
    assert.equal(receipt.physicalOutputDigestSha256, digest);
    const shifted = samples(110); for (const row of shifted) { row.probes[0].totalLength += 10; }
    const other = probeReceipts(shifted, shifted, hash(JSON.stringify(canonicalPhysicalProbes(shifted))));
    assert.notEqual(other.physicalOutputDigestSha256, digest);
    assert.equal(other.semanticProbeDigestSha256, receipt.semanticProbeDigestSha256);
    shifted[0].probes[0].diagnostics.offscreenState.rowSample[0].rawContentPreview = 'corrupted';
    assert.notEqual(probeReceipts(shifted, shifted, hash(JSON.stringify(canonicalPhysicalProbes(shifted)))).semanticProbeDigestSha256, receipt.semanticProbeDigestSha256);
    assert.throws(() => probeReceipts(before, shifted, digest));
});

test('generation normalization changes exactly the16 schema bytes and validates pair linkage', () => {
    const files = fileBytes(), manifests = [];
    for (const [pathname, bytes] of files) {
        const header = inspectHeader(pathname, bytes, bytes.length), normalized = normalizedChunk(bytes, 0, header);
        const differences = [...bytes.keys()].filter((index) => normalized[index] !== bytes[index]);
        assert.deepEqual(differences, header.generationRange ? Array.from({length: 16}, (_, index) => header.generationRange[0] + index) : []);
        if (header.kind === 'content') { assert.strictEqual(normalized, bytes); }
        else { assert.notStrictEqual(normalized, bytes); }
        manifests.push({path: pathname, bytes: bytes.length, header});
    }
    assert.deepEqual(validateHeaderLinks(manifests, fixture.termRows).pairs, 1);
    const wrong = structuredClone(manifests); wrong[2].header.generationId = 'f'.repeat(32);
    assert.throws(() => validateHeaderLinks(wrong, fixture.termRows), /generation/);
    wrong[2].header.generationId = wrong[1].header.generationId; ++wrong[2].header.descriptorBytes;
    assert.throws(() => validateHeaderLinks(wrong, fixture.termRows), /descriptor-length/);
    assert.throws(() => inspectHeader(TERM_FILES.jmdict[2], Buffer.alloc(65), 65), /magic/);
});

test('normalization honors sliced chunk boundaries without changing adjacent bytes', () => {
    const original = fileBytes().get(TERM_FILES.jmdict[2]), header = inspectHeader(TERM_FILES.jmdict[2], original, original.length);
    const pieces = [original.subarray(0, 30), original.subarray(30, 34), original.subarray(34)];
    const normalized = Buffer.concat(pieces.map((piece, index) => normalizedChunk(piece, [0, 30, 34][index], header)));
    assert.deepEqual(normalized, normalizedChunk(original, 0, header));
    assert.deepEqual(original.subarray(0, 24), normalized.subarray(0, 24));
    assert.deepEqual(original.subarray(40), normalized.subarray(40));
});

test('browser range reader enforces exact sequential bounded coverage and catches short snapshots', async () => {
    await withFs(fileBytes(), async () => {
        const begun = await browserBegin({key: 'testLayout', files: TERM_FILES.jmdict});
        const name = TERM_FILES.jmdict[0], size = begun.selected[0].bytes;
        await assert.rejects(browserRead({key: 'testLayout', path: name, offset: 1, length: CHUNK_BYTES, maxBytes: CHUNK_BYTES}), /range/);
        await assert.rejects(browserRead({key: 'testLayout', path: name, offset: 0, length: 1, maxBytes: CHUNK_BYTES}), /range/);
        const first = await browserRead({key: 'testLayout', path: name, offset: 0, length: CHUNK_BYTES, maxBytes: CHUNK_BYTES});
        checkChunkReceipt(first, {path: name, offset: 0, length: CHUNK_BYTES, size});
        await assert.rejects(browserRead({key: 'testLayout', path: name, offset: 0, length: CHUNK_BYTES, maxBytes: CHUNK_BYTES}), /range/);
        await assert.rejects(browserFinish({key: 'testLayout'}), /Incomplete/);
        globalThis.testLayout.files.get(name).file = {size, slice: () => ({arrayBuffer: async () => new ArrayBuffer(2)})};
        await assert.rejects(browserRead({key: 'testLayout', path: name, offset: CHUNK_BYTES, length: 17, maxBytes: CHUNK_BYTES}), /Short/);
    });
});

test('Node range validation rejects transport corruption, noncanonical base64 and every changed coordinate', () => {
    const bytes = Buffer.from('bytes'), expected = {path: 'file', offset: 0, length: 5, size: 5};
    const receipt = {...expected, base64: bytes.toString('base64'), sha256: hash(bytes)};
    assert.deepEqual(checkChunkReceipt(receipt, expected), bytes);
    for (const key of ['path', 'offset', 'length', 'size']) { assert.throws(() => checkChunkReceipt({...receipt, [key]: 'wrong'}, expected)); }
    assert.throws(() => checkChunkReceipt({...receipt, base64: receipt.base64 + '\n'}, expected));
    assert.throws(() => checkChunkReceipt({...receipt, sha256: 'a'.repeat(64)}, expected));
});

test('exclusive probe performs no write/flush/truncate and closes a handle when getSize fails', async () => {
    await withFs(fileBytes(), async ({events}) => {
        const result = await acquireAndCloseTermHandles(TERM_FILES.jmdict);
        assert.equal(result.length, 3); assert(result.every(({exclusiveHandleClosed}) => exclusiveHandleClosed));
        assert.equal(events.filter(([event]) => event === 'close').length, 3);
    });
    await withFs(fileBytes(), async ({events}) => {
        await assert.rejects(acquireAndCloseTermHandles(TERM_FILES.jmdict), /size failed/);
        assert.deepEqual(events, [['acquire', TERM_FILES.jmdict[0]], ['close', TERM_FILES.jmdict[0]]]);
    }, {failSize: TERM_FILES.jmdict[0]});
});

test('failed worker termination still joins the observed close before rejecting the proof', async () => {
    const worker = new EventEmitter();
    worker.evaluate = async () => [{path: 'file', bytes: 1, exclusiveHandleClosed: true}];
    let terminateCalled;
    const terminateEntered = new Promise((resolve) => { terminateCalled = resolve; });
    let calls = 0, settled = false;
    const page = {url: () => 'chrome-extension://fixture/settings.html', waitForEvent: async () => worker,
        evaluate: async () => { if (++calls === 1) { return true; } terminateCalled(); throw new Error('termination transport failure'); }};
    const pending = proveNoTermWriterLeases(page, ['file']).finally(() => { settled = true; });
    await terminateEntered;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'A failed command must not abandon the close promise');
    worker.emit('close');
    await assert.rejects(pending, /termination failed/);
    assert.equal(settled, true);
});

test('complete hash-only helper binds all deterministic bytes and retains failed inventory receipts', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'alias-export-unit-'));
    try {
        for (const corrupt of [false, true]) {
            const files = fileBytes(), probes = samples();
            const inventory = [...files].map(([path, bytes]) => ({path, bytes: bytes.length})).sort((a, b) => a.path.localeCompare(b.path));
            const validation = {title: fixture.expectedTitle, termRows: fixture.termRows,
                outputDigestSha256: hash(JSON.stringify(canonicalPhysicalProbes(probes))), storage: {files: inventory}};
            const request = {schemaVersion: 1, baseline: CURRENT_BASE, candidate: 'b'.repeat(40), sourceTree: 'c'.repeat(40),
                protocolBlob: PROTOCOL_BLOB, arm: 'A', sourceCommit: CURRENT_BASE, mode: 'hash-only', dictionary: 'jmdict',
                sourceManifestSha256: 'e'.repeat(64), packageSha256: 'f'.repeat(64), fixtureSha256: fixture.sha256,
                termFiles: TERM_FILES.jmdict, outputDirectory: path.join(temporary, corrupt ? 'bad' : 'good'),
                exporterSha256: hash(await readFile(new URL('./browser-layout-export.mjs', import.meta.url)))};
            await withFs(files, async () => {
                const page = {evaluate: async (fn, arg) => {
                    if (corrupt && fn === browserFinish) { files.set('unexpected.bin', Buffer.from('x')); }
                    return await fn(arg);
                }};
                const pending = exportBrowserTermLayout({page, request, validation, fixture, beforeProbes: probes, afterProbes: probes, importDebug: {}});
                if (corrupt) { await assert.rejects(pending, /Storage changed/); }
                else { const report = await pending; assert(report.complete); assert.equal(report.files.length, 3); assert.equal(report.files[0].chunks, 2); }
                const saved = JSON.parse(await readFile(path.join(request.outputDirectory, 'layout.json')));
                assert.equal(saved.complete, !corrupt); assert.equal(Boolean(saved.failure), corrupt);
                assert(!Object.prototype.hasOwnProperty.call(globalThis, '__manabitanAliasLayoutProofDa6c4'));
            });
        }
    } finally { await rm(temporary, {recursive: true, force: true}); }
});
