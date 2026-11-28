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

import {hashTermEntryContentBytesPair} from './term-entry-content-hash.js';
import {TERM_CONTENT_BLOCK_ENVELOPE_BYTES, TERM_CONTENT_BLOCK_ENVELOPE_MAGIC, wrapCompressedTermContentBlock} from './term-content-block-envelope.js';
import {compress, compressUsingDict, createCCtx, createDCtx, decompress, decompressUsingDict, freeCCtx, init} from '../../lib/zstd-wasm.js';

/** @type {number} */
let cctx = 0;
/** @type {number} */
let dctx = 0;

const codecReady = (async () => {
    await init(new URL('../../lib/zstd.wasm', import.meta.url).href);
    cctx = Number(createCCtx());
    if (cctx === 0) { throw new Error('Failed to create term-content compression context'); }
    dctx = Number(createDCtx());
    if (dctx === 0) {
        freeCCtx(cctx);
        cctx = 0;
        throw new Error('Failed to create term-content decompression context');
    }
})();

void codecReady.then(
    () => { self.postMessage({type: 'ready'}); },
    (error) => { self.postMessage({type: 'initialization-error', error: `${error}`}); },
);

self.addEventListener('message', (event) => {
    void handleMessage(event);
});

/**
 * @param {MessageEvent<unknown>} event
 * @returns {Promise<void>}
 * @throws {Error} For invalid or unavailable codec operations.
 */
async function handleMessage(event) {
    const data = /** @type {{id?: unknown, action?: unknown, bytes?: unknown, codecId?: unknown, dictionary?: unknown, envelope?: unknown, expectedDecodedLength?: unknown, maxOutputSize?: unknown, wrap?: unknown, level?: unknown}} */ (event.data);
    const id = data?.id;
    if (!Number.isSafeInteger(id) || (data.action !== 'decode' && data.action !== 'compress')) {
        self.postMessage({id, error: 'Invalid term-content codec request', errorKind: 'invalid-input'});
        return;
    }

    try {
        await codecReady;
        const bytes = data.bytes;
        if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 16 * 1024 * 1024) {
            throw typedError('TermContentCodecInputError', 'Term-content codec input is outside its byte limit');
        }
        const codecId = data.codecId;
        if (codecId !== null && (typeof codecId !== 'string' || codecId.length === 0 || codecId.length > 128)) {
            throw typedError('TermContentCodecInputError', 'Term-content codec identity is invalid');
        }
        const dictionaryInput = data.dictionary;
        let dictionary = null;
        if (codecId !== null) {
            if (!(dictionaryInput instanceof Uint8Array) || dictionaryInput.byteLength === 0 || dictionaryInput.byteLength > 128 * 1024) {
                throw typedError('TermContentCodecInputError', 'Custom codec dictionary is missing or outside its byte limit');
            }
            dictionary = dictionaryInput;
        } else if (typeof dictionaryInput !== 'undefined' && dictionaryInput !== null) {
            throw typedError('TermContentCodecInputError', 'Vanilla codec request must not include a dictionary');
        }
        if (data.action === 'decode') {
            const expectedDecodedLength = data.expectedDecodedLength;
            const maxOutputSize = data.maxOutputSize;
            if (typeof expectedDecodedLength !== 'number' || !Number.isSafeInteger(expectedDecodedLength) || expectedDecodedLength <= 0 || expectedDecodedLength > 128 * 1024 * 1024 ||
            typeof maxOutputSize !== 'number' || !Number.isSafeInteger(maxOutputSize) || maxOutputSize < expectedDecodedLength || maxOutputSize > 128 * 1024 * 1024) {
                throw typedError('TermContentCodecInputError', 'Decoded frame size is outside its limit');
            }
            const compressed = data.envelope === 'mbc2' ? unwrapEnvelope(bytes) : bytes;
            if (data.envelope !== 'mbc2' && data.envelope !== 'none') {
                throw typedError('TermContentCodecInputError', 'Term-content frame envelope is unsupported');
            }
            const decodedValue = /** @type {unknown} */ (dictionary === null ?
                decompress(compressed, {defaultHeapSize: expectedDecodedLength, maxOutputSize}) :
                decompressUsingDict(dctx, compressed, dictionary, {defaultHeapSize: expectedDecodedLength, maxOutputSize}));
            const decoded = decodedValue instanceof Uint8Array ? decodedValue : null;
            if (!(decoded instanceof Uint8Array) || decoded.byteLength !== expectedDecodedLength) {
                throw typedError('TermContentCodecOutputError', 'Decoded term-content frame length did not match its manifest');
            }
            const output = ownedBuffer(decoded);
            self.postMessage({id, bytes: output}, [output]);
            return;
        }

        if (data.wrap !== true && data.wrap !== false) {
            throw typedError('TermContentCodecInputError', 'Term-content frame envelope mode is invalid');
        }
        const level = typeof data.level === 'undefined' ? 1 : data.level;
        if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 3) {
            throw typedError('TermContentCodecInputError', 'Term-content background compression level is unsupported');
        }
        const compressedValue = /** @type {unknown} */ (dictionary === null ? compress(bytes, level) : compressUsingDict(cctx, bytes, dictionary, level));
        const compressed = compressedValue instanceof Uint8Array ? compressedValue : null;
        if (compressed === null) { throw typedError('TermContentCodecOutputError', 'Compressed term-content frame was invalid'); }
        const outputValue = /** @type {unknown} */ (data.wrap ? wrapCompressedTermContentBlock(compressed) : compressed);
        const outputBytes = outputValue instanceof Uint8Array ? outputValue : null;
        if (outputBytes === null) { throw typedError('TermContentCodecOutputError', 'Compressed term-content output was invalid'); }
        const output = ownedBuffer(outputBytes);
        self.postMessage({id, bytes: output}, [output]);
    } catch (error) {
        const codecError = error instanceof Error ? error : new Error('Term-content codec worker failed');
        const errorKind = codecError.name === 'TermContentCodecInputError' ?
            'invalid-input' :
            (codecError.name === 'TermContentCodecOutputError' ? 'invalid-output' : 'unavailable');
        self.postMessage({id, error: codecError.message, errorKind});
    }
}

/**
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 * @throws {Error} If the checksum is invalid.
 */
function unwrapEnvelope(bytes) {
    if (bytes.byteLength <= TERM_CONTENT_BLOCK_ENVELOPE_BYTES ||
    TERM_CONTENT_BLOCK_ENVELOPE_MAGIC.some((value, index) => bytes[index] !== value)) {
        throw typedError('TermContentCodecInputError', 'Compressed term-content envelope is invalid');
    }
    const compressed = bytes.subarray(TERM_CONTENT_BLOCK_ENVELOPE_BYTES);
    const [hash1, hash2] = hashTermEntryContentBytesPair(compressed);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(4, true) !== hash1 || view.getUint32(8, true) !== hash2) {
        throw typedError('TermContentCodecInputError', 'Compressed term-content envelope checksum is invalid');
    }
    return compressed;
}

/**
 * @param {Uint8Array} bytes
 * @returns {ArrayBuffer}
 * @throws {TypeError} If copied output cannot be represented by an ArrayBuffer.
 */
function ownedBuffer(bytes) {
    return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer ?
        bytes.buffer :
        Uint8Array.from(bytes).buffer;
}

/**
 * @param {string} name
 * @param {string} message
 * @returns {Error}
 */
function typedError(name, message) {
    const error = new Error(message);
    error.name = name;
    return error;
}
