/* Two exact XXH32 states, with the four stripe accumulators in SIMD lanes.
 * No speculative load: each vector consumes one complete 16-byte stripe.
 * The scalar tail/finalizer deliberately retains the established algorithm. */
static void hash_content_xxh32_pair_simd(const uint8_t* src, uint32_t length, uint32_t seed1, uint32_t seed2, uint32_t* out1, uint32_t* out2) {
    const uint8_t* p = src;
    const uint8_t* const end = src + length;
    const v128_t prime1 = wasm_u32x4_splat(2654435761u);
    const v128_t prime2 = wasm_u32x4_splat(2246822519u);
    const v128_t initial = wasm_u32x4_make(2654435761u + 2246822519u, 2246822519u, 0u, 0u - 2654435761u);
    v128_t a = wasm_i32x4_add(initial, wasm_u32x4_splat(seed1));
    v128_t b = wasm_i32x4_add(initial, wasm_u32x4_splat(seed2));
    do {
        const v128_t value = wasm_i32x4_mul(wasm_v128_load(p), prime2);
        a = wasm_i32x4_add(a, value);
        b = wasm_i32x4_add(b, value);
        a = wasm_v128_or(wasm_i32x4_shl(a, 13), wasm_u32x4_shr(a, 19));
        b = wasm_v128_or(wasm_i32x4_shl(b, 13), wasm_u32x4_shr(b, 19));
        a = wasm_i32x4_mul(a, prime1);
        b = wasm_i32x4_mul(b, prime1);
        p += 16u;
    } while ((uint32_t)(end - p) >= 16u);
    uint32_t h1 = rotl32(wasm_u32x4_extract_lane(a, 0), 1u) + rotl32(wasm_u32x4_extract_lane(a, 1), 7u) +
        rotl32(wasm_u32x4_extract_lane(a, 2), 12u) + rotl32(wasm_u32x4_extract_lane(a, 3), 18u);
    uint32_t h2 = rotl32(wasm_u32x4_extract_lane(b, 0), 1u) + rotl32(wasm_u32x4_extract_lane(b, 1), 7u) +
        rotl32(wasm_u32x4_extract_lane(b, 2), 12u) + rotl32(wasm_u32x4_extract_lane(b, 3), 18u);
    h1 += length;
    h2 += length;
    while ((uint32_t)(end - p) >= 4u) {
        const uint32_t value = read_u32_le(p);
        h1 = rotl32(h1 + value * 3266489917u, 17u) * 668265263u;
        h2 = rotl32(h2 + value * 3266489917u, 17u) * 668265263u;
        p += 4u;
    }
    while (p < end) {
        const uint32_t value = *p++;
        h1 = rotl32(h1 + value * 374761393u, 11u) * 2654435761u;
        h2 = rotl32(h2 + value * 374761393u, 11u) * 2654435761u;
    }
    *out1 = xxh32_finalize(h1);
    *out2 = xxh32_finalize(h2);
}
