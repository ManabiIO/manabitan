/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import assert from 'node:assert/strict'
import {readFile, realpath, writeFile} from 'node:fs/promises'
import {dirname, resolve} from 'node:path'
import {setImmediate as turn} from 'node:timers/promises'
import {Worker as ThreadWorker} from 'node:worker_threads'
import {crc32, deflateRawSync} from 'node:zlib'
import * as parser from '../../../ext/js/dictionary/term-bank-wasm-parser.js'
import {takeOwnedTermContent} from '../../../ext/js/dictionary/term-content-ownership.js'

assert.ok(process.argv[2], 'A fresh output file path is required')
const output = resolve(process.argv[2])
assert.equal(await realpath(dirname(output)), dirname(output))
const terminations = []
const unhandled = []
let disableSharedArrayBuffer = false
let forceOwnedWithoutProjection = false
let receive = (data, deliver) => deliver(data)
let parseRequests = 0
process.on('unhandledRejection', (error) => unhandled.push(String(error)))
class BrowserWorker extends EventTarget {
    constructor(url) {
        super()
        this.worker = new ThreadWorker(new URL('worker-node.mjs', import.meta.url), {
            workerData: {url: url.href, disableSharedArrayBuffer},
        })
        this.worker.on('message', (data) => receive(data, (value) => this.dispatchEvent(new MessageEvent('message', {data: value}))))
        this.worker.on('error', (error) => {
            const event = new Event('error')
            Object.defineProperty(event, 'message', {value: error.message})
            this.dispatchEvent(event)
        })
        this.worker.on('messageerror', () => this.dispatchEvent(new MessageEvent('messageerror')))
    }

    postMessage(data, transfer) {
        if (data.type === 'parse') {
            ++parseRequests
            if (forceOwnedWithoutProjection) {
                // Exercise the direct worker contract independently of the
                // public parser's large-projected admission implication.
                data = {...data, options: {...data.options, projectImagePaths: false, ownContentBytes: true}}
            }
        }
        this.worker.postMessage(data, transfer)
    }

    terminate() { terminations.push(this.worker.terminate()) }
}
globalThis.Worker = BrowserWorker
Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {hardwareConcurrency: 4, deviceMemory: 8}})
parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../../../ext/lib/term-bank-parser.wasm', import.meta.url))))
const encoder = new TextEncoder()
const options = {computeContentHashes: true,
    emitContentSlab: true,
    emitTokenBinaryContent: true,
    emitTermByteLists: false,
    prepareLookupIndexes: true,
    validateGlossaryTypes: true,
    projectImagePaths: true,
    mediaHintFastScan: true,
    experimentalNativeEscapedKeys: false}
const workerCount = parser.getParallelTermBankParserWorkerCount(options)
const defer = () => {
    let resolvePromise
    const promise = new Promise((resolveValue) => { resolvePromise = resolveValue })
    return {promise, resolve: () => resolvePromise()}
}
async function waitFor(promise, outcome) {
    let timer
    try {
        return await Promise.race([
            promise,
            outcome.then((error) => {
                if (error !== null) { throw error }
                throw new Error('Borrowed worker completed before the expected schedule event')
            }),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('Borrowed worker schedule timed out')), 5000)
            }),
        ])
    } finally { clearTimeout(timer) }
}
function bank(index, repeated = false, compact = false) {
    const glossary = [{type: 'image', path: `image-${index}.png`}, (compact ? 'short' : 'x'.repeat(2048)) + index]
    const rows = Array.from({length: repeated ? 40 : 1}, (_, row) => [`word-${index}-${row}`, '', '', '', index, glossary, row + 1, ''])
    // Large projected admission must continue enabling native escaped-key parsing.
    return JSON.stringify(rows).replaceAll('"type":', '"ty\\u0070e":')
}
function compressedSources(banks) {
    return banks.map((json) => {
        const raw = encoder.encode(json)
        const bytes = Uint8Array.from(deflateRawSync(raw))
        return {bytes, compressionMethod: 8, compressedSize: bytes.length, uncompressedSize: raw.length, signature: crc32(raw)}
    })
}
function independentFields(chunk) {
    const {contentBytesBuffer, releaseBorrowedContent, ...fields} = chunk
    void contentBytesBuffer
    void releaseBorrowedContent
    return fields
}
const cases = []
async function runCase(name, run) {
    try {
        await run()
        cases.push({name, passed: true})
    } catch (error) {
        cases.push({name, passed: false, error: String(error), stack: error.stack})
    } finally {
        receive = (data, deliver) => deliver(data)
        disableSharedArrayBuffer = false
        forceOwnedWithoutProjection = false
        await parser.disposeParallelTermBankParser()
        await Promise.all(terminations.splice(0))
    }
}

