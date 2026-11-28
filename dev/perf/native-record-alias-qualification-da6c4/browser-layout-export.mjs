// SPDX-License-Identifier: GPL-3.0-or-later
// Research-only, post-endpoint OPFS proof. No extension product module is changed.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, open, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';

export const CHUNK_BYTES = 256 * 1024;
export const CURRENT_BASE = 'dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16';
export const PROTOCOL_BLOB = '7801b5fd696fffe4f250b98a19d6d80406518705';
export const TERM_FILES = Object.freeze({
    jmdict: [
        'manabitan-term-content.bin',
        'manabitan-term-records/dict-25|JMdict%20%5B2026-11-22%5Draw-block-v2%3Ajmdict.mbtr',
        'manabitan-term-records/dict-25|JMdict%20%5B2026-11-22%5Draw-block-v2%3Ajmdict.mbtr.mbti',
    ],
    jitendex: [
        'manabitan-term-content.bin',
        'manabitan-term-records/dict-31|Jitendex.org%20%5B2026-10-03%5Draw-block-v2%3Ajmdict.mbtr',
        'manabitan-term-records/dict-31|Jitendex.org%20%5B2026-10-03%5Draw-block-v2%3Ajmdict.mbtr.mbti',
    ],
    vndb: [
        'manabitan-term-content.bin',
        'manabitan-term-records/dict-28|VNDB%20Characters%20by%20Beeraw-block-v2.mbtr',
        'manabitan-term-records/dict-28|VNDB%20Characters%20by%20Beeraw-block-v2.mbtr.mbti',
        'manabitan-term-records/dict-28|VNDB%20Characters%20by%20Beeraw-v6.mbtr',
        'manabitan-term-records/dict-28|VNDB%20Characters%20by%20Beeraw-v6.mbtr.mbti',
    ],
});
const STATE_KEY = '__manabitanAliasLayoutProofDa6c4';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digestPattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const comparePath = (a, b) => a.path < b.path ? -1 : (a.path > b.path ? 1 : 0);

async function saveJson(filename, value) {
    await writeFile(filename + '.partial', JSON.stringify(value, null, 2) + '\n');
    await rename(filename + '.partial', filename);
}

export function canonicalPhysicalProbes(results) {
    assert(Array.isArray(results) && results.length === 12);
    return results.map(({term, probes}) => ({term, probes: probes.map((probe) => {
        const diagnostics = probe.diagnostics;
        const state = diagnostics?.offscreenState ?? diagnostics?.localState ?? diagnostics;
        const rows = Array.isArray(state?.rowSample) ? state.rowSample : [];
        return {term: probe.term, totalLength: probe.totalLength,
            rowSampleCount: probe.rowSampleCount, inBoundsRowCount: probe.inBoundsRowCount,
            outOfBoundsRowCount: probe.outOfBoundsRowCount, glossaryReadyRowCount: probe.glossaryReadyRowCount,
            readablePreviewRowCount: probe.readablePreviewRowCount,
            rowSample: rows.map((row) => ({rawEntryContentOffset: row.rawEntryContentOffset,
                rawEntryContentLength: row.rawEntryContentLength, glossaryLength: row.glossaryLength,
                rawContentPreview: row.rawContentPreview})),
        };
    })}));
}

export function probeReceipts(before, after, expectedDigest) {
    const a = canonicalPhysicalProbes(before), b = canonicalPhysicalProbes(after);
    const physical = (value) => sha256(JSON.stringify(value));
    assert.equal(physical(a), expectedDigest, 'Original pre-restart probe digest changed');
    assert.equal(physical(b), expectedDigest, 'Original post-restart probe digest changed');
    const logical = (rows) => rows.map(({term, probes}) => ({term, probes: probes.map(({totalLength: _length, rowSample, ...probe}) => ({
        ...probe, rowSample: rowSample.map(({rawEntryContentOffset: _offset, ...row}) => row),
    }))}));
    const logicalBefore = logical(a), logicalAfter = logical(b);
    assert.deepEqual(logicalBefore, logicalAfter);
    return {before, after, physicalBefore: a, physicalAfter: b,
        physicalOutputDigestSha256: expectedDigest, semanticProbeDigestSha256: physical(logicalBefore),
        semanticProjection: logicalBefore,
        semanticProjectionRemovedFields: ['probe.totalLength', 'probe.rowSample[].rawEntryContentOffset']};
}

