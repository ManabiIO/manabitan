"""Independent WASM32 compression-only bit-stream width experiment."""
from pathlib import Path
import sys
source = Path(sys.argv[1])
p = source / 'lib/common/bitstream.h'
s = p.read_text()
assert s.count('typedef size_t BitContainerType;') == 1
s = s.replace('typedef size_t BitContainerType;', '''typedef size_t BitContainerType;
#if defined(__wasm32__)
typedef U64 BitCContainerType;
#else
typedef BitContainerType BitCContainerType;
#endif''')
s = s.replace('    BitContainerType bitContainer;', '    BitCContainerType bitContainer;', 1)
s = s.replace('BIT_CStream_t* bitC, BitContainerType value', 'BIT_CStream_t* bitC, BitCContainerType value')
s = s.replace('                            BitContainerType value, unsigned nbBits)', '                            BitCContainerType value, unsigned nbBits)')
s = s.replace('                                BitContainerType value, unsigned nbBits)', '                                BitCContainerType value, unsigned nbBits)')
s = s.replace('FORCE_INLINE_TEMPLATE BitContainerType BIT_getLowerBits(BitContainerType bitContainer,', 'FORCE_INLINE_TEMPLATE BitCContainerType BIT_getLowerBits(BitCContainerType bitContainer,')
assert s.count('    MEM_writeLEST(bitC->ptr, bitC->bitContainer);') == 2
s = s.replace('    MEM_writeLEST(bitC->ptr, bitC->bitContainer);', '''#if defined(__wasm32__)
    MEM_writeLE64(bitC->ptr, bitC->bitContainer);
#else
    MEM_writeLEST(bitC->ptr, bitC->bitContainer);
#endif''')
s = s.replace('`dstCapacity` must be > sizeof(size_t)', '`dstCapacity` must be > sizeof(BitCContainerType)')
s = s.replace('Local register is BitContainerType, 64-bits on 64-bits systems, or 32-bits on 32-bits systems.', 'Local register is BitCContainerType: uint64_t on WASM32, otherwise size_t.')
p.write_text(s)
p = source / 'lib/common/fse.h'
s = p.read_text()
old = '#define FSE_BLOCKBOUND(size) ((size) + ((size)>>7) + 4 /* fse states */ + sizeof(size_t) /* bitContainer */)'
assert s.count(old) == 1
s = s.replace(old, '#if defined(__wasm32__)\n#define FSE_BLOCKBOUND(size) ((size) + ((size)>>7) + 4 /* fse states */ + 8 /* compressor bitContainer */)\n#else\n' + old + '\n#endif')
p.write_text(s)
p = source / 'lib/compress/zstd_compress_sequences.c'
s = p.read_text()
start = s.index('ZSTD_encodeSequences_body(')
end = s.index('\nstatic size_t\nZSTD_encodeSequences_default', start)
body = s[start:end]
assert body.count('MEM_32bits()') == 6, body.count('MEM_32bits()')
body = body.replace('MEM_32bits()', '(sizeof(blockStream.bitContainer) == 4)')
p.write_text(s[:start] + body + s[end:])
