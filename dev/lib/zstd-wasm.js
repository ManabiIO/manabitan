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

/* eslint no-underscore-dangle: off */

import createZstdModule from './zstd-simd-module.js';

/** @type {import('core').SafeAny|null} */
let moduleInstance = null;
/** @type {Promise<void>|null} */
let initialization = null;
/** @type {Map<number, {source: number, sourceCapacity: number, destination: number, destinationCapacity: number, dictionary: number, dictionaryCapacity: number}>} */
const contextBuffers = new Map();
const TERM_CONTENT_BLOCK_ENVELOPE_BYTES = 12;

/**
 * @param {string} [path='/lib/zstd.wasm']
 * @returns {Promise<void>}
 * @throws {Error} If the module cannot be initialized.
 */
export async function init(path = '/lib/zstd.wasm') {
    if (moduleInstance !== null) { return; }
    if (initialization !== null) { return await initialization; }
    initialization = (async () => {
        moduleInstance = await createZstdModule({
            locateFile(fileName) {
                return fileName.endsWith('.wasm') ? path : fileName;
            },
        });
    })();
    try {
        await initialization;
    } catch (error) {
        initialization = null;
        throw error;
    }
}

/**
 * @returns {import('core').SafeAny}
 * @throws {Error} If the module is not initialized.
 */
function getModule() {
    if (moduleInstance === null) { throw new Error('Zstd WASM is not initialized'); }
    return moduleInstance;
}

/**
 * @param {number} code
 * @throws {Error} If Zstd reports an error result.
 */
function checkResult(code) {
    if (getModule()._ZSTD_isError(code) !== 0) {
        throw new Error(`Zstd operation failed with code ${code}`);
    }
}

/**
 * @param {number} context
 * @param {number} sourceSize
 * @param {number} destinationSize
 * @param {number} dictionarySize
 * @returns {{source: number, sourceCapacity: number, destination: number, destinationCapacity: number, dictionary: number, dictionaryCapacity: number}}
 * @throws {Error} If a required buffer cannot be allocated.
 */
function ensureContextBuffers(context, sourceSize, destinationSize, dictionarySize) {
    const module = getModule();
    let buffers = contextBuffers.get(context);
    if (typeof buffers === 'undefined') {
        buffers = {source: 0, sourceCapacity: 0, destination: 0, destinationCapacity: 0, dictionary: 0, dictionaryCapacity: 0};
        contextBuffers.set(context, buffers);
    }
    if (buffers.sourceCapacity < sourceSize) {
        if (buffers.source !== 0) { module._free(buffers.source); }
        buffers.source = 0;
        buffers.sourceCapacity = 0;
        buffers.source = module._malloc(sourceSize);
        if (buffers.source === 0) { throw new Error('Failed to allocate Zstd source buffer'); }
        buffers.sourceCapacity = sourceSize;
    }
    if (buffers.destinationCapacity < destinationSize) {
        if (buffers.destination !== 0) { module._free(buffers.destination); }
        buffers.destination = 0;
        buffers.destinationCapacity = 0;
        buffers.destination = module._malloc(destinationSize);
        if (buffers.destination === 0) { throw new Error('Failed to allocate Zstd destination buffer'); }
        buffers.destinationCapacity = destinationSize;
    }
    if (buffers.dictionaryCapacity < dictionarySize) {
        if (buffers.dictionary !== 0) { module._free(buffers.dictionary); }
        buffers.dictionary = 0;
        buffers.dictionaryCapacity = 0;
        buffers.dictionary = module._malloc(dictionarySize);
        if (buffers.dictionary === 0) { throw new Error('Failed to allocate Zstd dictionary buffer'); }
        buffers.dictionaryCapacity = dictionarySize;
    }
    return buffers;
}

/** @param {number} context */
function releaseContextBuffers(context) {
    const buffers = contextBuffers.get(context);
    if (typeof buffers === 'undefined') { return; }
    const module = getModule();
    if (buffers.source !== 0) { module._free(buffers.source); }
    if (buffers.destination !== 0) { module._free(buffers.destination); }
    if (buffers.dictionary !== 0) { module._free(buffers.dictionary); }
    contextBuffers.delete(context);
}

/** @returns {number} */
export function createCCtx() { return getModule()._ZSTD_createCCtx(); }

