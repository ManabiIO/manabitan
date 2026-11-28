// Diagnostic host adapter: unchanged browser workers run in Node worker_threads.
import {parentPort, workerData} from 'node:worker_threads'
import {readFile} from 'node:fs/promises'
import {openSync, writeSync, ftruncateSync, fsyncSync, closeSync} from 'node:fs'
import {fileURLToPath} from 'node:url'

globalThis.self = globalThis
Object.defineProperty(globalThis, 'navigator', {value: {hardwareConcurrency: workerData.hardwareConcurrency, deviceMemory: workerData.deviceMemory}, configurable: true})
const originalFetch = globalThis.fetch
globalThis.fetch = async (resource, options) => {
    const url = resource instanceof URL ? resource : new URL(typeof resource === 'string' ? resource : resource.url)
    return url.protocol === 'file:' ? new Response(await readFile(fileURLToPath(url)), {headers: {'Content-Type': 'application/wasm'}}) : originalFetch(resource, options)
}
const listeners = []
const backlog = []
let initialized = false
globalThis.addEventListener = (type, listener) => {
    if (type === 'message') listeners.push(listener)
}
globalThis.removeEventListener = (type, listener) => {
    if (type === 'message') {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
    }
}
globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer)
const dispatch = (data) => {
    // Node structured clone strips the test file handle prototype. Hydrate only
    // the handle sent by the real import-index client, preserving its real worker.
    if (data?.action === 'open' && typeof data.fileHandle?.location === 'string') {
        const location = data.fileHandle.location
        data.fileHandle = {
            async createSyncAccessHandle() {
                const fd = openSync(location, 'r+')
                return {
                    write(buffer, {at = 0} = {}) { return writeSync(fd, buffer, 0, buffer.byteLength, at) },
                    truncate(size) { ftruncateSync(fd, size) },
                    flush() { fsyncSync(fd) },
                    close() { closeSync(fd) },
                }
            },
        }
    }
    const event = {data}
    for (const listener of listeners) listener(event)
    globalThis.onmessage?.(event)
}
parentPort.on('message', (data) => {
    if (initialized) dispatch(data)
    else backlog.push(data)
})
await import(workerData.url)
initialized = true
for (const data of backlog) dispatch(data)
