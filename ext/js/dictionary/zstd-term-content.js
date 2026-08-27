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

import {
    compress,
    compressSpansUsingDictWithPrefix,
    createCCtx,
    createDCtx,
    compressUsingDict,
    compressUsingDictWithPrefix,
    decompress,
    decompressUsingDict,
    freeCCtx,
    freeDCtx,
    init,
} from '../../lib/zstd-wasm.js';
import {log} from '../core/log.js';
import {safePerformance} from '../core/safe-performance.js';
import {TERM_CONTENT_BLOCK_ENVELOPE_BYTES, wrapCompressedTermContentBlock} from './term-content-block-envelope.js';

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

const COMPRESSION_WORKER_COUNT = 4;
const COMPRESSION_WORKER_READY_TIMEOUT_MS = 30_000;
const COMPRESSION_JOB_TIMEOUT_MS = 60_000;
const JMDICT_COMPRESSION_LEVEL = -3;

/**
 * @param {unknown} value
 * @returns {Uint8Array}
 * @throws {TypeError} If the generated Zstd wrapper returns invalid output.
 */
function requireCompressedBytes(value) {
    if (!(value instanceof Uint8Array)) {
        throw new TypeError('Zstd compression returned invalid bytes');
    }
    return value;
}

export class TermContentCompressionPool {
    /** @param {Worker[]} workers */
    constructor(workers) {
        if (workers.length === 0) { throw new RangeError('Term content compression pool requires a worker'); }
        /** @type {Worker[]} */
        this._workers = workers;
        /** @type {Map<number, {resolve: (value: {bytes: Uint8Array, envelopeMs: number}) => void, reject: (reason?: unknown) => void, timeoutId: ReturnType<typeof setTimeout>}>} */
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
        return (await this._compress(contents, dictName, false)).chunks;
    }

    /**
     * @param {Uint8Array[]} contents
     * @param {string|null} dictName
     * @returns {Promise<{chunks: Uint8Array[], envelopeMs: number, wrapped: true}>}
     */
    async compressWrapped(contents, dictName) {
        const {chunks, envelopeMs} = await this._compress(contents, dictName, true);
        return {
            chunks,
            envelopeMs,
            wrapped: true,
        };
    }

    /**
     * @param {Uint8Array} source
     * @param {Uint32Array} sourceOffsets
     * @param {Uint32Array} sourceLengths
     * @param {Uint32Array} blockStartIndexes
     * @param {Uint32Array} blockLengths
     * @param {string|null} dictName
     * @returns {Promise<{chunks: Uint8Array[], envelopeMs: number, wrapped: true}>}
     */
    async compressWrappedSpans(source, sourceOffsets, sourceLengths, blockStartIndexes, blockLengths, dictName) {
        if (this._failed) { throw new Error('Term content compression pool is unavailable'); }
        const blockCount = blockLengths.length;
        if (
            blockCount === 0 ||
            sourceOffsets.length !== sourceLengths.length ||
            blockStartIndexes.length !== blockCount + 1 ||
            blockStartIndexes[0] !== 0 ||
            blockStartIndexes[blockCount] !== sourceOffsets.length
        ) {
            throw new RangeError('Term content compression block plan is invalid');
        }
        for (let blockIndex = 0; blockIndex < blockCount; ++blockIndex) {
            const start = blockStartIndexes[blockIndex];
            const end = blockStartIndexes[blockIndex + 1];
            if (end < start || end > sourceOffsets.length) {
                throw new RangeError('Term content compression block span is invalid');
            }
        }
        const envelopeMsByWorker = new Float64Array(this._workers.length);
        const chunks = await Promise.all(Array.from(blockLengths, async (contentBytes, blockIndex) => {
            const workerIndex = blockIndex % this._workers.length;
            const start = blockStartIndexes[blockIndex];
            const end = blockStartIndexes[blockIndex + 1];
            const blockOffsets = sourceOffsets.slice(start, end);
            const blockSourceLengths = sourceLengths.slice(start, end);
            const result = await this._dispatch(
                workerIndex,
                {
                    source,
                    sourceOffsets: blockOffsets,
                    sourceLengths: blockSourceLengths,
                    contentBytes,
                    dictName,
                    wrap: true,
                },
                [blockOffsets.buffer, blockSourceLengths.buffer],
            );
            envelopeMsByWorker[workerIndex] += result.envelopeMs;
            return result.bytes;
        }));
        return {
            chunks,
            envelopeMs: Math.max(0, ...envelopeMsByWorker),
            wrapped: true,
        };
    }

