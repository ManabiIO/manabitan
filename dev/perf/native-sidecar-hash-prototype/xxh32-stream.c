/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Bounded scalar XXH32 prototype. Constants and round/finalization match
 * term-bank-parser.c; this experiment adds streaming carry state only.
 */

#include <stdint.h>
#if defined(__wasm_simd128__)
#include <wasm_simd128.h>
#endif

#define EXPORTED(name) __attribute__((export_name(name)))
#define SCRATCH_CAPACITY 61440u
#define PRIME1 2654435761u
#define PRIME2 2246822519u
#define PRIME3 3266489917u
#define PRIME4 668265263u
#define PRIME5 374761393u

static uint8_t scratch[SCRATCH_CAPACITY] __attribute__((aligned(16)));
static struct {
    uint32_t seed;
    uint32_t total_length;
    uint32_t has_stripe;
    uint32_t v1;
    uint32_t v2;
    uint32_t v3;
    uint32_t v4;
    uint32_t carry_length;
    uint8_t carry[16];
} state;

static inline uint32_t read_u32_le(const uint8_t* p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8u) |
        ((uint32_t)p[2] << 16u) | ((uint32_t)p[3] << 24u);
}

static inline uint32_t rotl32(uint32_t value, uint32_t amount) {
    return (value << amount) | (value >> (32u - amount));
}

static inline uint32_t round32(uint32_t accumulator, uint32_t value) {
    return rotl32(accumulator + value * PRIME2, 13u) * PRIME1;
}

static inline void consume_stripe(const uint8_t* p) {
    state.v1 = round32(state.v1, read_u32_le(p));
    state.v2 = round32(state.v2, read_u32_le(p + 4u));
    state.v3 = round32(state.v3, read_u32_le(p + 8u));
    state.v4 = round32(state.v4, read_u32_le(p + 12u));
}

EXPORTED("xxh32_scratch_ptr") uint32_t xxh32_scratch_ptr(void) {
    return (uint32_t)(uintptr_t)scratch;
}

EXPORTED("xxh32_scratch_capacity") uint32_t xxh32_scratch_capacity(void) {
    return SCRATCH_CAPACITY;
}

EXPORTED("xxh32_init") void xxh32_init(uint32_t seed) {
    state.seed = seed;
    state.total_length = 0u;
    state.has_stripe = 0u;
    state.v1 = seed + PRIME1 + PRIME2;
    state.v2 = seed + PRIME2;
    state.v3 = seed;
    state.v4 = seed - PRIME1;
    state.carry_length = 0u;
}

EXPORTED("xxh32_update") uint32_t xxh32_update(uint32_t length) {
    if (length > SCRATCH_CAPACITY) { return 0u; }
    state.total_length += length;
    const uint8_t* p = scratch;
    uint32_t remaining = length;
    if (state.carry_length != 0u) {
        uint32_t copied = 16u - state.carry_length;
        if (copied > remaining) { copied = remaining; }
        for (uint32_t i = 0u; i < copied; ++i) {
            state.carry[state.carry_length + i] = p[i];
        }
        state.carry_length += copied;
        p += copied;
        remaining -= copied;
        if (state.carry_length != 16u) { return 1u; }
        consume_stripe(state.carry);
        state.has_stripe = 1u;
        state.carry_length = 0u;
    }
    if (remaining >= 16u) {
#if defined(__wasm_simd128__)
        v128_t accumulators = wasm_u32x4_make(state.v1, state.v2, state.v3, state.v4);
        const v128_t prime1 = wasm_i32x4_splat((int32_t)PRIME1);
        const v128_t prime2 = wasm_i32x4_splat((int32_t)PRIME2);
        do {
            accumulators = wasm_i32x4_add(accumulators, wasm_i32x4_mul(wasm_v128_load(p), prime2));
            accumulators = wasm_v128_or(wasm_i32x4_shl(accumulators, 13), wasm_u32x4_shr(accumulators, 19));
            accumulators = wasm_i32x4_mul(accumulators, prime1);
            p += 16u;
            remaining -= 16u;
        } while (remaining >= 16u);
        state.v1 = wasm_u32x4_extract_lane(accumulators, 0);
        state.v2 = wasm_u32x4_extract_lane(accumulators, 1);
        state.v3 = wasm_u32x4_extract_lane(accumulators, 2);
        state.v4 = wasm_u32x4_extract_lane(accumulators, 3);
#else
        uint32_t v1 = state.v1;
        uint32_t v2 = state.v2;
        uint32_t v3 = state.v3;
        uint32_t v4 = state.v4;
        do {
            v1 = round32(v1, read_u32_le(p));
            v2 = round32(v2, read_u32_le(p + 4u));
            v3 = round32(v3, read_u32_le(p + 8u));
            v4 = round32(v4, read_u32_le(p + 12u));
            p += 16u;
            remaining -= 16u;
        } while (remaining >= 16u);
        state.v1 = v1;
        state.v2 = v2;
        state.v3 = v3;
        state.v4 = v4;
#endif
        state.has_stripe = 1u;
    }
    for (uint32_t i = 0u; i < remaining; ++i) { state.carry[i] = p[i]; }
    state.carry_length = remaining;
    return 1u;
}

EXPORTED("xxh32_finish") uint32_t xxh32_finish(void) {
    uint32_t hash = state.has_stripe != 0u ?
        rotl32(state.v1, 1u) + rotl32(state.v2, 7u) + rotl32(state.v3, 12u) + rotl32(state.v4, 18u) :
        state.seed + PRIME5;
    hash += state.total_length;
    const uint8_t* p = state.carry;
    uint32_t remaining = state.carry_length;
    while (remaining >= 4u) {
        hash = rotl32(hash + read_u32_le(p) * PRIME3, 17u) * PRIME4;
        p += 4u;
        remaining -= 4u;
    }
    while (remaining != 0u) {
        hash = rotl32(hash + (uint32_t)(*p) * PRIME5, 11u) * PRIME1;
        ++p;
        --remaining;
    }
    hash ^= hash >> 15u;
    hash *= PRIME2;
    hash ^= hash >> 13u;
    hash *= PRIME3;
    hash ^= hash >> 16u;
    return hash;
}
