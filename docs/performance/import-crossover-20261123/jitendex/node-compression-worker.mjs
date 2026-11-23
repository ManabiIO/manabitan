import {parentPort, workerData} from 'node:worker_threads'
import {readFile} from 'node:fs/promises'

globalThis.self = {
    addEventListener(type, listener) {
        if (type === 'message') parentPort.on('message', (data) => listener({data}))
    },
    postMessage(message, transfer = []) { parentPort.postMessage(message, transfer) },
}
globalThis.fetch = async (input) => {
    const url = new URL(String(input), workerData.url)
    if (url.protocol !== 'file:') throw new Error(`Unexpected worker resource ${url}`)
    return new Response(await readFile(url), {headers: {'Content-Type': 'application/wasm'}})
}
await import(workerData.url)