    /**
     * @param {Uint8Array[]} contents
     * @param {string|null} dictName
     * @param {boolean} wrap
     * @returns {Promise<{chunks: Uint8Array[], envelopeMs: number}>}
     */
    async _compress(contents, dictName, wrap) {
        if (this._failed) { throw new Error('Term content compression pool is unavailable'); }
        if (contents.length === 0) { return {chunks: [], envelopeMs: 0}; }
        const seenBuffers = new Set();
        const sharedBuffers = new Set();
        for (const {buffer} of contents) {
            if (!(buffer instanceof ArrayBuffer)) { continue; }
            if (seenBuffers.has(buffer)) {
                sharedBuffers.add(buffer);
            } else {
                seenBuffers.add(buffer);
            }
        }
        const envelopeMsByWorker = new Float64Array(this._workers.length);
        const chunks = await Promise.all(contents.map(async (content, index) => {
            const workerIndex = index % this._workers.length;
            const {buffer} = content;
            /** @type {Transferable[]} */
            const transfer = [];
            if (
                buffer instanceof ArrayBuffer &&
                !sharedBuffers.has(buffer) &&
                content.byteOffset === 0 &&
                content.byteLength === buffer.byteLength
            ) {
                transfer.push(buffer);
            }
            const result = await this._dispatch(
                workerIndex,
                {content, dictName, wrap},
                transfer,
            );
            envelopeMsByWorker[workerIndex] += result.envelopeMs;
            return result.bytes;
        }));
        return {chunks, envelopeMs: Math.max(0, ...envelopeMsByWorker)};
    }

