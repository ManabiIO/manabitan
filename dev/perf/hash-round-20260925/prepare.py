from pathlib import Path
import hashlib
import json
import os

root = Path('.')
out = root / 'builds/hash-round'
out.mkdir(parents=True, exist_ok=True)
p = root / 'ext/js/dictionary/wasm/term-bank-parser.c'
s = p.read_text()
assert hashlib.sha256(s.encode()).hexdigest() == 'b65eebac1d7a83eeb6ae14969069afc376a0084ddb0f6ffa01a84d1266dde108'
(out / 'base.c').write_text(s)
a = s.index('static void hash_content_xxh32_pair(')
b = s.index('\nstatic inline int write_byte_and_hash', a)
f = s[a:b]
x = f.index('        uint32_t a1 = seed1')
y = f.index('\n    } else {', x)
f = f[:x] + '''        const v128_t offsets = wasm_i32x4_make(2654435761u + 2246822519u, 2246822519u, 0u, 0u - 2654435761u);
        const v128_t prime1 = wasm_i32x4_splat(2654435761u);
        const v128_t prime2 = wasm_i32x4_splat(2246822519u);
        v128_t v1 = wasm_i32x4_add(wasm_i32x4_splat(seed1), offsets);
        v128_t v2 = wasm_i32x4_add(wasm_i32x4_splat(seed2), offsets);
        do {
            const v128_t input = wasm_i32x4_mul(wasm_v128_load(p), prime2);
            v1 = wasm_i32x4_add(v1, input);
            v2 = wasm_i32x4_add(v2, input);
            v1 = wasm_i32x4_mul(wasm_v128_or(wasm_i32x4_shl(v1, 13), wasm_u32x4_shr(v1, 19)), prime1);
            v2 = wasm_i32x4_mul(wasm_v128_or(wasm_i32x4_shl(v2, 13), wasm_u32x4_shr(v2, 19)), prime1);
            p += 16u;
        } while (p <= limit);
        h1 = rotl32(wasm_u32x4_extract_lane(v1, 0), 1u) + rotl32(wasm_u32x4_extract_lane(v1, 1), 7u) +
            rotl32(wasm_u32x4_extract_lane(v1, 2), 12u) + rotl32(wasm_u32x4_extract_lane(v1, 3), 18u);
        h2 = rotl32(wasm_u32x4_extract_lane(v2, 0), 1u) + rotl32(wasm_u32x4_extract_lane(v2, 1), 7u) +
            rotl32(wasm_u32x4_extract_lane(v2, 2), 12u) + rotl32(wasm_u32x4_extract_lane(v2, 3), 18u);''' + f[y:]
s = (s[:a] + f + s[b:]).replace('#include <stdint.h>', '#include <stdint.h>\n#include <wasm_simd128.h>')
assert hashlib.sha256(s.encode()).hexdigest() == 'b9896a9f98e4d018d2b7431818be2ab63f76a87f8bfea49190ac1b9e56f37e7e'
(out / 'candidate.c').write_text(s)
p.write_text(s)

if os.environ.get('DICTIONARY') == 'wty-en-en':
    p = root / 'test/perf/dictionaries.lock.json'
    lock = json.loads(p.read_text())
    lock['dictionaries']['wty-en-en'] = {
        'label': 'wty-en-en', 'cacheFile': 'wty-en-en.zip',
        'release': '21b1b22cd655d7936d62b127e6404fbb8a88c7c3',
        'url': 'https://huggingface.co/datasets/daxida/wty-release/resolve/21b1b22cd655d7936d62b127e6404fbb8a88c7c3/latest/dict/en/en/wty-en-en.zip',
        'sha256': 'b9603db16dee82afd811386302ccd78bab591a6513b0d3194d937dc9110dd4a5',
        'sizeBytes': 106918350, 'expectedTitle': 'wty-en-en',
        'revision': '2026.08.29', 'termRows': 1643040,
    }
    p.write_text(json.dumps(lock, indent=4) + '\n')
    p = root / 'test/chromium/extension-two-dictionary-import.e2e.js'
    source = p.read_text()
    for old, new in [
        ("new Set(['jmdict', 'jmnedict', 'jitendex'])", "new Set(['jmdict', 'jmnedict', 'jitendex', 'wty-en-en'])"),
        ("jitendex: {label: 'Jitendex', filePath: cachedDictionaries.jitendexPath},", "jitendex: {label: 'Jitendex', filePath: cachedDictionaries.jitendexPath},\n            'wty-en-en': {label: 'wty-en-en', filePath: path.join(dictionaryCacheDir, 'wty-en-en.zip')},"),
    ]:
        assert source.count(old) == 1, old
        source = source.replace(old, new)
    assert source.count('maxBuffer: 32 * 1024 * 1024') == 2
    source = source.replace('maxBuffer: 32 * 1024 * 1024', 'maxBuffer: 256 * 1024 * 1024')
    p.write_text(source)
