#include <stddef.h>
#include <stdint.h>

#define XXH32_PRIME1 UINT32_C(2654435761)
#define XXH32_PRIME2 UINT32_C(2246822519)
#define XXH32_PRIME3 UINT32_C(3266489917)
#define XXH32_PRIME4 UINT32_C(668265263)
#define XXH32_PRIME5 UINT32_C(374761393)

#define TERM_CONTENT_BLOCK_ENVELOPE_BYTES 12
#define TERM_CONTENT_BLOCK_ENVELOPE_MAGIC UINT32_C(0x3243424d)

static uint32_t rotate_left_32(uint32_t value, uint32_t amount) {
    return (value << amount) | (value >> (32 - amount));
}

static uint32_t read_u32_le(const uint8_t* bytes) {
    return ((uint32_t)bytes[0]) |
        ((uint32_t)bytes[1] << 8) |
        ((uint32_t)bytes[2] << 16) |
        ((uint32_t)bytes[3] << 24);
}

static void write_u32_le(uint8_t* bytes, uint32_t value) {
    bytes[0] = (uint8_t)value;
    bytes[1] = (uint8_t)(value >> 8);
    bytes[2] = (uint8_t)(value >> 16);
    bytes[3] = (uint8_t)(value >> 24);
}

static uint32_t xxh32_round(uint32_t accumulator, uint32_t input) {
    accumulator += input * XXH32_PRIME2;
    accumulator = rotate_left_32(accumulator, 13);
    return accumulator * XXH32_PRIME1;
}

static uint32_t xxh32_finalize(
    uint32_t hash,
    const uint8_t* bytes,
    size_t offset,
    size_t length
) {
    hash += (uint32_t)length;
    while (offset + 4 <= length) {
        hash += read_u32_le(bytes + offset) * XXH32_PRIME3;
        hash = rotate_left_32(hash, 17) * XXH32_PRIME4;
        offset += 4;
    }
    while (offset < length) {
        hash += ((uint32_t)bytes[offset]) * XXH32_PRIME5;
        hash = rotate_left_32(hash, 11) * XXH32_PRIME1;
        ++offset;
    }
    hash ^= hash >> 15;
    hash *= XXH32_PRIME2;
    hash ^= hash >> 13;
    hash *= XXH32_PRIME3;
    hash ^= hash >> 16;
    return hash;
}

static void xxh32_pair(
    const uint8_t* bytes,
    size_t length,
    uint32_t seed1,
    uint32_t seed2,
    uint32_t* hash1_out,
    uint32_t* hash2_out
) {
    size_t offset = 0;
    uint32_t hash1;
    uint32_t hash2;
    if (length >= 16) {
        uint32_t a1 = seed1 + XXH32_PRIME1 + XXH32_PRIME2;
        uint32_t a2 = seed1 + XXH32_PRIME2;
        uint32_t a3 = seed1;
        uint32_t a4 = seed1 - XXH32_PRIME1;
        uint32_t b1 = seed2 + XXH32_PRIME1 + XXH32_PRIME2;
        uint32_t b2 = seed2 + XXH32_PRIME2;
        uint32_t b3 = seed2;
        uint32_t b4 = seed2 - XXH32_PRIME1;
        const size_t limit = length - 16;
        do {
            const uint32_t input1 = read_u32_le(bytes + offset);
            const uint32_t input2 = read_u32_le(bytes + offset + 4);
            const uint32_t input3 = read_u32_le(bytes + offset + 8);
            const uint32_t input4 = read_u32_le(bytes + offset + 12);
            a1 = xxh32_round(a1, input1);
            a2 = xxh32_round(a2, input2);
            a3 = xxh32_round(a3, input3);
            a4 = xxh32_round(a4, input4);
            b1 = xxh32_round(b1, input1);
            b2 = xxh32_round(b2, input2);
            b3 = xxh32_round(b3, input3);
            b4 = xxh32_round(b4, input4);
            offset += 16;
        } while (offset <= limit);
        hash1 = rotate_left_32(a1, 1) + rotate_left_32(a2, 7) +
            rotate_left_32(a3, 12) + rotate_left_32(a4, 18);
        hash2 = rotate_left_32(b1, 1) + rotate_left_32(b2, 7) +
            rotate_left_32(b3, 12) + rotate_left_32(b4, 18);
    } else {
        hash1 = seed1 + XXH32_PRIME5;
        hash2 = seed2 + XXH32_PRIME5;
    }
    *hash1_out = xxh32_finalize(hash1, bytes, offset, length);
    *hash2_out = xxh32_finalize(hash2, bytes, offset, length);
}

int manabitan_write_block_envelope(uint8_t* output, size_t output_size) {
    if (output == NULL || output_size <= TERM_CONTENT_BLOCK_ENVELOPE_BYTES) {
        return 0;
    }
    uint32_t hash1;
    uint32_t hash2;
    xxh32_pair(
        output + TERM_CONTENT_BLOCK_ENVELOPE_BYTES,
        output_size - TERM_CONTENT_BLOCK_ENVELOPE_BYTES,
        UINT32_C(0x811c9dc5),
        UINT32_C(0x9e3779b9),
        &hash1,
        &hash2
    );
    if ((hash1 | hash2) == 0) {
        hash1 = 1;
    }
    write_u32_le(output, TERM_CONTENT_BLOCK_ENVELOPE_MAGIC);
    write_u32_le(output + 4, hash1);
    write_u32_le(output + 8, hash2);
    return 1;
}
