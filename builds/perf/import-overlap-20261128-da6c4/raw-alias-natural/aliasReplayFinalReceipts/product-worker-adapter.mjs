// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import {Worker as NodeWorker} from 'node:worker_threads';
import {describeFileHandle} from './archived/raw-alias-node-opfs.mjs';
export function createWorkerAdapter(rootPath) {
    const workers = [], receivedByPreparedMap = new WeakMap();
    class WorkerAdapter {
        constructor(entry) {
            this.entry = String(entry);
            assert(/\/(?:zstd-term-content-compression-worker|term-record-import-index-worker|term-bank-wasm-parser-worker)\.js$/.test(new URL(entry).pathname));
            this.kind = /term-record-import-index-worker/.test(this.entry) ? 'index' : (/term-bank-wasm-parser-worker/.test(this.entry) ? 'parser' : 'compression');
            this.listeners = new Map(); this.messages = 0; this.transferBytes = 0; this.readySeen = false;
            this.termination = null; this.terminationRequested = false; this.failures = []; this.jobs = new Map(); this.results = [];
            this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
            void this.ready.catch(() => {});
            this.worker = new NodeWorker(new URL('./product-worker-bridge.mjs', import.meta.url), {workerData: {entry: this.entry, rootPath}, execArgv: []});
            workers.push(this);
            this.worker.on('message', (data) => {
                if (data?.type === 'ready') { this.readySeen = true; this.resolveReady(); }
                if (data?.type === 'initialization-error') { this.rejectReady(new Error(String(data.error))); }
                if (this.kind === 'parser' && data?.type === 'result') {
                    const chunk = data.chunk, files = this.jobs.get(data.id); assert(files);
                    const receipt = {files, rows: data.rowCount, ownsContentBytes: data.ownsContentBytes,
                        borrowsWorkerMemory: data.borrowsWorkerMemory, mediaRows: chunk?.mediaRows?.length ?? null,
                        sourceBufferKind: chunk?.contentBytesBuffer?.buffer?.constructor?.name ?? null};
                    this.results.push(receipt); this.jobs.delete(data.id);
                    if (chunk?.preparedLookupIndexes instanceof Map) { receivedByPreparedMap.set(chunk.preparedLookupIndexes, receipt); }
                }
                for (const listener of this.listeners.get('message') ?? []) { listener({data}); }
            });
            this.worker.on('error', (error) => this.fail('error', error));
            this.worker.on('messageerror', (error) => this.fail('messageerror', error));
            this.worker.on('exit', (code) => {
                if (!this.terminationRequested) { this.fail('exit', new Error('Unexpected worker exit ' + code)); }
                else if (!this.readySeen) { this.rejectReady(new Error('Terminated before readiness')); }
            });
        }
        fail(event, error) {
            this.failures.push({event, message: String(error)}); this.rejectReady(error);
            for (const listener of this.listeners.get(event === 'messageerror' ? 'messageerror' : 'error') ?? []) { listener({error, message: String(error)}); }
        }
        addEventListener(type, listener) { if (!this.listeners.has(type)) { this.listeners.set(type, new Set()); } this.listeners.get(type).add(listener); }
        removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
        postMessage(message, transfer = []) {
            let data = message;
            if (this.kind === 'index' && data.action === 'open') { data = {...data, fileHandle: describeFileHandle(data.fileHandle)}; }
            if (this.kind === 'parser' && data.type === 'parse') {
                assert(Array.isArray(data.sourceMetadata)); this.jobs.set(data.id, data.sourceMetadata.map(({filename}) => filename));
            }
            ++this.messages; for (const item of transfer) { if (item instanceof ArrayBuffer) { this.transferBytes += item.byteLength; } }
            this.worker.postMessage(data, transfer);
        }
        terminate() { this.terminationRequested = true; this.termination ??= this.worker.terminate(); return this.termination; }
    }
    return {WorkerAdapter, workers, receivedByPreparedMap,
        receipts: () => workers.map(({kind, readySeen, messages, transferBytes, failures, results}) => ({kind, readySeen, messages, transferBytes, failures, resultCount: results.length})),
        assertHealthy: () => assert(workers.every(({failures}) => failures.length === 0), 'Worker failure or unexpected exit'),
        terminateAll: async () => {
            const results = await Promise.allSettled(workers.map((worker) => worker.terminate()));
            const failures = results.filter(({status}) => status === 'rejected').map(({reason}) => reason);
            if (failures.length) { throw new AggregateError(failures, 'Worker termination failed'); }
        },
    };
}
