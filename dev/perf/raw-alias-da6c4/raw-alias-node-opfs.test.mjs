// Deterministic real-file gates. Run before any component timing:
// node node-opfs-adapter.test.mjs /absolute/path/node-opfs-adapter.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {File, Blob} from 'node:buffer';
import {readFile, writeFile, rm, symlink} from 'node:fs/promises';
import {Worker} from 'node:worker_threads';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

assert.equal(process.argv.length, 3);
const adapterUrl = pathToFileURL(path.resolve(process.argv[2])).href;
const {createNodeOpfs, describeFileHandle, reviveFileHandle, getNodeOpfsOperations, assertNodeOpfsQuiescent} = await import(adapterUrl);
const results = [];
async function run(name, callback) {
    let passed = false;
    await test(name, {timeout: 10000}, async () => { await callback(); passed = true; });
    results.push({name, passed});
}
async function withFs(callback) {
    const filesystem = await createNodeOpfs();
    try { await callback(filesystem); } finally { await filesystem.dispose(); }
}
async function seed(filesystem, name, content) {
    const handle = await filesystem.root.getFileHandle(name, {create: true});
    await writeFile(path.join(filesystem.rootPath, name), content);
    return handle;
}
const array = async (file) => [...new Uint8Array(await file.arrayBuffer())];

await run('getFile and slice metadata are lazy and preserve native File/Blob identities', async () => withFs(async (filesystem) => {
    const content = Uint8Array.from({length: 256 * 1024}, (_, index) => index & 255);
    const handle = await seed(filesystem, 'source.bin', content);
    const file = await handle.getFile();
    assert(file instanceof File);
    assert(file instanceof globalThis.File);
    assert.equal(file.size, content.length);
    assert.equal(file.name, 'source.bin');
    const slice = file.slice(1000, 1017);
    assert(slice instanceof Blob);
    assert.equal(slice.size, 17);
    assert.equal(filesystem.operations.filter((entry) => entry.type === 'logical-read').length, 0);
    assert.equal(filesystem.operations.filter((entry) => entry.type === 'read-call').length, 0);
    assert.deepEqual(await array(slice), [...content.subarray(1000, 1017)]);
    const reads = filesystem.operations.filter((entry) => entry.type === 'read-call');
    assert.equal(reads.reduce((sum, entry) => sum + entry.bytes, 0), 17);
    assert.equal(reads[0].offset, 1000);
}));

await run('lazy slices retain Blob range normalization and nested offsets', async () => withFs(async (filesystem) => {
    const file = await (await seed(filesystem, 'ranges', Uint8Array.from([0, 1, 2, 3, 4, 5]))).getFile();
    const cases = [
        [0, 2, [0, 1]], [-2, undefined, [4, 5]], [-100, 100, [0, 1, 2, 3, 4, 5]],
        [4, 2, []], [NaN, 2.9, [0, 1]], [Infinity, Infinity, []], [-Infinity, 2, [0, 1]],
    ];
    for (const [start, end, expected] of cases) { assert.deepEqual(await array(file.slice(start, end)), expected); }
    assert.deepEqual(await array(file.slice(1, 5).slice(1, 3)), [2, 3]);
    assert.equal(file.slice(0, 1, 'TEXT/PLAIN').type, 'text/plain');
    assert.equal(file.slice(0, 1, 'bad\nvalue').type, '');
}));

await run('empty slices issue no payload reads', async () => withFs(async (filesystem) => {
    const file = await (await seed(filesystem, 'empty-read', Uint8Array.of(1))).getFile();
    const first = filesystem.operations.length;
    assert.deepEqual(await array(file.slice(9, 10)), []);
    assert.equal(filesystem.operations.slice(first).filter((entry) => entry.type === 'read-call').length, 0);
}));

await run('writable commit is staged and invalidates old File snapshots only after close', async () => withFs(async (filesystem) => {
    const handle = await seed(filesystem, 'commit', Uint8Array.of(1, 2, 3));
    const old = await handle.getFile();
    const writable = await handle.createWritable();
    await writable.write(Uint8Array.of(9, 8));
    assert.deepEqual(await array(old), [1, 2, 3]);
    await writable.close();
    await assert.rejects(old.arrayBuffer(), {name: 'NotReadableError'});
    assert.deepEqual(await array(await handle.getFile()), [9, 8]);
    assert.equal(filesystem.openResourceCount, 0);
    assert(filesystem.operations.some((entry) => entry.type === 'writable-flush'));
    assert(filesystem.operations.some((entry) => entry.type === 'writable-commit'));
}));

