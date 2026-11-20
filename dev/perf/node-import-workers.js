/*
 * Copyright (C) 2026  Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {readFile, realpath} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {isMainThread, parentPort, workerData, Worker as ThreadWorker} from 'node:worker_threads'

/** @typedef {{source: string, hardwareConcurrency: number, deviceMemory: number}} TransportOptions */
/** @typedef {{parserWorkers: number, compressionWorkers: number, compressionJobs: number, compressionSpanJobs: number, compressionInputBytes: number, compressionOutputBytes: number, sourceConsumedMessages: number, completedCompressionJobs: number, errors: string[]}} TransportStats */

/**
 * Adapt browser message transport only. The selected checkout supplies both
 * production workers and every module/asset they load. This is Node evidence,
 * not a browser or OPFS implementation.
 * @param {TransportOptions} options
 * @returns {{snapshot: () => TransportStats, dispose: () => Promise<void>}}
 */
export function installNodeImportWorkers(options) {
    assert.ok(isMainThread)
    const previousWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker')
    /** @type {TransportStats} */
    const stats = {parserWorkers: 0, compressionWorkers: 0, compressionJobs: 0, compressionSpanJobs: 0, compressionInputBytes: 0, compressionOutputBytes: 0, sourceConsumedMessages: 0, completedCompressionJobs: 0, errors: []}
    /** @type {Set<{terminate: () => void}>} */
    const workers = new Set()
    /** @type {Array<Promise<number>>} */
    const terminations = []

    class BrowserWorker extends EventTarget {
        /** @param {URL|string} entry */
        constructor(entry) {
            super()
            const url = new URL(entry)
            assert.equal(url.protocol, 'file:')
            const filename = fileURLToPath(url)
            const relative = path.relative(options.source, filename)
            assert.ok(['ext/js/dictionary/term-bank-wasm-parser-worker.js', 'ext/js/dictionary/zstd-term-content-compression-worker.js'].includes(relative), `Unexpected worker: ${relative}`)
            /** @type {boolean} */
            this.compression = relative.endsWith('/zstd-term-content-compression-worker.js')
            /** @type {boolean} */
            this.terminated = false
            /** @type {ThreadWorker} */
            this.thread = new ThreadWorker(new URL(import.meta.url), {workerData: {...options, entry: url.href}})
            workers.add(this)
            if (this.compression) {
                ++stats.compressionWorkers
            } else {
                ++stats.parserWorkers
            }
            this.thread.on('message', (/** @type {unknown} */ data) => {
                const message = /** @type {{type?: string, id?: number, compressed?: ArrayBuffer, error?: string}} */ (data)
                if (this.compression) {
                    if (message.type === 'source-consumed') { ++stats.sourceConsumedMessages }
                    if (message.compressed instanceof ArrayBuffer) {
                        ++stats.completedCompressionJobs
                        stats.compressionOutputBytes += message.compressed.byteLength
                    }
                    if (typeof message.error === 'string') { stats.errors.push(message.error) }
                }
                this.dispatchEvent(new MessageEvent('message', {data}))
            })
            this.thread.on('error', (error) => { this.fail(error.message) })
            this.thread.on('messageerror', (error) => {
                stats.errors.push(String(error))
                this.dispatchEvent(new MessageEvent('messageerror'))
            })
            this.thread.on('exit', (code) => {
                if (!this.terminated && code !== 0) { this.fail(`Worker exited with code ${code}`) }
            })
        }

        /** @param {string} message */
        fail(message) {
            stats.errors.push(message)
            const event = new Event('error')
            Object.defineProperty(event, 'message', {value: message})
            this.dispatchEvent(event)
        }

        /**
         * @param {unknown} data
         * @param {import('node:worker_threads').TransferListItem[]} [transfer]
         */
        postMessage(data, transfer) {
            if (this.compression) {
                const message = /** @type {{id?: number, contentBytes?: number, source?: Uint8Array, content?: Uint8Array}} */ (data)
                if (typeof message.id === 'number') {
                    ++stats.compressionJobs
                    if (message.source instanceof Uint8Array) { ++stats.compressionSpanJobs }
                    stats.compressionInputBytes += message.contentBytes ?? message.content?.byteLength ?? 0
                }
            }
            this.thread.postMessage(data, transfer)
        }

        /** Stop this worker once and retain its termination promise for cleanup. */
        terminate() {
            if (this.terminated) { return }
            this.terminated = true
            terminations.push(this.thread.terminate())
        }
    }

    Reflect.set(globalThis, 'Worker', BrowserWorker)
    return {
        snapshot: () => ({...stats, errors: [...stats.errors]}),
        dispose: async () => {
            for (const worker of workers) { worker.terminate() }
            await Promise.all(terminations)
            if (previousWorker) {
                Object.defineProperty(globalThis, 'Worker', previousWorker)
            } else {
                Reflect.deleteProperty(globalThis, 'Worker')
            }
        },
    }
}

if (!isMainThread) {
    assert.ok(parentPort)
    const port = parentPort
    /** @type {unknown} */
    const payload = workerData
    const options = /** @type {TransportOptions & {entry: string}} */ (payload)
    const source = await realpath(options.source)
    const entry = await realpath(fileURLToPath(options.entry))
    assert.ok(entry.startsWith(`${source}${path.sep}`), 'Worker escaped selected source')
    Reflect.set(globalThis, 'self', globalThis)
    Reflect.set(globalThis, 'addEventListener', (/** @type {string} */ type, /** @type {(event: {data: unknown}) => void} */ listener) => {
        assert.equal(type, 'message')
        port.on('message', (data) => { listener({data}) })
    })
    Reflect.set(globalThis, 'postMessage', (/** @type {unknown} */ data, /** @type {import('node:worker_threads').TransferListItem[]} */ transfer) => { port.postMessage(data, transfer) })
    Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {hardwareConcurrency: options.hardwareConcurrency, deviceMemory: options.deviceMemory}})
    globalThis.fetch = async (resource, init) => {
        const url = resource instanceof Request ? new URL(resource.url) : new URL(String(resource))
        assert.equal(url.protocol, 'file:', 'Worker benchmark cannot fetch network resources')
        const filename = await realpath(fileURLToPath(url))
        assert.ok(filename.startsWith(`${source}${path.sep}`), 'Worker asset escaped selected source')
        init?.signal?.throwIfAborted()
        return new Response(await readFile(filename), {headers: {'Content-Type': filename.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'}})
    }
    // eslint-disable-next-line no-unsanitized/method -- Entry is confined to a selected local production worker above.
    await import(options.entry)
}