/** @returns {number} */
export function createDCtx() { return getModule()._ZSTD_createDCtx(); }

/**
 * @param {number} context
 * @returns {number}
 */
export function freeCCtx(context) {
    releaseContextBuffers(context);
    return getModule()._ZSTD_freeCCtx(context);
}

/**
 * @param {number} context
 * @returns {number}
 */
export function freeDCtx(context) {
    releaseContextBuffers(context);
    return getModule()._ZSTD_freeDCtx(context);
}

/**
 * @param {Uint8Array} content
 * @param {number} [level=3]
 * @returns {Uint8Array}
 * @throws {Error} If allocation or compression fails.
 */
export function compress(content, level = 3) {
    const module = getModule();
    const bound = module._ZSTD_compressBound(content.byteLength);
    const source = module._malloc(content.byteLength);
    if (source === 0) { throw new Error('Failed to allocate Zstd source buffer'); }
    try {
        const destination = module._malloc(bound);
        if (destination === 0) { throw new Error('Failed to allocate Zstd destination buffer'); }
        module.HEAPU8.set(content, source);
        try {
            const size = module._ZSTD_compress(destination, bound, source, content.byteLength, level);
            checkResult(size);
            return module.HEAPU8.slice(destination, destination + size);
        } finally {
            module._free(destination);
        }
    } finally {
        module._free(source);
    }
}

/**
 * @param {number} context
 * @param {Uint8Array} content
 * @param {Uint8Array} dictionary
 * @param {number} [level=3]
 * @returns {Uint8Array}
 */
export function compressUsingDict(context, content, dictionary, level = 3) {
    return compressUsingDictWithPrefix(context, content, dictionary, 0, level);
}

/**
 * Compresses into a retained WASM destination with room before the frame.
 * The returned array owns its bytes, and its prefix is zero-filled so callers
 * can write metadata without making a second copy of the compressed frame.
 * @param {number} context
 * @param {Uint8Array} content
 * @param {Uint8Array} dictionary
 * @param {number} prefixBytes
 * @param {number} [level=3]
 * @param {boolean} [writeBlockEnvelope=false]
 * @returns {Uint8Array}
 * @throws {Error} If allocation or compression fails.
 */
export function compressUsingDictWithPrefix(context, content, dictionary, prefixBytes, level = 3, writeBlockEnvelope = false) {
    if (!Number.isSafeInteger(prefixBytes) || prefixBytes < 0) {
        throw new RangeError('Zstd output prefix must be a non-negative safe integer');
    }
    if (writeBlockEnvelope && prefixBytes !== TERM_CONTENT_BLOCK_ENVELOPE_BYTES) {
        throw new RangeError('Zstd block integrity envelope requires a 12-byte prefix');
    }
    const module = getModule();
    const bound = module._ZSTD_compressBound(content.byteLength);
    const destinationSize = bound + prefixBytes;
    if (!Number.isSafeInteger(destinationSize)) {
        throw new RangeError('Zstd output buffer size exceeds the safe integer range');
    }
    const buffers = ensureContextBuffers(context, content.byteLength, destinationSize, dictionary.byteLength);
    module.HEAPU8.set(content, buffers.source);
    module.HEAPU8.set(dictionary, buffers.dictionary);
    if (prefixBytes > 0) {
        module.HEAPU8.fill(0, buffers.destination, buffers.destination + prefixBytes);
    }
    const size = module._ZSTD_compress_usingDict(
        context,
        buffers.destination + prefixBytes,
        buffers.destinationCapacity - prefixBytes,
        buffers.source,
        content.byteLength,
        buffers.dictionary,
        dictionary.byteLength,
        level,
    );
    checkResult(size);
    if (writeBlockEnvelope && module._manabitan_write_block_envelope(buffers.destination, prefixBytes + size) !== 1) {
        throw new Error('Failed to write Zstd block integrity envelope');
    }
    return module.HEAPU8.slice(
        buffers.destination,
        buffers.destination + prefixBytes + size,
    );
}