// All browser functions are self-contained because Playwright serializes their source.
export async function browserBegin({key, files}) {
    if (Object.prototype.hasOwnProperty.call(globalThis, key)) { throw new Error('Layout proof already owns this page'); }
    const root = await navigator.storage.getDirectory();
    const inventory = [];
    const visit = async (directory, prefix) => {
        for await (const [name, handle] of directory.entries()) {
            const pathname = prefix + name;
            if (handle.kind === 'directory') { await visit(handle, pathname + '/'); }
            else { inventory.push({path: pathname, bytes: (await handle.getFile()).size}); }
        }
    };
    await visit(root, '');
    inventory.sort((a, b) => a.path < b.path ? -1 : (a.path > b.path ? 1 : 0));
    const selected = new Map();
    for (const pathname of files) {
        const parts = pathname.split('/');
        let directory = root;
        for (const part of parts.slice(0, -1)) { directory = await directory.getDirectoryHandle(part); }
        const handle = await directory.getFileHandle(parts.at(-1));
        const file = await handle.getFile();
        if (!Number.isSafeInteger(file.size) || file.size <= 0) { throw new Error('Invalid term file size'); }
        selected.set(pathname, {file, nextOffset: 0});
    }
    Object.defineProperty(globalThis, key, {configurable: true, value: {root, files: selected, worker: null, workerErrors: []}});
    return {inventory, selected: [...selected].map(([path, item]) => ({path, bytes: item.file.size}))};
}

export async function browserRead({key, path, offset, length, maxBytes}) {
    const state = globalThis[key], item = state?.files.get(path);
    if (!item || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset !== item.nextOffset ||
        length <= 0 || length > maxBytes || length !== Math.min(maxBytes, item.file.size - offset)) {
        throw new Error('Invalid, skipped or repeated layout range');
    }
    const bytes = new Uint8Array(await item.file.slice(offset, offset + length).arrayBuffer());
    if (bytes.length !== length) { throw new Error('Short layout snapshot read'); }
    const checksum = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    let binary = '';
    for (let at = 0; at < bytes.length; at += 16384) { binary += String.fromCharCode(...bytes.subarray(at, at + 16384)); }
    const base64 = btoa(binary);
    item.nextOffset += length;
    return {path, offset, length, size: item.file.size, base64,
        sha256: [...checksum].map((value) => value.toString(16).padStart(2, '0')).join('')};
}

export async function browserFinish({key}) {
    const state = globalThis[key];
    if (!state) { throw new Error('Missing layout owner'); }
    for (const item of state.files.values()) {
        if (item.nextOffset !== item.file.size) { throw new Error('Incomplete layout file'); }
    }
    if (state.worker !== null || state.workerErrors.length) { throw new Error('Layout worker did not retire cleanly'); }
    const inventory = [];
    const visit = async (directory, prefix) => {
        for await (const [name, handle] of directory.entries()) {
            const pathname = prefix + name;
            if (handle.kind === 'directory') { await visit(handle, pathname + '/'); }
            else { inventory.push({path: pathname, bytes: (await handle.getFile()).size}); }
        }
    };
    await visit(state.root, '');
    inventory.sort((a, b) => a.path < b.path ? -1 : (a.path > b.path ? 1 : 0));
    state.files.clear();
    delete globalThis[key];
    return inventory;
}

export async function acquireAndCloseTermHandles(files) {
    const root = await navigator.storage.getDirectory(), receipts = [];
    for (const pathname of files) {
        const parts = pathname.split('/');
        let directory = root;
        for (const part of parts.slice(0, -1)) { directory = await directory.getDirectoryHandle(part); }
        const handle = await directory.getFileHandle(parts.at(-1));
        // Default access is exclusive. No worker protocol 'open' request is sent;
        // that production operation would truncate a file and is prohibited here.
        const access = await handle.createSyncAccessHandle();
        let bytes;
        try { bytes = access.getSize(); } finally { access.close(); }
        receipts.push({path: pathname, bytes, exclusiveHandleClosed: true});
    }
    return receipts;
}

