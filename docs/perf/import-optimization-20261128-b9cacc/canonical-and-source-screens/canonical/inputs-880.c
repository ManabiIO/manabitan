/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2016-2022  Yomichan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

#include <stdint.h>

// Private ABI v1; mirror term-content-canonical-layout.js. All scratch columns
// fit below the authoritative arena, which begins at the fixed 8 MiB prefix.
#define MAX_ROWS 100000u
#define EXACT_BATCH_SIZE 4096u
#define PREFIX 8388608u
#define META 131072u
#define IDENT (META + 16u * MAX_ROWS)
#define ROWS (IDENT + 4u * MAX_ROWS)
#define SIGS (ROWS + 4u * MAX_ROWS)
#define FLAGS (SIGS + 12u * MAX_ROWS)
#define OUT (FLAGS + MAX_ROWS)
#define JOURNAL (OUT + 24u * MAX_ROWS)
#define EXACT (JOURNAL + 12u * MAX_ROWS)
#define EPOCHS (EXACT + EXACT_BATCH_SIZE * 8u)
#define INDEXES (EPOCHS + MAX_ROWS * 4u)
#define LAYOUT_END (INDEXES + MAX_ROWS * 4u)
#define U32(p) ((uint32_t *)(uintptr_t)(p))
#define U8(p) ((uint8_t *)(uintptr_t)(p))

_Static_assert(LAYOUT_END == 8263840u, "canonical layout v1 endpoint");
_Static_assert(LAYOUT_END <= PREFIX, "canonical scratch exceeds reserved prefix");
_Static_assert(META >= 131072u, "canonical scratch overlaps stack");
_Static_assert(FLAGS % 4u == 0 && OUT % 4u == 0 && INDEXES % 4u == 0,
               "canonical columns must remain aligned");

__attribute__((export_name("canonical_abi_version")))
uint32_t canonical_abi_version(void) { return 1u; }
__attribute__((export_name("canonical_layout_end")))
uint32_t canonical_layout_end(void) { return LAYOUT_END; }
__attribute__((export_name("canonical_max_rows")))
uint32_t canonical_max_rows(void) { return MAX_ROWS; }
__attribute__((export_name("canonical_prefix_bytes")))
uint32_t canonical_prefix_bytes(void) { return PREFIX; }

