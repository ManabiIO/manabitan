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

void initialization.then(
    () => { self.postMessage({type: 'ready'}); },
    (error) => { self.postMessage({type: 'initialization-error', error: `${error}`}); },
);

self.addEventListener('message', (event) => {
    void compressContent(event);
});

/** @param {MessageEvent} event */
async function compressContent(event) {
    const rawData = /** @type {unknown} */ (event.data);
    const data = /** @type {{type?: unknown, id?: unknown, content?: unknown, source?: unknown, sourceOffsets?: unknown, sourceLengths?: unknown, contentBytes?: unknown, blocks?: unknown, dictName?: unknown, wrap?: unknown, compressionExperiments?: import('dictionary-importer').ImportExperiments}} */ (rawData);
    const id = typeof data?.id === 'number' ? data.id : -1;
    try {
        const {compressTermContentZstd, compressWrappedTermContentZstd, finishWrappedTermContentZstdSpans, prepareWrappedTermContentZstdSpans} = await modulePromise;
        await initialization;
        const dictName = typeof data.dictName === 'string' ? data.dictName : null;
        const options = data.compressionExperiments ?? {};
        if (data.type === 'compress-spans-batch') {
            if (
                data.wrap !== true ||
                !(data.source instanceof Uint8Array) ||
                !(data.sourceOffsets instanceof Uint32Array) ||
                !(data.sourceLengths instanceof Uint32Array) ||
                data.sourceOffsets.length !== data.sourceLengths.length ||
                !Array.isArray(data.blocks) ||
                data.blocks.length === 0
            ) {
                throw new TypeError('Compression worker span batch is invalid');
            }
            const {source, sourceOffsets, sourceLengths, blocks} = data;
            for (const block of blocks) {
                if (
                    typeof block !== 'object' || block === null ||
                    !Number.isSafeInteger(block.start) || block.start < 0 ||
                    !Number.isSafeInteger(block.end) || block.end < block.start || block.end > sourceOffsets.length ||
                    !Number.isSafeInteger(block.contentBytes) || block.contentBytes < 0
                ) {
                    throw new RangeError('Compression worker span batch block is invalid');
                }
            }
            const compressedBatch = [];
            let envelopeMs = 0;
            for (let index = 0; index < blocks.length; ++index) {
                const {start, end, contentBytes} = blocks[index];
                // Finish each prepared handle before preparing the next block:
                // the codec reuses one native workspace within this worker.
                const prepared = prepareWrappedTermContentZstdSpans(
                    source,
                    sourceOffsets.subarray(start, end),
                    sourceLengths.subarray(start, end),
                    contentBytes,
                    dictName,
                    options,
                );
                if (index + 1 === blocks.length) {
                    self.postMessage({type: 'source-consumed', id});
                }
                const result = finishWrappedTermContentZstdSpans(prepared);
                compressedBatch.push(ownCompressedBytes(result.bytes));
                envelopeMs += result.envelopeMs;
            }
            self.postMessage({id, compressedBatch, envelopeMs}, compressedBatch);
            return;
        }
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
            self.postMessage({type: 'source-consumed', id});
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
        const compressed = ownCompressedBytes(bytes);
        self.postMessage({id, compressed, envelopeMs}, [compressed]);
    } catch (error) {
        self.postMessage({id, error: `${error}`});
    }
}

/**
 * @param {Uint8Array} bytes
 * @returns {ArrayBuffer}
 */
function ownCompressedBytes(bytes) {
    return (
        bytes.buffer instanceof ArrayBuffer &&
        bytes.byteOffset === 0 &&
        bytes.byteLength === bytes.buffer.byteLength
    ) ?
        bytes.buffer :
        Uint8Array.from(bytes).buffer;
}