export async function proveNoTermWriterLeases(page, files) {
    const workerUrl = new URL('/js/dictionary/term-record-import-index-worker.js', page.url()).href;
    const observed = page.waitForEvent('worker', {predicate: (worker) => worker.url() === workerUrl, timeout: 45000});
    const ready = page.evaluate(({key, url}) => {
        const state = globalThis[key];
        if (!state || state.worker !== null) { throw new Error('Invalid layout worker admission'); }
        const worker = new Worker(url, {type: 'module'}); state.worker = worker;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { reject(new Error('Layout worker did not become ready')); }, 45000);
            worker.addEventListener('error', (event) => {
                state.workerErrors.push(String(event.message)); clearTimeout(timer); reject(new Error(String(event.message)));
            });
            worker.addEventListener('message', (event) => {
                if (event.data?.type === 'ready') { clearTimeout(timer); resolve(true); }
                else { state.workerErrors.push('Unexpected layout worker protocol message'); clearTimeout(timer); reject(new Error('Unexpected layout worker protocol message')); }
            });
        });
    }, {key: STATE_KEY, url: workerUrl});
    let worker, failure = null, receipts = null;
    try {
        const results = await Promise.allSettled([observed, ready]);
        if (results[0].status === 'fulfilled') { worker = results[0].value; }
        const failures = results.filter(({status}) => status === 'rejected').map(({reason}) => reason);
        if (failures.length) { throw new AggregateError(failures, 'Layout worker startup failed'); }
        receipts = await worker.evaluate(acquireAndCloseTermHandles, files);
    } catch (error) { failure = error; }
    let closeTimer;
    const closed = worker ? new Promise((resolve, reject) => {
        worker.once('close', resolve);
        closeTimer = setTimeout(() => { reject(new Error('Layout worker termination was not observed')); }, 45000);
    }) : Promise.resolve();
    try {
        // Observe both promises even if the terminate command itself fails.
        // A rejected command cannot make a still-owned worker disappear.
        const outcomes = await Promise.allSettled([page.evaluate((key) => {
            const state = globalThis[key];
            if (state?.worker) { state.worker.terminate(); state.worker = null; }
        }, STATE_KEY), closed]);
        const failures = outcomes.filter(({status}) => status === 'rejected').map(({reason}) => reason);
        if (failures.length) { throw new AggregateError(failures, 'Layout worker termination failed'); }
    } catch (error) { failure = failure ? new AggregateError([failure, error], 'Layout check and termination failed') : error; }
    finally { clearTimeout(closeTimer); }
    if (failure) { throw failure; }
    return receipts;
}

export function inspectHeader(pathname, prefix, totalBytes) {
    if (pathname.endsWith('.mbtr.mbti')) {
        assert(prefix.length >= 40 && totalBytes > 40, 'Incomplete index header');
        assert.equal(prefix.subarray(0, 8).toString('ascii'), 'MBTIDX11', 'Index header magic/version');
        const descriptorBytes = Number(prefix.readBigUInt64LE(8));
        assert(Number.isSafeInteger(descriptorBytes) && descriptorBytes >= 26);
        const chunkCount = prefix.readUInt32LE(16), rowCount = prefix.readUInt32LE(20);
        assert(chunkCount > 0 && rowCount > 0);
        return {kind: 'index', generationRange: [24, 40], generationId: prefix.subarray(24, 40).toString('hex'),
            descriptorBytes, chunkCount, rowCount};
    }
    if (pathname.endsWith('.mbtr')) {
        assert(prefix.length >= 26 && totalBytes >= 26, 'Incomplete record descriptor');
        assert.equal(prefix.subarray(0, 8).toString('ascii'), 'MBTRD16X', 'Record header magic/version');
        return {kind: 'descriptor', generationRange: [8, 24], generationId: prefix.subarray(8, 24).toString('hex')};
    }
    assert.equal(pathname, 'manabitan-term-content.bin');
    return {kind: 'content', generationRange: null, generationId: null};
}

