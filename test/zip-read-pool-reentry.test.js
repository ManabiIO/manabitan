/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
import assert from 'node:assert/strict'
import {test} from 'vitest'
import {AbortableZipReadPool, TermBankSourcePipeline} from '../ext/js/dictionary/term-bank-source-pipeline.js'

/** @returns {{promise: Promise<Uint8Array>, resolve: (bytes: Uint8Array) => void, reject: (reason?: unknown) => void}} */
function deferred() {
    /** @type {(bytes: Uint8Array) => void} */
    let resolve = () => {}
    /** @type {(reason?: unknown) => void} */
    let reject = () => {}
    /** @type {Promise<Uint8Array>} */
    const promise = new Promise((yes, no) => {
        resolve = yes
        reject = no
    })
    return {promise, resolve, reject}
}

async function flush() {
    for (let i = 0; i < 40; ++i) { await Promise.resolve() }
}

function files() {
    return Array.from({length: 4}, (_, index) => ({
        filename: `term_bank_${index}.json`,
        getData() {},
        offset: index * 50,
        compressionMethod: 0,
        compressedSize: 3,
        uncompressedSize: 3,
        signature: 0,
    }))
}

test('read callback reentry shares the already admitted entry', async () => {
    const file = files()[0]
    const gate = deferred()
    let calls = 0
    let nested
    const pool = new AbortableZipReadPool(() => {
        if (++calls === 1) { nested = pool.read(file) }
        return gate.promise
    })
    const first = pool.read(file)
    gate.resolve(new Uint8Array([1, 2, 3]))
    await Promise.all([first, nested, pool.dispose()])
    assert.equal(calls, 1)
    assert.equal(first, nested)
})

for (const method of ['abortAndJoin', 'dispose']) {
    for (const outcome of ['resolve', 'reject']) {
        test(`${method} started inside admission owns the ${outcome} read`, async () => {
            const file = files()[0]
            const gate = deferred()
            /** @type {AbortSignal[]} */
            const signals = []
            let join
            let joined = false
            const pool = new AbortableZipReadPool((_file, value) => {
                signals.push(value)
                join = (method === 'dispose' ? pool.dispose() : pool.abortAndJoin()).then(() => { joined = true })
                return gate.promise
            })
            const first = pool.read(file)
            const failure = new Error('late read failure')
            const checked = outcome === 'reject' ? assert.rejects(first, (error) => error === failure) : first
            await flush()
            const joinedEarly = joined
            const abortedDuringAdmission = signals[0].aborted
            if (outcome === 'reject') {
                gate.reject(failure)
            } else {
                gate.resolve(new Uint8Array([1, 2, 3]))
            }
            await Promise.all([checked, join, pool.dispose()])
            assert.equal(abortedDuringAdmission, true)
            assert.equal(joinedEarly, false)
            assert.equal(joined, true)
        })
    }
}

test('release inside admission cannot be undone when the callback returns', async () => {
    const file = files()[0]
    let calls = 0
    const pool = new AbortableZipReadPool(() => {
        ++calls
        pool.release(file)
        return Promise.resolve(new Uint8Array([calls]))
    })
    const first = pool.read(file)
    const second = pool.read(file)
    const values = await Promise.all([first, second])
    await pool.dispose()
    assert.notEqual(first, second)
    assert.equal(calls, 2)
    assert.deepEqual(values.map((bytes) => bytes[0]), [1, 2])
})

test('nested replacement retains the newer cache entry and both pending lifetimes', async () => {
    const file = files()[0]
    const gates = [deferred(), deferred()]
    /** @type {AbortSignal[]} */
    const signals = []
    let second
    const pool = new AbortableZipReadPool((_file, signal) => {
        const index = signals.length
        signals.push(signal)
        if (index === 0) {
            pool.release(file)
            second = pool.read(file)
        }
        return gates[index].promise
    })
    const first = pool.read(file)
    const current = pool.read(file)
    let joined = false
    const disposal = pool.dispose().then(() => { joined = true })
    gates[1].resolve(new Uint8Array([2]))
    await flush()
    const joinedEarly = joined
    gates[0].resolve(new Uint8Array([1]))
    await Promise.all([first, second, current, disposal])
    assert.equal(current, second)
    assert.notEqual(first, second)
    assert.equal(signals.length, 2)
    assert.ok(signals.every((signal) => signal.aborted))
    assert.equal(joinedEarly, false)
})

test('abort observer reentering disposal receives the same shared promise', async () => {
    const gate = deferred()
    let nested
    const pool = new AbortableZipReadPool((_file, signal) => {
        signal.addEventListener('abort', () => { nested = pool.dispose() }, {once: true})
        return gate.promise
    })
    const read = pool.read(files()[0])
    const outer = pool.dispose()
    gate.resolve(new Uint8Array([1]))
    await Promise.all([read, outer, nested])
    assert.equal(outer, nested)
    assert.equal(pool.dispose(), outer)
})

for (const compressed of [false, true]) {
    test(`pipeline joins disposal entered from ${compressed ? 'compressed' : 'plain'} read admission`, async () => {
        const inputs = files()
        const gate = deferred()
        /** @type {AbortSignal[]} */
        const signals = []
        let disposal
        let disposed = false
        /** @type {(file: import('../ext/js/dictionary/term-bank-source-pipeline.js').TermBankSourceFile, signal: AbortSignal) => Promise<Uint8Array>} */
        const read = (_file, value) => {
            signals.push(value)
            disposal = pipeline.dispose().then(() => { disposed = true })
            return gate.promise
        }
        const pipeline = new TermBankSourcePipeline({
            termFiles: inputs,
            enabled: true,
            deviceMemory: 8,
            read,
            readCompressed: read,
        })
        const plan = pipeline.createCompressedImportRunPlan(0)
        assert.ok(plan)
        const pending = compressed ? plan.loaders[0]() : pipeline.read(inputs[0])
        await flush()
        const disposedEarly = disposed
        const abortedDuringAdmission = signals[0].aborted
        gate.resolve(new Uint8Array([1, 2, 3]))
        await Promise.all([pending, disposal])
        assert.equal(abortedDuringAdmission, true)
        assert.equal(disposedEarly, false)
    })
}

test('reader callbacks and abort notifications retain synchronous timing', async () => {
    let calls = 0
    let aborted = false
    const gate = deferred()
    const pool = new AbortableZipReadPool((_file, signal) => {
        ++calls
        signal.addEventListener('abort', () => { aborted = true }, {once: true})
        return gate.promise
    })
    const read = pool.read(files()[0])
    assert.equal(calls, 1)
    const disposal = pool.dispose()
    assert.equal(aborted, true)
    gate.resolve(new Uint8Array())
    await Promise.all([read, disposal])
})

test('synchronous admission failure preserves its exact rejection and shared identity', async () => {
    const file = files()[0]
    const error = new Error('synchronous failure')
    let calls = 0
    const pool = new AbortableZipReadPool(() => {
        ++calls
        throw error
    })
    const first = pool.read(file)
    assert.equal(first, pool.read(file))
    await assert.rejects(first, (value) => value === error)
    assert.equal(calls, 1)
    await pool.dispose()
})

test('successful cached results retain byte identity without copying', async () => {
    const file = files()[0]
    const bytes = new Uint8Array([1, 2, 3])
    const pool = new AbortableZipReadPool(async () => bytes)
    const first = pool.read(file)
    assert.equal(await first, bytes)
    assert.equal(pool.read(file), first)
    assert.equal(await pool.read(file), bytes)
    await pool.dispose()
    assert.throws(() => pool.read(file), /disposed/)
})
