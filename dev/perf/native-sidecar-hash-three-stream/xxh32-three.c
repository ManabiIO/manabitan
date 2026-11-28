/* Copyright (C) 2026 Manabitan authors; SPDX-License-Identifier: GPL-3.0-or-later */
#include <stdint.h>
#include <wasm_simd128.h>

#define EXPORTED(name) __attribute__((export_name(name)))
#define CAPACITY 20480u
#define PRIME1 2654435761u
#define PRIME2 2246822519u
#define PRIME3 3266489917u
#define PRIME4 668265263u
#define PRIME5 374761393u

typedef struct {
    uint32_t seed, total_length, has_stripe;
    uint32_t v1, v2, v3, v4;
    uint32_t carry_length;
    uint8_t carry[16];
} HashState;

static uint8_t scratch[3u * CAPACITY] __attribute__((aligned(16)));
static HashState states[3];

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
static inline v128_t rotate_lanes(v128_t lanes) {
    return wasm_v128_or(wasm_i32x4_shl(lanes, 13), wasm_u32x4_shr(lanes, 19));
}
static inline void consume_stripe(HashState* state, const uint8_t* p) {
    state->v1 = round32(state->v1, read_u32_le(p));
    state->v2 = round32(state->v2, read_u32_le(p + 4u));
    state->v3 = round32(state->v3, read_u32_le(p + 8u));
    state->v4 = round32(state->v4, read_u32_le(p + 12u));
}

EXPORTED("xxh32_scratch_ptr") uint32_t xxh32_scratch_ptr(void) {
    return (uint32_t)(uintptr_t)scratch;
}
EXPORTED("xxh32_scratch_capacity") uint32_t xxh32_scratch_capacity(void) { return CAPACITY; }

EXPORTED("xxh32_init") void xxh32_init(uint32_t seed) {
    for (uint32_t i = 0u; i < 3u; ++i) {
        states[i].seed = seed;
        states[i].total_length = 0u;
        states[i].has_stripe = 0u;
        states[i].v1 = seed + PRIME1 + PRIME2;
        states[i].v2 = seed + PRIME2;
        states[i].v3 = seed;
        states[i].v4 = seed - PRIME1;
        states[i].carry_length = 0u;
    }
}

#define LOAD_ADD(i) lanes[i] = wasm_i32x4_add(lanes[i], wasm_i32x4_mul(wasm_v128_load(p[i]), prime2))
#define ROTATE(i) lanes[i] = rotate_lanes(lanes[i])
#define MULTIPLY(i) lanes[i] = wasm_i32x4_mul(lanes[i], prime1)
#define ADVANCE(i) p[i] += 16u; remaining[i] -= 16u
#define PAIR(a, b) \
    while (remaining[a] >= 16u && remaining[b] >= 16u) { \
        LOAD_ADD(a); LOAD_ADD(b); \
        ROTATE(a); ROTATE(b); \
        MULTIPLY(a); MULTIPLY(b); \
        ADVANCE(a); ADVANCE(b); \
    }

EXPORTED("xxh32_update") uint32_t xxh32_update(uint32_t length0, uint32_t length1, uint32_t length2) {
    if (length0 > CAPACITY || length1 > CAPACITY || length2 > CAPACITY) { return 0u; }
    const uint8_t* p[3] = {scratch, scratch + CAPACITY, scratch + 2u * CAPACITY};
    uint32_t remaining[3] = {length0, length1, length2};
    uint32_t pending_carry[3] = {0u, 0u, 0u};
    v128_t lanes[3];
    const v128_t prime1 = wasm_i32x4_splat((int32_t)PRIME1);
    const v128_t prime2 = wasm_i32x4_splat((int32_t)PRIME2);
    for (uint32_t i = 0u; i < 3u; ++i) {
        HashState* state = &states[i];
        state->total_length += remaining[i];
        if (state->carry_length != 0u) {
            uint32_t copied = 16u - state->carry_length;
            if (copied > remaining[i]) { copied = remaining[i]; }
            for (uint32_t j = 0u; j < copied; ++j) state->carry[state->carry_length + j] = p[i][j];
            state->carry_length += copied;
            p[i] += copied;
            remaining[i] -= copied;
            if (state->carry_length == 16u) {
                consume_stripe(state, state->carry);
                state->has_stripe = 1u;
                state->carry_length = 0u;
            } else {
                pending_carry[i] = 1u;
            }
        }
        if (remaining[i] >= 16u) state->has_stripe = 1u;
        lanes[i] = wasm_u32x4_make(state->v1, state->v2, state->v3, state->v4);
    }
    while (remaining[0] >= 16u && remaining[1] >= 16u && remaining[2] >= 16u) {
        LOAD_ADD(0); LOAD_ADD(1); LOAD_ADD(2);
        ROTATE(0); ROTATE(1); ROTATE(2);
        MULTIPLY(0); MULTIPLY(1); MULTIPLY(2);
        ADVANCE(0); ADVANCE(1); ADVANCE(2);
    }
    PAIR(0, 1)
    PAIR(0, 2)
    PAIR(1, 2)
    for (uint32_t i = 0u; i < 3u; ++i) {
        while (remaining[i] >= 16u) {
            LOAD_ADD(i);
            ROTATE(i);
            MULTIPLY(i);
            ADVANCE(i);
        }
        HashState* state = &states[i];
        state->v1 = wasm_u32x4_extract_lane(lanes[i], 0);
        state->v2 = wasm_u32x4_extract_lane(lanes[i], 1);
        state->v3 = wasm_u32x4_extract_lane(lanes[i], 2);
        state->v4 = wasm_u32x4_extract_lane(lanes[i], 3);
        if (pending_carry[i] == 0u) {
            for (uint32_t j = 0u; j < remaining[i]; ++j) state->carry[j] = p[i][j];
            state->carry_length = remaining[i];
        }
    }
    return 1u;
}

EXPORTED("xxh32_finish") uint32_t xxh32_finish(uint32_t index) {
    if (index >= 3u) return 0u;
    const HashState* state = &states[index];
    uint32_t hash = state->has_stripe != 0u ?
        rotl32(state->v1, 1u) + rotl32(state->v2, 7u) + rotl32(state->v3, 12u) + rotl32(state->v4, 18u) : state->seed + PRIME5;
    hash += state->total_length;
    const uint8_t* p = state->carry;
    uint32_t remaining = state->carry_length;
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
