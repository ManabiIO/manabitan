/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
import assert from 'node:assert/strict'
import {readFile, readdir, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {createNodeOpfs} from './node-opfs-adapter.mjs'

const root = path.resolve(process.argv[2] ?? new URL('../before', import.meta.url).pathname)
const source = path.join(root, 'ext/js/dictionary/term-content-opfs-store.js')
// eslint-disable-next-line no-unsanitized/method -- The test runner intentionally imports production source from the supplied checkout path.
const {TermContentOpfsStore} = await import(pathToFileURL(source).href)
const output = process.argv[3]
const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const tests = []
const results = []
const test = (name, body) => tests.push({name, body})
const tick = () => new Promise((resolve) => {
    setImmediate(resolve)
})
const latch = () => {
    let resolve
    const promise = new Promise((done) => { resolve = done })
    return {promise, resolve}
}
const fileName = (index) => `manabitan-term-content${index === 0 ? '' : `^${index}`}.bin`
async function persist(env, name, bytes) {
    const handle = await env.root.getFileHandle(name, {create: true})
    const writable = await handle.createWritable()
    await writable.write(Uint8Array.from(bytes))
    await writable.close()
}
async function snapshot(env) {
    const result = {}
    for (const name of (await readdir(env.rootPath)).sort()) {
        result[name] = [...await readFile(path.join(env.rootPath, name))]
    }
    return result
}
async function seed(store) {
    await store.prepare()
    await store.beginImportSession()
    await store.appendBatch([Uint8Array.of(1, 2, 3, 4)])
    await store.endImportSession()
    assert.deepEqual(await store.readSlice(0, 4), Uint8Array.of(1, 2, 3, 4))
}

for (const missing of [0, 1]) {
    test(`missing segment ${missing} cannot shift surviving content addresses`, async (env, store) => {
        for (let index = 0; index < 3; ++index) {
            if (index !== missing) { await persist(env, fileName(index), [index + 1, index + 11]) }
        }
        const before = await snapshot(env)
        await assert.rejects(store.prepare(), /segment|contiguous/i)
        assert.deepEqual(await snapshot(env), before)
    })
}
for (const unreadable of [0, 1, 2]) {
    test(`unreadable segment ${unreadable} cannot disappear from the content map`, async (env, store) => {
        for (let index = 0; index < 3; ++index) { await persist(env, fileName(index), [index + 1]) }
        const before = await snapshot(env)
        const failure = new DOMException('Transient storage read failure', 'NotReadableError')
        env.hooks.beforeGetFile = (name) => {
            if (name === fileName(unreadable)) { throw failure }
        }
        await assert.rejects(store.prepare(), (error) => error === failure)
        env.hooks.beforeGetFile = null
        assert.deepEqual(await snapshot(env), before)
        await store.prepare()
        assert.deepEqual(await store.readSlice(0, 3), Uint8Array.of(1, 2, 3))
    })
}
for (const alias of ['0', '01', '9007199254740992']) {
    test(`ambiguous numeric segment ${alias} is not admitted`, async (env, store) => {
        await persist(env, fileName(0), [1])
        await persist(env, `manabitan-term-content^${alias}.bin`, [2])
        const before = await snapshot(env)
        await assert.rejects(store.prepare(), /segment/i)
        assert.deepEqual(await snapshot(env), before)
    })
}
test('contiguous legacy short segments and unrelated files remain readable', async (env, store) => {
    await persist(env, fileName(0), [1, 2])
    await persist(env, fileName(1), [3])
    await persist(env, 'unrelated.bin', [99])
    await store.prepare()
    assert.deepEqual(await store.readSlice(0, 3), Uint8Array.of(1, 2, 3))
})
test('rollback can remove a gapped interrupted-only segment', async (env, store) => {
    await seed(store)
    const checkpoint = await store.createImportCheckpoint()
    await persist(env, fileName(2), [90, 91])
    await store.rollbackImportSession(checkpoint)
    assert.deepEqual(await snapshot(env), {[fileName(0)]: [1, 2, 3, 4]})
})

for (const appendKind of ['direct-batch', 'blob', 'outside-import']) {
    test(`${appendKind}: write failure remains fatal until rollback`, async (env, store) => {
        await seed(store)
        const checkpoint = await store.createImportCheckpoint()
        if (appendKind !== 'outside-import') { await store.beginImportSession() }
        store._flushThresholdBytes = 1
        const failure = new Error('Injected OPFS write failure')
        env.hooks.beforeWrite = () => { throw failure }
        const append = appendKind === 'blob' ?
            store.appendBlob(new Blob([Uint8Array.of(5, 6)])) :
            store.appendBatch([Uint8Array.of(5, 6)])
        await assert.rejects(append, (error) => error === failure)
        env.hooks.beforeWrite = null
        await assert.rejects(store.endImportSession(), (error) => error === failure)
        await assert.rejects(store.endImportSession(), (error) => error === failure)
        await assert.rejects(store.appendBatch([Uint8Array.of(7)]), (error) => error === failure)
        await store.rollbackImportSession(checkpoint)
        await store.beginImportSession()
        assert.deepEqual(await store.appendBatch([Uint8Array.of(8)]), [{offset: 4, length: 1}])
        await store.endImportSession()
        assert.deepEqual(await store.readSlice(0, 5), Uint8Array.of(1, 2, 3, 4, 8))
    })
}
test('failed close cannot make subsequent finalization report success', async (env, store) => {
    await seed(store)
    const checkpoint = await store.createImportCheckpoint()
    await store.beginImportSession()
    await store.appendBatch([Uint8Array.of(5, 6)])
    const failure = new Error('Injected OPFS close failure')
    const writable = store._writable
    const abort = writable.abort.bind(writable)
    writable.close = async () => {
        await abort()
        throw failure
    }
    await assert.rejects(store.endImportSession(), (error) => error === failure)
    await assert.rejects(store.endImportSession(), (error) => error === failure)
    await assert.rejects(store.beginImportSession(), (error) => error === failure)
    await store.rollbackImportSession(checkpoint)
    assert.deepEqual(await store.readSlice(0, 4), Uint8Array.of(1, 2, 3, 4))
})

for (const producer of ['batch', 'blob', 'derived-prefix']) {
    test(`out-of-range snapshot refresh cannot rewind ${producer} append cursors`, async (env, store) => {
        await seed(store)
        await store.beginImportSession()
        store.setQueueImportWritesEnabled(true)
        store._flushThresholdBytes = 1
        await store.appendBatch([Uint8Array.of(5, 6, 7, 8)])
        await store.flushImportWrites()
        // An out-of-range probe must not replace active writer state with
        // shorter committed snapshots or abandon its unclosed writable.
        assert.equal(await store.readSlice(99, 1), null)
        let append
        if (producer === 'blob') {
            append = store.appendBlob(new Blob([Uint8Array.of(9, 10)]))
        } else if (producer === 'derived-prefix') {
            append = store.beginAppendBatchWithDerivedPrefix(Promise.resolve([Uint8Array.of(10)]), [1], () => [Uint8Array.of(9)]).completion
        } else {
            append = store.appendBatch([Uint8Array.of(9, 10)])
        }
        const result = await append
        let offset
        if (producer === 'blob') {
            offset = result.offset
        } else if (producer === 'derived-prefix') {
            offset = result.derivedOffsets[0]
        } else {
            offset = result[0].offset
        }
        assert.equal(offset, 8, 'Returned offset must include all already-written, not-yet-closed bytes')
        if (producer === 'derived-prefix') { assert.equal(result.primaryOffsets[0], 9) }
        await store.endImportSession()
        assert.deepEqual(await store.readSlice(0, 10), Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10))
    })
}
test('NotReadable snapshot recovery cannot discard active append accounting', async (env, store) => {
    await seed(store)
    await store.beginImportSession()
    store.setQueueImportWritesEnabled(true)
    store._flushThresholdBytes = 1
    await store.appendBatch([Uint8Array.of(5, 6, 7, 8)])
    await store.flushImportWrites()
    store._readPageCache.clear()
    store.setExactSliceCacheEnabled(false)
    const file = store._segmentStates[0].readFile
    const slice = file.slice.bind(file)
    let failed = false
    file.slice = (...args) => {
        const value = slice(...args)
        if (!failed) {
            failed = true
            value.arrayBuffer = async () => { throw new DOMException('Snapshot invalidated', 'NotReadableError') }
        }
        return value
    }
    assert.deepEqual(await store.readSlice(0, 2), Uint8Array.of(1, 2))
    assert.equal(failed, true)
    assert.deepEqual(await store.appendBatch([Uint8Array.of(9, 10)]), [{offset: 8, length: 2}])
    await store.endImportSession()
    assert.deepEqual(await store.readSlice(0, 10), Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10))
})

