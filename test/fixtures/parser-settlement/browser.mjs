/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import assert from 'node:assert/strict'
import {readFile, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {dirname, resolve, sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium} from 'playwright'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const server = createServer(async (request, response) => {
    try {
        const pathname = new URL(request.url, 'http://localhost').pathname
        const file = resolve(root, `.${decodeURIComponent(pathname)}`)
        if (file !== root && !file.startsWith(`${root}${sep}`)) { throw new Error('Outside fixture root') }
        response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
        response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
        response.setHeader('Content-Type', pathname.endsWith('.wasm') ? 'application/wasm' : (pathname === '/' ? 'text/html' : 'text/javascript'))
        response.end(pathname === '/' ? '<!doctype html><title>Native parser regression</title>' : await readFile(file))
    } catch (_) { response.writeHead(404).end() }
})
await new Promise((done) => { server.listen(0, '127.0.0.1', done) })
let browser
try {
    browser = await chromium.launch({headless: true, args: ['--no-sandbox']})
    const page = await browser.newPage()
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    const report = await page.evaluate(async () => {
        if (!globalThis.crossOriginIsolated) { throw new Error('Shared worker-memory qualification requires isolation') }
        const parser = await import('/ext/js/dictionary/term-bank-wasm-parser.js')
        const {runSettlementCases} = await import('/test/fixtures/parser-settlement/cases.mjs')
        const assert = {
            equal: (actual, expected, message = '') => { if (!Object.is(actual, expected)) { throw new Error(`${message}: ${String(actual)} !== ${String(expected)}`) } },
            deepEqual: (actual, expected, message = '') => { if (JSON.stringify(actual) !== JSON.stringify(expected)) { throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`) } },
            ok: (actual, message = '') => { if (!actual) { throw new Error(message || 'Assertion failed') } },
            match: (actual, expected) => { if (!expected.test(actual)) { throw new Error(`Unexpected message: ${String(actual)}`) } },
        }
        const NativeWorker = globalThis.Worker
        let intercept = (data, deliver) => deliver(data)
        let workers = 0
        class GatedWorker extends EventTarget {
            constructor(url, options) {
                super()
                ++workers
                this.worker = new NativeWorker(url, options)
                this.worker.addEventListener('message', (event) => intercept(event.data, (data) => this.dispatchEvent(new MessageEvent('message', {data}))))
                this.worker.addEventListener('messageerror', () => this.dispatchEvent(new MessageEvent('messageerror')))
                this.worker.addEventListener('error', (event) => this.dispatchEvent(new globalThis.ErrorEvent('error', {message: event.message})))
            }

            postMessage(data, transfer) { this.worker.postMessage(data, transfer) }
            terminate() { this.worker.terminate() }
        }
        globalThis.Worker = GatedWorker
        Object.defineProperty(navigator, 'hardwareConcurrency', {value: 4, configurable: true})
        Object.defineProperty(navigator, 'deviceMemory', {value: 8, configurable: true})
        const encoder = new TextEncoder()
        function crc32(bytes) {
            let value = 0xffffffff
            for (const byte of bytes) {
                value ^= byte
                for (let i = 0; i < 8; ++i) { value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0) }
            }
            return (value ^ 0xffffffff) >>> 0
        }
        async function makeSources(banks, mode) {
            return await Promise.all(banks.map(async (json) => {
                const raw = encoder.encode(json)
                if (mode !== 'stored' && mode !== 'deflate') { return raw }
                const bytes = mode === 'stored' ? raw : new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer())
                return {bytes, compressionMethod: mode === 'stored' ? 0 : 8, compressedSize: bytes.length, uncompressedSize: raw.length, signature: crc32(raw)}
            }))
        }
        const turn = () => new Promise((done) => { setTimeout(done, 0) })
        const settlement = await runSettlementCases(parser, {assert, makeSources, setIntercept: (fn) => { intercept = fn }, turn, cleanup: () => parser.disposeParallelTermBankParser()})
        const empty = []
        const options = {emitContentSlab: true, emitTokenBinaryContent: true, prepareLookupIndexes: true}
        for (const mode of ['eager', 'deferred', 'lazy', 'stored', 'deflate']) {
            for (const shape of ['all-empty', 'leading-empty', 'middle-empty', 'trailing-empty', 'malformed']) {
                const row = (i) => JSON.stringify([[`term-${i}`, '', '', '', i, ['definition'], i, '']])
                const banks = {
                    'all-empty': ['[]', '[]', '[]', '[]'],
                    'leading-empty': ['[]', '[]', row(0), row(1)],
                    'middle-empty': [row(0), '[]', '[]', row(1)],
                    'trailing-empty': [row(0), row(1), '[]', '[]'],
                    'malformed': ['[]', '[,]', '[]', '[]'],
                }[shape]
                try {
                    const sources = await makeSources(banks, mode)
                    const sizes = sources.map((s) => s.uncompressedSize ?? s.byteLength)
                    const scores = []
                    const sink = (chunk) => {
                        assert.ok(chunk.rowCount > 0)
                        scores.push(...chunk.scoreList)
                    }
                    let operation
                    switch (mode) {
                        case 'eager': { operation = parser.parseTermBankWithWasmColumnChunksParallel(sources, 3, sink, options)
                            break
                        }
                        case 'deferred': { operation = parser.parseTermBankWithWasmColumnChunksParallelDeferred(sources.map((s) => Promise.resolve(s)), sizes, 3, sink, options)
                            break
                        }
                        case 'lazy': { operation = parser.parseTermBankWithWasmColumnChunksParallelLazy(sources.map((s) => async () => s), sizes, 3, sink, options)
                            break
                        }
                        default: { operation = parser.parseTermBankWithWasmColumnChunksParallelCompressedLazy(sources.map((s) => async () => s), sizes, 3, sink, options) }
                    }
                    let failure
                    try {
                        assert.equal(await operation, true)
                    } catch (error) { failure = error }
                    if (shape === 'malformed') { assert.ok(failure instanceof Error) } else {
                        if (failure) { throw failure }
                        assert.deepEqual(scores, shape === 'all-empty' ? [] : [0, 1])
                    }
                    empty.push({name: `${mode}: ${shape}`, passed: true})
                } catch (error) { empty.push({name: `${mode}: ${shape}`, passed: false, error: String(error)}) } finally { await parser.disposeParallelTermBankParser() }
            }
        }
        return {userAgent: navigator.userAgent, isolated: globalThis.crossOriginIsolated, workerCount: workers, settlement, empty}
    })
    report.browserVersion = browser.version()
    report.pageErrors = pageErrors
    await writeFile(process.argv[2] ?? '/tmp/parser-native-browser.json', `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify({settlement: [report.settlement.passed, report.settlement.failed], empty: [report.empty.filter((x) => x.passed).length, report.empty.filter((x) => !x.passed).length], pageErrors}))
    assert.equal(report.settlement.failed, 0)
    assert.ok(report.empty.every((x) => x.passed))
    assert.deepEqual(pageErrors, [])
} finally {
    await browser?.close()
    await new Promise((done) => { server.close(done) })
}