// Header at 1024: journal progress, next cursor, pending count, exact count,
// resolved count, dense count, reserved. The journal count is volatile so a
// trap cannot hide an insertion from the synchronous JS rollback owner.
// Config at 1088: pointers x10, capacity, dense, rowCount, first, last, cursor,
// contentRowStart, baseOffset, bufferLength, lookup, reserve, trapAfter. The
// old projection slots are reserved. trapAfter is for internal fault tests.
__attribute__((export_name("scan_canonical")))
int32_t scan_canonical(void) {
    volatile uint32_t *h = (volatile uint32_t *)(uintptr_t)1024u;
    const uint32_t *c = U32(1088u);
    const uint64_t bytes = (uint64_t)__builtin_wasm_memory_size(0) * 65536u;
    h[0] = h[2] = h[3] = h[4] = h[6] = 0;
    h[1] = c[15];
    h[5] = c[11];
    if (c[12] > MAX_ROWS || c[14] < c[13] || c[14] - c[13] > MAX_ROWS ||
        c[15] > c[14] - c[13] || c[1] == 0 || (c[1] & (c[1] - 1)) || bytes < PREFIX) {
        return -1;
    }
    uint32_t widths[8] = {4, 4, 1, 4, 1, 4, 4, 4};
    for (uint32_t k = 0; k < 8; ++k) {
        if (c[k + 2] < PREFIX || c[k + 2] % widths[k] ||
            (uint64_t)c[k + 2] + (uint64_t)c[10] * widths[k] > bytes) {
            return -1;
        }
    }
    if (c[0] < PREFIX || c[0] % 4 || (uint64_t)c[0] + (uint64_t)c[1] * 4 > bytes || c[11] > c[10]) {
        return -1;
    }
    uint32_t *slots = U32(c[0]), *hash1 = U32(c[2]), *hash2 = U32(c[3]), *length = U32(c[5]);
    uint8_t *state = U8(c[4]), *present = U8(c[6]);
    uint32_t *s1 = U32(c[7]), *s2 = U32(c[8]), *s3 = U32(c[9]);
    const uint32_t *meta = U32(META), *identity = U32(IDENT), *rows = U32(ROWS), *sigs = U32(SIGS);
    const uint8_t *flags = U8(FLAGS);
    uint32_t *out = U32(OUT), *journal = U32(JOURNAL), *exact = U32(EXACT);
    const uint32_t n = c[14] - c[13], mask = c[1] - 1;
    // Validated authoritative pointers cannot reach this config or the fixed
    // input columns below PREFIX. Snapshot immutable inputs across the journal
    // barrier, while preserving every volatile progress write and trap point.
    const uint32_t row_count = c[12], first_unique = c[13], row_start = c[16];
    const uint32_t base_offset = c[17], buffer_length = c[18];
    const uint32_t capacity = c[10], slots_count = c[1];
    const uint32_t lookup = c[19], reserve = c[20], trap_after = c[21];
    for (uint32_t i = c[15]; i < n; ++i) {
        const uint32_t unique = first_unique + i, global = rows[i];
        if (global < row_start || (uint64_t)global - row_start >= row_count) { return -2; }
        const uint32_t row = global - row_start;
        if (identity[row] != unique) { return -2; }
        h[1] = i + 1;
        if (flags[i] == 1) {
            ++h[4];
            continue;
        }
        const uint32_t *m = meta + row * 4;
        const uint32_t content_length = m[1], content_hash1 = m[2], content_hash2 = m[3];
        const uint64_t offset = (uint64_t)base_offset + m[0], end = offset + content_length;
        if (end > buffer_length || offset > 0xffffffffu) { return -3; }
        uint32_t hash = content_hash1 ^ (content_hash2 * 0x9e3779b1u);
        hash ^= hash >> 16;
        uint32_t slot = hash & mask, probes = 0, existing = 0xffffffffu, pair = 0;
        while (slots[slot]) {
            uint32_t index = slots[slot] - 1;
            if (index >= capacity || ++probes >= slots_count) { return -4; }
            if (hash1[index] == content_hash1 && hash2[index] == content_hash2) {
                pair = 1;
                if (lookup && state[index] == 1) {
                    existing = index;
                    break;
                }
            }
            slot = (slot + 1) & mask;
        }
        if (existing != 0xffffffffu) {
            uint32_t j = h[3];
            exact[j * 2] = i;
            exact[j * 2 + 1] = existing;
            h[3] = j + 1;
            // Do not inspect the following row before the exact-byte await.
            if (h[3] == EXACT_BATCH_SIZE) { return 1; }
            continue;
        }
        uint32_t staged = 0xffffffffu;
        if (reserve && !pair) {
            const uint32_t index = h[5];
            if (index >= capacity || state[index] != 0 || content_length == 0xffffffffu) { return -5; }
            uint32_t j = h[0];
            journal[j * 3] = slot;
            journal[j * 3 + 1] = slots[slot];
            journal[j * 3 + 2] = index;
            h[0] = j + 1; // Commit rollback progress BEFORE authoritative mutation.
            __asm__ __volatile__("" ::: "memory");
            hash1[index] = content_hash1;
            hash2[index] = content_hash2;
            length[index] = content_length;
            s1[index] = sigs[i * 3];
            s2[index] = sigs[i * 3 + 1];
            s3[index] = sigs[i * 3 + 2];
            present[index] = 1;
            state[index] = 2;
            slots[slot] = index + 1;
            staged = index;
            h[5] = index + 1;
            if (trap_after && h[0] == trap_after) { __builtin_trap(); }
        }
        uint32_t j = h[2]++;
        out[j] = (uint32_t)offset;
        out[MAX_ROWS + j] = content_length;
        out[2u * MAX_ROWS + j] = content_hash1;
        out[3u * MAX_ROWS + j] = content_hash2;
        out[4u * MAX_ROWS + j] = unique;
        out[5u * MAX_ROWS + j] = staged;
    }
    return 0;
}
