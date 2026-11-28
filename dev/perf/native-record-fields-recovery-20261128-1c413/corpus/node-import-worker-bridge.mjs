/* SPDX-License-Identifier: GPL-3.0-or-later */
// Actual worker_threads transport around unchanged production worker modules.
import {parentPort, workerData} from 'node:worker_threads'
import {basename, join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {installFileRuntime} from './node-runtime.mjs'
import {importFileHandle} from './node-opfs-disk.mjs'

if (parentPort === null) throw new Error('Expected a worker thread')
const allowed = new Set(['term-bank-wasm-parser-worker.js',
    'zstd-term-content-compression-worker.js', 'term-record-import-index-worker.js'])
const entry = resolve(workerData.entry)
if (!allowed.has(basename(entry)) ||
    entry !== join(resolve(workerData.repository), 'ext/js/dictionary', basename(entry))) {
    throw new Error('Unexpected production worker entry')
}
await installFileRuntime(workerData.repository, (asset) => {
    parentPort.postMessage({__manabitanCorrectnessAsset: true, asset})
})
Object.defineProperty(globalThis, 'navigator', {value: {
    hardwareConcurrency: 4, deviceMemory: 8, userAgent: 'Manabitan correctness-only worker adapter'
}, configurable: true})
const events = new EventTarget()
globalThis.addEventListener = events.addEventListener.bind(events)
globalThis.removeEventListener = events.removeEventListener.bind(events)
globalThis.postMessage = (value, transfer = []) => {
    parentPort.postMessage(value, Array.isArray(transfer) ? transfer : transfer.transfer ?? [])
}
const queued = []
let listening = false
const receive = (data) => {
    if (basename(entry) === 'term-record-import-index-worker.js' && data?.action === 'open') {
        data.fileHandle = importFileHandle(data.fileHandle, workerData.adapterState)
    }
    const event = new Event('message')
    Object.defineProperty(event, 'data', {value: data})
    events.dispatchEvent(event)
    if (typeof globalThis.onmessage === 'function') globalThis.onmessage(event)
}
parentPort.on('message', (data) => {
    if (!listening) queued.push(data)
    else receive(data)
})
await import(pathToFileURL(entry).href)
listening = true
for (const data of queued) receive(data)
queued.length = 0
