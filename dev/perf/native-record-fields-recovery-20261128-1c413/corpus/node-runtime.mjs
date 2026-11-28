/* SPDX-License-Identifier: GPL-3.0-or-later */
// Shared host bindings for the NEW, untimed Node correctness driver.
import {readFile, realpath} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {relative, resolve, sep} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {Worker as NodeWorker} from 'node:worker_threads'
import {exportFileHandle} from './node-opfs-disk.mjs'

export async function installFileRuntime(repository, onAsset = () => {}) {
    const root = await realpath(resolve(repository))
    const ext = root + sep + 'ext'
    const extUrl = pathToFileURL(ext + sep)
    Object.defineProperty(globalThis, 'self', {value: globalThis, configurable: true})
    Object.defineProperty(globalThis, 'crossOriginIsolated', {value: true, configurable: true})
    Object.defineProperty(globalThis, 'chrome', {value: {
        runtime: {
            getURL: (path) => new URL(String(path).replace(/^\/+/, ''), extUrl).href,
            getManifest: () => ({name: 'Manabitan correctness-only adapter', version: '0.0.0.0'})
        }
    }, configurable: true})
    globalThis.fetch = async (input, init = {}) => {
        const raw = typeof input === 'string' || input instanceof URL ? input : input.url
        const url = new URL(raw)
        if (url.protocol !== 'file:') throw new Error('Correctness worker attempted non-file fetch: ' + url.origin)
        const filename = await realpath(fileURLToPath(url))
        const child = relative(ext, filename)
        if (child === '..' || child.startsWith('..' + sep) || resolve(ext, child) !== filename) {
            throw new Error('Asset fetch escaped the checked-out ext directory')
        }
        const signal = init.signal ?? (input instanceof Request ? input.signal : null)
        signal?.throwIfAborted()
        const bytes = await readFile(filename, signal ? {signal} : {})
        signal?.throwIfAborted()
        const mediaType = filename.endsWith('.wasm') ? 'application/wasm' :
            filename.endsWith('.json') ? 'application/json' :
            filename.endsWith('.js') || filename.endsWith('.mjs') ? 'application/javascript' :
            'application/octet-stream'
        onAsset({path: 'ext/' + child.split(sep).join('/'), bytes: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex')})
        return new Response(bytes, {status: 200, headers: {'Content-Type': mediaType}})
    }
    return {root, ext}
}

export function installWorkers(repository, adapterState) {
    const root = resolve(repository)
    const entryDirectory = root + sep + 'ext' + sep + 'js' + sep + 'dictionary' + sep
    const allowed = new Set([
        'term-bank-wasm-parser-worker.js',
        'zstd-term-content-compression-worker.js',
        'term-record-import-index-worker.js'
    ])
    const workers = new Set()
    const receipts = []
    class Worker extends EventTarget {
        constructor(url, options = {}) {
            super()
            const filename = fileURLToPath(new URL(url))
            const entry = filename.slice(entryDirectory.length)
            if (!filename.startsWith(entryDirectory) || !allowed.has(entry) || options.type !== 'module') {
                throw new Error('Unexpected production Worker entry: ' + filename)
            }
            this.onmessage = null
            this.onerror = null
            this.onmessageerror = null
            this.receipt = {entry, name: options.name ?? null, ready: 0, sent: 0, received: 0,
                parseRequests: [], parseResults: [], compressionRequests: 0, compressionResults: 0,
                indexActions: {}, sourceConsumed: 0, assets: [], failures: [], terminated: false, exitCode: null}
            receipts.push(this.receipt)
            this.worker = new NodeWorker(new URL('./node-import-worker-bridge.mjs', import.meta.url), {
                workerData: {repository: root, entry: filename, adapterState: resolve(adapterState)},
                name: options.name
            })
            workers.add(this)
            this.worker.on('message', (data) => {
                if (data?.__manabitanCorrectnessAsset === true) {
                    this.receipt.assets.push(data.asset)
                    return
                }
                ++this.receipt.received
                if (data?.type === 'ready') ++this.receipt.ready
                if (data?.type === 'source-consumed') ++this.receipt.sourceConsumed
                if (data?.type === 'result' && entry === 'term-bank-wasm-parser-worker.js') {
                    this.receipt.parseResults.push({id: data.id, rowCount: data.rowCount})
                }
                if (entry === 'zstd-term-content-compression-worker.js' && data?.compressed instanceof ArrayBuffer) {
                    ++this.receipt.compressionResults
                }
                if (data?.type === 'initialization-error' || data?.type === 'parse-error' ||
                    (data?.error !== null && typeof data?.error !== 'undefined')) {
                    this.receipt.failures.push({type: data.type ?? null, error: data.error})
                }
                this.emit('message', {data})
            })
            this.worker.on('messageerror', (cause) => {
                this.receipt.failures.push({type: 'messageerror', error: String(cause)})
                this.emit('messageerror', {message: String(cause), error: cause})
            })
            this.worker.on('error', (cause) => {
                this.receipt.failures.push({type: 'error', error: String(cause)})
                this.emit('error', {message: String(cause), error: cause})
            })
            this.worker.on('exit', (code) => {
                this.receipt.exitCode = code
                workers.delete(this)
                if (!this.receipt.terminated && code !== 0) {
                    this.receipt.failures.push({type: 'unexpected-exit', error: String(code)})
                    this.emit('error', {message: 'Production worker exited with code ' + code})
                }
            })
        }
        emit(type, properties) {
            const event = new Event(type, {cancelable: type === 'error'})
            for (const [key, value] of Object.entries(properties)) Object.defineProperty(event, key, {value})
            this.dispatchEvent(event)
            if (typeof this['on' + type] === 'function') this['on' + type](event)
        }
        postMessage(data, transfer = []) {
            ++this.receipt.sent
            let message = data
            if (this.receipt.entry === 'term-record-import-index-worker.js' && data?.action === 'open') {
                message = {...data, fileHandle: exportFileHandle(data.fileHandle)}
            }
            if (data?.type === 'parse') {
                this.receipt.parseRequests.push({id: data.id,
                    banks: (data.sourceMetadata ?? []).map((source) => ({
                        filename: source.filename, compressionMethod: source.compressionMethod,
                        compressedSize: source.compressedSize, uncompressedSize: source.uncompressedSize,
                        signature: source.signature
                    })),
                    sourceByteLengths: (data.sourceBuffers ?? []).map((buffer) => buffer.byteLength)})
            }
            if (this.receipt.entry === 'zstd-term-content-compression-worker.js') ++this.receipt.compressionRequests
            if (this.receipt.entry === 'term-record-import-index-worker.js' && typeof data?.action === 'string') {
                this.receipt.indexActions[data.action] = (this.receipt.indexActions[data.action] ?? 0) + 1
            }
            this.worker.postMessage(message, Array.isArray(transfer) ? transfer : transfer.transfer ?? [])
        }
        terminate() {
            this.receipt.terminated = true
            return this.worker.terminate()
        }
    }
    Object.defineProperty(globalThis, 'Worker', {value: Worker, configurable: true, writable: true})
    return {
        receipts,
        async close() {
            await Promise.all([...workers].map((worker) => worker.terminate()))
        }
    }
}
