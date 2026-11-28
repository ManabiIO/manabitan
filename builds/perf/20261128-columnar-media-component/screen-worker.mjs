import {parentPort, workerData} from 'node:worker_threads';
import {columnFields, digestValue} from './screen-digest.mjs';

// Qualification only. Timed observations use the existing stock Node adapter.
globalThis.self = globalThis;
globalThis.addEventListener = (type, listener) => {
    if (type === 'message') { parentPort.on('message', (data) => listener({data})); }
};
globalThis.postMessage = (message, transfer = []) => {
    if (message.type !== 'result' || message.chunk === null) {
        parentPort.postMessage(message, transfer);
        return;
    }
    const buffers = transfer.filter((value) => value instanceof ArrayBuffer);
    const screenProof = {
        payloadHash: digestValue(columnFields(message.chunk)),
        bufferCount: buffers.length,
        uniqueBufferCount: new Set(buffers).size,
        transferredBytes: buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0),
        memory: process.memoryUsage(),
    };
    parentPort.postMessage({...message, screenProof}, transfer);
    parentPort.postMessage({
        type: 'screen-transfer-detached',
        id: message.id,
        detached: buffers.every((buffer) => buffer.byteLength === 0),
    });
};
await import(workerData.url);
