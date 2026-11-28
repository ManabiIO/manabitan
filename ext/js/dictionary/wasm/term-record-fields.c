/*
 * Copyright (C) 2026 Manabitan authors
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
#include <stddef.h>

#define EXPORT(name) __attribute__((export_name(name)))
#define PREFIX 131072u
#define MAX_SCORE_COUNT 65535u
#define U32_NULL 0xffffffffu
#define MAX_SAFE_INTEGER 9007199254740991.0
#define MAX_DELTA 4294967294.0

typedef struct { uint32_t start; uint64_t size; uint32_t alignment; } Region;

static uint32_t mix_score(uint32_t value) {
    value ^= value >> 16;
    value *= 0x7feb352du;
    value ^= value >> 15;
    value *= 0x846ca68bu;
    return value ^ (value >> 16);
}

EXPORT("record_fields_abi_version")
uint32_t record_fields_abi_version(void) { return 1u; }

/*
 * Return an owned-arena compact byte length, zero for unsupported compact
 * format, or a negative code for malformed private arguments. Nothing outside
 * the passed private memory changes, and no output is published on failure.
 */
EXPORT("encode_record_fields")
int32_t encode_record_fields(
    uint32_t count, uint32_t unique_count,
    uint32_t row_ptr, uint32_t input_score_ptr,
    uint32_t offset_ptr, uint32_t length_ptr,
    double content_base,
    uint32_t slot_ptr, uint32_t slot_count,
    uint32_t dictionary_ptr, uint32_t key_ptr,
    uint32_t output_ptr, uint32_t output_capacity
) {
    if (!count || !unique_count) { return 0; }
    const uint32_t score_capacity = count < MAX_SCORE_COUNT ? count : MAX_SCORE_COUNT;
    if (
        !slot_count || (slot_count & (slot_count - 1u)) ||
        slot_count < score_capacity * 2u || slot_count > 131072u ||
        !(content_base >= 0.0 && content_base <= MAX_SAFE_INTEGER) ||
        (double)(uint64_t)content_base != content_base
    ) { return -1; }

    const uint64_t memory_bytes = (uint64_t)__builtin_wasm_memory_size(0) * 65536u;
    const Region regions[] = {
        {row_ptr, (uint64_t)count * 4u, 4u},
        {input_score_ptr, (uint64_t)count * 4u, 4u},
        {offset_ptr, (uint64_t)unique_count * 8u, 8u},
        {length_ptr, (uint64_t)unique_count * 4u, 4u},
        {slot_ptr, (uint64_t)slot_count * 4u, 4u},
        {dictionary_ptr, (uint64_t)score_capacity * 4u, 4u},
        {key_ptr, (uint64_t)count * 2u, 2u},
        {output_ptr, output_capacity, 4u},
    };
    for (uint32_t i = 0; i < 8u; ++i) {
        const Region a = regions[i];
        if (
            a.start < PREFIX || a.start % a.alignment ||
            (uint64_t)a.start + a.size > memory_bytes
        ) { return -2; }
        for (uint32_t j = i + 1u; j < 8u; ++j) {
            const Region b = regions[j];
            if ((uint64_t)a.start < (uint64_t)b.start + b.size &&
                (uint64_t)b.start < (uint64_t)a.start + a.size) { return -2; }
        }
    }

    const uint32_t *rows = (const uint32_t *)(uintptr_t)row_ptr;
    const int32_t *input_scores = (const int32_t *)(uintptr_t)input_score_ptr;
    const double *offsets = (const double *)(uintptr_t)offset_ptr;
    const uint32_t *lengths = (const uint32_t *)(uintptr_t)length_ptr;
    uint32_t *slots = (uint32_t *)(uintptr_t)slot_ptr;
    int32_t *dictionary = (int32_t *)(uintptr_t)dictionary_ptr;
    uint16_t *keys = (uint16_t *)(uintptr_t)key_ptr;
    __builtin_memset(slots, 0, (size_t)slot_count * 4u);
    uint32_t score_count = 0;
    const uint32_t mask = slot_count - 1u;
    // Keep adversarial score collisions linear in the admitted input/table
    // size. Exhaustion abandons only this private attempt; JS remains exact.
    uint64_t remaining_probes = (uint64_t)count * 4u + slot_count;

    for (uint32_t row = 0; row < count; ++row) {
        const uint32_t unique = rows[row];
        if (unique >= unique_count) { return -3; }
        if (lengths[unique] >= 65535u) { return 0; }
        const double offset = offsets[unique];
        if (offset != -1.0) {
            if (!(offset >= 0.0 && offset <= MAX_SAFE_INTEGER) ||
                (double)(uint64_t)offset != offset) { return -4; }
            const double delta = offset - content_base;
            if (!(delta >= 0.0 && delta <= MAX_DELTA) ||
                (double)(uint32_t)delta != delta) { return -4; }
        }
        const int32_t score = input_scores[row];
        uint32_t slot = mix_score((uint32_t)score) & mask;
        uint32_t entry = slots[slot];
        uint32_t probes = 0;
        while (entry) {
            if (!remaining_probes--) { return 0; }
            if (entry > score_count || ++probes >= slot_count) { return -5; }
            if (dictionary[entry - 1u] == score) { break; }
            slot = (slot + 1u) & mask;
            entry = slots[slot];
        }
        if (!entry) {
            if (score_count >= score_capacity) { return 0; }
            dictionary[score_count] = score;
            entry = ++score_count;
            slots[slot] = entry;
        }
        keys[row] = (uint16_t)(entry - 1u);
    }
    const uint64_t byte_length = 16u + (uint64_t)score_count * 4u + (uint64_t)count * 8u;
    if (!score_count || score_count >= MAX_SCORE_COUNT || byte_length >= (uint64_t)count * 12u) { return 0; }
    if (byte_length > output_capacity || byte_length > 0x7fffffffu) { return -6; }

    uint32_t *header = (uint32_t *)(uintptr_t)output_ptr;
    header[0] = 0x3246524du;
    header[1] = count;
    header[2] = score_count;
    header[3] = 2u;
    int32_t *output_scores = (int32_t *)(uintptr_t)(output_ptr + 16u);
    __builtin_memcpy(output_scores, dictionary, (size_t)score_count * 4u);
    uint32_t *output_offsets = (uint32_t *)(uintptr_t)(output_ptr + 16u + score_count * 4u);
    uint16_t *output_lengths = (uint16_t *)(output_offsets + count);
    uint16_t *output_keys = output_lengths + count;
    for (uint32_t row = 0; row < count; ++row) {
        const uint32_t unique = rows[row];
        const double offset = offsets[unique];
        output_offsets[row] = offset < 0.0 ? U32_NULL : (uint32_t)(offset - content_base);
        output_lengths[row] = (uint16_t)lengths[unique];
    }
    __builtin_memcpy(output_keys, keys, (size_t)count * 2u);
    return (int32_t)byte_length;
}
