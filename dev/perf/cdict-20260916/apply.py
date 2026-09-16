from pathlib import Path
import hashlib, json, sys

assert sys.argv[1] == 'cdict'


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    assert s.count(old) == count, (path, s.count(old), old[:120])
    p.write_text(s.replace(old, new))

# Export the stable public Zstd CDict APIs from the pinned single-file build.
replace('dev/bin/build-zstd-wasm.js', "    '_ZSTD_createCCtx',\n", "    '_ZSTD_createCCtx',\n    '_ZSTD_createCDict',\n    '_ZSTD_freeCDict',\n")
replace('dev/bin/build-zstd-wasm.js', "    '_ZSTD_compress_usingDict',\n", "    '_ZSTD_compress_usingDict',\n    '_ZSTD_compress_usingCDict',\n")

replace('dev/lib/zstd-simd-module.d.ts', '    _ZSTD_createCCtx(): number;\n', '''    _ZSTD_createCCtx(): number;\n    _ZSTD_createCDict(dictionary: number, dictionarySize: number, level: number): number;\n    _ZSTD_freeCDict(dictionary: number): number;\n''')
replace('dev/lib/zstd-simd-module.d.ts', '    _ZSTD_compress_usingDict(context: number, destination: number, capacity: number, source: number, size: number, dictionary: number, dictionarySize: number, level: number): number;\n', '''    _ZSTD_compress_usingDict(context: number, destination: number, capacity: number, source: number, size: number, dictionary: number, dictionarySize: number, level: number): number;\n    _ZSTD_compress_usingCDict(context: number, destination: number, capacity: number, source: number, size: number, dictionary: number): number;\n''')

wrapper = Path('dev/lib/zstd-wasm.js')
s = wrapper.read_text()
anchor = '/** @returns {number} */\nexport function createDCtx() { return getModule()._ZSTD_createDCtx(); }\n'
assert s.count(anchor) == 1
addition = r'''/**
 * Builds an immutable native compression dictionary once for repeated use.
 * Zstd copies/digests the input during creation, so the JS bytes may be reused
 * after this synchronous call returns.
 * @param {Uint8Array} dictionary
 * @param {number} [level=3]
 * @returns {number}
 */
export function createCDict(dictionary, level = 3) {
    const module = getModule();
    const source = module._malloc(dictionary.byteLength);
    if (source === 0) { throw new Error('Failed to allocate Zstd dictionary input'); }
    try {
        module.HEAPU8.set(dictionary, source);
        const cdict = module._ZSTD_createCDict(source, dictionary.byteLength, level);
        if (cdict === 0) { throw new Error('Failed to create Zstd compression dictionary'); }
        return cdict;
    } finally {
        module._free(source);
    }
}

/** @param {number} dictionary @returns {number} */
export function freeCDict(dictionary) { return getModule()._ZSTD_freeCDict(dictionary); }

'''
s = s.replace(anchor, addition + anchor)

# Add CDict compression next to the existing raw-dictionary wrapper. It uses the
# same retained context buffers and output-envelope path but no per-block raw
# dictionary allocation/copy/digest.
anchor = '/**\n * Gathers logical spans directly into the retained WASM input buffer before\n'
idx = s.index(anchor)
addition = r'''/**
 * @param {number} context
 * @param {Uint8Array} content
 * @param {number} dictionary
 * @param {number} [prefixBytes=0]
 * @param {boolean} [writeBlockEnvelope=false]
 * @returns {Uint8Array}
 */
export function compressUsingCDictWithPrefix(context, content, dictionary, prefixBytes = 0, writeBlockEnvelope = false) {
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
    const buffers = ensureContextBuffers(context, content.byteLength, destinationSize, 0);
    module.HEAPU8.set(content, buffers.source);
    if (prefixBytes > 0) {
        module.HEAPU8.fill(0, buffers.destination, buffers.destination + prefixBytes);
    }
    const size = module._ZSTD_compress_usingCDict(
        context,
        buffers.destination + prefixBytes,
        buffers.destinationCapacity - prefixBytes,
        buffers.source,
        content.byteLength,
        dictionary,
    );
    checkResult(size);
    if (writeBlockEnvelope && module._manabitan_write_block_envelope(buffers.destination, prefixBytes + size) !== 1) {
        throw new Error('Failed to write Zstd block integrity envelope');
    }
    return module.HEAPU8.slice(buffers.destination, buffers.destination + prefixBytes + size);
}

'''
s = s[:idx] + addition + s[idx:]