for (const phase of ['create', 'seek']) {
    test(`failed import ${phase} remains fatal until rollback`, async (env, store) => {
        await seed(store)
        const checkpoint = await store.createImportCheckpoint()
        const failure = new Error(`Injected ${phase} failure`)
        if (phase === 'create') {
            env.hooks.beforeCreateWritable = () => { throw failure }
        } else {
            env.hooks.afterCreateWritable = (_name, writable) => {
                writable.seek = async () => { throw failure }
            }
        }
        await assert.rejects(store.beginImportSession(), (error) => error === failure)
        env.hooks.beforeCreateWritable = null
        env.hooks.afterCreateWritable = null
        await assert.rejects(store.beginImportSession(), (error) => error === failure)
        await assert.rejects(store.endImportSession(), (error) => error === failure)
        await assert.rejects(store.appendBatch([Uint8Array.of(5)]), (error) => error === failure)
        await store.rollbackImportSession(checkpoint)
        await store.beginImportSession()
        await store.appendBatch([Uint8Array.of(5)])
        await store.endImportSession()
        assert.deepEqual(await store.readSlice(0, 5), Uint8Array.of(1, 2, 3, 4, 5))
    })
}

for (const changed of ['shorter-tail', 'changed-prefix', 'missing-tail']) {
    test(`snapshot refresh rejects ${changed} instead of rebasing existing addresses`, async (env, store) => {
        await persist(env, fileName(0), [1, 2])
        await persist(env, fileName(1), [3, 4])
        await store.prepare()
        await store.ensureLoadedForRead()
        if (changed === 'shorter-tail') {
            await persist(env, fileName(1), [3])
        } else if (changed === 'changed-prefix') {
            await persist(env, fileName(0), [1, 2, 9])
        } else {
            await env.root.removeEntry(fileName(1))
        }
        const disk = await snapshot(env)
        assert.equal(await store.readSlice(99, 1), null)
        assert.deepEqual(store._segmentStates.map((x) => [x.index, x.fileLength, x.startOffset]), [[0, 2, 0], [1, 2, 2]])
        assert.deepEqual(await snapshot(env), disk)
    })
}

