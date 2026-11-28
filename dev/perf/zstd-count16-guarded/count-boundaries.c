/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Compile this unchanged wrapper against each complete pinned source tree.
 * These exports exercise the real internal helper and segment continuation;
 * they are never linked into the production codec.
 */
#include "zstd_compress_internal.h"

__attribute__((export_name("countMatch")))
size_t countMatch(size_t input, size_t match, size_t limit)
{
    return ZSTD_count((const BYTE*)input, (const BYTE*)match, (const BYTE*)limit);
}

__attribute__((export_name("countSegments")))
size_t countSegments(size_t input, size_t match, size_t limit,
                     size_t matchEnd, size_t prefixStart)
{
    return ZSTD_count_2segments((const BYTE*)input, (const BYTE*)match,
                              (const BYTE*)limit, (const BYTE*)matchEnd,
                              (const BYTE*)prefixStart);
}