/**
 * Gathers logical spans directly into the retained WASM input buffer before
 * compression, avoiding a full packed JavaScript slab allocation.
 * @param {number} context
 * @param {Uint8Array} source
 * @param {Uint32Array} sourceOffsets
 * @param {Uint32Array} sourceLengths
 * @param {number} contentBytes
 * @param {Uint8Array} dictionary
 * @param {number} prefixBytes
 * @param {number} [level=3]
 * @param {boolean} [writeBlockEnvelope=false]
 * @returns {Uint8Array}
 * @throws {Error} If a span is invalid or allocation or compression fails.
 */
export function compressSpansUsingDictWithPrefix(
    context,
    source,
    sourceOffsets,
    sourceLengths,
    contentBytes,
    dictionary,
    prefixBytes,
    level = 3,
    writeBlockEnvelope = false,
) {
    return finishPreparedSpanCompression(prepareSpanCompression(
        context,
        source,
        sourceOffsets,
        sourceLengths,
        contentBytes,
        dictionary,
        prefixBytes,
        level,
        writeBlockEnvelope,
    ));
}

/**
 * Gathers source spans into retained WASM memory without starting compression.
 * Once this returns, callers may safely release or reuse the source bytes.
 * @param {number} context
 * @param {Uint8Array} source
 * @param {Uint32Array} sourceOffsets
 * @param {Uint32Array} sourceLengths
 * @param {number} contentBytes
 * @param {Uint8Array} dictionary
 * @param {number} prefixBytes
 * @param {number} [level=3]
 * @param {boolean} [writeBlockEnvelope=false]
 * @returns {{context: number, buffers: ReturnType<typeof ensureContextBuffers>, contentBytes: number, dictionaryBytes: number, prefixBytes: number, level: number, writeBlockEnvelope: boolean}}
 * @throws {Error} If a span is invalid or allocation fails.
 */
