"""Apply one isolated, assert-before-edit round-seven candidate."""
import sys,json,hashlib
from pathlib import Path
v=sys.argv[1]
p=Path('ext/js/dictionary/wasm/term-bank-parser.c')
s=p.read_text()
if v=='hash-vector':
 s=s.replace('#include <stdint.h>','#include <stdint.h>\n#include <wasm_simd128.h>')
 start=s.index('        uint32_t a1 = seed1 +',s.index('static void hash_content_xxh32_pair'))
 end=s.index('    } else {',start)
 s=s[:start]+'''        v128_t first = wasm_i32x4_make(seed1 + 2654435761u + 2246822519u,
            seed1 + 2246822519u, seed1, seed1 - 2654435761u);
        v128_t second = wasm_i32x4_make(seed2 + 2654435761u + 2246822519u,
            seed2 + 2246822519u, seed2, seed2 - 2654435761u);
        do {
            const v128_t input = wasm_i32x4_mul(wasm_v128_load(p), wasm_i32x4_splat(2246822519u));
            first = wasm_i32x4_add(first, input);
            second = wasm_i32x4_add(second, input);
            first = wasm_v128_or(wasm_i32x4_shl(first, 13u), wasm_u32x4_shr(first, 19u));
            second = wasm_v128_or(wasm_i32x4_shl(second, 13u), wasm_u32x4_shr(second, 19u));
            first = wasm_i32x4_mul(first, wasm_i32x4_splat(2654435761u));
            second = wasm_i32x4_mul(second, wasm_i32x4_splat(2654435761u));
            p += 16u;
        } while (p <= limit);
        h1 = rotl32(wasm_u32x4_extract_lane(first, 0), 1u) + rotl32(wasm_u32x4_extract_lane(first, 1), 7u) +
            rotl32(wasm_u32x4_extract_lane(first, 2), 12u) + rotl32(wasm_u32x4_extract_lane(first, 3), 18u);
        h2 = rotl32(wasm_u32x4_extract_lane(second, 0), 1u) + rotl32(wasm_u32x4_extract_lane(second, 1), 7u) +
            rotl32(wasm_u32x4_extract_lane(second, 2), 12u) + rotl32(wasm_u32x4_extract_lane(second, 3), 18u);
'''+s[end:]
elif v=='key-bulk':
 old='''            for (uint32_t i = 0u; i < value_length; ++i) {
                strings[strings_cursor + i] = src[value_start + i];
            }'''
 assert s.count(old)==1
 s=s.replace(old,'            __builtin_memcpy(strings + strings_cursor, src + value_start, value_length);')
elif v=='gather-once':
 p=Path('dev/lib/zstd-wasm.js');s=p.read_text()
 start=s.index('    let outputOffset = 0;',s.index('export function prepareSpanCompression'))
 end=s.index('    if (outputOffset !== contentBytes)',start)
 s=s[:start]+'''    let outputOffset = 0;
    let runOffset = 0;
    let runLength = 0;
    let runEnd = 0;
    let hasRun = false;
    const heap = module.HEAPU8;
    const sourceSize = source.byteLength;
    for (let i = 0; i < sourceOffsets.length; ++i) {
        const sourceOffset = sourceOffsets[i];
        const sourceLength = sourceLengths[i];
        if (sourceOffset > sourceSize || sourceLength > sourceSize - sourceOffset) {
            throw new RangeError(`Zstd source span ${i} is out of bounds`);
        }
        if (sourceLength > contentBytes - outputOffset - runLength) {
            throw new RangeError(`Zstd source span ${i} exceeds the gathered content size`);
        }
        if (hasRun && sourceOffset !== runEnd) {
            heap.set(source.subarray(runOffset, runEnd), buffers.source + outputOffset);
            outputOffset += runLength;
            runLength = 0;
            hasRun = false;
        }
        if (!hasRun) { runOffset = sourceOffset; hasRun = true; }
        runLength += sourceLength;
        runEnd = sourceOffset + sourceLength;
    }
    if (hasRun) {
        heap.set(source.subarray(runOffset, runEnd), buffers.source + outputOffset);
        outputOffset += runLength;
    }
'''+s[end:]
else:raise ValueError(v)
p.write_text(s)
print(json.dumps({'source':p.as_posix(),'sha256':hashlib.sha256(s.encode()).hexdigest()}))