await run('keepExistingData writes and seeks preserve prefix bytes and file holes', async () => withFs(async (filesystem) => {
    const handle = await seed(filesystem, 'keep', Uint8Array.of(1, 2, 3, 4));
    const writable = await handle.createWritable({keepExistingData: true});
    await writable.seek(2);
    await writable.write(Uint8Array.of(9));
    await writable.write({type: 'write', position: 6, data: Uint8Array.of(8)});
    await writable.close();
    assert.deepEqual(await array(await handle.getFile()), [1, 2, 9, 4, 0, 0, 8]);
    assert.equal(filesystem.operations.filter((entry) => entry.type === 'staging-copy').length, 1);
}));

await run('truncate clamps the writable cursor and preserves sequential write order', async () => withFs(async (filesystem) => {
    const handle = await seed(filesystem, 'truncate', Uint8Array.of(1, 2, 3, 4));
    const writable = await handle.createWritable({keepExistingData: true});
    await writable.seek(4);
    await writable.truncate(2);
    await writable.write(Uint8Array.of(9));
    await writable.close();
    assert.deepEqual(await array(await handle.getFile()), [1, 2, 9]);
}));

await run('abort preserves the original file and releases writer ownership', async () => withFs(async (filesystem) => {
    const handle = await seed(filesystem, 'abort', Uint8Array.of(4, 5));
    const writable = await handle.createWritable();
    await writable.write(Uint8Array.of(9));
    await writable.abort();
    await writable.close();
    assert.deepEqual(await array(await handle.getFile()), [4, 5]);
    assert.equal(filesystem.openResourceCount, 0);
    const next = await handle.createWritable();
    await next.abort();
}));

await run('unawaited write and seek calls remain ordered', async () => withFs(async (filesystem) => {
    const handle = await seed(filesystem, 'queue', new Uint8Array(0));
    const writable = await handle.createWritable();
    await Promise.all([writable.write(Uint8Array.of(1, 2)), writable.seek(1), writable.write(Uint8Array.of(9))]);
    await writable.close();
    assert.deepEqual(await array(await handle.getFile()), [1, 9]);
}));

await run('exclusive ownership covers distinct handles and removal', async () => withFs(async (filesystem) => {
    const one = await seed(filesystem, 'locked', Uint8Array.of(1));
    const two = await filesystem.root.getFileHandle('locked');
    const writable = await one.createWritable({keepExistingData: true});
    await assert.rejects(two.createWritable(), {name: 'NoModificationAllowedError'});
    await assert.rejects(two.createSyncAccessHandle(), {name: 'NoModificationAllowedError'});
    await assert.rejects(filesystem.root.removeEntry('locked'), {name: 'NoModificationAllowedError'});
    await writable.close();
    const access = await two.createSyncAccessHandle();
    access.close();
    await filesystem.root.removeEntry('locked');
    await assert.rejects(one.getFile(), {name: 'NotFoundError'});
}));

await run('synchronous handles preserve typed-view offsets, explicit positions and fsync', async () => withFs(async (filesystem) => {
    const handle = await seed(filesystem, 'sync', Uint8Array.of(0, 0, 0));
    const access = await handle.createSyncAccessHandle();
    assert.equal(access.write(Uint8Array.of(99, 7, 8, 99).subarray(1, 3), {at: 3}), 2);
    assert.equal(access.getSize(), 5);
    const target = new Uint8Array(6).fill(99);
    assert.equal(access.read(new DataView(target.buffer, 2, 2), {at: 3}), 2);
    assert.deepEqual([...target], [99, 99, 7, 8, 99, 99]);
    access.truncate(4);
    access.flush();
    access.close();
    access.close();
    assert.deepEqual(await array(await handle.getFile()), [0, 0, 0, 7]);
    assert.throws(() => access.write(Uint8Array.of(1)), {name: 'InvalidStateError'});
    assert.equal(filesystem.operations.filter((entry) => entry.type === 'sync-flush').length, 1);
}));