test('external tail growth remains readable and preserves the next append cursor', async (env, store) => {
    await seed(store)
    await persist(env, fileName(0), [1, 2, 3, 4, 5, 6])
    assert.deepEqual(await store.readSlice(4, 2), Uint8Array.of(5, 6))
    await store.beginImportSession()
    assert.deepEqual(await store.appendBatch([Uint8Array.of(7)]), [{offset: 6, length: 1}])
    await store.endImportSession()
    assert.deepEqual(await store.readSlice(0, 7), Uint8Array.of(1, 2, 3, 4, 5, 6, 7))
})

for (const queued of [false, true]) {
    test(`snapshot publication and append reservation share ownership (queued=${queued})`, async (env, store) => {
        await seed(store)
        await store.beginImportSession()
        store.setQueueImportWritesEnabled(queued)
        store._flushThresholdBytes = 1
        await store.appendBatch([Uint8Array.of(5, 6, 7, 8)])
        await store.flushImportWrites()
        const entered = latch()
        const release = latch()
        let held = false
        env.hooks.beforeGetFile = async () => {
            if (held) { return }
            held = true
            entered.resolve()
            await release.promise
        }
        // Force the normal invalidated-snapshot path independently of the
        // older spanning-overlay repair, so the same test runs on PR #70.
        store._invalidateReadState()
        const reading = store.readSlice(2, 4)
        let append
        try {
            await entered.promise
            append = store.appendBatch([Uint8Array.of(9, 10)])
            // Let the baseline producer proceed while the old File snapshot
            // is held. The fixed producer must instead await the owner.
            await tick()
            await tick()
        } finally {
            release.resolve()
        }
        assert.deepEqual(await reading, Uint8Array.of(3, 4, 5, 6))
        assert.deepEqual(await append, [{offset: 8, length: 2}])
        await store.flushImportWrites()
        assert.deepEqual(await store.appendBatch([Uint8Array.of(11)]), [{offset: 10, length: 1}])
        await store.endImportSession()
        assert.deepEqual(await store.readSlice(0, 11), Uint8Array.from({length: 11}, (_, i) => i + 1))
    })
}

