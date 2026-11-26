import {parentPort, workerData} from 'node:worker_threads'
import {pathToFileURL} from 'node:url'

globalThis.self = {
    addEventListener(type, listener) {
        if (type !== 'message') throw new Error(`Unsupported event ${type}`)
        parentPort.on('message', (data) => listener({data}))
    },
    postMessage(data, transfer) { parentPort.postMessage(data, transfer) },
}
await import(pathToFileURL(`${workerData.root}/ext/js/dictionary/term-bank-wasm-parser-worker.js`))
parentPort.postMessage({type: 'adapter-ready'})