for (const config of [
    {name: 'byte-heavy shared chunks wait for sink settlement', borrowed: true},
    {name: 'repeated content retains private lookahead', repeated: true, borrowed: false},
    {name: 'compact cacheable content retains owned shared lookahead', compact: true, small: true, borrowed: false},
    {name: 'unavailable shared-buffer support retains private lookahead', noShared: true, borrowed: false},
    {name: 'forced ownership without image projection stays private', forceNonProjected: true, borrowed: false},
    {name: 'cancelled borrowed sinks cannot admit another group', borrowed: true, cancel: true},
    {name: 'failed borrowed sinks preserve the original failure', borrowed: true, fail: true},
]) {
    await runCase(config.name, async () => {
        disableSharedArrayBuffer = config.noShared === true
        forceOwnedWithoutProjection = config.forceNonProjected === true
        const sources = compressedSources(Array.from({length: 24}, (_, index) => bank(index, config.repeated, config.compact)))
        const estimates = sources.map((source) => (config.small ? source.uncompressedSize : 24 * 1024 * 1024))
        const firstSink = defer()
        const finishSink = defer()
        const initialReady = defer()
        const expectedLead = config.borrowed ? workerCount : workerCount * 3
        const results = []
        const retained = []
        let calls = 0
        let nextBankIndex = 0
        let cancelled = false
        const original = new Error('Borrowed content sink failure witness')
        parseRequests = 0
        receive = (data, deliver) => {
            if (data.type === 'result') {
                results.push(data)
                if (results.length === expectedLead) { initialReady.resolve() }
            }
            deliver(data)
        }
        const outcome = parser.parseTermBankWithWasmColumnChunksParallelCompressedLazy(
            sources.map((source) => async () => source),
            estimates,
            3,
            async (chunk) => {
                ++calls
                assert.equal(typeof chunk.releaseBorrowedContent, config.borrowed ? 'function' : 'undefined')
                assert.equal(takeOwnedTermContent(chunk.contentBytesBuffer), !config.borrowed)
                const rowsPerBank = config.repeated ? 40 : 1
                const bankCount = chunk.rowCount / rowsPerBank
                assert.ok(Number.isInteger(bankCount) && bankCount > 0)
                if (config.forceNonProjected) {
                    assert.equal(chunk.projectedMedia, undefined)
                    assert.ok(chunk.mediaRows.length > 0)
                    assert.ok(chunk.mediaRows.every(({imagePaths}) => typeof imagePaths === 'undefined'))
                } else {
                    assert.deepEqual(chunk.mediaRows, [])
                    const keys = Array.from({length: bankCount}, (_, index) => encoder.encode(`word-${nextBankIndex + index}-0`))
                    const bytes = new Uint8Array(keys.reduce((length, key) => length + key.length, 0))
                    const spans = new Uint32Array(bankCount * 4)
                    let offset = 0
                    for (let index = 0; index < bankCount; ++index) {
                        const key = keys[index]
                        bytes.set(key, offset)
                        spans.set([offset, key.length, offset, key.length], index * 4)
                        offset += key.length
                    }
                    assert.deepEqual(chunk.projectedMedia, {
                        rowIndexes: Uint32Array.from({length: bankCount}, (_, index) => index * rowsPerBank),
                        pathEnds: Uint32Array.from({length: bankCount}, (_, index) => index + 1),
                        paths: Array.from({length: bankCount}, (_, index) => `image-${nextBankIndex + index}.png`),
                        diagnosticKeys: {bytes, spans, decodedKeys: null},
                    })
                }
                nextBankIndex += bankCount
                const fields = independentFields(chunk)
                retained.push({fields, snapshot: structuredClone(fields)})
                if (calls !== 1) { return }
                const originalContent = Uint8Array.from(chunk.contentBytesBuffer)
                firstSink.resolve()
                await finishSink.promise
                assert.deepEqual(chunk.contentBytesBuffer, originalContent, 'The parser must not reuse the active source lease')
                if (config.fail) { throw original }
            },
            options,
            () => cancelled,
        ).then(() => null, (error) => error)
        try {
            await waitFor(firstSink.promise, outcome)
            await waitFor(initialReady.promise, outcome)
            await turn()
            assert.equal(parseRequests, expectedLead)
            for (const result of results) {
                assert.equal(result.borrowsWorkerMemory, config.borrowed)
                assert.equal(result.ownsContentBytes, !config.borrowed)
                assert.equal(result.profile.experiments.experimentalNativeEscapedKeys, !config.small)
                assert.equal(result.chunk.contentBytesBuffer.buffer instanceof SharedArrayBuffer, config.borrowed || config.small === true)
            }
            cancelled = config.cancel === true
        } finally { finishSink.resolve() }
        const error = await outcome
        if (config.cancel) {
            assert.equal(error?.name, 'AbortError')
            assert.equal(calls, 1)
        } else if (config.fail) {
            assert.equal(error?.message, original.message)
            assert.equal(error?.stack, original.stack)
            assert.equal(calls, 1)
        } else {
            assert.equal(error, null)
            assert.ok(calls > workerCount)
        }
        for (const {fields, snapshot} of retained) {
            assert.deepEqual(fields, snapshot, 'Record, key and media snapshots must survive later parser reuse')
        }
    })
}

