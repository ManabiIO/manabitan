import {parentPort, workerData} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
const originalFetch = globalThis.fetch;
globalThis.fetch = async (value, options) => {
 const url = new URL(value instanceof Request ? value.url : value);
 return url.protocol === 'file:' ? new Response(await readFile(url), {headers: {'Content-Type': 'application/wasm'}}) : originalFetch(value, options);
};
globalThis.self = globalThis;
globalThis.addEventListener = (type, listener) => {
 if (type === 'message') parentPort.on('message', data => listener({data}));
};
globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
await import(workerData.url);
