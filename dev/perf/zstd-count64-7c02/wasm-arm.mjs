import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// Research-only adapter. Matches the production level/dictionary/native API.
// Four independently reset contexts model worker reuse; calls remain serial.
export async function openArm(directory, maximumSourceBytes, maximumDictionaryBytes) {
    const {default: create} = await import(pathToFileURL(path.join(directory, 'zstd-simd-module.js')).href);
    const module = await create({wasmBinary: await readFile(path.join(directory, 'zstd-simd-module.wasm'))});
    const outputCapacity = module._ZSTD_compressBound(maximumSourceBytes);
    const source = module._malloc(Math.max(1, maximumSourceBytes));
    const output = module._malloc(outputCapacity + 12);
    const dictionary = module._malloc(Math.max(1, maximumDictionaryBytes));
    assert.ok(source && output && dictionary);
    const contexts = Array.from({length: 4}, () => module._ZSTD_createCCtx());
    const decoder = module._ZSTD_createDCtx();
    assert.ok(contexts.every(Boolean) && decoder);
    let counter = 0;
    function prepare(bytes, dict) {
        assert.ok(bytes.byteLength <= maximumSourceBytes && dict.byteLength <= maximumDictionaryBytes);
        module.HEAPU8.set(bytes, source);
        module.HEAPU8.set(dict, dictionary);
    }
    return {
        module,
        compress(bytes, dict, worker = counter++ % 4, copyOutput = true) {
            prepare(bytes, dict);
            const length = module._ZSTD_compress_usingDict(contexts[worker], output + 12, outputCapacity,
                source, bytes.byteLength, dict.byteLength === 0 ? 0 : dictionary, dict.byteLength, -1);
            if (module._ZSTD_isError(length)) { return {error: length >>> 0}; }
            assert.ok(length >= 0 && length <= outputCapacity);
            if (!copyOutput) { return {length}; }
            assert.equal(module._manabitan_write_block_envelope(output, length + 12), 1);
            return {
                length,
                frame: Buffer.from(module.HEAPU8.subarray(output + 12, output + 12 + length)),
                envelope: Buffer.from(module.HEAPU8.subarray(output, output + 12 + length)),
            };
        },
        decompress(frame, dict) {
            assert.ok(frame.byteLength <= outputCapacity && dict.byteLength <= maximumDictionaryBytes);
            module.HEAPU8.set(frame, output + 12);
            module.HEAPU8.set(dict, dictionary);
            const length = module._ZSTD_decompress_usingDict(decoder, source, maximumSourceBytes,
                output + 12, frame.byteLength, dict.byteLength === 0 ? 0 : dictionary, dict.byteLength);
            if (module._ZSTD_isError(length)) { return {error: length >>> 0}; }
            return {bytes: Buffer.from(module.HEAPU8.subarray(source, source + length))};
        },
        close() {
            for (const context of contexts) { module._ZSTD_freeCCtx(context); }
            module._ZSTD_freeDCtx(decoder);
            module._free(source);
            module._free(output);
            module._free(dictionary);
        },
    };
}
