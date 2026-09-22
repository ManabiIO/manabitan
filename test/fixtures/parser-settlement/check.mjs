/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import assert from 'node:assert/strict'
import {readFile, writeFile} from 'node:fs/promises'
import {Worker as ThreadWorker} from 'node:worker_threads'
import {crc32, deflateRawSync} from 'node:zlib'
import {setImmediate as turn} from 'node:timers/promises'
import {runSettlementCases} from './cases.mjs'
import * as parser from '../../../ext/js/dictionary/term-bank-wasm-parser.js'

const terminations = []
let intercept = (data, deliver) => deliver(data)
let workerCount = 0
const unhandled = []
process.on('unhandledRejection', (error) => unhandled.push(String(error)))
class BrowserWorker extends EventTarget {
    constructor(url) {
        super()
        ++workerCount
        this.worker = new ThreadWorker(new URL('worker-node.mjs', import.meta.url), {workerData: {url: url.href}})
        this.worker.on('message', (data) => intercept(data, (value) => this.dispatchEvent(new MessageEvent('message', {data: value}))))
        this.worker.on('error', (error) => {
            const event = new Event('error')
            Object.defineProperty(event, 'message', {value: error.message})
            this.dispatchEvent(event)
        })
        this.worker.on('messageerror', () => this.dispatchEvent(new MessageEvent('messageerror')))
    }

    postMessage(data, transfer) { this.worker.postMessage(data, transfer) }
    terminate() { terminations.push(this.worker.terminate()) }
}
globalThis.Worker = BrowserWorker
Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {hardwareConcurrency: 4, deviceMemory: 8}})
parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../../../ext/lib/term-bank-parser.wasm', import.meta.url))))
const encoder = new TextEncoder()
function sources(banks, mode) {
    return banks.map((json) => {
        const raw = encoder.encode(json)
        if (!['stored', 'deflate'].includes(mode)) { return raw }
        const bytes = mode === 'stored' ? raw : Uint8Array.from(deflateRawSync(raw))
        return {bytes, compressionMethod: mode === 'stored' ? 0 : 8, compressedSize: bytes.length, uncompressedSize: raw.length, signature: crc32(raw)}
    })
}
const result = await runSettlementCases(parser, {
    assert,
    makeSources: sources,
    setIntercept: (fn) => { intercept = fn },
    turn,
    cleanup: async () => {
        await parser.disposeParallelTermBankParser()
        await Promise.all(terminations.splice(0))
    },
})
await turn()
const report = {node: process.version, ...result, workerCount, unhandled}
await writeFile(process.argv[2] ?? '/tmp/parser-settlement.json', `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({passed: report.passed, failed: report.failed, unhandled}, null, 2))
if (report.failed > 0 || unhandled.length > 0) { process.exitCode = 1 }