test('reset can remove gapped interrupted segments without publishing them', async (env, store) => {
    await seed(store)
    await persist(env, fileName(2), [90])
    await store.reset()
    assert.deepEqual(await snapshot(env), {[fileName(0)]: []})
})

test('successful finalization remains idempotent and snapshots permit next import', async (env, store) => {
    await seed(store)
    await store.endImportSession()
    await store.ensureLoadedForRead()
    await store.beginImportSession()
    await store.appendBatch([Uint8Array.of(5)])
    await store.endImportSession()
    await store.endImportSession()
    assert.deepEqual(await store.readSlice(0, 5), Uint8Array.of(1, 2, 3, 4, 5))
})

test('failed rollback cannot re-enable admission over unverified content', async (env, store) => {
    await seed(store)
    const checkpoint = await store.createImportCheckpoint()
    await store.beginImportSession()
    await store.appendBatch([Uint8Array.of(5, 6)])
    await store.endImportSession()
    await persist(env, fileName(0), [1])
    let rollbackError
    await assert.rejects(store.rollbackImportSession(checkpoint), (error) => {
        rollbackError = error
        return error instanceof Error && /roll back/.test(error.message)
    })
    const before = await snapshot(env)
    await assert.rejects(store.appendBatch([Uint8Array.of(90)]), (error) => error === rollbackError)
    await assert.rejects(store.beginImportSession(), (error) => error === rollbackError)
    await assert.rejects(store.endImportSession(), (error) => error === rollbackError)
    assert.deepEqual(await snapshot(env), before)
    await store.rollbackImportSession({segments: []})
    await store.beginImportSession()
    await store.appendBatch([Uint8Array.of(42)])
    await store.endImportSession()
    assert.deepEqual(await store.readSlice(0, 1), Uint8Array.of(42))
})

for (const {name, body} of tests) {
    console.error('START', name)
    const env = await createNodeOpfs()
    Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {storage: {getDirectory: async () => env.root}, deviceMemory: 8}})
    const store = new TermContentOpfsStore()
    try {
        let timer
        try {
            await Promise.race([
                body(env, store),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('Test timeout')), 5000)
                }),
            ])
        } finally {
            clearTimeout(timer)
        }
        results.push({name, passed: true})
        console.error('PASS', name)
    } catch (error) {
        results.push({name, passed: false, error: error instanceof Error ? error.stack ?? error.message : String(error)})
        console.error('FAIL', name, error instanceof Error ? error.message : String(error))
    } finally {
        env.hooks.beforeWrite = null
        env.hooks.beforeGetFile = null
        env.hooks.beforeCreateWritable = null
        env.hooks.afterCreateWritable = null
        try {
            await store.endImportSession()
        } catch (_) {
            // Cleanup is best-effort after the assertion result is recorded.
        }
        await env.dispose()
    }
}
if (previousNavigator) {
    Object.defineProperty(globalThis, 'navigator', previousNavigator)
} else {
    delete globalThis.navigator
}
const report = {
    node: process.version,
    sourceSha256: createHash('sha256').update(await readFile(source)).digest('hex'),
    storage: 'temporary-file File System API adapter; faults/delays only at file/stream boundaries',
    passed: results.filter(({passed}) => passed).length,
    failed: results.filter(({passed}) => !passed).length,
    results,
}
if (output) {
    await writeFile(output, JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify(report, null, 2))
process.exitCode = report.failed ? 1 : 0
