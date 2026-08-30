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
    const data = /** @type {{id?: unknown, content?: unknown, source?: unknown, sourceOffsets?: unknown, sourceLengths?: unknown, contentBytes?: unknown, dictName?: unknown, wrap?: unknown}} */ (rawData);
    const id = typeof data?.id === 'number' ? data.id : -1;
    try {
        const {compressTermContentZstd, compressWrappedTermContentZstd, finishWrappedTermContentZstdSpans, prepareWrappedTermContentZstdSpans} = await modulePromise;
        await initialization;
        const dictName = typeof data.dictName === 'string' ? data.dictName : null;
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
            );
            self.postMessage({type: 'source-consumed', id});
            result = finishWrappedTermContentZstdSpans(prepared);
        } else {
            if (!(data.content instanceof Uint8Array)) {
                throw new TypeError('Compression worker input is not a Uint8Array');
            }
            result = data.wrap === true ?
                compressWrappedTermContentZstd(data.content, dictName) :
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
        self.postMessage({id, error: `${error}`});
    }
}