export function normalizedChunk(bytes, offset, header) {
    if (header.generationRange === null) { return bytes; }
    const [start, end] = header.generationRange;
    const left = Math.max(0, start - offset), right = Math.min(bytes.length, end - offset);
    if (left >= right) { return bytes; }
    const copy = Buffer.from(bytes); copy.fill(0, left, right); return copy;
}

export function validateHeaderLinks(files, expectedRows) {
    const byPath = new Map(files.map((file) => [file.path, file]));
    assert.equal(byPath.size, files.length);
    let rows = 0, pairs = 0;
    for (const file of files) {
        if (file.header.kind === 'descriptor') { assert(byPath.has(file.path + '.mbti'), 'Missing matching index'); }
        if (file.header.kind !== 'index') { continue; }
        const descriptor = byPath.get(file.path.slice(0, -5)); assert(descriptor);
        assert.equal(descriptor.header.kind, 'descriptor');
        assert.equal(file.header.generationId, descriptor.header.generationId, 'Descriptor/index generation mismatch');
        assert.equal(file.header.descriptorBytes, descriptor.bytes, 'Sidecar descriptor-length mismatch');
        rows += file.header.rowCount; ++pairs;
    }
    assert(pairs > 0); assert.equal(rows, expectedRows, 'Index headers do not cover all fixture rows');
    return {pairs, rows, normalization: 'Only descriptor[8,24) and index[24,40), after magic/version/length/generation linkage validation'};
}

export function checkChunkReceipt(receipt, expected) {
    for (const key of ['path', 'offset', 'length', 'size']) { assert.equal(receipt[key], expected[key], 'Changed range ' + key); }
    assert.equal(typeof receipt.base64, 'string'); assert(digestPattern.test(receipt.sha256));
    const bytes = Buffer.from(receipt.base64, 'base64');
    assert.equal(bytes.length, expected.length); assert.equal(bytes.toString('base64'), receipt.base64, 'Noncanonical base64 range');
    assert.equal(sha256(bytes), receipt.sha256, 'Browser/Node range digest mismatch');
    return bytes;
}