# Reuse the existing validated span gather with an empty raw dictionary, then
# finish against a compiled dictionary. This keeps one span-validation path.
anchor = '/**\n * @param {{context: number, buffers: ReturnType<typeof ensureContextBuffers>, contentBytes: number, dictionaryBytes: number, prefixBytes: number, level: number, writeBlockEnvelope: boolean}} prepared\n * @returns {Uint8Array}\n'
idx = s.index(anchor)
addition = r'''/**
 * @param {number} context
 * @param {Uint8Array} source
 * @param {Uint32Array} sourceOffsets
 * @param {Uint32Array} sourceLengths
 * @param {number} contentBytes
 * @param {number} dictionary
 * @param {number} prefixBytes
 * @param {boolean} [writeBlockEnvelope=false]
 * @returns {{prepared: ReturnType<typeof prepareSpanCompression>, dictionary: number}}
 */
export function prepareSpanCompressionUsingCDict(
    context,
    source,
    sourceOffsets,
    sourceLengths,
    contentBytes,
    dictionary,
    prefixBytes,
    writeBlockEnvelope = false,
) {
    return {
        prepared: prepareSpanCompression(
            context,
            source,
            sourceOffsets,
            sourceLengths,
            contentBytes,
            new Uint8Array(),
            prefixBytes,
            0,
            writeBlockEnvelope,
        ),
        dictionary,
    };
}

/**
 * @param {{prepared: ReturnType<typeof prepareSpanCompression>, dictionary: number}} operation
 * @returns {Uint8Array}
 */
export function finishPreparedSpanCompressionUsingCDict(operation) {
    const {prepared, dictionary} = operation;
    const {context, buffers, contentBytes, prefixBytes, writeBlockEnvelope} = prepared;
    const module = getModule();
    if (contextBuffers.get(context) !== buffers) {
        throw new Error('Prepared Zstd span buffers are no longer active');
    }
    const size = module._ZSTD_compress_usingCDict(
        context,
        buffers.destination + prefixBytes,
        buffers.destinationCapacity - prefixBytes,
        buffers.source,
        contentBytes,
        dictionary,
    );
    checkResult(size);
    if (writeBlockEnvelope && module._manabitan_write_block_envelope(buffers.destination, prefixBytes + size) !== 1) {
        throw new Error('Failed to write Zstd block integrity envelope');
    }
    return module.HEAPU8.slice(buffers.destination, buffers.destination + prefixBytes + size);
}

'''
s = s[:idx] + addition + s[idx:]
wrapper.write_text(s)