export function prepareSpanCompression(
    context,
    source,
    sourceOffsets,
    sourceLengths,
    contentBytes,
    dictionary,
    prefixBytes,
    level = 3,
    writeBlockEnvelope = false,
) {
    if (sourceOffsets.length !== sourceLengths.length) {
        throw new RangeError('Zstd source span offsets and lengths must have equal sizes');
    }
    if (!Number.isSafeInteger(contentBytes) || contentBytes < 0) {
        throw new RangeError('Zstd gathered content size must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(prefixBytes) || prefixBytes < 0) {
        throw new RangeError('Zstd output prefix must be a non-negative safe integer');
    }
    if (writeBlockEnvelope && prefixBytes !== TERM_CONTENT_BLOCK_ENVELOPE_BYTES) {
        throw new RangeError('Zstd block integrity envelope requires a 12-byte prefix');
    }
    const module = getModule();
    const bound = module._ZSTD_compressBound(contentBytes);
    const destinationSize = bound + prefixBytes;
    if (!Number.isSafeInteger(destinationSize)) {
        throw new RangeError('Zstd output buffer size exceeds the safe integer range');
    }
    const buffers = ensureContextBuffers(context, contentBytes, destinationSize, dictionary.byteLength);
    let outputOffset = 0;
    for (let i = 0; i < sourceOffsets.length;) {
        const runOffset = sourceOffsets[i];
        let runLength = 0;
        let runSpanCount = 0;
        let runEnd = runOffset;
        do {
            const sourceOffset = sourceOffsets[i];
            const sourceLength = sourceLengths[i];
            if (sourceOffset > source.byteLength || sourceLength > source.byteLength - sourceOffset) {
                throw new RangeError(`Zstd source span ${i} is out of bounds`);
            }
            if (sourceLength > contentBytes - outputOffset - runLength) {
                throw new RangeError(`Zstd source span ${i} exceeds the gathered content size`);
            }
            if (runSpanCount > 0 && sourceOffset !== runEnd) {
                break;
            }
            runLength += sourceLength;
            runEnd = sourceOffset + sourceLength;
            ++runSpanCount;
            ++i;
        } while (i < sourceOffsets.length);
        module.HEAPU8.set(
            source.subarray(runOffset, runOffset + runLength),
            buffers.source + outputOffset,
        );
        outputOffset += runLength;
    }
    if (outputOffset !== contentBytes) {
        throw new RangeError(`Zstd gathered ${outputOffset} bytes; expected ${contentBytes}`);
    }
    module.HEAPU8.set(dictionary, buffers.dictionary);
    if (prefixBytes > 0) {
        module.HEAPU8.fill(0, buffers.destination, buffers.destination + prefixBytes);
    }
    return {context, buffers, contentBytes, dictionaryBytes: dictionary.byteLength, prefixBytes, level, writeBlockEnvelope};
}

/**
 * @param {{context: number, buffers: ReturnType<typeof ensureContextBuffers>, contentBytes: number, dictionaryBytes: number, prefixBytes: number, level: number, writeBlockEnvelope: boolean}} prepared
 * @returns {Uint8Array}
 * @throws {Error} If the prepared buffers are stale or compression fails.
 */
export function finishPreparedSpanCompression(prepared) {
    const {context, buffers, contentBytes, dictionaryBytes, prefixBytes, level, writeBlockEnvelope} = prepared;
    const module = getModule();
    if (contextBuffers.get(context) !== buffers) {
        throw new Error('Prepared Zstd span buffers are no longer active');
    }
    const size = module._ZSTD_compress_usingDict(
        context,
        buffers.destination + prefixBytes,
        buffers.destinationCapacity - prefixBytes,
        buffers.source,
        contentBytes,
        buffers.dictionary,
        dictionaryBytes,
        level,
    );
    checkResult(size);
    if (writeBlockEnvelope && module._manabitan_write_block_envelope(buffers.destination, prefixBytes + size) !== 1) {
        throw new Error('Failed to write Zstd block integrity envelope');
    }
    return module.HEAPU8.slice(
        buffers.destination,
        buffers.destination + prefixBytes + size,
    );
}

/**
 * @param {Uint8Array} content
 * @param {{defaultHeapSize?: number}} [options]
 * @returns {Uint8Array}
 */
export function decompress(content, options = {}) {
    return decompressUsingContext(0, content, null, options.defaultHeapSize ?? 1024 * 1024);
}

/**
 * @param {number} context
 * @param {Uint8Array} content
 * @param {Uint8Array} dictionary
 * @param {{defaultHeapSize?: number}} [options]
 * @returns {Uint8Array}
 */
export function decompressUsingDict(context, content, dictionary, options = {}) {
    return decompressUsingContext(context, content, dictionary, options.defaultHeapSize ?? 1024 * 1024);
}

/**
 * @param {number} context
 * @param {Uint8Array} content
 * @param {Uint8Array|null} dictionary
 * @param {number} defaultHeapSize
 * @returns {Uint8Array}
 * @throws {Error} If the frame is invalid or allocation or decompression fails.
 */
function decompressUsingContext(context, content, dictionary, defaultHeapSize) {
    const module = getModule();
    const source = module._malloc(content.byteLength);
    if (source === 0) { throw new Error('Failed to allocate Zstd input buffer'); }
    try {
        module.HEAPU8.set(content, source);
        const frameSizeValue = module._ZSTD_getFrameContentSize(source, content.byteLength);
        const frameSize = typeof frameSizeValue === 'bigint' ? Number(frameSizeValue) : frameSizeValue;
        const outputSize = frameSize < 0 ? defaultHeapSize : frameSize;
        if (!Number.isSafeInteger(outputSize) || outputSize <= 0) {
            throw new Error(`Invalid Zstd frame content size: ${frameSizeValue}`);
        }
        const destination = module._malloc(outputSize);
        if (destination === 0) { throw new Error('Failed to allocate Zstd destination buffer'); }
        let dictionaryPointer = 0;
        try {
            dictionaryPointer = dictionary === null ? 0 : module._malloc(dictionary.byteLength);
            if (dictionary !== null && dictionaryPointer === 0) {
                throw new Error('Failed to allocate Zstd dictionary buffer');
            }
            if (dictionary !== null) { module.HEAPU8.set(dictionary, dictionaryPointer); }
            const size = dictionary === null ?
                module._ZSTD_decompress(destination, outputSize, source, content.byteLength) :
                module._ZSTD_decompress_usingDict(
                    context,
                    destination,
                    outputSize,
                    source,
                    content.byteLength,
                    dictionaryPointer,
                    dictionary.byteLength,
                );
            checkResult(size);
            return module.HEAPU8.slice(destination, destination + size);
        } finally {
            if (dictionaryPointer !== 0) { module._free(dictionaryPointer); }
            module._free(destination);
        }
    } finally {
        module._free(source);
    }
}
