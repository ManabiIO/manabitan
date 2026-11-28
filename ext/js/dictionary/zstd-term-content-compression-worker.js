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
    const rawData = /** @type {unknown} */ (event.data);
    const data = /** @type {{messages?: unknown}|null} */ (rawData);
    const operation = Array.isArray(data?.messages) ? compressBatch(data.messages) : compressContent(event.data);
    // A failed error reply must fail the worker as well, so the pool can
    // terminate every reader and settle its source leases immediately.
    void operation.catch((error) => {
        setTimeout(() => { throw error; }, 0);
    });
});

/**
 * @param {Record<string, unknown>} response
 * @param {Transferable[]} [transfer]
 */
function postResponse(response, transfer = []) {
    self.postMessage(response, transfer);
}

/**
 * @param {Array<Record<string, unknown>>} responses
 * @param {Transferable[]} [transfer]
 */
function postResponses(responses, transfer = []) {
    if (responses.length === 0) { return; }
    try {
        postResponse({responses}, transfer);
    } catch (error) {
        // Structured cloning is atomic. If the grouped reply fails, settle
        // each buffered job with the transport failure instead of a timeout.
        for (const {id} of responses) { postResponse({id, error: `${error}`}); }
    }
}

/** @param {unknown[]} messages */
async function compressBatch(messages) {
    /** @type {Array<Record<string, unknown>>} */
    const consumed = [];
    /** @type {Array<Record<string, unknown>>} */
    const responses = [];
    /** @type {Transferable[]} */
    const transfers = [];
    const flushConsumed = () => { postResponses(consumed.splice(0)); };
    for (let index = 0; index < messages.length; ++index) {
        await compressContent(messages[index], (response, transfer = []) => {
            if (response.type === 'source-consumed') {
                consumed.push(response);
                // All blocks have now copied their source into private WASM
                // memory. Release the lease before the last compression.
                if (index === messages.length - 1) { flushConsumed(); }
            } else if (typeof response.error === 'string') {
                flushConsumed();
                postResponse(response);
            } else {
                responses.push(response);
                transfers.push(...transfer);
            }
        });
    }
    flushConsumed();
    postResponses(responses, transfers);
}

/**
 * @param {unknown} rawData
 * @param {(response: Record<string, unknown>, transfer?: Transferable[]) => void} [respond]
 */
async function compressContent(rawData, respond = postResponse) {
    const data = /** @type {{id?: unknown, content?: unknown, source?: unknown, sourceOffsets?: unknown, sourceLengths?: unknown, contentBytes?: unknown, dictName?: unknown, wrap?: unknown, compressionExperiments?: import('dictionary-importer').ImportExperiments}} */ (rawData);
    const id = typeof data?.id === 'number' ? data.id : -1;
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
            respond({type: 'source-consumed', id});
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
        respond({id, compressed, envelopeMs}, [compressed]);
    } catch (error) {
        respond({id, error: `${error}`});
    }
}
