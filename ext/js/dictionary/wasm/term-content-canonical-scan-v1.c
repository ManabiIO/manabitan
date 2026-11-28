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
    for (uint32_t i = c[15]; i < n; ++i) {
        const uint32_t unique = c[13] + i, global = rows[i];
        if (global < c[16] || (uint64_t)global - c[16] >= c[12]) { return -2; }
        const uint32_t row = global - c[16];
        if (identity[row] != unique) { return -2; }
        h[1] = i + 1;
        if (flags[i] == 1) {
            ++h[4];
            continue;
        }
        const uint32_t *m = meta + row * 4;
        const uint64_t offset = (uint64_t)c[17] + m[0], end = offset + m[1];
        if (end > c[18] || offset > 0xffffffffu) { return -3; }
        uint32_t hash = m[2] ^ (m[3] * 0x9e3779b1u);
        hash ^= hash >> 16;
        uint32_t slot = hash & mask, probes = 0, existing = 0xffffffffu, pair = 0;
        while (slots[slot]) {
            uint32_t index = slots[slot] - 1;
            if (index >= c[10] || ++probes >= c[1]) { return -4; }
            if (hash1[index] == m[2] && hash2[index] == m[3]) {
                pair = 1;
                if (c[19] && state[index] == 1) {
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
        if (c[20] && !pair) {
            const uint32_t index = h[5];
            if (index >= c[10] || state[index] != 0 || m[1] == 0xffffffffu) { return -5; }
            uint32_t j = h[0];
            journal[j * 3] = slot;
            journal[j * 3 + 1] = slots[slot];
            journal[j * 3 + 2] = index;
            h[0] = j + 1; // Commit rollback progress BEFORE authoritative mutation.
            __asm__ __volatile__("" ::: "memory");
            hash1[index] = m[2];
            hash2[index] = m[3];
            length[index] = m[1];
            s1[index] = sigs[i * 3];
            s2[index] = sigs[i * 3 + 1];
            s3[index] = sigs[i * 3 + 2];
            present[index] = 1;
            state[index] = 2;
            slots[slot] = index + 1;
            staged = index;
            h[5] = index + 1;
            if (c[21] && h[0] == c[21]) { __builtin_trap(); }
        }
        uint32_t j = h[2]++;
        out[j] = (uint32_t)offset;
        out[MAX_ROWS + j] = m[1];
        out[2u * MAX_ROWS + j] = m[2];
        out[3u * MAX_ROWS + j] = m[3];
        out[4u * MAX_ROWS + j] = unique;
        out[5u * MAX_ROWS + j] = staged;
    }
    return 0;
}

// Lookup-sidecar integrity hashing uses this compiled module in a separate,
// fixed three-page instance. Refuse the canonical scanner's larger live arena:
// its metadata may remain borrowed across an exact-content resolution await.
#define LOOKUP_HASH_DATA 131072u
#define LOOKUP_HASH_STATE (LOOKUP_HASH_DATA - 32u)
#define LOOKUP_HASH_SEED 0x811c9dc5u
#define LOOKUP_HASH_PRIME1 0x9e3779b1u
#define LOOKUP_HASH_PRIME2 0x85ebca77u
#define LOOKUP_HASH_PRIME3 0xc2b2ae3du
#define LOOKUP_HASH_PRIME4 0x27d4eb2fu
#define LOOKUP_HASH_PRIME5 0x165667b1u
#define LOOKUP_HASH_ACTIVE 0x48415348u

static void lookup_hash_require_source(uint32_t length) {
    if (__builtin_wasm_memory_size(0) != 3u || length > 65536u) {
        __builtin_trap();
    }
}

static uint32_t lookup_hash_read_u32(const uint8_t *p) {
    return (uint32_t)p[0] | (uint32_t)p[1] << 8u |
           (uint32_t)p[2] << 16u | (uint32_t)p[3] << 24u;
}

static uint32_t lookup_hash_rotate(uint32_t value, uint32_t amount) {
    return (value << amount) | (value >> (32u - amount));
}

static uint32_t lookup_hash_round(uint32_t accumulator, uint32_t value) {
    return lookup_hash_rotate(accumulator + value * LOOKUP_HASH_PRIME2, 13u) * LOOKUP_HASH_PRIME1;
}

__attribute__((export_name("lookup_hash_abi_version")))
uint32_t lookup_hash_abi_version(void) { return 1u; }

__attribute__((export_name("lookup_hash_begin")))
void lookup_hash_begin(uint32_t total) {
    lookup_hash_require_source(0);
    uint32_t *state = U32(LOOKUP_HASH_STATE);
    state[0] = LOOKUP_HASH_SEED + LOOKUP_HASH_PRIME1 + LOOKUP_HASH_PRIME2;
    state[1] = LOOKUP_HASH_SEED + LOOKUP_HASH_PRIME2;
    state[2] = LOOKUP_HASH_SEED;
    state[3] = LOOKUP_HASH_SEED - LOOKUP_HASH_PRIME1;
    state[4] = total;
    state[5] = 0;
    state[6] = LOOKUP_HASH_ACTIVE;
}

__attribute__((export_name("lookup_hash_update")))
void lookup_hash_update(uint32_t length) {
    lookup_hash_require_source(length);
    uint32_t *state = U32(LOOKUP_HASH_STATE);
    if (state[6] != LOOKUP_HASH_ACTIVE || (length & 15u) != 0 ||
        state[5] > state[4] || length > state[4] - state[5]) {
        __builtin_trap();
    }
    const uint8_t *source = U8(LOOKUP_HASH_DATA);
    uint32_t v1 = state[0], v2 = state[1], v3 = state[2], v4 = state[3];
    for (uint32_t cursor = 0; cursor < length; cursor += 16u) {
        v1 = lookup_hash_round(v1, lookup_hash_read_u32(source + cursor));
        v2 = lookup_hash_round(v2, lookup_hash_read_u32(source + cursor + 4u));
        v3 = lookup_hash_round(v3, lookup_hash_read_u32(source + cursor + 8u));
        v4 = lookup_hash_round(v4, lookup_hash_read_u32(source + cursor + 12u));
    }
    state[0] = v1; state[1] = v2; state[2] = v3; state[3] = v4;
    state[5] += length;
}

__attribute__((export_name("lookup_hash_finish")))
uint32_t lookup_hash_finish(uint32_t length) {
    lookup_hash_require_source(length);
    uint32_t *state = U32(LOOKUP_HASH_STATE);
    if (state[5] > state[4] || length != state[4] - state[5]) { __builtin_trap(); }
    const uint32_t full = length & ~15u;
    lookup_hash_update(full);
    uint32_t hash = state[4] >= 16u ?
        lookup_hash_rotate(state[0], 1u) + lookup_hash_rotate(state[1], 7u) +
        lookup_hash_rotate(state[2], 12u) + lookup_hash_rotate(state[3], 18u) :
        LOOKUP_HASH_SEED + LOOKUP_HASH_PRIME5;
    hash += state[4];
    const uint8_t *source = U8(LOOKUP_HASH_DATA);
    uint32_t cursor = full;
    while (cursor + 4u <= length) {
        hash = lookup_hash_rotate(hash + lookup_hash_read_u32(source + cursor) * LOOKUP_HASH_PRIME3, 17u) * LOOKUP_HASH_PRIME4;
        cursor += 4u;
    }
    while (cursor < length) {
        hash = lookup_hash_rotate(hash + source[cursor] * LOOKUP_HASH_PRIME5, 11u) * LOOKUP_HASH_PRIME1;
        ++cursor;
    }
    hash ^= hash >> 15u;
    hash *= LOOKUP_HASH_PRIME2;
    hash ^= hash >> 13u;
    hash *= LOOKUP_HASH_PRIME3;
    hash ^= hash >> 16u;
    state[6] = 0;
    return hash;
}
