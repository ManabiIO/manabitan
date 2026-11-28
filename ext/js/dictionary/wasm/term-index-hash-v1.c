/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

#include <stdint.h>
#include <wasm_simd128.h>

#define INPUT_BYTES 65536u
#define SEED 0x811c9dc5u
#define PRIME1 0x9e3779b1u
#define PRIME2 0x85ebca77u
#define PRIME3 0xc2b2ae3du
#define PRIME4 0x27d4eb2fu
#define PRIME5 0x165667b1u

/* Independent XXH32 lanes preserve the existing seed, little-endian words and
 * final avalanche. All state belongs to one synchronous JS call; no source
 * view, native address, allocation or checksum is retained by its caller. */
static uint8_t input[INPUT_BYTES];
static v128_t accumulators;
static uint32_t total_length;
static uint32_t processed_length;

static inline uint32_t rotate(uint32_t value, uint32_t bits) {
    return (value << bits) | (value >> (32u - bits));
}

static inline uint32_t read32(const uint8_t *bytes) {
    return (uint32_t)bytes[0] | ((uint32_t)bytes[1] << 8u) |
        ((uint32_t)bytes[2] << 16u) | ((uint32_t)bytes[3] << 24u);
}

__attribute__((export_name("hash_abi_version")))
uint32_t hash_abi_version(void) { return 1u; }

__attribute__((export_name("input_pointer")))
uint32_t input_pointer(void) { return (uint32_t)(uintptr_t)input; }

__attribute__((export_name("input_capacity")))
uint32_t input_capacity(void) { return INPUT_BYTES; }

__attribute__((export_name("reset")))
void reset(uint32_t length) {
    total_length = length;
    processed_length = 0u;
    accumulators = wasm_i32x4_make(SEED + PRIME1 + PRIME2, SEED + PRIME2, SEED, SEED - PRIME1);
}

__attribute__((export_name("update")))
void update(uint32_t length) {
    if (length > INPUT_BYTES || (length & 15u) != 0u || length > total_length - processed_length) {
        __builtin_trap();
    }
    v128_t accumulator = accumulators;
    const v128_t prime1 = wasm_i32x4_splat(PRIME1);
    const v128_t prime2 = wasm_i32x4_splat(PRIME2);
    for (uint32_t offset = 0u; offset < length; offset += 16u) {
        accumulator = wasm_i32x4_add(accumulator, wasm_i32x4_mul(wasm_v128_load(input + offset), prime2));
        accumulator = wasm_v128_or(wasm_i32x4_shl(accumulator, 13), wasm_u32x4_shr(accumulator, 19));
        accumulator = wasm_i32x4_mul(accumulator, prime1);
    }
    accumulators = accumulator;
    processed_length += length;
}

__attribute__((export_name("digest")))
uint32_t digest(uint32_t tail_length) {
    if (tail_length >= 16u || tail_length != total_length - processed_length) {
        __builtin_trap();
    }
    uint32_t hash = SEED + PRIME5;
    if (total_length >= 16u) {
        hash = rotate(wasm_i32x4_extract_lane(accumulators, 0), 1u) +
            rotate(wasm_i32x4_extract_lane(accumulators, 1), 7u) +
            rotate(wasm_i32x4_extract_lane(accumulators, 2), 12u) +
            rotate(wasm_i32x4_extract_lane(accumulators, 3), 18u);
    }
    hash += total_length;
    uint32_t offset = 0u;
    for (; offset + 4u <= tail_length; offset += 4u) {
        hash = rotate(hash + read32(input + offset) * PRIME3, 17u) * PRIME4;
    }
    for (; offset < tail_length; ++offset) {
        hash = rotate(hash + (uint32_t)input[offset] * PRIME5, 11u) * PRIME1;
    }
    hash ^= hash >> 15u;
    hash *= PRIME2;
    hash ^= hash >> 13u;
    hash *= PRIME3;
    hash ^= hash >> 16u;
    return hash;
}
