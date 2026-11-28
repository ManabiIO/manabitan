/* Research-only exports of the actual upstream helpers under test. */
#include <stdint.h>
#include "lib/compress/zstd_compress_internal.h"

uint32_t count_probe(uint32_t input, uint32_t match, uint32_t end) {
    return (uint32_t)ZSTD_count((const BYTE*)(uintptr_t)input,
        (const BYTE*)(uintptr_t)match, (const BYTE*)(uintptr_t)end);
}

uint32_t count_two_probe(uint32_t input, uint32_t match, uint32_t end,
                         uint32_t match_end, uint32_t second) {
    return (uint32_t)ZSTD_count_2segments((const BYTE*)(uintptr_t)input,
        (const BYTE*)(uintptr_t)match, (const BYTE*)(uintptr_t)end,
        (const BYTE*)(uintptr_t)match_end, (const BYTE*)(uintptr_t)second);
}
