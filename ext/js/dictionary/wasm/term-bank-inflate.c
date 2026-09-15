/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/* Compile only libdeflate's portable full-buffer DEFLATE implementation.
 * No allocator, host imports, CPU dispatcher or streaming state is needed.
 * Each parser worker owns a separate module instance. Calls within an instance
 * are synchronous and non-reentrant, as for the parser's existing heap arena.
 */
#define FREESTANDING
#include "vendor/libdeflate/lib/deflate_decompress.c"

/* Zero initialization satisfies the upstream decompressor construction
 * contract. Never free this static object or expose it to another worker. */
static struct libdeflate_decompressor term_bank_decompressor;

int32_t term_bank_inflate(
    const uint8_t* input,
    uint32_t input_length,
    uint8_t* output,
    uint32_t output_length
) {
    size_t consumed = 0;
    size_t produced = 0;
    const enum libdeflate_result result = libdeflate_deflate_decompress_ex(
        &term_bank_decompressor, input, input_length, output, output_length,
        &consumed, &produced
    );
    if (result != LIBDEFLATE_SUCCESS) { return -2; }
    if (produced != output_length) { return -3; }
    if (consumed != input_length) { return -6; }
    return 0;
}
