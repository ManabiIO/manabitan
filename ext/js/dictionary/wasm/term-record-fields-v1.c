/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include <stdint.h>

#define SCORE_SLOTS 2048u
#define MAX_SCORES 1024u
#define MAX_ROWS 262144u
#define MAX_UNIQUE 262144u
#define MAX_MEMORY (8u * 1024u * 1024u)
#define MAGIC 0x3246524du
#define NULL_OFFSET 0xffffffffu
#define MAX_DELTA 4294967294.0
#define MAX_SAFE 9007199254740991.0

extern unsigned char __heap_base;
static uint16_t score_slots[SCORE_SLOTS];
static int32_t score_values[MAX_SCORES];

__attribute__((export_name("record_fields_abi_version")))
uint32_t record_fields_abi_version(void) { return 1u; }

__attribute__((export_name("record_fields_scratch_start")))
uint32_t record_fields_scratch_start(void) {
    return ((uint32_t)(uintptr_t)&__heap_base + 7u) & ~7u;
}

/* Private copied input layout: indexes, scores, unique offsets, unique lengths,
 * score-key scratch and the final output aligned to four bytes. */
__attribute__((export_name("encode_record_fields")))
int32_t encode_record_fields(uint32_t count, uint32_t unique_count, double base) {
    if (!count || count > MAX_ROWS || !unique_count || unique_count > MAX_UNIQUE ||
        !(base >= 0.0) || base > MAX_SAFE || __builtin_trunc(base) != base) {
        return 0;
    }
    uint32_t start = record_fields_scratch_start();
    uint32_t required = (start + count * 10u + unique_count * 12u + 3u) & ~3u;
    required += count * 12u;
    if (required > MAX_MEMORY || required > __builtin_wasm_memory_size(0) * 65536u) {
        return 0;
    }
    const uint32_t *indexes = (const uint32_t *)(uintptr_t)start;
    const int32_t *scores = (const int32_t *)(indexes + count);
    const double *offsets = (const double *)(scores + count);
    const uint32_t *lengths = (const uint32_t *)(offsets + unique_count);
    uint16_t *score_keys = (uint16_t *)(lengths + unique_count);
    uint32_t *output = (uint32_t *)(((uintptr_t)(score_keys + count) + 3u) & ~(uintptr_t)3u);
    uint32_t score_count = 0;
    for (uint32_t i = 0; i < SCORE_SLOTS; ++i) { score_slots[i] = 0; }
    for (uint32_t i = 0; i < count; ++i) {
        uint32_t unique = indexes[i];
        if (unique >= unique_count) { return 0; }
        double offset = offsets[unique];
        if (lengths[unique] >= 65535u) { return 0; }
        if (offset != -1.0) {
            if (!(offset >= 0.0) || offset > MAX_SAFE || __builtin_trunc(offset) != offset) { return 0; }
            double delta = offset - base;
            if (!(delta >= 0.0) || delta > MAX_DELTA) { return 0; }
        }
        int32_t score = scores[i];
        uint32_t hash = (uint32_t)score;
        hash = (hash ^ (hash >> 16u)) * 2654435761u;
        uint32_t slot = hash & (SCORE_SLOTS - 1u);
        while (score_slots[slot] && score_values[score_slots[slot] - 1u] != score) {
            slot = (slot + 1u) & (SCORE_SLOTS - 1u);
        }
        if (!score_slots[slot]) {
            if (score_count >= MAX_SCORES) { return 0; }
            score_values[score_count] = score;
            score_slots[slot] = ++score_count;
        }
        score_keys[i] = score_slots[slot] - 1u;
    }
    uint32_t byte_length = 16u + score_count * 4u + count * 8u;
    if (!score_count || byte_length >= count * 12u) { return 0; }
    output[0] = MAGIC;
    output[1] = count;
    output[2] = score_count;
    output[3] = 2u;
    int32_t *out_scores = (int32_t *)(output + 4);
    for (uint32_t i = 0; i < score_count; ++i) { out_scores[i] = score_values[i]; }
    uint32_t *out_offsets = (uint32_t *)(out_scores + score_count);
    uint16_t *out_lengths = (uint16_t *)(out_offsets + count);
    uint16_t *out_keys = out_lengths + count;
    for (uint32_t i = 0; i < count; ++i) {
        uint32_t unique = indexes[i];
        double offset = offsets[unique];
        out_offsets[i] = offset < 0.0 ? NULL_OFFSET : (uint32_t)(offset - base);
        out_lengths[i] = (uint16_t)lengths[unique];
        out_keys[i] = score_keys[i];
    }
    return (int32_t)byte_length;
}