await run('revived file handles share path locks and have independently retained receipts', async () => withFs(async (filesystem) => {
    const handle = await seed(filesystem, 'revive', Uint8Array.of(2, 3));
    const operations = [];
    const revived = await reviveFileHandle(describeFileHandle(handle), {operations});
    const access = await handle.createSyncAccessHandle();
    await assert.rejects(revived.createSyncAccessHandle(), {name: 'NoModificationAllowedError'});
    access.close();
    const next = await revived.createSyncAccessHandle();
    assert.equal(filesystem.openResourceCount, 0);
    await assert.rejects(assertNodeOpfsQuiescent(filesystem), (cause) => (
        cause.receipt?.parentOpenResources === 0 && cause.receipt.lockEntries.length === 1
    ));
    next.write(Uint8Array.of(8), {at: 1});
    next.flush();
    next.close();
    assert.deepEqual(await array(await handle.getFile()), [2, 8]);
    assert.equal(getNodeOpfsOperations(revived), operations);
    assert.equal(operations.filter((entry) => entry.type === 'sync-write-call').length, 1);
}));

async function workerAttempt(descriptor) {
    const code = [
        "const {parentPort, workerData} = require('node:worker_threads');",
        "(async () => {",
        " const {reviveFileHandle} = await import(workerData.adapterUrl);",
        " const operations = [];",
        " const handle = await reviveFileHandle(workerData.descriptor, {operations});",
        " try { const access = await handle.createSyncAccessHandle(); access.write(Uint8Array.of(7), {at: 0}); access.flush(); access.close(); parentPort.postMessage({opened:true,operations}); }",
        " catch (error) { parentPort.postMessage({opened:false,name:error.name,message:String(error)}); }",
        "})().catch(error => { parentPort.postMessage({fatal:String(error.stack || error)}); process.exitCode=1; });",
    ].join('\n');
    const worker = new Worker(code, {eval: true, workerData: {adapterUrl, descriptor}});
    let timer;
    try {
        return await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Adapter worker test timed out')), 5000);
            worker.once('message', resolve);
            worker.once('error', reject);
            worker.once('exit', (code) => { if (code !== 0) { reject(new Error('Adapter worker exited: ' + code)); } });
        });
    } finally {
        clearTimeout(timer);
        await worker.terminate();
    }
}
await run('exclusive synchronous ownership is enforced across real Node workers', async () => withFs(async (filesystem) => {
    const handle = await seed(filesystem, 'cross-worker', Uint8Array.of(1, 2));
    const access = await handle.createSyncAccessHandle();
    const blocked = await workerAttempt(describeFileHandle(handle));
    assert.equal(blocked.opened, false);
    assert.equal(blocked.name, 'NoModificationAllowedError');
    access.close();
    const allowed = await workerAttempt(describeFileHandle(handle));
    assert.equal(allowed.opened, true);
    assert.equal(allowed.operations.filter((entry) => entry.type === 'sync-flush').length, 1);
    assert.deepEqual(await array(await handle.getFile()), [7, 2]);
}));

await run('directories, names and missing entries follow bounded handle rules', async () => withFs(async (filesystem) => {
    const child = await filesystem.root.getDirectoryHandle('sub', {create: true});
    const file = await child.getFileHandle('entry', {create: true});
    assert.deepEqual(await filesystem.root.resolve(file), ['sub', 'entry']);
    assert.deepEqual(await child.resolve(child), []);
    assert.deepEqual([...await (async () => { const a = []; for await (const [name] of child.entries()) { a.push(name); } return a; })()], ['entry']);
    for (const name of ['', '.', '..', 'a/b', 'a\\b', '\0']) {
        await assert.rejects(filesystem.root.getFileHandle(name, {create: true}), TypeError);
    }
    await assert.rejects(filesystem.root.removeEntry('missing'), {name: 'NotFoundError'});
    await child.removeEntry('entry');
    await filesystem.root.removeEntry('sub');
}));

await run('descriptors reject escaping paths and symbolic-link ancestors', async () => withFs(async (filesystem) => {
    const handle = await seed(filesystem, 'safe', Uint8Array.of(1));
    const descriptor = describeFileHandle(handle);
    await assert.rejects(reviveFileHandle({...descriptor, path: path.join(filesystem.rootPath, '..', 'outside')}), TypeError);
    await assert.rejects(reviveFileHandle({...descriptor, path: 'relative'}), TypeError);
    await symlink(filesystem.rootPath, path.join(filesystem.rootPath, 'link'));
    await assert.rejects(filesystem.root.getFileHandle('link'), {name: 'TypeMismatchError'});
    await assert.rejects(reviveFileHandle({...descriptor, path: path.join(filesystem.rootPath, 'link', 'safe')}), {name: 'TypeMismatchError'});
}));

