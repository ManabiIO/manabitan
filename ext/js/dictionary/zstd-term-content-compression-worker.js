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

Reflect.set(globalThis, '__manabitanTermContentCompressionWorker', true);

const modulePromise = /** @type {Promise<typeof import('./zstd-term-content.js')>} */ (
    import('./zstd-term-content.js')
);
const initialization = modulePromise.then(({initializeTermContentZstd}) => initializeTermContentZstd());

/** @typedef {{type?: unknown, id?: unknown, content?: unknown, source?: unknown, sourceOffsets?: unknown, sourceLengths?: unknown, contentBytes?: unknown, dictName?: unknown, wrap?: unknown, compressionExperiments?: import('dictionary-importer').ImportExperiments, blockStartIndexes?: unknown, blockLengths?: unknown, nextBlock?: unknown, remainingSources?: unknown, batchId?: unknown, jobIds?: unknown}} CompressionMessage */

void initialization.then(
    () => { self.postMessage({type: 'ready'}); },
    (error) => { self.postMessage({type: 'initialization-error', error: `${error}`}); },
);

self.addEventListener('message', (event) => {
    const rawData = /** @type {unknown} */ (event.data);
    const data = /** @type {CompressionMessage} */ (rawData);
    if (data?.type === 'compress-spans-batch') {
        void compressSpanBatch(data);
    } else {
        void compressContent(data);
    }
});

/* eslint-disable @stylistic/semi */
/** @param {CompressionMessage} data */
async function compressSpanBatch(data) {
    try {
        const {source, sourceOffsets, sourceLengths, blockStartIndexes, blockLengths, nextBlock, remainingSources, batchId, jobIds} = data
        if (
            !(source instanceof Uint8Array) || !(source.buffer instanceof SharedArrayBuffer) ||
            !(sourceOffsets instanceof Uint32Array) || !(sourceLengths instanceof Uint32Array) ||
            !(blockStartIndexes instanceof Uint32Array) || !(blockLengths instanceof Uint32Array) ||
            !(nextBlock instanceof Uint32Array) || !(nextBlock.buffer instanceof SharedArrayBuffer) || nextBlock.length !== 1 ||
            !(remainingSources instanceof Uint32Array) || !(remainingSources.buffer instanceof SharedArrayBuffer) || remainingSources.length !== 1 ||
            (remainingSources.buffer === nextBlock.buffer && remainingSources.byteOffset === nextBlock.byteOffset) ||
            typeof batchId !== 'number' || !Number.isSafeInteger(batchId) || batchId <= 0 ||
            !Array.isArray(jobIds) || jobIds.length !== blockLengths.length || jobIds.length === 0 ||
            batchId !== jobIds[0] ||
            blockStartIndexes.length !== blockLengths.length + 1 || sourceOffsets.length !== sourceLengths.length ||
            blockStartIndexes[0] !== 0 || blockStartIndexes[blockLengths.length] !== sourceOffsets.length || data.wrap !== true
        ) {
            throw new TypeError('Compression worker batch input is invalid')
        }
        // Read the decreasing count first. Concurrent claims can only make
        // the following lower bound less restrictive.
        const unreadSources = Atomics.load(remainingSources, 0)
        if (unreadSources > jobIds.length || unreadSources < jobIds.length - Atomics.load(nextBlock, 0)) {
            throw new RangeError('Compression worker batch source count is invalid')
        }
        await initialization
        for (;;) {
            // The counter saturates at the block count, so even an exhausted
            // queue can be shared safely without an overflowing claim index.
            let block = Atomics.load(nextBlock, 0)
            for (;;) {
                if (block > jobIds.length) { throw new RangeError('Compression worker batch claim is invalid') }
                if (block === jobIds.length) { return }
                const observed = Atomics.compareExchange(nextBlock, 0, block, block + 1)
                if (observed === block) { break }
                block = observed
            }
            const start = blockStartIndexes[block]
            const end = blockStartIndexes[block + 1]
            if (end < start || end > sourceOffsets.length || !Number.isSafeInteger(jobIds[block])) {
                throw new RangeError('Compression worker batch block is invalid')
            }
            // Every result/error remains immediate with its original deadline.
            // A failed gather leaves the shared count nonzero; ordinary job
            // replies then drain the failed source barrier at completion.
            await compressContent({
                id: jobIds[block],
                source,
                sourceOffsets: sourceOffsets.subarray(start, end),
                sourceLengths: sourceLengths.subarray(start, end),
                contentBytes: blockLengths[block],
                dictName: data.dictName,
                wrap: true,
                compressionExperiments: data.compressionExperiments,
            }, () => {
                const previous = Atomics.sub(remainingSources, 0, 1)
                if (previous === 0 || previous > jobIds.length) {
                    throw new RangeError('Compression worker batch source count is invalid')
                }
                if (previous === 1) { self.postMessage({type: 'source-consumed-batch', batchId}) }
            })
        }
    } catch (error) {
        // A malformed batch or failed initialization leaves unclaimed jobs.
        // The coordinator terminates every reader before settling those jobs.
        self.postMessage({type: 'batch-error', error: `${error}`})
    }
}
/* eslint-enable @stylistic/semi */

/* eslint-disable @stylistic/semi */
/**
 * @param {CompressionMessage} data
 * @param {() => void} [onGathered]
 */
async function compressContent(data, onGathered) {
    const id = typeof data?.id === 'number' ? data.id : -1;
    let hasGathered = false
    try {
        const {compressTermContentZstd, compressWrappedTermContentZstd, finishWrappedTermContentZstdSpans, prepareWrappedTermContentZstdSpans} = await modulePromise;
        await initialization;
        const dictName = typeof data.dictName === 'string' ? data.dictName : null;
        const options = data.compressionExperiments ?? {};
        /** @type {{bytes: Uint8Array, envelopeMs: number}} */
        let result;
        if (
            data.source instanceof Uint8Array &&
            data.sourceOffsets instanceof Uint32Array &&
            data.sourceLengths instanceof Uint32Array
        ) {
            if (data.wrap !== true) { throw new TypeError('Span compression requires a wrapped output'); }
            if (
                typeof data.contentBytes !== 'number' ||
                !Number.isSafeInteger(data.contentBytes) ||
                data.contentBytes < 0 ||
                data.sourceOffsets.length !== data.sourceLengths.length
            ) {
                throw new RangeError('Compression worker span input is invalid');
            }
            const prepared = prepareWrappedTermContentZstdSpans(
                data.source,
                data.sourceOffsets,
                data.sourceLengths,
                data.contentBytes,
                dictName,
                options,
            );
            hasGathered = true
            if (typeof onGathered === 'function') {
                onGathered()
            } else {
                self.postMessage({type: 'source-consumed', id})
            }
            result = finishWrappedTermContentZstdSpans(prepared);
        } else {
            if (!(data.content instanceof Uint8Array)) {
                throw new TypeError('Compression worker input is not a Uint8Array');
            }
            result = data.wrap === true ?
                compressWrappedTermContentZstd(data.content, dictName, options) :
                {bytes: compressTermContentZstd(data.content, dictName), envelopeMs: 0};
        }
        const {bytes, envelopeMs} = result;
        const compressed = (
            bytes.buffer instanceof ArrayBuffer &&
            bytes.byteOffset === 0 &&
            bytes.byteLength === bytes.buffer.byteLength
        ) ?
            bytes.buffer :
            Uint8Array.from(bytes).buffer;
        self.postMessage({id, compressed, envelopeMs}, [compressed]);
    } catch (error) {
        self.postMessage({id, error: `${error}`, hasGathered})
    }
}
/* eslint-enable @stylistic/semi */