    /**
     * @param {number} workerIndex
     * @param {Record<string, unknown>} message
     * @param {Transferable[]} transfer
     * @returns {Promise<{bytes: Uint8Array, envelopeMs: number}>}
     */
    _dispatch(workerIndex, message, transfer) {
        const id = this._nextId++;
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this._fail(new Error(`Term content compression worker timed out after ${COMPRESSION_JOB_TIMEOUT_MS}ms`));
            }, COMPRESSION_JOB_TIMEOUT_MS);
            this._pending.set(id, {resolve, reject, timeoutId});
            try {
                this._workers[workerIndex].postMessage({id, ...message}, transfer);
            } catch (error) {
                clearTimeout(timeoutId);
                this._pending.delete(id);
                reject(error);
            }
        });
    }

    /** */
    close() {
        this._fail(new Error('Term content compression pool closed'));
    }

    /** @param {MessageEvent} event */
    _onMessage(event) {
        const rawData = /** @type {unknown} */ (event.data);
        const data = /** @type {{id?: unknown, compressed?: unknown, envelopeMs?: unknown, error?: unknown}} */ (rawData);
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
        pending.resolve({
            bytes: new Uint8Array(data.compressed),
            envelopeMs: typeof data.envelopeMs === 'number' && Number.isFinite(data.envelopeMs) && data.envelopeMs >= 0 ? data.envelopeMs : 0,
        });
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
        let nextDctx = 0;
        try {
            nextDctx = Number(createDCtx());
            if (nextDctx === 0) {
                throw new Error('Failed to create zstd decompression context');
            }
        } catch (error) {
            if (nextDctx !== 0) { freeDCtx(nextDctx); }
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

/**
 * Compresses and integrity-wraps blocks before they cross the worker boundary.
 * @param {Uint8Array[]} contents
 * @param {string|null} dictName
 * @returns {Promise<{chunks: Uint8Array[], envelopeMs: number, wrapped: boolean}>}
 */
export async function compressWrappedTermContentZstdBatch(contents, dictName) {
    if (contents.length < 2) {
        let envelopeMs = 0;
        const chunks = contents.map((content) => {
            const result = compressWrappedTermContentZstd(content, dictName);
            envelopeMs += result.envelopeMs;
            return result.bytes;
        });
        return {chunks, envelopeMs, wrapped: true};
    }
    try {
        const pool = await initializeCompressionPool();
        if (pool !== null && !pool.failed) {
            return await pool.compressWrapped(contents, dictName);
        }
    } catch (error) {
        const hasDetachedInput = contents.some((content) => content.byteLength === 0);
        log.warn(new Error(
            hasDetachedInput ?
                `Parallel wrapped term content compression failed after input transfer; caller repack required: ${error}` :
                `Parallel wrapped term content compression failed; using synchronous compression: ${error}`,
        ));
        compressionPool?.close();
        compressionPool = null;
        compressionPoolPromise = null;
        // A successful postMessage transfer detaches the sender's packed slab.
        // The block-store owner can reconstruct those slabs from stable source
        // bytes; attempting the local fallback here would only fail or encode an
        // empty block before that owner gets a chance to repack.
        if (hasDetachedInput) {
            throw error;
        }
    }
    let envelopeMs = 0;
    const chunks = contents.map((content) => {
        const result = compressWrappedTermContentZstd(content, dictName);
        envelopeMs += result.envelopeMs;
        return result.bytes;
    });
    return {chunks, envelopeMs, wrapped: true};
}

/**
 * @param {Uint8Array} source
 * @param {Uint32Array} sourceOffsets
 * @param {Uint32Array} sourceLengths
 * @param {Uint32Array} blockStartIndexes
 * @param {Uint32Array} blockLengths
 * @param {string|null} dictName
 * @returns {Promise<{chunks: Uint8Array[], envelopeMs: number, wrapped: true}>}
 */
export async function compressWrappedTermContentZstdSpansBatch(
    source,
    sourceOffsets,
    sourceLengths,
    blockStartIndexes,
    blockLengths,
    dictName,
) {
    if (blockLengths.length === 1) {
        const result = compressWrappedTermContentZstdSpans(
            source,
            sourceOffsets,
            sourceLengths,
            blockLengths[0],
            dictName,
        );
        return {chunks: [result.bytes], envelopeMs: result.envelopeMs, wrapped: true};
    }
    try {
        const pool = await initializeCompressionPool();
        if (pool !== null && !pool.failed) {
            return await pool.compressWrappedSpans(
                source,
                sourceOffsets,
                sourceLengths,
                blockStartIndexes,
                blockLengths,
                dictName,
            );
        }
    } catch (error) {
        compressionPool?.close();
        compressionPool = null;
        compressionPoolPromise = null;
        throw error;
    }
    throw new Error('Parallel span compression is unavailable');
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
        return compressUsingDict(cctx, content, jmdictDict, JMDICT_COMPRESSION_LEVEL);
    }
    return compress(content, 1);
}

/**
 * @param {Uint8Array} content
 * @param {string|null} dictName
 * @returns {{bytes: Uint8Array, envelopeMs: number}}
 * @throws {Error} If Zstd is unavailable or compression fails.
 */
export function compressWrappedTermContentZstd(content, dictName) {
    if (!isInitialized || cctx === null) {
        throw new Error('Term content zstd not initialized');
    }
    if (dictName === 'jmdict' && jmdictDict !== null) {
        const output = requireCompressedBytes(compressUsingDictWithPrefix(
            cctx,
            content,
            jmdictDict,
            TERM_CONTENT_BLOCK_ENVELOPE_BYTES,
            JMDICT_COMPRESSION_LEVEL,
            true,
        ));
        return {bytes: output, envelopeMs: 0};
    }
    const compressed = requireCompressedBytes(compress(content, 1));
    const start = safePerformance.now();
    const output = wrapCompressedTermContentBlock(compressed);
    return {bytes: output, envelopeMs: safePerformance.now() - start};
}

/**
 * @param {Uint8Array} source
 * @param {Uint32Array} sourceOffsets
 * @param {Uint32Array} sourceLengths
 * @param {number} contentBytes
 * @param {string|null} dictName
 * @returns {{bytes: Uint8Array, envelopeMs: number}}
 * @throws {Error} If the dictionary is unavailable or compression fails.
 */
export function compressWrappedTermContentZstdSpans(source, sourceOffsets, sourceLengths, contentBytes, dictName) {
    if (!isInitialized || cctx === null || dictName !== 'jmdict' || jmdictDict === null) {
        throw new Error('Term content zstd dictionary is unavailable');
    }
    const output = requireCompressedBytes(compressSpansUsingDictWithPrefix(
        cctx,
        source,
        sourceOffsets,
        sourceLengths,
        contentBytes,
        jmdictDict,
        TERM_CONTENT_BLOCK_ENVELOPE_BYTES,
        JMDICT_COMPRESSION_LEVEL,
        true,
    ));
    return {bytes: output, envelopeMs: 0};
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