await run('lazy text and stream reads reproduce the full file bytes', async () => withFs(async (filesystem) => {
    const value = 'dictionary α 日本語';
    const handle = await seed(filesystem, 'text', new TextEncoder().encode(value));
    const file = await handle.getFile();
    assert.equal(await file.text(), value);
    const chunks = [];
    for await (const chunk of file.stream()) { chunks.push(chunk); }
    assert.equal(new TextDecoder().decode(Buffer.concat(chunks)), value);
    assert.doesNotThrow(() => JSON.stringify(filesystem.operations));
}));

await run('failed writes preserve original contents and release all resources on close', async () => withFs(async (filesystem) => {
    const handle = await seed(filesystem, 'failure', Uint8Array.of(6, 5));
    const writable = await handle.createWritable();
    await assert.rejects(writable.write({type: 'unknown'}), TypeError);
    await assert.rejects(writable.close(), TypeError);
    assert.equal(filesystem.openResourceCount, 0);
    assert.deepEqual(await array(await handle.getFile()), [6, 5]);
    const access = await handle.createSyncAccessHandle();
    access.close();
    await assert.rejects(writable.write(Uint8Array.of(1)), {name: 'InvalidStateError'});
}));

await run('dispose aborts uncommitted writers while preserving explicitly retained files', async () => {
    const filesystem = await createNodeOpfs();
    try {
        const handle = await seed(filesystem, 'dispose', Uint8Array.of(3));
        const writable = await handle.createWritable();
        await writable.write(Uint8Array.of(9));
        await filesystem.dispose({remove: false});
        assert.deepEqual([...await readFile(path.join(filesystem.rootPath, 'dispose'))], [3]);
        assert.equal(filesystem.openResourceCount, 0);
    } finally {
        await filesystem.dispose();
        await rm(filesystem.rootPath, {recursive: true, force: true});
    }
});


await run('quiescence refuses parent leases and orphan lock or staging files without mutating them', async () => withFs(async (filesystem) => {
    const handle = await seed(filesystem, 'quiescence', Uint8Array.of(1));
    const initial = await assertNodeOpfsQuiescent(filesystem);
    assert.equal(initial.parentOpenResources, 0);
    const writable = await handle.createWritable();
    await assert.rejects(assertNodeOpfsQuiescent(filesystem), (cause) => (
        cause.receipt?.parentOpenResources === 1 &&
        cause.receipt.lockEntries.length === 1 && cause.receipt.stagingEntries.length === 1
    ));
    await writable.abort();
    const quiet = await assertNodeOpfsQuiescent(filesystem);
    const orphanStaging = path.join(quiet.stagingDirectory, 'orphan.write');
    const orphanLock = path.join(quiet.lockDirectory, 'orphan.lock');
    try {
        await writeFile(orphanStaging, Uint8Array.of(9));
        await assert.rejects(assertNodeOpfsQuiescent(filesystem), (cause) => cause.receipt?.stagingEntries.includes('orphan.write'));
        assert.deepEqual([...await readFile(orphanStaging)], [9]);
        await rm(orphanStaging);
        await writeFile(orphanLock, '{}');
        await assert.rejects(assertNodeOpfsQuiescent(filesystem), (cause) => cause.receipt?.lockEntries.includes('orphan.lock'));
        assert.equal(await readFile(orphanLock, 'utf8'), '{}');
    } finally {
        await rm(orphanStaging, {force: true});
        await rm(orphanLock, {force: true});
    }
    await assertNodeOpfsQuiescent(filesystem);
}));

assert(results.every(({passed}) => passed), 'At least one adapter test failed');
console.log('NODE_OPFS_ADAPTER_TEST_RESULT ' + JSON.stringify({
    complete: true,
    scope: 'Deterministic real Node file/worker adapter correctness only; no corpus or performance result.',
    adapterUrl, tests: results,
    receiptMeaning: 'read-call/write-call counters are observed Node API invocations, not measured kernel syscall counts.',
}));
