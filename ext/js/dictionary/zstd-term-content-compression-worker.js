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
    const data = /** @type {{id?: unknown, content?: unknown, source?: unknown, sourceOffsets?: unknown, sourceLengths?: unknown, contentBytes?: unknown, blockStartIndexes?: unknown, blockLengths?: unknown, dictName?: unknown, wrap?: unknown}} */ (rawData);
    const id = typeof data?.id === 'number' ? data.id : -1;
    try {
        const {compressTermContentZstd, compressWrappedTermContentZstd, compressWrappedTermContentZstdSpans} = await modulePromise;
        await initialization;
        const dictName = typeof data.dictName === 'string' ? data.dictName : null;
        /** @type {{bytes: Uint8Array, envelopeMs: number}} */
        let result;
        if (
            data.source instanceof Uint8Array &&
            data.sourceOffsets instanceof Uint32Array &&
            data.sourceLengths instanceof Uint32Array &&
            data.blockStartIndexes instanceof Uint32Array &&
            data.blockLengths instanceof Uint32Array
        ) {
            if (
                data.wrap !== true ||
                data.sourceOffsets.length !== data.sourceLengths.length ||
                data.blockStartIndexes.length !== data.blockLengths.length + 1 ||
                data.blockStartIndexes[0] !== 0 ||
                data.blockStartIndexes[data.blockLengths.length] !== data.sourceOffsets.length
            ) {
                throw new RangeError('Compression worker span batch input is invalid');
            }
            /** @type {ArrayBuffer[]} */
            const compressed = new Array(data.blockLengths.length);
            let envelopeMs = 0;
            for (let i = 0; i < data.blockLengths.length; ++i) {
                const start = data.blockStartIndexes[i];
                const end = data.blockStartIndexes[i + 1];
                if (end < start || end > data.sourceOffsets.length) {
                    throw new RangeError('Compression worker span batch partition is invalid');
                }
                const blockResult = compressWrappedTermContentZstdSpans(
                    data.source,
                    data.sourceOffsets.subarray(start, end),
                    data.sourceLengths.subarray(start, end),
                    data.blockLengths[i],
                    dictName,
                );
                envelopeMs += blockResult.envelopeMs;
                compressed[i] = toTransferableBuffer(blockResult.bytes);
            }
            self.postMessage(
                {id, compressed, envelopeMs},
                compressed,
            );
            return;
        } else if (
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
            result = compressWrappedTermContentZstdSpans(
                data.source,
                data.sourceOffsets,
                data.sourceLengths,
                data.contentBytes,
                dictName,
            );
        } else {
            if (!(data.content instanceof Uint8Array)) {
                throw new TypeError('Compression worker input is not a Uint8Array');
            }
            result = data.wrap === true ?
                compressWrappedTermContentZstd(data.content, dictName) :
                {bytes: compressTermContentZstd(data.content, dictName), envelopeMs: 0};
        }
        const {bytes, envelopeMs} = result;
        const compressed = toTransferableBuffer(bytes);
        self.postMessage({id, compressed, envelopeMs}, [compressed]);
    } catch (error) {
        self.postMessage({id, error: `${error}`});
    }
}

/**
 * @param {Uint8Array} bytes
 * @returns {ArrayBuffer}
 */
function toTransferableBuffer(bytes) {
    return (
        bytes.buffer instanceof ArrayBuffer &&
        bytes.byteOffset === 0 &&
        bytes.byteLength === bytes.buffer.byteLength
    ) ?
        bytes.buffer :
        Uint8Array.from(bytes).buffer;
}