await runCase('peer parser failure releases waits without reusing active content', async () => {
    const sources = compressedSources(Array.from({length: 24}, (_, index) => (index === 1 ? '[,]' : bank(index))))
    const firstSink = defer()
    const failureDelivered = defer()
    const finishSink = defer()
    let calls = 0
    receive = (data, deliver) => {
        if (data.type === 'parse-error') {
            void firstSink.promise.then(() => {
                deliver(data)
                failureDelivered.resolve()
            })
        } else { deliver(data) }
    }
    const outcome = parser.parseTermBankWithWasmColumnChunksParallelCompressedLazy(
        sources.map((source) => async () => source),
        sources.map(() => 24 * 1024 * 1024),
        3,
        async (chunk) => {
            ++calls
            assert.equal(typeof chunk.releaseBorrowedContent, 'function')
            const originalContent = Uint8Array.from(chunk.contentBytesBuffer)
            firstSink.resolve()
            await finishSink.promise
            assert.deepEqual(chunk.contentBytesBuffer, originalContent)
        },
        options,
    ).then(() => null, (error) => error)
    try {
        await waitFor(failureDelivered.promise, outcome)
        await turn()
    } finally { finishSink.resolve() }
    const error = await outcome
    assert.ok(error instanceof Error)
    assert.match(error.message, /parse|JSON/i)
    assert.equal(calls, 1)
})
await turn()
const report = {node: process.version,
    cases,
    unhandled,
    passed: cases.filter((item) => item.passed).length,
    failed: cases.filter((item) => !item.passed).length}
await writeFile(output, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'})
console.log(JSON.stringify(report, null, 2))
if (report.failed > 0 || unhandled.length > 0) { process.exitCode = 1 }
