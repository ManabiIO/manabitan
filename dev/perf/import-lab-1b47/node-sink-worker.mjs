/* SPDX-License-Identifier: GPL-3.0-or-later */
// Test boundary only: Web Worker transport over Node worker_threads.
import {parentPort, workerData} from 'node:worker_threads';
import {installFileFetch} from './node-sink-file-fetch.mjs';
installFileFetch();
globalThis.self = globalThis;
Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {hardwareConcurrency: workerData.cpus, deviceMemory: workerData.memory}});
globalThis.addEventListener = (type, listener) => {
    if (type === 'message') { parentPort.on('message', (data) => listener({data})); }
};
globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
await import(workerData.url);
