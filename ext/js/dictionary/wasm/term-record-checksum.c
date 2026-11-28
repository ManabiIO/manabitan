/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

#include <stdint.h>
#include <wasm_simd128.h>

/* The persisted lookup format uses XXH32 with the original term-key seed. */
#define LOOKUP_HASH_SEED 0x811c9dc5u

static inline uint32_t read_u32_le(const uint8_t* p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8u) |
        ((uint32_t)p[2] << 16u) | ((uint32_t)p[3] << 24u);
}

static inline uint32_t rotl32(uint32_t value, uint32_t amount) {
    return (value << amount) | (value >> (32u - amount));
}

__attribute__((visibility("default")))
uint32_t hash_lookup_index_bytes(uint32_t source_ptr, uint32_t length) {
    const uint8_t* p = (const uint8_t*)(uintptr_t)source_ptr;
    const uint8_t* const end = p + length;
    uint32_t hash = LOOKUP_HASH_SEED + 374761393u;
    if (length >= 16u) {
        const uint8_t* const limit = end - 16u;
        const v128_t prime1 = wasm_i32x4_splat((int32_t)2654435761u);
        const v128_t prime2 = wasm_i32x4_splat((int32_t)2246822519u);
        v128_t lanes = wasm_u32x4_make(
            LOOKUP_HASH_SEED + 2654435761u + 2246822519u,
            LOOKUP_HASH_SEED + 2246822519u,
            LOOKUP_HASH_SEED,
            LOOKUP_HASH_SEED - 2654435761u
        );
        do {
            lanes = wasm_i32x4_add(lanes, wasm_i32x4_mul(wasm_v128_load(p), prime2));
            lanes = wasm_v128_or(wasm_i32x4_shl(lanes, 13), wasm_u32x4_shr(lanes, 19));
            lanes = wasm_i32x4_mul(lanes, prime1);
            p += 16u;
        } while (p <= limit);
        hash =
            rotl32(wasm_u32x4_extract_lane(lanes, 0), 1u) +
            rotl32(wasm_u32x4_extract_lane(lanes, 1), 7u) +
            rotl32(wasm_u32x4_extract_lane(lanes, 2), 12u) +
            rotl32(wasm_u32x4_extract_lane(lanes, 3), 18u);
    }
    hash += length;
    while ((uint32_t)(end - p) >= 4u) {
        hash += read_u32_le(p) * 3266489917u;
        hash = rotl32(hash, 17u) * 668265263u;
        p += 4u;
    }
    while (p < end) {
        hash += ((uint32_t)(*p)) * 374761393u;
        hash = rotl32(hash, 11u) * 2654435761u;
        ++p;
    }
    hash ^= hash >> 15u;
    hash *= 2246822519u;
    hash ^= hash >> 13u;
    hash *= 3266489917u;
    hash ^= hash >> 16u;
    return hash;
}
