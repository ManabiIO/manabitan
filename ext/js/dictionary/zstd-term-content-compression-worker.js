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
    const data = /** @type {{id?: unknown, content?: unknown, source?: unknown, sourceOffsets?: unknown, sourceLengths?: unknown, contentBytes?: unknown, spanBatch?: unknown, dictName?: unknown, wrap?: unknown, compressionExperiments?: import('dictionary-importer').ImportExperiments}} */ (rawData);
    const id = typeof data?.id === 'number' ? data.id : -1;
    try {
        const {compressTermContentZstd, compressWrappedTermContentZstd, finishWrappedTermContentZstdSpans, prepareWrappedTermContentZstdSpans} = await modulePromise;
        await initialization;
        const dictName = typeof data.dictName === 'string' ? data.dictName : null;
        const options = data.compressionExperiments ?? {};
        /* eslint-disable @stylistic/semi */
        if (Array.isArray(data.spanBatch)) {
            const spanBatch = /** @type {unknown[]} */ (data.spanBatch)
            /** @type {Array<{id: number, compressed: ArrayBuffer, envelopeMs: number}>} */
            const results = []
            /** @type {ArrayBuffer[]} */
            const transfer = []
            /** @type {number[]} */
            const consumed = []
            const acknowledgeSources = () => {
                if (consumed.length === 0) { return }
                self.postMessage({type: 'sources-consumed', ids: consumed})
                consumed.length = 0
            }
            for (let index = 0; index < spanBatch.length; ++index) {
                const block = /** @type {{id?: unknown, sourceOffsets?: unknown, sourceLengths?: unknown, contentBytes?: unknown}} */ (spanBatch[index])
                const blockId = typeof block?.id === 'number' ? block.id : -1
                let sourcePrepared = false
                try {
                    if (
                        data.wrap !== true || !(data.source instanceof Uint8Array) ||
                        !(block?.sourceOffsets instanceof Uint32Array) || !(block.sourceLengths instanceof Uint32Array) ||
                        typeof block.contentBytes !== 'number' || !Number.isSafeInteger(block.contentBytes) ||
                        block.contentBytes < 0 || block.sourceOffsets.length !== block.sourceLengths.length
                    ) { throw new RangeError('Compression worker span input is invalid') }
                    const prepared = prepareWrappedTermContentZstdSpans(
                        data.source,
                        block.sourceOffsets,
                        block.sourceLengths,
                        block.contentBytes,
                        dictName,
                        options,
                    )
                    sourcePrepared = true
                    consumed.push(blockId)
                    // Aggregate source release still occurs after this worker's
                    // final gather and before its final compression. Earlier
                    // owned frames stay within this already-admitted batch.
                    if (index + 1 === spanBatch.length) { acknowledgeSources() }
                    const {bytes, envelopeMs} = finishWrappedTermContentZstdSpans(prepared)
                    const compressed = (
                        bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 &&
                        bytes.byteLength === bytes.buffer.byteLength
                    ) ?
bytes.buffer :
Uint8Array.from(bytes).buffer
                    results.push({id: blockId, compressed, envelopeMs})
                    transfer.push(compressed)
                } catch (error) {
                    // Keep the first observed failure and continue every later
                    // logical job, just as separately queued worker messages do.
                    // A post-gather failure must retain its successful lease.
                    if (sourcePrepared) { self.postMessage({type: 'source-consumed', id: blockId}) }
                    self.postMessage({id: blockId, error: `${error}`})
                }
            }
            acknowledgeSources()
            self.postMessage({type: 'compression-results', results}, transfer)
            return
        }
        /* eslint-enable @stylistic/semi */
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
        const compressed = (
            bytes.buffer instanceof ArrayBuffer &&
            bytes.byteOffset === 0 &&
            bytes.byteLength === bytes.buffer.byteLength
        ) ?
            bytes.buffer :
            Uint8Array.from(bytes).buffer;
        self.postMessage({id, compressed, envelopeMs}, [compressed]);
    } catch (error) {
        /* eslint-disable @stylistic/semi */
        if (Array.isArray(data?.spanBatch)) {
            for (const rawBlock of /** @type {unknown[]} */ (data.spanBatch)) {
                const block = /** @type {{id?: unknown}} */ (rawBlock)
                self.postMessage({id: typeof block?.id === 'number' ? block.id : -1, error: `${error}`})
            }
        } else {
            self.postMessage({id, error: `${error}`})
        }
        /* eslint-enable @stylistic/semi */
    }
}
