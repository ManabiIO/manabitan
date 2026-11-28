import assert from 'node:assert/strict';
import {stat} from 'node:fs/promises';
import {test} from 'node:test';
import {createBoundedNodeOpfs} from './node-opfs-bounded.mjs';

import {createNodeOpfs} from '../../fixtures/opfs-continuation/node-opfs-adapter.mjs';
const bytes = async (file) => [...new Uint8Array(await file.arrayBuffer())];

for (const [name, create] of [['existing', createNodeOpfs], ['bounded', createBoundedNodeOpfs]]) {
    test(`${name}: ordered writes, committed visibility, snapshots, abort`, async () => {
        const env = await create();
        try {
            const dir = await env.root.getDirectoryHandle('records', {create: true});
            const file = await dir.getFileHandle('a.bin', {create: true});
            assert.equal(typeof file.createSyncAccessHandle, 'undefined');
            assert.equal((await file.getFile()).size, 0);
            const first = await file.createWritable();
            await first.write('abc');
            await first.write(new Uint8Array([99, 100, 101, 99]).subarray(1, 3));
            await first.seek(1);
            await first.write({type: 'write', data: new Uint8Array([88]).buffer});
            await first.write({type: 'write', position: 7, data: new Blob(['z'])});
            assert.equal((await file.getFile()).size, 0);
            const entries = [];
            for await (const [entry] of dir.entries()) { entries.push(entry); }
            assert.deepEqual(entries, ['a.bin']);
            await first.close();
            const snapshot = await file.getFile();
            assert.deepEqual(await bytes(snapshot), [97, 88, 99, 100, 101, 0, 0, 122]);
            const second = await file.createWritable({keepExistingData: true});
            await second.truncate(3);
            await second.truncate(6);
            await second.seek(3);
            await second.write('xy');
            assert.deepEqual(await bytes(await file.getFile()), [97, 88, 99, 100, 101, 0, 0, 122]);
            await second.close();
            assert.deepEqual(await bytes(snapshot), [97, 88, 99, 100, 101, 0, 0, 122], 'Previously obtained snapshot must remain readable');
            assert.deepEqual(await bytes(await file.getFile()), [97, 88, 99, 120, 121, 0]);
            const discarded = await file.createWritable();
            await discarded.write('not published');
            await discarded.abort();
            assert.deepEqual(await bytes(await file.getFile()), [97, 88, 99, 120, 121, 0]);
            await assert.rejects(discarded.write('x'), {name: 'InvalidStateError'});
            await assert.rejects(file.createWritable().then(async (writer) => {
                try {
                    env.hooks.beforeWrite = () => { throw new Error('injected'); };
                    await writer.write('x');
                } finally {
                    env.hooks.beforeWrite = null;
                    await writer.abort();
                }
            }), /injected/);
            assert.deepEqual(await bytes(await file.getFile()), [97, 88, 99, 120, 121, 0]);
            await dir.removeEntry('a.bin');
            await assert.rejects(dir.getFileHandle('a.bin'), {name: 'NotFoundError'});
            await assert.rejects(file.getFile(), {name: 'NotFoundError'});
        } finally { await env.dispose(); }
        await assert.rejects(stat(env.rootPath), {code: 'ENOENT'});
    });
}

test('bounded: validates confined paths and closes abandoned writers', async () => {
    const env = await createBoundedNodeOpfs();
    for (const name of ['', '.', '..', '../outside', 'nested/file', 'nested\\file', 'bad\0name']) {
        await assert.rejects(env.root.getFileHandle(name, {create: true}), TypeError);
        await assert.rejects(env.root.getDirectoryHandle(name, {create: true}), TypeError);
        await assert.rejects(env.root.removeEntry(name), TypeError);
    }
    const file = await env.root.getFileHandle('open.bin', {create: true});
    const writer = await file.createWritable();
    await writer.write(new Uint8Array(1024));
    await env.dispose();
    await assert.rejects(stat(env.rootPath), {code: 'ENOENT'});
    await assert.rejects(writer.write('x'), {name: 'InvalidStateError'});
});

test('bounded: lazy slices and a large staged write retain exact data', async () => {
    const env = await createBoundedNodeOpfs();
    try {
        const file = await env.root.getFileHandle('large.bin', {create: true});
        const writer = await file.createWritable();
        const block = new Uint8Array(64 * 1024);
        for (let index = 0; index < 32; ++index) {
            block.fill(index);
            await writer.write(block);
        }
        await writer.close();
        const snapshot = await file.getFile();
        assert.equal(snapshot.size, block.length * 32);
        for (const index of [0, 1, 15, 31]) {
            assert((await bytes(snapshot.slice(index * block.length, index * block.length + 32))).every((value) => value === index));
        }
    } finally { await env.dispose(); }
});
