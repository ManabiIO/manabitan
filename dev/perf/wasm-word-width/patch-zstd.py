from pathlib import Path
import sys

source = Path(sys.argv[1])
mode = sys.argv[2]
path = source / 'lib/compress/zstd_compress_internal.h'
text = path.read_text()
start = text.index('MEM_STATIC size_t ZSTD_count(')
end = text.index('\n/** ZSTD_count_2segments()', start)
original = text[start:end]
if mode == 'baseline':
    sys.exit(0)
if mode in ('count8', 'count8ctz'):
    branch = '''#if defined(__wasm32__)
    const BYTE* const pStart = pIn;
    while ((size_t)(pInLimit - pIn) >= sizeof(U64)) {
        U64 const diff = MEM_read64(pMatch) ^ MEM_read64(pIn);
        if (diff) return (size_t)(pIn - pStart) + (ZSTD_countTrailingZeros64(diff) >> 3);
        pIn += sizeof(U64);
        pMatch += sizeof(U64);
    }
    if ((size_t)(pInLimit - pIn) >= sizeof(U32) && MEM_read32(pMatch) == MEM_read32(pIn)) {
        pIn += sizeof(U32);
        pMatch += sizeof(U32);
    }
    if ((size_t)(pInLimit - pIn) >= sizeof(U16) && MEM_read16(pMatch) == MEM_read16(pIn)) {
        pIn += sizeof(U16);
        pMatch += sizeof(U16);
    }
    if (pIn < pInLimit && *pMatch == *pIn) ++pIn;
    return (size_t)(pIn - pStart);
#else
'''
elif mode == 'count8unroll':
    branch = '''#if defined(__wasm32__)
    const BYTE* const pStart = pIn;
    if ((size_t)(pInLimit - pIn) >= sizeof(U64)) {
        const BYTE* const pInLoopLimit = pInLimit - (sizeof(U64) - 1);
        { U64 const diff = MEM_read64(pMatch) ^ MEM_read64(pIn);
          if (diff) return (size_t)(__builtin_ctzll(diff) >> 3); }
        pIn += sizeof(U64); pMatch += sizeof(U64);
        while (pIn < pInLoopLimit) {
            U64 const diff = MEM_read64(pMatch) ^ MEM_read64(pIn);
            if (!diff) { pIn += sizeof(U64); pMatch += sizeof(U64); continue; }
            pIn += __builtin_ctzll(diff) >> 3;
            return (size_t)(pIn - pStart);
        }
    }
    if ((size_t)(pInLimit - pIn) >= sizeof(U32) && MEM_read32(pMatch) == MEM_read32(pIn)) {
        pIn += sizeof(U32); pMatch += sizeof(U32);
    }
    if ((size_t)(pInLimit - pIn) >= sizeof(U16) && MEM_read16(pMatch) == MEM_read16(pIn)) {
        pIn += sizeof(U16); pMatch += sizeof(U16);
    }
    if (pIn < pInLimit && *pMatch == *pIn) ++pIn;
    return (size_t)(pIn - pStart);
#else
'''
else:
    raise SystemExit('Unknown mode')
if mode == 'count8ctz':
    branch = branch.replace('ZSTD_countTrailingZeros64(diff)', '__builtin_ctzll(diff)')
opening = original.index('{') + 1
closing = original.rindex('}')
changed = original[:opening] + '\n' + branch + original[opening:closing] + '#endif\n' + original[closing:]
path.write_text(text[:start] + changed + text[end:])
