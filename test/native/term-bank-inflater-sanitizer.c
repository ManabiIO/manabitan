/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Portable decoder sanitizer companion, not browser qualification.
 * From the repository root on Linux with clang and zlib development headers:
 * clang -O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer \
 *   -ffunction-sections -fdata-sections -I. \
 *   test/native/term-bank-inflater-sanitizer.c -Wl,--gc-sections -lz -o /tmp/inflater-test
 * ASAN_OPTIONS=detect_leaks=1 UBSAN_OPTIONS=halt_on_error=1 /tmp/inflater-test
 */
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>
#define FREESTANDING
/* Load shared definitions before suppressing the host CPU dispatch selection.
 * The production wasm32 build also uses only the portable implementation.
 * Native machine words and pointers still follow the host ABI; the separate
 * production-WASM suite covers the actual wasm32 build and memory boundaries. */
#include "ext/js/dictionary/wasm/vendor/libdeflate/lib/lib_common.h"
#undef ARCH_X86_64
#undef ARCH_X86_32
#undef ARCH_ARM64
#undef ARCH_ARM32
#include "ext/js/dictionary/wasm/term-bank-inflate.c"

static uint32_t rng = 0x917ca63du;
static uint32_t random_word(void) { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return rng; }
static unsigned cases;

static int decode_case(const uint8_t *input, size_t in_length, const uint8_t *expected,
                       size_t out_length, size_t alignment, int expected_status) {
    uint8_t *in = malloc(in_length + alignment + 1);
    uint8_t *out = malloc(out_length + alignment + 1);
    assert(in && out);
    memset(in, 0xcc, in_length + alignment + 1);
    memset(out, 0xa5, out_length + alignment + 1);
    /* Right-align input/output to ASan's allocation boundary. */
    memcpy(in + alignment + 1, input, in_length);
    int status = term_bank_inflate(in + alignment + 1, (uint32_t)in_length,
                                  out + alignment + 1, (uint32_t)out_length);
    if (expected_status == 0) {
        assert(status == 0);
        assert(memcmp(out + alignment + 1, expected, out_length) == 0);
    } else if (expected_status < 0) {
        assert(status == expected_status || (expected_status == -99 && status < 0));
    }
    for (size_t i = 0; i <= alignment; ++i) assert(out[i] == 0xa5);
    free(in);
    free(out);
    ++cases;
    return status;
}

int main(void) {
    const size_t widths[] = {0, 1, 2, 7, 8, 15, 16, 31, 32, 255, 256, 257, 258,
                            259, 4095, 4096, 32767, 32768, 65535, 65536, 131073};
    const int strategies[] = {Z_DEFAULT_STRATEGY, Z_FIXED, Z_HUFFMAN_ONLY};
    for (unsigned trial = 0; trial < 1024; ++trial) {
        size_t size = trial < sizeof(widths) / sizeof(widths[0]) ? widths[trial] : random_word() % 8193;
        uint8_t *expected = malloc(size + 1);
        assert(expected);
        for (size_t i = 0; i < size; ++i) expected[i] = trial % 2 ? (uint8_t)random_word() : (uint8_t)(i % 13);
        for (unsigned strategy = 0; strategy < 3; ++strategy) {
            z_stream zs = {0};
            assert(deflateInit2(&zs, trial % 10, Z_DEFLATED, -MAX_WBITS, 8, strategies[strategy]) == Z_OK);
            size_t capacity = deflateBound(&zs, size) + 32;
            uint8_t *compressed = malloc(capacity + 8);
            assert(compressed);
            zs.next_in = expected;
            zs.avail_in = size;
            zs.next_out = compressed;
            zs.avail_out = capacity;
            assert(deflate(&zs, Z_FINISH) == Z_STREAM_END);
            size_t input_length = zs.total_out;
            assert(deflateEnd(&zs) == Z_OK);
            for (size_t a = 0; a < 16; a += 3) decode_case(compressed, input_length, expected, size, a, 0);
            for (size_t extra = 1; extra <= 8; ++extra) {
                memset(compressed + input_length, 0, extra);
                decode_case(compressed, input_length + extra, expected, size, extra, -6);
            }
            if (size > 0) decode_case(compressed, input_length, expected, size - 1, 1, -99);
            decode_case(compressed, input_length, expected, size + 1, 7, -3);
            /* Repeated truncated calls are interleaved with a successful reuse. */
            for (size_t end = 0; end < input_length && end < 64; ++end) {
                decode_case(compressed, end, expected, size, end % 16, -99);
            }
            decode_case(compressed, input_length, expected, size, 15, 0);
            free(compressed);
        }
        free(expected);
    }
    printf("%u exact decoder cases passed; portable native word size=%zu, context bytes=%zu\n", cases, sizeof(machine_word_t), sizeof(term_bank_decompressor));
    return 0;
}