term = Path('ext/js/dictionary/zstd-term-content.js')
s = term.read_text()
s = s.replace('    compressUsingDict,\n    compressUsingDictWithPrefix,\n', '    compressUsingDict,\n    compressUsingCDictWithPrefix,\n    compressUsingDictWithPrefix,\n')
s = s.replace('    createCCtx,\n    createDCtx,\n', '    createCCtx,\n    createCDict,\n    createDCtx,\n')
s = s.replace('    finishPreparedSpanCompression,\n    freeCCtx,\n', '    finishPreparedSpanCompression,\n    finishPreparedSpanCompressionUsingCDict,\n    freeCCtx,\n    freeCDict,\n')
s = s.replace('    prepareSpanCompression,\n', '    prepareSpanCompression,\n    prepareSpanCompressionUsingCDict,\n')
s = s.replace('/** @type {number|null} */\nlet dctx = null;\n', '/** @type {number|null} */\nlet dctx = null;\n/** @type {number|null} */\nlet jmdictCDict = null;\n')
old = '''        let nextDctx = 0;\n        try {\n            nextDctx = Number(createDCtx());\n            if (nextDctx === 0) {\n                throw new Error('Failed to create zstd decompression context');\n            }\n        } catch (error) {\n            if (nextDctx !== 0) { freeDCtx(nextDctx); }\n            freeCCtx(nextCctx);\n            throw error;\n        }\n        cctx = nextCctx;\n        dctx = nextDctx;\n        jmdictDict = loadedJmdictDict;\n'''
new = '''        let nextDctx = 0;\n        let nextCDict = 0;\n        try {\n            nextCDict = Number(createCDict(loadedJmdictDict, JMDICT_COMPRESSION_LEVEL));\n            if (nextCDict === 0) {\n                throw new Error('Failed to create zstd compression dictionary');\n            }\n            nextDctx = Number(createDCtx());\n            if (nextDctx === 0) {\n                throw new Error('Failed to create zstd decompression context');\n            }\n        } catch (error) {\n            if (nextDctx !== 0) { freeDCtx(nextDctx); }\n            if (nextCDict !== 0) { freeCDict(nextCDict); }\n            freeCCtx(nextCctx);\n            throw error;\n        }\n        cctx = nextCctx;\n        dctx = nextDctx;\n        jmdictCDict = nextCDict;\n        jmdictDict = loadedJmdictDict;\n'''
assert s.count(old) == 1
s = s.replace(old, new)
old = '''    if (dictName === 'jmdict' && jmdictDict !== null) {\n        return compressUsingDict(cctx, content, jmdictDict, JMDICT_COMPRESSION_LEVEL);\n    }\n'''
new = '''    if (dictName === 'jmdict' && jmdictCDict !== null) {\n        return compressUsingCDictWithPrefix(cctx, content, jmdictCDict);\n    }\n'''
assert s.count(old) == 1
s = s.replace(old, new)
old = '''    if (dictName === 'jmdict' && jmdictDict !== null) {\n        const output = requireCompressedBytes(compressUsingDictWithPrefix(\n            cctx,\n            content,\n            jmdictDict,\n            TERM_CONTENT_BLOCK_ENVELOPE_BYTES,\n            JMDICT_COMPRESSION_LEVEL,\n            true,\n        ));\n'''
new = '''    if (dictName === 'jmdict' && jmdictCDict !== null) {\n        const output = requireCompressedBytes(compressUsingCDictWithPrefix(\n            cctx,\n            content,\n            jmdictCDict,\n            TERM_CONTENT_BLOCK_ENVELOPE_BYTES,\n            true,\n        ));\n'''
assert s.count(old) == 1
s = s.replace(old, new)
old = '''    if (!isInitialized || cctx === null || dictName !== 'jmdict' || jmdictDict === null) {\n        throw new Error('Term content zstd dictionary is unavailable');\n    }\n    return prepareSpanCompression(\n        cctx,\n        source,\n        sourceOffsets,\n        sourceLengths,\n        contentBytes,\n        jmdictDict,\n        TERM_CONTENT_BLOCK_ENVELOPE_BYTES,\n        JMDICT_COMPRESSION_LEVEL,\n        true,\n    );\n'''
new = '''    if (!isInitialized || cctx === null || dictName !== 'jmdict' || jmdictCDict === null) {\n        throw new Error('Term content zstd dictionary is unavailable');\n    }\n    return prepareSpanCompressionUsingCDict(\n        cctx,\n        source,\n        sourceOffsets,\n        sourceLengths,\n        contentBytes,\n        jmdictCDict,\n        TERM_CONTENT_BLOCK_ENVELOPE_BYTES,\n        true,\n    );\n'''
assert s.count(old) == 1
s = s.replace(old, new)
old = '''export function finishWrappedTermContentZstdSpans(prepared) {\n    const output = requireCompressedBytes(finishPreparedSpanCompression(prepared));\n'''
new = '''export function finishWrappedTermContentZstdSpans(prepared) {\n    const output = requireCompressedBytes(finishPreparedSpanCompressionUsingCDict(prepared));\n'''
assert s.count(old) == 1
s = s.replace(old, new)
term.write_text(s)

