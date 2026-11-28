/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Measurement-only compact record-field encoder. No product integration.
 * ABI 1: imported private memory, fixed 4 MiB. The JS caller owns all pointers,
 * bounds input copies, and returns an owned copy only after complete success.
 * Zero means use the unchanged JS encoder, including its errors and formats.
 */
#include <stdint.h>

#define MEMORY_BYTES 4194304u
#define SCRATCH_START 131072u
#define MAX_ROWS 65534u
#define MAX_SLOTS 131072u
#define U16_NULL 65535u
#define U32_NULL 0xffffffffu
#define MAX_DELTA 0xfffffffeu
#define COMPACT_MAGIC 0x3246524du
#define MAX_SAFE_INTEGER 9007199254740991.0

/* Bulk-memory intrinsics keep this freestanding module free of libc imports. */
void* memset(void* destination, int value, unsigned long count) {
    __builtin_memset(destination, value, count);
    return destination;
}

void* memcpy(void* destination, const void* source, unsigned long count) {
    __builtin_memcpy(destination, source, count);
    return destination;
}

static int valid_region(const void* address, uint32_t bytes, uint32_t alignment) {
    const uintptr_t pointer = (uintptr_t)address;
    return pointer >= SCRATCH_START && pointer <= MEMORY_BYTES &&
        (pointer & (alignment - 1u)) == 0u && bytes <= MEMORY_BYTES - pointer;
}

static uint32_t score_hash(uint32_t value) {
    value ^= value >> 16u;
    value *= 0x7feb352du;
    value ^= value >> 15u;
    value *= 0x846ca68bu;
    return value ^ (value >> 16u);
}

uint32_t record_field_abi_version(void) {
    return 1u;
}

uint32_t encode_compact_record_fields(
    uint32_t row_count,
    uint32_t unique_count,
    double content_offset_base,
    const int32_t* scores,
    const uint32_t* unique_ids,
    const double* resolved_offsets,
    const uint32_t* resolved_lengths,
    uint32_t* score_slots,
    uint32_t slot_count,
    int32_t* palette,
    uint16_t* score_keys,
    uint8_t* output,
    uint32_t output_capacity
) {
    if (
        row_count == 0u || row_count > MAX_ROWS ||
        unique_count == 0u || unique_count > MEMORY_BYTES / 12u ||
        slot_count < row_count * 2u || slot_count > MAX_SLOTS ||
        (slot_count & (slot_count - 1u)) != 0u ||
        !(content_offset_base >= 0.0) || content_offset_base > MAX_SAFE_INTEGER ||
        (double)(uint64_t)content_offset_base != content_offset_base ||
        !valid_region(scores, row_count * 4u, 4u) ||
        !valid_region(unique_ids, row_count * 4u, 4u) ||
        !valid_region(resolved_offsets, unique_count * 8u, 8u) ||
        !valid_region(resolved_lengths, unique_count * 4u, 4u) ||
        !valid_region(score_slots, slot_count * 4u, 4u) ||
        !valid_region(palette, row_count * 4u, 4u) ||
        !valid_region(score_keys, row_count * 2u, 2u) ||
        !valid_region(output, output_capacity, 4u)
    ) {
        return 0u;
    }

    __builtin_memset(score_slots, 0, slot_count * 4u);
    const uint32_t slot_mask = slot_count - 1u;
    uint32_t score_count = 0u;
    for (uint32_t row = 0u; row < row_count; ++row) {
        const uint32_t unique_id = unique_ids[row];
        if (unique_id >= unique_count || resolved_lengths[unique_id] >= U16_NULL) {
            return 0u;
        }
        const int32_t score = scores[row];
        uint32_t slot = score_hash((uint32_t)score) & slot_mask;
        uint32_t encoded_key = score_slots[slot];
        while (encoded_key != 0u && palette[encoded_key - 1u] != score) {
            slot = (slot + 1u) & slot_mask;
            encoded_key = score_slots[slot];
        }
        if (encoded_key == 0u) {
            if (score_count >= U16_NULL) { return 0u; }
            palette[score_count] = score;
            encoded_key = ++score_count;
            score_slots[slot] = encoded_key;
        }
        score_keys[row] = (uint16_t)(encoded_key - 1u);
    }

    const uint32_t output_bytes = 16u + score_count * 4u + row_count * 8u;
    if (
        score_count == 0u || score_count >= U16_NULL ||
        output_bytes >= row_count * 12u || output_bytes > output_capacity
    ) {
        return 0u;
    }
    uint32_t* header = (uint32_t*)output;
    header[0] = COMPACT_MAGIC;
    header[1] = row_count;
    header[2] = score_count;
    header[3] = 2u;
    __builtin_memcpy(output + 16u, palette, score_count * 4u);
    uint32_t* output_offsets = (uint32_t*)(output + 16u + score_count * 4u);
    uint16_t* output_lengths = (uint16_t*)(output_offsets + row_count);
    uint16_t* output_keys = output_lengths + row_count;
    for (uint32_t row = 0u; row < row_count; ++row) {
        const uint32_t unique_id = unique_ids[row];
        const double offset = resolved_offsets[unique_id];
        uint32_t encoded_offset;
        if (offset == -1.0) {
            encoded_offset = U32_NULL;
        } else {
            if (
                !(offset >= 0.0) || offset > MAX_SAFE_INTEGER ||
                (double)(uint64_t)offset != offset
            ) {
                return 0u;
            }
            const double delta = offset - content_offset_base;
            if (
                !(delta >= 0.0) || delta > (double)MAX_DELTA ||
                (double)(uint32_t)delta != delta
            ) {
                return 0u;
            }
            encoded_offset = (uint32_t)delta;
        }
        output_offsets[row] = encoded_offset;
        output_lengths[row] = (uint16_t)resolved_lengths[unique_id];
    }
    __builtin_memcpy(output_keys, score_keys, row_count * 2u);
    return output_bytes;
}
