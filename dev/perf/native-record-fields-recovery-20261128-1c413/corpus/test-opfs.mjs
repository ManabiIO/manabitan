/* SPDX-License-Identifier: GPL-3.0-or-later */
// Actual disk I/O smoke for the NEW correctness-only adapter, never a timing test.
import assert from 'node:assert/strict'
import {File} from 'node:buffer'
import {mkdir, readdir, symlink, writeFile} from 'node:fs/promises'
import {join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createDiskOpfs, exportFileHandle, importFileHandle, installDiskOpfs} from './node-opfs-disk.mjs'
import {installFileRuntime, installWorkers} from './node-runtime.mjs'

const [repositoryArgument, outputArgument] = process.argv.slice(2)
if (!repositoryArgument || !outputArgument) throw new Error('Usage: node test-opfs.mjs REPOSITORY FRESH_OUTPUT')
const repository = resolve(repositoryArgument)
const output = resolve(outputArgument)
await mkdir(output, {recursive: false})
const passed = []
const check = async (label, callback) => { await callback(); passed.push(label) }
let adapter
try {
    adapter = await createDiskOpfs(join(output, 'disk'))
    installDiskOpfs(adapter)
    const root = adapter.root
    const directory = await root.getDirectoryHandle('test', {create: true})
    const file = await directory.getFileHandle('bytes', {create: true})
    const read = async () => [...new Uint8Array(await (await file.getFile()).arrayBuffer())]
    await check('exact BufferSource view and commit visibility', async () => {
        const writer = await file.createWritable()
        const backing = new Uint8Array([99, 1, 2, 3, 99])
        await writer.write(new DataView(backing.buffer, 1, 3))
        assert.deepEqual(await read(), [])
        await writer.close()
        assert.deepEqual(await read(), [1, 2, 3])
        const snapshot = await file.getFile()
        assert.ok(snapshot instanceof File)
        assert.deepEqual([...new Uint8Array(await snapshot.slice(1, 3).arrayBuffer())], [2, 3])
        await assert.rejects(writer.write(new Uint8Array([4])), {name: 'InvalidStateError'})
    })
    await check('keepExistingData, seek, positioned write and truncate', async () => {
        const writer = await file.createWritable({keepExistingData: true})
        await writer.seek(1)
        await writer.write(new Uint8Array([8]))
        await writer.write({type: 'write', position: 5, data: new Uint8Array([9])})
        await writer.truncate(7)
        await writer.close()
        assert.deepEqual(await read(), [1, 8, 3, 0, 0, 9, 0])
    })
    await check('abort preserves previously committed bytes', async () => {
        const writer = await file.createWritable()
        await writer.write(new Blob([new Uint8Array([4, 5, 6])]))
        await writer.abort()
        assert.deepEqual(await read(), [1, 8, 3, 0, 0, 9, 0])
        assert.deepEqual(await readdir(adapter.context.staging), [])
    })
    await check('BufferSource is snapshotted when write is requested', async () => {
        const writer = await file.createWritable()
        const input = new Uint8Array([4, 5, 6])
        const writing = writer.write(input)
        input.fill(99)
        await writing
        await writer.close()
        assert.deepEqual(await read(), [4, 5, 6])
    })
    await check('queued command properties are snapshotted', async () => {
        const writer = await file.createWritable()
        const command = {type: 'write', position: 1, data: new Uint8Array([7, 8])}
        const writing = writer.write(command)
        command.type = 'truncate'
        command.position = 99
        command.size = 200
        command.data.fill(66)
        await writing
        const truncate = {type: 'truncate', size: 2}
        const truncating = writer.write(truncate)
        truncate.size = 100
        await truncating
        await writer.close()
        assert.deepEqual(await read(), [0, 7])
        const restore = await file.createWritable()
        await restore.write(new Uint8Array([4, 5, 6]))
        await restore.close()
    })
    await check('sync access exact offsets, seek cursor, flush and close', async () => {
        const sync = await file.createSyncAccessHandle()
        assert.equal(sync.getSize(), 3)
        const source = new Uint8Array([80, 10, 11, 80])
        assert.equal(sync.write(source.subarray(1, 3), {at: 1}), 2)
        const target = new Uint8Array(7).fill(77)
        assert.equal(sync.read(new DataView(target.buffer, 2, 3), {at: 0}), 3)
        assert.deepEqual([...target], [77, 77, 4, 10, 11, 77, 77])
        sync.truncate(2)
        assert.equal(sync.write(new Uint8Array([12])), 1)
        sync.flush()
        assert.equal(sync.getSize(), 3)
        sync.close()
        sync.close()
        assert.throws(() => sync.getSize(), {name: 'InvalidStateError'})
        assert.deepEqual(await read(), [4, 10, 12])
    })
    await check('adapter writer exclusion and locked directory deletion', async () => {
        const sync = await file.createSyncAccessHandle()
        await assert.rejects(file.createWritable(), {name: 'NoModificationAllowedError'})
        await assert.rejects(file.createSyncAccessHandle(), {name: 'NoModificationAllowedError'})
        await assert.rejects(root.removeEntry('test', {recursive: true}), {name: 'NoModificationAllowedError'})
        sync.close()
        const writer = await file.createWritable({keepExistingData: true})
        await assert.rejects(file.createSyncAccessHandle(), {name: 'NoModificationAllowedError'})
        await writer.abort()
    })
    await check('directories, missing entries, kinds and resolution', async () => {
        assert.deepEqual(await root.resolve(file), ['test', 'bytes'])
        assert.deepEqual(await directory.resolve(directory), [])
        assert.equal(await directory.resolve(root), null)
        assert.equal(await file.isSameEntry(await directory.getFileHandle('bytes')), true)
        const keys = []
        for await (const key of directory.keys()) keys.push(key)
        assert.deepEqual(keys, ['bytes'])
        await assert.rejects(root.getFileHandle('test'), {name: 'TypeMismatchError'})
        await assert.rejects(directory.getFileHandle('missing'), {name: 'NotFoundError'})
        await assert.rejects(root.removeEntry('test'), {name: 'InvalidModificationError'})
        for (const invalid of ['', '.', '..', 'x/y', 'x\\y', '\0']) {
            await assert.rejects(directory.getFileHandle(invalid, {create: true}), TypeError)
        }
    })
    await check('file tokens stay within the exact adapter and reject symlinks', async () => {
        const token = exportFileHandle(file)
        const imported = importFileHandle(token, adapter.state)
        const locked = await file.createSyncAccessHandle()
        await assert.rejects(imported.createSyncAccessHandle(), {name: 'NoModificationAllowedError'})
        await assert.rejects(importFileHandle(token, adapter.state).createWritable(), {name: 'NoModificationAllowedError'})
        locked.close()
        assert.deepEqual([...new Uint8Array(await (await imported.getFile()).arrayBuffer())], [4, 10, 12])
        assert.throws(() => importFileHandle({...token, relativePath: '../escape'}, adapter.state))
        assert.throws(() => importFileHandle({...token, root: '/tmp'}, adapter.state))
        await symlink(file._path, join(directory._path, 'link'))
        await assert.rejects(directory.getFileHandle('link'), {name: 'SecurityError'})
        assert.throws(() => importFileHandle({...token, relativePath: 'test/link'}, adapter.state))
    })
    await check('unchanged production index worker and real transferred buffers', async () => {
        await installFileRuntime(repository)
        const workers = installWorkers(repository, adapter.state)
        let client
        try {
            const module = await import(pathToFileURL(join(repository, 'ext/js/dictionary/term-record-import-index-worker-client.js')).href)
            client = await module.createImportIndexWorkerClient()
            assert.ok(client, 'The real index worker must start')
            const indexFile = await directory.getFileHandle('index', {create: true})
            const writer = await client.open(indexFile)
            assert.ok(writer, 'The disk sync handle must be supported')
            await writer.writeChunks([new Uint8Array([1, 2, 3, 4])])
            await writer.seek(1)
            await writer.writeChunks([new Uint8Array([7, 8])])
            await writer.truncate(3)
            await writer.close()
            assert.deepEqual([...new Uint8Array(await (await indexFile.getFile()).arrayBuffer())], [1, 7, 8])
            assert.equal(workers.receipts.length, 1)
            assert.equal(workers.receipts[0].ready, 1)
            assert.deepEqual(workers.receipts[0].failures, [])
            assert.equal(workers.receipts[0].indexActions.open, 1)
            assert.equal(workers.receipts[0].indexActions.close, 1)
        } finally {
            client?.dispose()
            await workers.close()
        }
    })
    await check('generation media actual stage, select, read and rollback', async () => {
        const media = await import(pathToFileURL(join(repository, 'ext/js/dictionary/dictionary-generation-media-store.js')).href)
        assert.equal(media.DictionaryGenerationMediaStore.supportsWrite(), true)
        const store = new media.DictionaryGenerationMediaStore()
        const payloads = [new Uint8Array([1, 2, 3]), new Uint8Array([4]), new Uint8Array([5, 6]), new Uint8Array([7, 8, 9, 10])]
        let offset = 0
        const records = payloads.map((bytes, i) => {
            const row = {path: 'images/' + (i + 1) + '.png', packedOffset: offset, packedLength: bytes.length,
                compressionMethod: 0, uncompressedLength: bytes.length,
                signature: media.computeGenerationMediaCrc(bytes, 0, bytes.length)}
            offset += bytes.length
            return row
        })
        const plan = media.createGenerationMediaIndex(records, offset)
        assert.ok(plan)
        const generation = '00000000-0000-4000-8000-000000000001'
        const staged = store.stage(generation, new Blob(payloads), plan)
        assert.equal(typeof staged.select(plan), 'string')
        await staged.promise
        await store.inspect(generation, plan.descriptor)
        for (let i = 0; i < payloads.length; ++i) {
            const result = await store.read(generation, plan.descriptor, records[i].path)
            assert.ok(result)
            assert.deepEqual(new Uint8Array(result.content), payloads[i])
            assert.equal(result.signature, records[i].signature)
        }
        assert.equal(await store.read(generation, plan.descriptor, 'images/9.png'), null)
        await store.remove(generation)
        await assert.rejects(store.inspect(generation, plan.descriptor))
        const cancelledId = '00000000-0000-4000-8000-000000000002'
        const cancelled = store.stage(cancelledId, new Blob(payloads), plan)
        cancelled.cancel()
        await cancelled.promise
        await store.remove(cancelledId)
        await store.reset()
    })
    assert.deepEqual(await readdir(adapter.context.staging), [])
    await writeFile(join(output, 'report.json'), JSON.stringify({
        schema: 1, passed: true, newReconstructedAdapter: true, timingAcquired: false,
        node: process.version, cases: passed,
        limitations: ['Host adapter, not browser OPFS', 'Writer exclusion is local to each adapter process',
            'Filesystem handles are disk-backed and index-worker tokens are explicitly rehydrated']
    }, null, 2) + '\n')
    console.log(JSON.stringify({passed: true, cases: passed.length, timingAcquired: false}))
} catch (cause) {
    await writeFile(join(output, 'failure.json'), JSON.stringify({
        passed: false, casesCompleted: passed, error: String(cause), stack: cause?.stack
    }, null, 2) + '\n')
    throw cause
}
