"""Isolated pipeline candidates; storage, cache policy and source lifetime stay fixed."""
from pathlib import Path
import hashlib, json, sys

variant = sys.argv[1]
p = Path('dev/lib/zstd-wasm.js' if variant.startswith('gather') else 'ext/js/dictionary/dictionary-database.js')
s = original = p.read_text()
expected = {'ext/js/dictionary/dictionary-database.js': 'aed3fdfcffd9967af17519fcbaea362253a4804ff760a8cc7070e52ebf5be5df'}
if str(p) in expected:
    assert hashlib.sha256(p.read_bytes()).hexdigest() == expected[str(p)]

def replace(old, new):
    global s
    assert s.count(old) == 1, (old[:100], s.count(old))
    s = s.replace(old, new)

helper = '''/**
 * Copies a validated, stable shared span into independently owned private bytes.
 * The caller must keep the source immutable until this synchronous copy returns.
 * This is not a concurrent shared-memory snapshot operation.
 * @param {Uint8Array} source
 * @param {number} sourceOffset
 * @param {Uint8Array} destination
 * @param {number} destinationOffset
 * @param {number} length
 */
function copyStableSharedBytes(source, sourceOffset, destination, destinationOffset, length) {
    if (
        length < 1024 ||
        typeof SharedArrayBuffer === 'undefined' ||
        !(source.buffer instanceof SharedArrayBuffer) ||
        destination.buffer instanceof SharedArrayBuffer
    ) {
        destination.set(source.subarray(sourceOffset, sourceOffset + length), destinationOffset);
        return;
    }
    // Align both views independently. Every word remains inside its logical span;
    // only private destination bytes move when the two alignment offsets differ.
    const sourcePrefix = (WIDTH - ((source.byteOffset + sourceOffset) % WIDTH)) % WIDTH;
    const destinationPrefix = (WIDTH - ((destination.byteOffset + destinationOffset) % WIDTH)) % WIDTH;
    const wordCount = Math.floor((length - Math.max(sourcePrefix, destinationPrefix)) / WIDTH);
    const wordBytes = wordCount * WIDTH;
    new WORDARRAY(destination.buffer, destination.byteOffset + destinationOffset + destinationPrefix, wordCount).set(
        new WORDARRAY(source.buffer, source.byteOffset + sourceOffset + sourcePrefix, wordCount),
    );
    if (sourcePrefix !== destinationPrefix) {
        destination.copyWithin(
            destinationOffset + sourcePrefix,
            destinationOffset + destinationPrefix,
            destinationOffset + destinationPrefix + wordBytes,
        );
    }
    destination.set(source.subarray(sourceOffset, sourceOffset + sourcePrefix), destinationOffset);
    const tail = sourcePrefix + wordBytes;
    destination.set(source.subarray(sourceOffset + tail, sourceOffset + length), destinationOffset + tail);
}

'''
if variant in ('gather32', 'gather64'):
    width = 4 if variant == 'gather32' else 8
    helper = helper.replace('WIDTH', str(width)).replace('WORDARRAY', 'Uint32Array' if width == 4 else 'BigUint64Array')
    replace('/**\n * Gathers source spans into retained WASM memory without starting compression.', helper + '/**\n * Gathers source spans into retained WASM memory without starting compression.')
    replace('''        module.HEAPU8.set(
            source.subarray(runOffset, runOffset + runLength),
            buffers.source + outputOffset,
        );''', '''        copyStableSharedBytes(source, runOffset, module.HEAPU8, buffers.source + outputOffset, runLength);''')
elif variant == 'cache64':
    helper = helper.replace('WIDTH', '8').replace('WORDARRAY', 'BigUint64Array')
    s += '\n' + helper
    replace('        const owned = spans.buffer.slice(minimumOffset, maximumEnd);', '''        const owned = new Uint8Array(byteLength);
        copyStableSharedBytes(spans.buffer, minimumOffset, owned, 0, byteLength);''')
elif variant == 'scalar-pending':
    start = s.index('            const contentRowEnd = contentRowStart + count;')
    end = s.index('            const dedupCanonicalScanMs = Math.max(', start)
    chunk = old = s[start:end]
    chunk = chunk.replace(' * @param {PendingContentDescriptor} descriptor', ''' * @param {number} uniqueIndex
             * @param {number} rowIndex
             * @param {number} contentOffset
             * @param {number} contentLength
             * @param {number} hash1
             * @param {number} hash2''')
    chunk = chunk.replace('''const appendPendingContent = (descriptor) => {
                const {uniqueIndex, rowIndex, contentOffset, contentLength, hash1, hash2} = descriptor;''', '''const appendPendingContent = (uniqueIndex, rowIndex, contentOffset, contentLength, hash1, hash2) => {''')
    chunk = chunk.replace('''                        appendPendingContent(descriptor);''', '''                        appendPendingContent(descriptor.uniqueIndex, descriptor.rowIndex, descriptor.contentOffset, descriptor.contentLength, descriptor.hash1, descriptor.hash2);''', 1)
    chunk = chunk.replace('''                    const descriptor = {uniqueIndex, rowIndex, contentOffset, contentLength, hash1, hash2};\n''', '')
    chunk = chunk.replace('''                        appendPendingContent(descriptor);''', '''                        appendPendingContent(uniqueIndex, rowIndex, contentOffset, contentLength, hash1, hash2);''')
    chunk = chunk.replace('exactCandidates.push({...descriptor, existingMeta});', 'exactCandidates.push({uniqueIndex, rowIndex, contentOffset, contentLength, hash1, hash2, existingMeta});')
    assert 'appendPendingContent(descriptor);' not in chunk and old != chunk
    replace(old, chunk)
else:
    raise ValueError(variant)
assert s != original
p.write_text(s)
print(json.dumps({'source': str(p), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}))
