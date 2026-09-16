from pathlib import Path
import hashlib
import json
import sys

variant = sys.argv[1]
assert variant in ('word-jump', 'simd-jump', 'inflight-bounds')
source = Path('ext/js/dictionary/dictionary-database.js' if variant == 'inflight-bounds' else 'ext/js/dictionary/wasm/term-bank-parser.c')
s = source.read_text()
expected = 'aed3fdfcffd9967af17519fcbaea362253a4804ff760a8cc7070e52ebf5be5df' if variant == 'inflight-bounds' else '9be72ee642106131ca57be11dc3131463bea4da1176548735ea2607d622f7920'
assert hashlib.sha256(s.encode()).hexdigest() == expected

def replace(before, after):
    global s
    assert s.count(before) == 1, before
    s = s.replace(before, after)

if variant == 'word-jump':
    replace('''            if (
                has_zero_byte64(word ^ UINT64_C(0x2222222222222222)) != 0u ||
                has_zero_byte64(word ^ UINT64_C(0x5c5c5c5c5c5c5c5c)) != 0u ||
                has_control_byte64(word) != 0u
            ) {
                break;
            }''', '''            const uint64_t special =
                has_zero_byte64(word ^ UINT64_C(0x2222222222222222)) |
                has_zero_byte64(word ^ UINT64_C(0x5c5c5c5c5c5c5c5c)) |
                has_control_byte64(word);
            if (special != 0u) {
                // On little-endian WASM the first marked byte is exact, even
                // when subtraction borrows mark a later byte spuriously.
                i += (uint32_t)__builtin_ctzll(special) / 8u;
                break;
            }''')
elif variant == 'simd-jump':
    replace('#include <stdint.h>', '#include <stdint.h>\n#include <wasm_simd128.h>')
    a = s.index('        while (i + 8u <= len) {', s.index('static int parse_string_span('))
    b = s.index('        if (i >= len)', a)
    s = s[:a] + '''        while (len - i >= 16u) {
            const v128_t bytes = wasm_v128_load(src + i);
            const v128_t special = wasm_v128_or(
                wasm_v128_or(wasm_i8x16_eq(bytes, wasm_i8x16_splat('"')),
                    wasm_i8x16_eq(bytes, wasm_i8x16_splat('\\\\'))),
                wasm_u8x16_lt(bytes, wasm_i8x16_splat(0x20)));
            const uint32_t mask = wasm_i8x16_bitmask(special);
            if (mask != 0u) {
                i += (uint32_t)__builtin_ctz(mask);
                break;
            }
            i += 16u;
        }
''' + s[b:]
else:
    a = s.index('    _registerInFlightTermContentSources(')
    b = s.index('\n    /**', a)
    part = s[a:b]
    old = '''            if (
                this._inFlightTermContentSourceBatches.size > 0 &&
                this._findInFlightTermContentSource(persistedOffset, persistedLength, dictName) !== void 0
            ) {
                throw new Error(
                    `Duplicate in-flight term content storage reference: ${this._getTermContentStorageKey(persistedOffset, persistedLength, dictName)}`,
                );
            }
'''
    assert part.count(old) == 1
    part = part.replace(old, '')
    old = '''        const batch = {
            offsets: pendingOffsets,'''
    new = '''        // Only an overlapping offset range can alias an active reservation.
        // All incoming rows have already been validated and checked internally.
        let overlapsActiveBatch = false;
        for (const active of this._inFlightTermContentSourceBatches) {
            if (minimumOffset <= active.maximumOffset && maximumOffset >= active.minimumOffset) {
                overlapsActiveBatch = true;
                break;
            }
        }
        if (overlapsActiveBatch) {
            for (let i = 0; i < count; ++i) {
                const dictName = Array.isArray(pendingResolvedDictNames) ? pendingResolvedDictNames[i] : pendingResolvedDictNames;
                if (this._findInFlightTermContentSource(pendingOffsets[i], pendingLengths[i], dictName) !== void 0) {
                    throw new Error(`Duplicate in-flight term content storage reference: ${this._getTermContentStorageKey(pendingOffsets[i], pendingLengths[i], dictName)}`);
                }
            }
        }
        const batch = {
            offsets: pendingOffsets,'''
    assert part.count(old) == 1
    part = part.replace(old, new)
    s = s[:a] + part + s[b:]
source.write_text(s)
print(json.dumps({'variant': variant, 'source': str(source), 'sha256': hashlib.sha256(s.encode()).hexdigest()}))
