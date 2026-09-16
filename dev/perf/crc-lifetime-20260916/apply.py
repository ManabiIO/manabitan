from pathlib import Path
import hashlib, json, sys
variant = sys.argv[1]
p = Path('dev/lib/zstd-wasm.js' if variant == 'lifetime' else 'ext/js/dictionary/wasm/term-bank-parser.c')
s = p.read_text()
expected = 'e9cb1632ee6d84e3c082bc1c273949829672361c8c96a6555a3395cd52aea32a' if variant == 'lifetime' else '490d3e4a3f9c436e51bde32188e8bfe8cae2ee38a87b232263d651878973ca60'
assert hashlib.sha256(p.read_bytes()).hexdigest() == expected
if variant in ('crc16', 'crc32'):
    width = int(variant[3:])
    s = s.replace('crc32_table[8][256]',f'crc32_table[{width}][256]').replace('slice < 8u','slice < '+str(width)+'u')
    start = s.index('    while (length - offset >= 8u) {')
    block = [f'    while (length - offset >= {width}u) {{']
    for word in range(width//4):
        block.extend([f'        uint32_t w{word};', f'        __builtin_memcpy(&w{word}, data + offset + {word*4}u, sizeof(w{word}));'])
    block.append('        w0 ^= crc;')
    block.append('        crc =')
    for byte in range(width):
        w=byte//4; shift=byte%4*8
        expr=f'w{w} & 0xffu' if shift==0 else f'(w{w} >> {shift}u) & 0xffu' if shift!=24 else f'w{w} >> 24u'
        block.append(f'            crc32_table[{width-1-byte}][{expr}]'+(';' if byte==width-1 else ' ^'))
    block.extend([f'        offset += {width}u;', '    }'])
    s=s[:start]+'    // Wider slicing reduces the serial CRC dependency; tails keep the original path.\n'+'\n'.join(block)+'\n'+s[start:]
elif variant == 'lifetime':
    s = s.replace('dictionaryCapacity: number}', 'dictionaryCapacity: number, prepared: object|null}')
    s = s.replace('dictionary: 0, dictionaryCapacity: 0};', 'dictionary: 0, dictionaryCapacity: 0, prepared: null};')
    s = s.replace('    if (buffers.sourceCapacity < sourceSize) {', "    // Invalidate the previous operation before any copy, free or allocation.\n    // The retained buffer object itself is reused, even when its pointers change.\n    buffers.prepared = null;\n    if (buffers.sourceCapacity < sourceSize) {")
    s = s.replace('    const module = getModule();\n    if (buffers.source !== 0)', '    buffers.prepared = null;\n    const module = getModule();\n    if (buffers.source !== 0)')
    s = s.replace('    return {context, buffers, contentBytes, dictionaryBytes: dictionary.byteLength, prefixBytes, level, writeBlockEnvelope};', '    const prepared = {context, buffers, contentBytes, dictionaryBytes: dictionary.byteLength, prefixBytes, level, writeBlockEnvelope};\n    buffers.prepared = prepared;\n    return prepared;')
    s = s.replace('    if (contextBuffers.get(context) !== buffers) {', '    if (contextBuffers.get(context) !== buffers || buffers.prepared !== prepared) {')
    needle = '    const size = module._ZSTD_compress_usingDict(\n        context,\n        buffers.destination + prefixBytes,\n        buffers.destinationCapacity - prefixBytes,\n        buffers.source,\n        contentBytes,'
    assert s.count(needle) == 1
    s = s.replace(needle, '    // A failed compression or envelope write must not leave a reusable handle.\n    buffers.prepared = null;\n' + needle)
else:
    raise ValueError(variant)
p.write_text(s)
print(json.dumps({'source':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}))
