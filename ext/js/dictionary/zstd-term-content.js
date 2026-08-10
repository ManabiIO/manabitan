/*
 * Copyright (C) 2026 Manabitan authors
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

import {createCCtx, createDCtx, compress, compressUsingDict, decompress, decompressUsingDict, freeCCtx, init} from '../../lib/zstd-wasm.js';
import {log} from '../core/log.js';

let isInitialized = false;
/** @type {Promise<void>|null} */
let initializePromise = null;
/** @type {Uint8Array|null} */
let jmdictDict = null;
/** @type {number|null} */
let cctx = null;
/** @type {number|null} */
let dctx = null;
/** @type {TermContentCompressionPool|null} */
let compressionPool = null;
/** @type {Promise<TermContentCompressionPool|null>|null} */
let compressionPoolPromise = null;

const COMPRESSION_WORKER_COUNT = 3;
const COMPRESSION_WORKER_READY_TIMEOUT_MS = 30_000;
const COMPRESSION_JOB_TIMEOUT_MS = 60_000;

class TermContentCompressionPool {
    /** @param {Worker[]} workers */
    constructor(workers) {
        /** @type {Worker[]} */
        this._workers = workers;
        /** @type {Map<number, {resolve: (value: Uint8Array) => void, reject: (reason?: unknown) => void, timeoutId: ReturnType<typeof setTimeout>}>} */
        this._pending = new Map();
        /** @type {number} */
        this._nextId = 1;
        /** @type {boolean} */
        this._failed = false;
        for (const worker of workers) {
            worker.addEventListener('message', (event) => { this._onMessage(event); });
            worker.addEventListener('error', (event) => {
                this._fail(new Error(event.message || 'Term content compression worker failed'));
            });
            worker.addEventListener('messageerror', () => {
                this._fail(new Error('Term content compression worker returned an invalid message'));
            });
        }
    }

    /** @returns {boolean} */
    get failed() { return this._failed; }

    /**
     * @param {Uint8Array[]} contents
     * @param {string|null} dictName
     * @returns {Promise<Uint8Array[]>}
     */
    async compress(contents, dictName) {
        if (this._failed) { throw new Error('Term content compression pool is unavailable'); }
        return await Promise.all(contents.map((content, index) => {
            const id = this._nextId++;
            return new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    this._fail(new Error(`Term content compression worker timed out after ${COMPRESSION_JOB_TIMEOUT_MS}ms`));
                }, COMPRESSION_JOB_TIMEOUT_MS);
                this._pending.set(id, {resolve, reject, timeoutId});
                try {
                    this._workers[index % this._workers.length].postMessage(
                        {id, content, dictName},
                        [content.buffer],
                    );
                } catch (error) {
                    clearTimeout(timeoutId);
                    this._pending.delete(id);
                    reject(error);
                }
            });
        }));
    }

    /** */
    close() {
        this._fail(new Error('Term content compression pool closed'));
    }

    /** @param {MessageEvent} event */
    _onMessage(event) {
        const rawData = /** @type {unknown} */ (event.data);
        const data = /** @type {{id?: unknown, compressed?: unknown, error?: unknown}} */ (rawData);
        const id = typeof data?.id === 'number' ? data.id : -1;
        const pending = this._pending.get(id);
        if (typeof pending === 'undefined') { return; }
        this._pending.delete(id);
        clearTimeout(pending.timeoutId);
        if (typeof data.error === 'string') {
            pending.reject(new Error(data.error));
            return;
        }
        if (!(data.compressed instanceof ArrayBuffer)) {
            pending.reject(new Error('Term content compression worker returned invalid bytes'));
            return;
        }
        pending.resolve(new Uint8Array(data.compressed));
    }

    /** @param {Error} error */
    _fail(error) {
        if (this._failed) { return; }
        this._failed = true;
        for (const worker of this._workers) { worker.terminate(); }
        this._workers = [];
        for (const {reject, timeoutId} of this._pending.values()) {
            clearTimeout(timeoutId);
            reject(error);
        }
        this._pending.clear();
    }
}

/**
 * @returns {Promise<void>}
 */
export async function initializeTermContentZstd() {
    if (isInitialized) { return; }
    if (initializePromise !== null) {
        await initializePromise;
        return;
    }
    initializePromise = (async () => {
        await init('/lib/zstd.wasm');
        const response = await fetch('/lib/zstd-dicts/jmdict.zdict');
        if (!response.ok) {
            throw new Error(`Failed to load zstd dictionary: ${response.status}`);
        }
        const loadedJmdictDict = new Uint8Array(await response.arrayBuffer());
        if (loadedJmdictDict.byteLength === 0) {
            throw new Error('Loaded zstd dictionary is empty');
        }
        const nextCctx = Number(createCCtx());
        if (nextCctx === 0) {
            throw new Error('Failed to create zstd compression context');
        }
        let nextDctx;
        try {
            nextDctx = Number(createDCtx());
            if (nextDctx === 0) {
                throw new Error('Failed to create zstd decompression context');
            }
        } catch (error) {
            freeCCtx(nextCctx);
            throw error;
        }
        cctx = nextCctx;
        dctx = nextDctx;
        jmdictDict = loadedJmdictDict;
        isInitialized = true;
        // Prewarm workers while archive/index preparation continues.
        void initializeCompressionPool();
    })();

    try {
        await initializePromise;
    } catch (e) {
        initializePromise = null;
        throw e;
    }
}