# A focused real-WASM test verifies repeated dictionary use, source lifetime,
# independent decoded output, and no use-after-free of the native CDict.
test = Path('test/zstd-cdict.test.js')
test.write_text(r'''/* Copyright (C) 2026 Manabitan authors */
/* SPDX-License-Identifier: GPL-3.0-or-later */
import {readFile} from 'node:fs/promises';
import {beforeAll, describe, expect, test} from 'vitest';
import {
    compressUsingCDictWithPrefix,
    createCCtx,
    createCDict,
    createDCtx,
    decompressUsingDict,
    finishPreparedSpanCompressionUsingCDict,
    freeCCtx,
    freeCDict,
    freeDCtx,
    init,
    prepareSpanCompressionUsingCDict,
} from '../dev/lib/zstd-wasm.js';

beforeAll(async () => {
    const wasmBinary = new Uint8Array(await readFile(new URL('../dev/data/zstd-simd.wasm', import.meta.url)));
    await initWithBinary(wasmBinary);
});

async function initWithBinary(wasmBinary) {
    const {default: create} = await import('../dev/lib/zstd-simd-module.js');
    // The wrapper singleton cannot take a binary directly; install a blob-like
    // data URL path is not available in Node. Existing zstd-wasm tests cover
    // wrapper init; this test instead uses the exported default path after the
    // checked-in/generated asset is built by the candidate workflow.
    void create;
    await init(new URL('../dev/data/zstd-simd.wasm', import.meta.url).pathname);
}

function bytes(seed, length) {
    const value = new Uint8Array(length);
    for (let i = 0; i < length; ++i) value[i] = (Math.imul(i + seed, 131) ^ (i >>> 3)) & 255;
    return value;
}

describe('compiled Zstd dictionary reuse', () => {
    test('reuses one CDict for repeated owned frames and decodes with the raw dictionary', () => {
        const dictionary = new TextEncoder().encode('Japanese dictionary definition noun verb expression reading glossary '.repeat(20));
        const cctx = createCCtx();
        const dctx = createDCtx();
        const cdict = createCDict(dictionary, -1);
        try {
            for (let i = 0; i < 40; ++i) {
                const input = bytes(i, 500 + i * 37);
                const output = compressUsingCDictWithPrefix(cctx, input, cdict, 0, false);
                expect(decompressUsingDict(dctx, output, dictionary)).toEqual(input);
            }
        } finally {
            freeCDict(cdict); freeCCtx(cctx); freeDCtx(dctx);
        }
    });

    test('prepared span input owns source bytes before compression and preserves envelope', () => {
        const dictionary = new TextEncoder().encode('Japanese dictionary content '.repeat(40));
        const cctx = createCCtx();
        const dctx = createDCtx();
        const cdict = createCDict(dictionary, -1);
        try {
            const source = bytes(7, 9000);
            const expected = new Uint8Array(6000);
            expected.set(source.subarray(31, 3031), 0);
            expected.set(source.subarray(5000, 8000), 3000);
            const operation = prepareSpanCompressionUsingCDict(cctx, source, new Uint32Array([31, 5000]), new Uint32Array([3000, 3000]), 6000, cdict, 12, true);
            source.fill(0);
            const wrapped = finishPreparedSpanCompressionUsingCDict(operation);
            expect(wrapped.byteLength).toBeGreaterThan(12);
            expect(decompressUsingDict(dctx, wrapped.subarray(12), dictionary)).toEqual(expected);
        } finally {
            freeCDict(cdict); freeCCtx(cctx); freeDCtx(dctx);
        }
    });
});
''')

changed = [
    'dev/bin/build-zstd-wasm.js', 'dev/lib/zstd-simd-module.d.ts', 'dev/lib/zstd-wasm.js',
    'ext/js/dictionary/zstd-term-content.js', 'test/zstd-cdict.test.js',
]
print(json.dumps({'changed': changed, 'hashes': {p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in changed}}))
