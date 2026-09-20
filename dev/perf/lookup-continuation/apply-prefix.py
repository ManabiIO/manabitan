from pathlib import Path
import hashlib
p = Path('ext/js/dictionary/term-lookup-index.js')
b = p.read_bytes()
assert hashlib.sha256(b).hexdigest() == '021c33b5487d41e8de7ca84e8f1fe6eb2c1cf8b927f91bc49259701dd4b25021'
s = b.decode()
old = '''        if ((end - start) < 2) { continue; }
        counts.fill(0);'''
new = '''        if ((end - start) < 2) { continue; }
        // Small groups do not justify another 257-bucket radix partition.
        if ((end - start) <= 16) {
            for (let i = start + 1; i < end; ++i) {
                const key = sorted[i];
                let j = i;
                while (j > start && compareKeyRanges(bytes, offsets, sorted[j - 1], key, reverse, depth) > 0) {
                    sorted[j] = sorted[j - 1];
                    --j;
                }
                sorted[j] = key;
            }
            continue;
        }
        counts.fill(0);'''
assert s.count(old) == 1
s = s.replace(old, new)
old = ''' * @param {number} bKey
 * @param {boolean} reverse
 * @returns {number}
 */
function compareKeyRanges(bytes, offsets, aKey, bKey, reverse) {'''
new = ''' * @param {number} bKey
 * @param {boolean} reverse
 * @param {number} [depth=0]
 * @returns {number}
 */
function compareKeyRanges(bytes, offsets, aKey, bKey, reverse, depth = 0) {'''
assert s.count(old) == 1
s = s.replace(old, new)
start = s.index('function compareKeyRanges(')
end = s.index('\n}\n', start)
part = s[start:end]
assert part.count('for (let i = 0; i < count; ++i)') == 1
s = s[:start] + part.replace('for (let i = 0; i < count; ++i)', 'for (let i = depth; i < count; ++i)') + s[end:]
p.write_text(s)