/**
 * Compresses independent blocks concurrently when module workers are
 * available. Packed input slabs are transferred to avoid structured-clone
 * copies; callers can reconstruct them from source entries after failure.
 * @param {Uint8Array[]} contents
 * @param {string|null} dictName
 * @returns {Promise<Uint8Array[]>}
 */
export async function compressTermContentZstdBatch(contents, dictName) {
    if (contents.length < 2) {
        return contents.map((content) => Uint8Array.from(compressTermContentZstd(content, dictName)));
    }
    try {
        const pool = await initializeCompressionPool();
        if (pool !== null && !pool.failed) {
            return await pool.compress(contents, dictName);
        }
    } catch (error) {
        log.warn(new Error(`Parallel term content compression failed; using synchronous compression: ${error}`));
        compressionPool?.close();
        compressionPool = null;
        compressionPoolPromise = null;
        if (contents.some((content) => content.byteLength === 0)) {
            throw error;
        }
    }
    return contents.map((content) => Uint8Array.from(compressTermContentZstd(content, dictName)));
}

/** @returns {Promise<TermContentCompressionPool|null>} */
async function initializeCompressionPool() {
    if (compressionPool !== null && !compressionPool.failed) { return compressionPool; }
    if (compressionPoolPromise !== null) { return await compressionPoolPromise; }
    if (
        typeof Worker === 'undefined' ||
        Reflect.get(globalThis, '__manabitanTermContentCompressionWorker') === true
    ) {
        return null;
    }
    compressionPoolPromise = (async () => {
        /** @type {Worker[]} */
        const workers = [];
        try {
            const readyPromises = [];
            for (let i = 0; i < COMPRESSION_WORKER_COUNT; ++i) {
                const worker = new Worker(
                    new URL('zstd-term-content-compression-worker.js', import.meta.url),
                    {type: 'module'},
                );
                workers.push(worker);
                readyPromises.push(waitForCompressionWorkerReady(worker));
            }
            await Promise.all(readyPromises);
            compressionPool = new TermContentCompressionPool(workers);
            return compressionPool;
        } catch (error) {
            for (const worker of workers) { worker.terminate(); }
            log.warn(new Error(`Term content compression workers unavailable: ${error}`));
            return null;
        }
    })();
    try {
        return await compressionPoolPromise;
    } finally {
        compressionPoolPromise = null;
    }
}

/**
 * @param {Worker} worker
 * @returns {Promise<void>}
 */
function waitForCompressionWorkerReady(worker) {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            cleanup();
            reject(new Error(`Compression worker initialization timed out after ${COMPRESSION_WORKER_READY_TIMEOUT_MS}ms`));
        }, COMPRESSION_WORKER_READY_TIMEOUT_MS);
        /** @param {MessageEvent<unknown>} event */
        const onMessage = (event) => {
            const rawData = /** @type {unknown} */ (event.data);
            const data = /** @type {{type?: unknown, error?: unknown}} */ (rawData);
            if (data?.type !== 'ready' && data?.type !== 'initialization-error') { return; }
            cleanup();
            if (data.type === 'ready') {
                resolve();
            } else {
                reject(new Error(typeof data.error === 'string' ? data.error : 'Compression worker initialization failed'));
            }
        };
        /** @param {ErrorEvent} event */
        const onError = (event) => {
            cleanup();
            reject(new Error(event.message || 'Compression worker initialization failed'));
        };
        const cleanup = () => {
            clearTimeout(timeoutId);
            worker.removeEventListener('message', onMessage);
            worker.removeEventListener('error', onError);
        };
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
    });
}

/**
 * @param {string} dictionaryTitle
 * @returns {string|null}
 */
export function resolveTermContentZstdDictName(dictionaryTitle) {
    const normalized = dictionaryTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalized.includes('jmdict') || normalized.includes('jitendex')) {
        return 'jmdict';
    }
    return null;
}

/**
 * @param {Uint8Array} content
 * @param {string|null} dictName
 * @returns {Uint8Array}
 * @throws {Error}
 */
export function compressTermContentZstd(content, dictName) {
    if (!isInitialized || cctx === null) {
        throw new Error('Term content zstd not initialized');
    }
    if (dictName === 'jmdict' && jmdictDict !== null) {
        return compressUsingDict(cctx, content, jmdictDict, 1);
    }
    return compress(content, 1);
}

/**
 * @param {Uint8Array} content
 * @param {string|null} dictName
 * @returns {Uint8Array}
 * @throws {Error}
 */
export function decompressTermContentZstd(content, dictName) {
    if (!isInitialized || dctx === null) {
        throw new Error('Term content zstd not initialized');
    }
    if (dictName === 'jmdict' && jmdictDict !== null) {
        return decompressUsingDict(dctx, content, jmdictDict);
    }
    return decompress(content);
}

/**
 * @param {unknown} error
 */
export function logTermContentZstdError(error) {
    log.error(error);
}
