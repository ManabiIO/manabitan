/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

// The same schedules and assertions execute in Node worker threads and Chromium.
export async function runSettlementCases(parser, {assert, makeSources, setIntercept, turn, cleanup}) {
    let onLoad = () => {}
    let estimateOverride = null
    const opts = {emitContentSlab: true, emitTokenBinaryContent: true, prepareLookupIndexes: true}
    const outcomes = []
    const defer = () => {
        let resolve
        const promise = new Promise((r) => { resolve = r })
        return {promise, resolve}
    }
    const jsonBank = (i) => JSON.stringify([[`word-${i}`, '', '', '', i, [`definition-${i}`], i, '']])
    async function run(mode, banks, sink, cancel = () => false) {
        const data = await makeSources(banks, mode)
        const sizes = data.map((s) => estimateOverride ?? s.uncompressedSize ?? s.byteLength)
        const loaders = data.map((s, i) => async () => {
            onLoad(i)
            return s
        })
        if (mode === 'eager') { return await parser.parseTermBankWithWasmColumnChunksParallel(data, 3, sink, opts, cancel) }
        if (mode === 'deferred') { return await parser.parseTermBankWithWasmColumnChunksParallelDeferred(data.map((s) => Promise.resolve(s)), sizes, 3, sink, opts, cancel) }
        if (mode === 'lazy') { return await parser.parseTermBankWithWasmColumnChunksParallelLazy(loaders, sizes, 3, sink, opts, cancel) }
        return await parser.parseTermBankWithWasmColumnChunksParallelCompressedLazy(loaders, sizes, 3, sink, opts, cancel)
    }
    async function test(name, fn) {
        let timer
        try {
            await Promise.race([fn(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture schedule timed out')), 5000) })])
            outcomes.push({name, passed: true})
        } catch (error) {
            outcomes.push({name, passed: false, error: String(error), stack: error.stack})
        } finally {
            clearTimeout(timer)
            setIntercept((data, deliver) => deliver(data))
            onLoad = () => {}
            estimateOverride = null
            await cleanup()
        }
    }
    for (const mode of ['eager', 'deferred', 'lazy', 'stored', 'deflate']) {
        await test(`${mode}: cancellation while ordered sink awaits a result prevents another write`, async () => {
            const firstSink = defer()
            const secondReady = defer()
            let releaseSecond
            let cancelled = false
            const calls = []
            setIntercept((data, deliver) => {
                if (data.type === 'result' && data.id === 2) {
                    releaseSecond = () => deliver(data)
                    secondReady.resolve()
                } else { deliver(data) }
            })
            const outcome = run(mode, [0, 1, 2, 3].map(jsonBank), (chunk) => {
                calls.push(chunk.scoreList[0])
                if (calls.length === 1) { firstSink.resolve() }
            }, () => cancelled).then(() => null, (error) => error)
            await firstSink.promise
            await secondReady.promise
            await turn()
            cancelled = true
            releaseSecond()
            const error = await outcome
            assert.equal(error?.name, 'AbortError')
            assert.deepEqual(calls, [0], 'A cancelled run must not enter another storage callback')
        })
        await test(`${mode}: buffered success cannot start another write after peer parse failure`, async () => {
            const secondReady = defer()
            const firstSink = defer()
            const failureReady = defer()
            const finishSink = defer()
            const calls = []
            setIntercept((data, deliver) => {
                deliver(data)
                if (data.type === 'result' && data.id === 2) { secondReady.resolve() }
                if (data.type === 'parse-error' && data.id === 3) { failureReady.resolve() }
            })
            const outcome = run(mode, [jsonBank(0), jsonBank(1), '[,]', jsonBank(3)], async (chunk) => {
                calls.push(chunk.scoreList[0])
                if (calls.length === 1) {
                    firstSink.resolve()
                    await secondReady.promise
                    // Production importer releases the content lease while record work can still be pending.
                    chunk.releaseBorrowedContent?.()
                    await finishSink.promise
                }
            }).then(() => null, (error) => error)
            await firstSink.promise
            await failureReady.promise
            await turn()
            finishSink.resolve()
            const error = await outcome
            assert.ok(error instanceof Error)
            assert.match(error.message, /parse|JSON/i)
            assert.deepEqual(calls, [0], 'A failed run must not consume its already-buffered peer result')
        })
        await test(`${mode}: cancellation after the final sink is still reported`, async () => {
            let cancelled = false
            const calls = []
            const error = await run(mode, [0, 1, 2, 3].map(jsonBank), (chunk, progress) => {
                calls.push(chunk.scoreList[0])
                if (progress.chunkIndex === progress.chunkCount) { cancelled = true }
            }, () => cancelled).then(() => null, (failure) => failure)
            assert.equal(error?.name, 'AbortError')
            assert.deepEqual(calls, [0, 1, 2, 3])
        })
        await test(`${mode}: ordinary ordered parsing and successor import remain correct`, async () => {
            for (let trial = 0; trial < 2; ++trial) {
                const calls = []
                assert.equal(await run(mode, [0, 1, 2, 3].map(jsonBank), (chunk) => calls.push(chunk.scoreList[0])), true)
                assert.deepEqual(calls, [0, 1, 2, 3])
            }
        })
        await test(`${mode}: sink failure preserves original error`, async () => {
            const original = new Error('sink failure witness')
            const calls = []
            const error = await run(mode, [0, 1, 2, 3].map(jsonBank), (chunk) => {
                calls.push(chunk.scoreList[0])
                throw original
            }).then(() => null, (failure) => failure)
            assert.equal(error?.name, original.name)
            assert.equal(error?.message, original.message)
            assert.equal(error?.stack, original.stack)
            assert.deepEqual(calls, [0])
        })
    }
    for (const mode of ['lazy', 'stored', 'deflate']) {
        await test(`${mode}: finalizing a cancelled sink cannot start another source window`, async () => {
            let cancelled = false
            const loaded = []
            onLoad = (i) => loaded.push(i)
            // Conservative estimates force 17 groups without allocating a 408 MiB fixture.
            estimateOverride = 24 * 1024 * 1024
            const error = await run(mode, Array.from({length: 17}, (_, i) => jsonBank(i)), () => {
                cancelled = true
            }, () => cancelled).then(() => null, (failure) => failure)
            assert.equal(error?.name, 'AbortError')
            assert.deepEqual(loaded, [0, 1, 2, 3, 4, 5, 6, 7])
        })
        await test(`${mode}: healthy sink advances the bounded source window`, async () => {
            const loaded = []
            const scores = []
            onLoad = (i) => loaded.push(i)
            estimateOverride = 24 * 1024 * 1024
            assert.equal(await run(mode, Array.from({length: 17}, (_, i) => jsonBank(i)), (chunk) => scores.push(chunk.scoreList[0])), true)
            assert.deepEqual(loaded, Array.from({length: 17}, (_, i) => i))
            assert.deepEqual(scores, loaded)
        })
    }
    await turn()
    return {passed: outcomes.filter((o) => o.passed).length, failed: outcomes.filter((o) => !o.passed).length, cases: outcomes}
}
