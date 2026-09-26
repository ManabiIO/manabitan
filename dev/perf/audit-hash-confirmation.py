#!/usr/bin/env python3
"""Independent confirmation of the exact retained candidate, opposite initial order."""
from pathlib import Path
import sys

helper = '''/**
 * Long-input specialization of the same XXH32 rounds. A shared DataView avoids
 * four indexed byte reads per word and is reused for both seeds. Keep the short
 * helper separate: combining the loops regressed short-input benchmarks.
 * @param {Uint8Array} bytes
 * @param {DataView} view
 * @param {number} seed
 * @returns {number}
 */
function hashContentXxh32View(bytes, view, seed) {
    let offset = 0;
    const length = bytes.length;
    const limit = length - 16;
    let v1 = (seed + 2654435761 + 2246822519) >>> 0;
    let v2 = (seed + 2246822519) >>> 0;
    let v3 = seed >>> 0;
    let v4 = (seed - 2654435761) >>> 0;
    do {
        v1 = xxh32Round(v1, view.getUint32(offset, true)); offset += 4;
        v2 = xxh32Round(v2, view.getUint32(offset, true)); offset += 4;
        v3 = xxh32Round(v3, view.getUint32(offset, true)); offset += 4;
        v4 = xxh32Round(v4, view.getUint32(offset, true)); offset += 4;
    } while (offset <= limit);
    let h32 = (
        rotateLeft32(v1, 1) +
        rotateLeft32(v2, 7) +
        rotateLeft32(v3, 12) +
        rotateLeft32(v4, 18)
    ) >>> 0;
    h32 = (h32 + length) >>> 0;
    while ((offset + 4) <= length) {
        h32 = (h32 + Math.imul(view.getUint32(offset, true), 3266489917)) >>> 0;
        h32 = Math.imul(rotateLeft32(h32, 17), 668265263) >>> 0;
        offset += 4;
    }
    while (offset < length) {
        h32 = (h32 + Math.imul(bytes[offset], 374761393)) >>> 0;
        h32 = Math.imul(rotateLeft32(h32, 11), 2654435761) >>> 0;
        ++offset;
    }
    h32 ^= h32 >>> 15;
    h32 = Math.imul(h32, 2246822519) >>> 0;
    h32 ^= h32 >>> 13;
    h32 = Math.imul(h32, 3266489917) >>> 0;
    h32 ^= h32 >>> 16;
    return h32 >>> 0;
}
'''
driver = Path(__file__).with_name('audit-hash-qualification.py')
s = driver.read_text()
anchor = "(out / 'hash-baseline.mjs').write_text(original)"
assert s.count(anchor) == 1
specialization = "candidate = original.replace('const HEX_BYTE_TABLE', 'const LONG_CONTENT_HASH_MIN_BYTES = 512;\\n\\nconst HEX_BYTE_TABLE').replace(old, new.replace('bytes.length >= 512', 'bytes.length >= LONG_CONTENT_HASH_MIN_BYTES')) + '\\n' + " + repr(helper) + "\nassert digest(candidate.encode()) == '12b275412b3930669ed7986f9d692ec12926c01716eb4447cbd6a238a2d4ace6'\n"
s = s.replace(anchor, specialization + anchor)
s = s.replace("[('warmup', 0, 'A'), ('warmup', 0, 'B')]", "[('warmup', 0, 'B'), ('warmup', 0, 'A')]")
s = s.replace("('AB' if pair % 2 == 0 else 'BA')", "('BA' if pair % 2 == 0 else 'AB')")
out = Path(sys.argv[3]).resolve()
out.mkdir(parents=True, exist_ok=True)
(out / 'executed-driver.py').write_text(s)
exec(compile(s, str(driver), 'exec'))