export async function exportBrowserTermLayout({page, request, validation, fixture, beforeProbes, afterProbes, importDebug}) {
    assert.equal(request.schemaVersion, 1); assert.equal(request.baseline, CURRENT_BASE); assert.equal(request.protocolBlob, PROTOCOL_BLOB);
    assert(['A', 'B', 'C'].includes(request.arm)); assert(['export', 'hash-only'].includes(request.mode));
    assert(commitPattern.test(request.candidate)); assert(commitPattern.test(request.sourceTree));
    assert.equal(request.sourceCommit, request.arm === 'B' ? request.candidate : request.baseline);
    assert(digestPattern.test(request.sourceManifestSha256)); assert(digestPattern.test(request.packageSha256));
    assert.equal(request.exporterSha256, sha256(await readFile(new URL(import.meta.url))));
    const expectedFiles = TERM_FILES[request.dictionary]; assert(expectedFiles);
    assert.deepEqual(request.termFiles, expectedFiles); assert.equal(request.fixtureSha256, fixture.sha256);
    assert.equal(validation.termRows, fixture.termRows); assert.equal(validation.title, fixture.expectedTitle);
    const output = path.resolve(request.outputDirectory); assert.equal(output, request.outputDirectory);
    await mkdir(output, {recursive: false});
    const reportPath = path.join(output, 'layout.json');
    const report = {schemaVersion: 1, complete: false, request, authoritativeTiming: false,
        scope: 'Read-only post-endpoint full term-file hashes; no performance observation. Export mode alone retains file bytes.',
        validation, fixture, importDebug, files: [], cleanupFailures: [], failure: null};
    let failure = null;
    try {
        report.probes = probeReceipts(beforeProbes, afterProbes, validation.outputDigestSha256);
        await saveJson(reportPath, report);
        const before = await page.evaluate(browserBegin, {key: STATE_KEY, files: expectedFiles});
        report.beforeInventory = before.inventory;
        assert.deepEqual(before.inventory, [...validation.storage.files].sort(comparePath), 'Storage changed before layout snapshot');
        assert.deepEqual(before.selected.map(({path}) => path), expectedFiles);
        for (const item of before.selected) {
            const expectedSize = validation.storage.files.find(({path}) => path === item.path)?.bytes;
            assert.equal(item.bytes, expectedSize);
            const rawHash = createHash('sha256'), normalizedHash = createHash('sha256');
            let offset = 0, chunks = 0, header = null, destination = null;
            if (request.mode === 'export') {
                const filename = path.join(output, 'opfs', item.path);
                await mkdir(path.dirname(filename), {recursive: true}); destination = await open(filename, 'wx', 0o600);
            }
            try {
                while (offset < item.bytes) {
                    const length = Math.min(CHUNK_BYTES, item.bytes - offset);
                    const received = await page.evaluate(browserRead, {key: STATE_KEY, path: item.path, offset, length, maxBytes: CHUNK_BYTES});
                    const bytes = checkChunkReceipt(received, {path: item.path, offset, length, size: item.bytes});
                    if (offset === 0) { header = inspectHeader(item.path, bytes, item.bytes); }
                    rawHash.update(bytes); normalizedHash.update(normalizedChunk(bytes, offset, header));
                    if (destination !== null) {
                        let written = 0;
                        while (written < bytes.length) {
                            const result = await destination.write(bytes, written, bytes.length - written, offset + written);
                            assert(result.bytesWritten > 0); written += result.bytesWritten;
                        }
                    }
                    offset += bytes.length; ++chunks;
                }
                if (destination !== null) { await destination.sync(); }
            } finally { await destination?.close(); }
            report.files.push({path: item.path, bytes: offset, sha256: rawHash.digest('hex'), normalizedSha256: normalizedHash.digest('hex'), header, chunks});
            await saveJson(reportPath, report);
        }
        report.headerLinkage = validateHeaderLinks(report.files, fixture.termRows);
        if (request.mode === 'export') {
            report.exclusiveTermHandles = await proveNoTermWriterLeases(page, expectedFiles);
            assert.deepEqual(report.exclusiveTermHandles.map(({path, bytes}) => ({path, bytes})), before.selected);
            assert(report.exclusiveTermHandles.every(({exclusiveHandleClosed}) => exclusiveHandleClosed === true));
        }
        report.afterInventory = await page.evaluate(browserFinish, {key: STATE_KEY});
        assert.deepEqual(report.afterInventory, report.beforeInventory, 'Storage changed during read-only layout proof');
        assert.equal(request.exporterSha256, sha256(await readFile(new URL(import.meta.url))), 'Exporter changed during observation');
        report.complete = true;
    } catch (error) { failure = error; report.failure = {message: String(error), stack: error?.stack ?? null}; }
    finally {
        try {
            await page.evaluate((key) => { const state = globalThis[key]; if (state?.worker) { state.worker.terminate(); } delete globalThis[key]; }, STATE_KEY);
        } catch (error) { report.cleanupFailures.push(String(error)); report.complete = false; }
        await saveJson(reportPath, report);
    }
    if (failure) { throw failure; }
    assert(report.complete, 'Layout proof cleanup failed');
    console.log(JSON.stringify({kind: 'native-alias-post-endpoint-layout', complete: true, arm: request.arm, mode: request.mode,
        dictionary: request.dictionary, sourceCommit: request.sourceCommit, protocolBlob: request.protocolBlob,
        physicalOutputDigestSha256: report.probes.physicalOutputDigestSha256, semanticProbeDigestSha256: report.probes.semanticProbeDigestSha256,
        files: report.files, headerLinkage: report.headerLinkage}));
    return report;
}

export async function exportBrowserTermLayoutFromHarness(context) {
    const filename = process.env.MANABITAN_ALIAS_LAYOUT_REQUEST;
    assert(typeof filename === 'string' && path.isAbsolute(filename), 'Missing frozen layout request');
    const request = JSON.parse(await readFile(filename));
    return await exportBrowserTermLayout({...context, request});
}
