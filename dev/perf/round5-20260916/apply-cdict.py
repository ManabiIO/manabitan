from pathlib import Path

p = Path('dev/bin/build-zstd-wasm.js')
s = p.read_text()
s = s.replace("    '_ZSTD_compress_usingDict',", "    '_ZSTD_compress_usingDict',\n    '_ZSTD_createCDict',\n    '_ZSTD_freeCDict',\n    '_ZSTD_compress_usingCDict',")
p.write_text(s)
p = Path('dev/lib/zstd-simd-module.d.ts')
s = p.read_text().replace('    _ZSTD_compressBound(size: number): number;', '''    _ZSTD_compressBound(size: number): number;
    _ZSTD_createCDict(dictionary: number, size: number, level: number): number;
    _ZSTD_freeCDict(dictionary: number): number;
    _ZSTD_compress_usingCDict(context: number, destination: number, capacity: number, source: number, size: number, dictionary: number): number;''')
p.write_text(s)
p = Path('dev/lib/zstd-wasm.js')
s = p.read_text()
s = s.replace('const TERM_CONTENT_BLOCK_ENVELOPE_BYTES = 12;', '''const TERM_CONTENT_BLOCK_ENVELOPE_BYTES = 12;
/** @type {Map<number, {pointer: number, bytes: Uint8Array, level: number}>} */
const preparedDictionaries = new Map();

/**
 * One owned prepared dictionary per live compressor. Check bytes rather than
 * object identity: callers may mutate and reuse a dictionary between calls.
 * @param {number} context
 * @param {Uint8Array} dictionary
 * @param {number} level
 * @returns {number}
 */
function preparedDictionary(context, dictionary, level) {
    const cached = preparedDictionaries.get(context);
    if (cached && cached.level === level && cached.bytes.length === dictionary.length) {
        let equal = true;
        for (let i = 0; i < dictionary.length; ++i) {
            if (cached.bytes[i] !== dictionary[i]) { equal = false; break; }
        }
        if (equal) { return cached.pointer; }
    }
    const module = getModule();
    if (cached) {
        module._ZSTD_freeCDict(cached.pointer);
        preparedDictionaries.delete(context);
    }
    const bytes = Uint8Array.from(dictionary);
    const buffers = contextBuffers.get(context);
    if (!buffers) { throw new Error('Missing compressor buffers'); }
    module.HEAPU8.set(bytes, buffers.dictionary);
    const pointer = module._ZSTD_createCDict(buffers.dictionary, bytes.length, level);
    if (pointer === 0) { throw new Error('Failed to prepare Zstd dictionary'); }
    preparedDictionaries.set(context, {pointer, bytes, level});
    return pointer;
}''')
s = s.replace('    releaseContextBuffers(context);\n    return getModule()._ZSTD_freeCCtx(context);', '''    const cached = preparedDictionaries.get(context);
    if (cached) {
        getModule()._ZSTD_freeCDict(cached.pointer);
        preparedDictionaries.delete(context);
    }
    releaseContextBuffers(context);
    return getModule()._ZSTD_freeCCtx(context);''')
s = s.replace('    module.HEAPU8.set(dictionary, buffers.dictionary);', '    const cdict = preparedDictionary(context, dictionary, level);')
s = s.replace('const size = module._ZSTD_compress_usingDict(', 'const size = module._ZSTD_compress_usingCDict(')
s = s.replace('        buffers.dictionary,\n        dictionary.byteLength,\n        level,', '        cdict,')
s = s.replace('        buffers.dictionary,\n        dictionaryBytes,\n        level,', '        cdict,')
s = s.replace('contentBytes: number, dictionaryBytes: number, prefixBytes: number, level: number, writeBlockEnvelope: boolean', 'contentBytes: number, dictionaryBytes: number, prefixBytes: number, level: number, writeBlockEnvelope: boolean, cdict: number')
s = s.replace('return {context, buffers, contentBytes, dictionaryBytes: dictionary.byteLength, prefixBytes, level, writeBlockEnvelope};', 'return {context, buffers, contentBytes, dictionaryBytes: dictionary.byteLength, prefixBytes, level, writeBlockEnvelope, cdict};')
s = s.replace('const {context, buffers, contentBytes, dictionaryBytes, prefixBytes, level, writeBlockEnvelope} = prepared;', 'const {context, buffers, contentBytes, prefixBytes, writeBlockEnvelope, cdict} = prepared;')
s = s.replace('if (contextBuffers.get(context) !== buffers) {', 'if (contextBuffers.get(context) !== buffers || preparedDictionaries.get(context)?.pointer !== cdict) {')
p.write_text(s)
