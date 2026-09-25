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

#define WASM_PAGE_SIZE 65536u
#define FNV1A_OFFSET 0x811c9dc5u
#define MIX_OFFSET 0x9e3779b9u
#define MAX_JSON_NESTING 256u
#define EXPERIMENT_BANK_SPANS 1u
#define EXPERIMENT_NATIVE_ESCAPED_KEYS 2u
#define EXPERIMENT_VALIDATED_GLOSSARY_REUSE 4u
#define EXPERIMENT_GLOBAL_EXACT_CONTENT_REUSE 8u
#define EXPERIMENT_FAST_GLOSSARY_NORMALIZATION 16u
/* Key lengths use every uint16 value; the null sentinel applies to IDs only. */
#define MAX_INTERNED_KEY_BYTES 0xffffu
#ifndef RECENT_CONTENT_DEDUP_WINDOW
#define RECENT_CONTENT_DEDUP_WINDOW 4u
#endif

extern unsigned char __heap_base;

static uint32_t heap_ptr = 0u;
static uint32_t last_parse_capacity = 0u;
static uint32_t last_content_capacity = 0u;

void* memset(void* dest, int value, unsigned long count) {
    unsigned char* bytes = (unsigned char*)dest;
    for (unsigned long i = 0u; i < count; ++i) {
        bytes[i] = (unsigned char)value;
    }
    return dest;
}

void* memcpy(void* dest, const void* source, unsigned long count) {
    unsigned char* output = (unsigned char*)dest;
    const unsigned char* input = (const unsigned char*)source;
    for (unsigned long i = 0u; i < count; ++i) {
        output[i] = input[i];
    }
    return dest;
}

int32_t term_bank_inflate(const uint8_t* input, uint32_t input_length,
                          uint8_t* output, uint32_t output_length);

int32_t term_bank_inflate(const uint8_t* input, uint32_t input_length, uint8_t* output, uint32_t output_length);
static uint32_t crc32_table[16][256];
static uint32_t crc32_table_initialized = 0u;

static uint32_t crc32_read_u32_le(const uint8_t* data) {
    return
        (uint32_t)data[0] |
        ((uint32_t)data[1] << 8u) |
        ((uint32_t)data[2] << 16u) |
        ((uint32_t)data[3] << 24u);
}

static uint32_t crc32_bytes(const uint8_t* data, uint32_t length) {
    if (crc32_table_initialized == 0u) {
        for (uint32_t i = 0u; i < 256u; ++i) {
            uint32_t value = i;
            for (uint32_t bit = 0u; bit < 8u; ++bit) {
                value = (value >> 1u) ^ ((value & 1u) != 0u ? 0xedb88320u : 0u);
            }
            crc32_table[0][i] = value;
        }
        for (uint32_t slice = 1u; slice < 16u; ++slice) {
            for (uint32_t i = 0u; i < 256u; ++i) {
                const uint32_t value = crc32_table[slice - 1u][i];
                crc32_table[slice][i] = (value >> 8u) ^ crc32_table[0][value & 0xffu];
            }
        }
        crc32_table_initialized = 1u;
    }

    uint32_t crc = 0xffffffffu;
    uint32_t offset = 0u;
    while (length - offset >= 16u) {
        const uint32_t first = crc32_read_u32_le(data + offset);
        const uint32_t second = crc32_read_u32_le(data + offset + 4u);
        const uint32_t third = crc32_read_u32_le(data + offset + 8u);
        const uint32_t fourth = crc32_read_u32_le(data + offset + 12u);
        crc ^= first;
        crc =
            crc32_table[15][crc & 0xffu] ^
            crc32_table[14][(crc >> 8u) & 0xffu] ^
            crc32_table[13][(crc >> 16u) & 0xffu] ^
            crc32_table[12][crc >> 24u] ^
            crc32_table[11][second & 0xffu] ^
            crc32_table[10][(second >> 8u) & 0xffu] ^
            crc32_table[9][(second >> 16u) & 0xffu] ^
            crc32_table[8][second >> 24u] ^
            crc32_table[7][third & 0xffu] ^
            crc32_table[6][(third >> 8u) & 0xffu] ^
            crc32_table[5][(third >> 16u) & 0xffu] ^
            crc32_table[4][third >> 24u] ^
            crc32_table[3][fourth & 0xffu] ^
            crc32_table[2][(fourth >> 8u) & 0xffu] ^
            crc32_table[1][(fourth >> 16u) & 0xffu] ^
            crc32_table[0][fourth >> 24u];
        offset += 16u;
    }
    while (offset < length) {
        crc = (crc >> 8u) ^ crc32_table[0][(crc ^ data[offset++]) & 0xffu];
    }
    return ~crc;
}

static int is_json_whitespace(uint8_t value) {
    return value == 0x20u || value == 0x09u || value == 0x0au || value == 0x0du;
}

__attribute__((visibility("default")))
int32_t inflate_and_join_term_banks(
    uint32_t input_ptr,
    uint32_t input_length,
    uint32_t input_offsets_ptr,
    uint32_t compressed_lengths_ptr,
    uint32_t uncompressed_lengths_ptr,
    uint32_t compression_methods_ptr,
    uint32_t signatures_ptr,
    uint32_t source_count,
    uint32_t output_ptr,
    uint32_t output_capacity,
    uint32_t bank_spans_ptr,
    uint32_t use_libdeflate
) {
    if (source_count == 0u || output_capacity < 2u) {
        return -1;
    }
    const uint8_t* input = (const uint8_t*)(uintptr_t)input_ptr;
    const uint32_t* input_offsets = (const uint32_t*)(uintptr_t)input_offsets_ptr;
    const uint32_t* compressed_lengths = (const uint32_t*)(uintptr_t)compressed_lengths_ptr;
    const uint32_t* uncompressed_lengths = (const uint32_t*)(uintptr_t)uncompressed_lengths_ptr;
    const uint32_t* compression_methods = (const uint32_t*)(uintptr_t)compression_methods_ptr;
    const uint32_t* signatures = (const uint32_t*)(uintptr_t)signatures_ptr;
    uint8_t* output = (uint8_t*)(uintptr_t)output_ptr;
    uint32_t* bank_spans = (uint32_t*)(uintptr_t)bank_spans_ptr;
    uint32_t cursor = bank_spans_ptr == 0u ? 1u : 0u;
    uint32_t nonempty_sources = 0u;
    if (bank_spans_ptr == 0u) { output[0] = '['; }

    for (uint32_t i = 0u; i < source_count; ++i) {
        const uint32_t input_offset = input_offsets[i];
        const uint32_t compressed_length = compressed_lengths[i];
        const uint32_t uncompressed_length = uncompressed_lengths[i];
        if (
            input_offset > input_length ||
            compressed_length > input_length - input_offset ||
            uncompressed_length > output_capacity - cursor
        ) {
            return -1;
        }
        uint8_t* inflated = output + cursor;
        if (compression_methods[i] == 0u) {
            if (compressed_length != uncompressed_length) {
                return -3;
            }
            memcpy(inflated, input + input_offset, uncompressed_length);
        } else if (compression_methods[i] == 8u && use_libdeflate == 1u) {
            const int32_t status = term_bank_inflate(input + input_offset, compressed_length, inflated, uncompressed_length);
            if (status != 0) { return status; }
        } else if (compression_methods[i] == 8u) {
            const int32_t status = term_bank_inflate(
                input + input_offset, compressed_length, inflated, uncompressed_length
            );
            if (status != 0) { return status; }
        } else {
            return -1;
        }
        if (crc32_bytes(inflated, uncompressed_length) != signatures[i]) {
            return -4;
        }

        uint32_t start = 0u;
        uint32_t end = uncompressed_length;
        while (start < end && is_json_whitespace(inflated[start])) { ++start; }
        while (end > start && is_json_whitespace(inflated[end - 1u])) { --end; }
        if (end - start < 2u || inflated[start] != '[' || inflated[end - 1u] != ']') {
            return -5;
        }
        if (bank_spans_ptr != 0u) {
            /* Preserve the CRC-verified bank, including its array wrapper.
             * The parser bounds every token to this bank's logical end. */
            bank_spans[i * 2u] = cursor;
            bank_spans[i * 2u + 1u] = uncompressed_length;
            cursor += uncompressed_length;
            continue;
        }
        ++start;
        --end;
        while (start < end && is_json_whitespace(inflated[start])) { ++start; }
        while (end > start && is_json_whitespace(inflated[end - 1u])) { --end; }
        const uint32_t content_length = end - start;
        if (content_length == 0u) {
            continue;
        }
        if (nonempty_sources > 0u) {
            output[cursor++] = ',';
        }
        /* The interiors can overlap while shifting left. Later compact banks
         * are already in place after the comma replaces their opening bracket. */
        if (output + cursor != inflated + start) {
            __builtin_memmove(output + cursor, inflated + start, content_length);
        }
        cursor += content_length;
        ++nonempty_sources;
    }
    if (bank_spans_ptr != 0u) { return (int32_t)cursor; }
    if (cursor >= output_capacity) {
        return -1;
    }
    output[cursor++] = ']';
    return (int32_t)cursor;
}

typedef struct {
    uint32_t expression_start;
    uint32_t expression_length;
    uint32_t reading_start;
    uint32_t reading_length;
    uint32_t definition_tags_start;
    uint32_t definition_tags_length;
    uint32_t rules_start;
    uint32_t rules_length;
    uint32_t score_start;
    uint32_t glossary_start;
    uint32_t glossary_length;
    uint32_t sequence_start;
    uint32_t term_tags_start;
    uint32_t term_tags_length;
    uint32_t glossary_may_contain_media;
    uint32_t glossary_requires_normalization;
    uint32_t glossary_requires_text_normalization;
} TermRowMeta;

static uint32_t align8(uint32_t value) {
    return (value + 7u) & ~7u;
}

static int ensure_memory(uint32_t required_bytes) {
    uint32_t current_pages = __builtin_wasm_memory_size(0);
    uint32_t current_bytes = current_pages * WASM_PAGE_SIZE;
    if (required_bytes <= current_bytes) {
        return 1;
    }
    uint32_t missing = required_bytes - current_bytes;
    uint32_t grow_pages = (missing + (WASM_PAGE_SIZE - 1u)) / WASM_PAGE_SIZE;
    int32_t rc = __builtin_wasm_memory_grow(0, grow_pages);
    return rc >= 0;
}

static uint32_t read_content_signature(
    const uint8_t* bytes,
    uint32_t length,
    uint32_t offset
) {
    uint32_t result = 0u;
    for (uint32_t i = 0u; i < 4u && offset + i < length; ++i) {
        result |= (uint32_t)bytes[offset + i] << (i * 8u);
    }
    return result;
}

__attribute__((visibility("default")))
void wasm_reset_heap(void) {
    heap_ptr = (uint32_t)(uintptr_t)&__heap_base;
}

__attribute__((visibility("default")))
uint32_t wasm_alloc(uint32_t size) {
    if (heap_ptr == 0u) {
        wasm_reset_heap();
    }
    if (size > UINT32_MAX - 7u) {
        return 0u;
    }
    uint32_t aligned_size = align8(size);
    uint32_t start = align8(heap_ptr);
    if (start > UINT32_MAX - aligned_size) {
        return 0u;
    }
    uint32_t end = start + aligned_size;
    if (!ensure_memory(end)) {
        return 0u;
    }
    heap_ptr = end;
    return start;
}

__attribute__((visibility("default")))
uint32_t wasm_get_last_parse_capacity(void) {
    return last_parse_capacity;
}

__attribute__((visibility("default")))
uint32_t wasm_get_last_content_capacity(void) {
    return last_content_capacity;
}

static int grow_term_row_buffer(
    uint32_t out_ptr,
    uint32_t old_capacity,
    uint32_t* out_capacity
) {
    const uint32_t max_capacity = UINT32_MAX / (uint32_t)sizeof(TermRowMeta);
    if (old_capacity >= max_capacity) { return 0; }
    uint32_t growth = old_capacity / 2u;
    if (growth < 8192u) { growth = 8192u; }
    const uint32_t new_capacity = old_capacity > max_capacity - growth ?
        max_capacity :
        old_capacity + growth;
    const uint32_t old_bytes = old_capacity * (uint32_t)sizeof(TermRowMeta);
    const uint32_t extra_bytes = (new_capacity - old_capacity) * (uint32_t)sizeof(TermRowMeta);
    if (out_ptr > UINT32_MAX - old_bytes) { return 0; }
    const uint32_t expected_end = out_ptr + old_bytes;
    if (heap_ptr != expected_end) { return 0; }
    const uint32_t extra_ptr = wasm_alloc(extra_bytes);
    if (extra_ptr == 0u || extra_ptr != expected_end) { return 0; }
    *out_capacity = new_capacity;
    last_parse_capacity = new_capacity;
    return 1;
}

static int grow_content_buffer(
    uint32_t out_ptr,
    uint32_t old_capacity,
    uint32_t* out_capacity
) {
    const uint32_t max_capacity = 0x7fffffffu;
    if (old_capacity >= max_capacity) { return 0; }
    uint32_t growth = old_capacity / 2u;
    if (growth < 1048576u) { growth = 1048576u; }
    const uint32_t new_capacity = old_capacity > max_capacity - growth ?
        max_capacity :
        old_capacity + growth;
    const uint32_t old_bytes = align8(old_capacity);
    const uint32_t new_bytes = align8(new_capacity);
    if (out_ptr > UINT32_MAX - old_bytes) { return 0; }
    const uint32_t expected_end = out_ptr + old_bytes;
    if (heap_ptr != expected_end) { return 0; }
    const uint32_t extra_ptr = wasm_alloc(new_bytes - old_bytes);
    if (extra_ptr == 0u || extra_ptr != expected_end) { return 0; }
    *out_capacity = new_capacity;
    last_content_capacity = new_capacity;
    return 1;
}

static int is_ws(uint8_t c) {
    return c == ' ' || c == '\n' || c == '\r' || c == '\t';
}

static uint32_t skip_ws(const uint8_t* src, uint32_t len, uint32_t i) {
    while (i < len && is_ws(src[i])) { ++i; }
    return i;
}

static inline uint64_t has_zero_byte64(uint64_t value) {
    return (value - UINT64_C(0x0101010101010101)) & ~value & UINT64_C(0x8080808080808080);
}

static inline uint64_t has_control_byte64(uint64_t value) {
    return (value - UINT64_C(0x2020202020202020)) & ~value & UINT64_C(0x8080808080808080);
}

static int is_hex_digit(uint8_t value) {
    return (value >= '0' && value <= '9') ||
        (value >= 'a' && value <= 'f') ||
        (value >= 'A' && value <= 'F');
}

static __attribute__((always_inline)) inline int parse_string_span(const uint8_t* src, uint32_t len, uint32_t start, uint32_t* out_end) {
    if (start >= len || src[start] != '"') { return 0; }
    uint32_t i = start + 1u;
    while (i < len) {
        while (i + 8u <= len) {
            uint64_t word;
            __builtin_memcpy(&word, src + i, sizeof(word));
            const uint64_t special =
                has_zero_byte64(word ^ UINT64_C(0x2222222222222222)) |
                has_zero_byte64(word ^ UINT64_C(0x5c5c5c5c5c5c5c5c)) |
                has_control_byte64(word);
            if (special != 0u) {
                // On little-endian WASM the first marked byte is exact, even
                // when subtraction borrows mark a later byte spuriously.
                i += (uint32_t)__builtin_ctzll(special) / 8u;
                break;
            }
            i += 8u;
        }
        if (i >= len) { break; }
        uint8_t c = src[i];
        if (c == '\\') {
            if (i + 1u >= len) { return 0; }
            const uint8_t escape = src[i + 1u];
            if (escape == 'u') {
                if (i + 6u > len) { return 0; }
                for (uint32_t j = i + 2u; j < i + 6u; ++j) {
                    if (!is_hex_digit(src[j])) { return 0; }
                }
                i += 6u;
                continue;
            }
            if (
                escape != '"' && escape != '\\' && escape != '/' &&
                escape != 'b' && escape != 'f' && escape != 'n' &&
                escape != 'r' && escape != 't'
            ) { return 0; }
            i += 2u;
            continue;
        }
        if (c < 0x20u) { return 0; }
        if (c == '"') {
            *out_end = i + 1u;
            return 1;
        }
        ++i;
    }
    return 0;
}

static uint32_t key_hex4(const uint8_t* p);

/* Compare a short ASCII keyword without allocating or decoding an arbitrary
 * JSON string. Escapes and literal characters have the same field identity.
 * end is a logical token/bank boundary, never the size of the WASM heap. */
static int json_string_matches_ascii_escaped(
    const uint8_t* src, uint32_t start, uint32_t end,
    const char* keyword, uint32_t keyword_length
) {
    if (start >= end || src[start] != '"') { return 0; }
    uint32_t i = start + 1u;
    for (uint32_t k = 0u; k < keyword_length; ++k) {
        if (i >= end) { return 0; }
        uint32_t c = src[i++];
        if (c == '\\') {
            if (end - i < 5u || src[i] != 'u') { return 0; }
            c = key_hex4(src + i + 1u);
            i += 5u;
        }
        if (c != (uint8_t)keyword[k]) { return 0; }
    }
    return i < end && src[i] == '"';
}

/* Keep the common literal comparison small enough to specialize at each call
 * site. Escaped spellings still use the same complete bounded decoder. */
static __attribute__((always_inline)) inline int json_string_matches_ascii(
    const uint8_t* src, uint32_t start, uint32_t end,
    const char* keyword, uint32_t keyword_length
) {
    if (start >= end || src[start] != '"') { return 0; }
    uint32_t i = start + 1u;
    for (uint32_t k = 0u; k < keyword_length; ++k) {
        if (i >= end) { return 0; }
        const uint8_t c = src[i++];
        if (c == '\\') {
            return json_string_matches_ascii_escaped(src, start, end, keyword, keyword_length);
        }
        if (c != (uint8_t)keyword[k]) { return 0; }
    }
    return i < end && src[i] == '"';
}

static int is_media_marker_at(const uint8_t* src, uint32_t len, uint32_t i) {
    return json_string_matches_ascii(src, i, len, "img", 3u) ||
        json_string_matches_ascii(src, i, len, "image", 5u);
}

static inline int type_text_pair_at(const uint8_t* src, uint32_t len, uint32_t key_start, uint32_t key_end) {
    if (!json_string_matches_ascii(src, key_start, key_end, "type", 4u)) { return 0; }
    const uint32_t separator = skip_ws(src, len, key_end);
    if (separator >= len || src[separator] != ':') { return 0; }
    const uint32_t value_start = skip_ws(src, len, separator + 1u);
    return json_string_matches_ascii(src, value_start, len, "text", 4u);
}

static int scan_scalar_span(const uint8_t* src, uint32_t len, uint32_t start, uint32_t* out_end) {
    if (start >= len) { return 0; }
    uint32_t i = start;
    while (i < len) {
        const uint8_t c = src[i];
        if (c == ',' || c == ']' || c == '}' || is_ws(c)) { break; }
        ++i;
    }
    if (i == start) { return 0; }
    *out_end = i;
    return 1;
}

static int parse_scalar_span(const uint8_t* src, uint32_t len, uint32_t start, uint32_t* out_end);

static int parse_composite_span_impl(
    const uint8_t* src,
    uint32_t len,
    uint32_t start,
    uint32_t* out_end,
    uint32_t* media_hint,
    uint32_t* normalization_hint,
    uint32_t* text_normalization_hint
) {
    enum {
        ARRAY_FIRST, ARRAY_AFTER_VALUE, ARRAY_VALUE,
        OBJECT_FIRST, OBJECT_COLON, OBJECT_VALUE, OBJECT_AFTER_VALUE, OBJECT_KEY
    };
    if (start >= len || (src[start] != '[' && src[start] != '{')) { return 0; }

    // The active frame stays in a local. Only suspended parents need stack
    // storage; the state also encodes the matching container type.
    uint8_t parents[MAX_JSON_NESTING];
    uint32_t depth = 1u;
    uint8_t state = src[start] == '[' ? ARRAY_FIRST : OBJECT_FIRST;
    uint32_t i = start + 1u;
    while (i < len) {
        const uint8_t c = src[i];
        if (is_ws(c)) {
            if (normalization_hint != 0 && *normalization_hint == 0u) {
                *normalization_hint = 1u;
            }
            ++i;
            continue;
        }
        if (c == '"') {
            if (media_hint != 0 && *media_hint == 0u && is_media_marker_at(src, len, i)) {
                *media_hint = 1u;
            }
            uint32_t s_end = 0u;
            if (!parse_string_span(src, len, i, &s_end)) { return 0; }
            if (state == OBJECT_FIRST || state == OBJECT_KEY) {
                if (
                    (
                        (normalization_hint != 0 && *normalization_hint == 0u) ||
                        (text_normalization_hint != 0 && *text_normalization_hint == 0u)
                    ) &&
                    type_text_pair_at(src, len, i, s_end)
                ) {
                    if (normalization_hint != 0) { *normalization_hint = 1u; }
                    if (text_normalization_hint != 0) { *text_normalization_hint = 1u; }
                }
                state = OBJECT_COLON;
            } else if (state == OBJECT_VALUE) {
                state = OBJECT_AFTER_VALUE;
            } else if (state == ARRAY_FIRST || state == ARRAY_VALUE) {
                state = ARRAY_AFTER_VALUE;
            } else {
                return 0;
            }
            i = s_end;
            continue;
        }
        if (c == ']' || c == '}') {
            if (c == ']') {
                if (state != ARRAY_FIRST && state != ARRAY_AFTER_VALUE) { return 0; }
            } else {
                if (state != OBJECT_FIRST && state != OBJECT_AFTER_VALUE) { return 0; }
            }
            ++i;
            if (--depth == 0u) {
                *out_end = i;
                return 1;
            }
            state = parents[depth - 1u];
            continue;
        }
        if (c == ',') {
            if (state == ARRAY_AFTER_VALUE) { state = ARRAY_VALUE; }
            else if (state == OBJECT_AFTER_VALUE) { state = OBJECT_KEY; }
            else { return 0; }
            ++i;
            continue;
        }
        if (c == ':') {
            if (state != OBJECT_COLON) { return 0; }
            state = OBJECT_VALUE;
            ++i;
            continue;
        }
        uint8_t next_state;
        if (state == ARRAY_FIRST || state == ARRAY_VALUE) { next_state = ARRAY_AFTER_VALUE; }
        else if (state == OBJECT_VALUE) { next_state = OBJECT_AFTER_VALUE; }
        else { return 0; }
        if (c == '[' || c == '{') {
            if (depth >= MAX_JSON_NESTING) { return 0; }
            parents[depth - 1u] = next_state;
            ++depth;
            state = c == '[' ? ARRAY_FIRST : OBJECT_FIRST;
            ++i;
            continue;
        }
        uint32_t scalar_end = 0u;
        if (!parse_scalar_span(src, len, i, &scalar_end)) { return 0; }
        state = next_state;
        i = scalar_end;
    }
    return 0;
}

static int parse_composite_span(const uint8_t* src, uint32_t len, uint32_t start, uint32_t* out_end) {
    return parse_composite_span_impl(src, len, start, out_end, 0, 0, 0);
}

static int token_equals_bytes(const uint8_t* src, uint32_t start, uint32_t end, const char* expected, uint32_t expected_length) {
    if (end - start != expected_length) { return 0; }
    for (uint32_t i = 0u; i < expected_length; ++i) {
        if (src[start + i] != (uint8_t)expected[i]) { return 0; }
    }
    return 1;
}

static int is_valid_json_number(const uint8_t* src, uint32_t start, uint32_t end) {
    uint32_t i = start;
    if (i < end && src[i] == '-') { ++i; }
    if (i >= end) { return 0; }
    if (src[i] == '0') {
        ++i;
        if (i < end && src[i] >= '0' && src[i] <= '9') { return 0; }
    } else {
        if (src[i] < '1' || src[i] > '9') { return 0; }
        do { ++i; } while (i < end && src[i] >= '0' && src[i] <= '9');
    }
    if (i < end && src[i] == '.') {
        ++i;
        const uint32_t fraction_start = i;
        while (i < end && src[i] >= '0' && src[i] <= '9') { ++i; }
        if (i == fraction_start) { return 0; }
    }
    if (i < end && (src[i] == 'e' || src[i] == 'E')) {
        ++i;
        if (i < end && (src[i] == '+' || src[i] == '-')) { ++i; }
        const uint32_t exponent_start = i;
        while (i < end && src[i] >= '0' && src[i] <= '9') { ++i; }
        if (i == exponent_start) { return 0; }
    }
    return i == end;
}

static int parse_scalar_span(const uint8_t* src, uint32_t len, uint32_t start, uint32_t* out_end) {
    uint32_t i = 0u;
    if (!scan_scalar_span(src, len, start, &i)) { return 0; }
    int valid = 0;
    switch (src[start]) {
        case 't': valid = token_equals_bytes(src, start, i, "true", 4u); break;
        case 'f': valid = token_equals_bytes(src, start, i, "false", 5u); break;
        case 'n': valid = token_equals_bytes(src, start, i, "null", 4u); break;
        default: valid = is_valid_json_number(src, start, i); break;
    }
    if (!valid) { return 0; }
    *out_end = i;
    return 1;
}

static int parse_value_span(const uint8_t* src, uint32_t len, uint32_t start, uint32_t* out_end) {
    if (start >= len) { return 0; }
    uint8_t c = src[start];
    if (c == '"') { return parse_string_span(src, len, start, out_end); }
    if (c == '[' || c == '{') { return parse_composite_span(src, len, start, out_end); }
    return parse_scalar_span(src, len, start, out_end);
}

static int parse_value_span_with_glossary_hints(
    const uint8_t* src,
    uint32_t len,
    uint32_t start,
    uint32_t* out_end,
    uint32_t* media_hint,
    uint32_t* normalization_hint,
    uint32_t* text_normalization_hint
) {
    if (start >= len) { return 0; }
    uint8_t c = src[start];
    if (c == '[' || c == '{') {
        return parse_composite_span_impl(src, len, start, out_end, media_hint, normalization_hint, text_normalization_hint);
    }
    return parse_value_span(src, len, start, out_end);
}

static int is_null_token(const uint8_t* src, uint32_t start, uint32_t length);

static int parse_int32_token(
    const uint8_t* src,
    uint32_t start,
    uint32_t end,
    int32_t null_value,
    int32_t* out_value
) {
    if (end - start == 4u && is_null_token(src, start, 4u)) {
        *out_value = null_value;
        return 1;
    }
    uint32_t i = start;
    int negative = 0;
    if (i < end && src[i] == '-') {
        negative = 1;
        ++i;
    }
    if (i >= end || src[i] < '0' || src[i] > '9') { return 0; }
    if (src[i] == '0' && i + 1u < end) { return 0; }
    uint32_t value = 0u;
    const uint32_t limit = negative ? 0x80000000u : 0x7fffffffu;
    for (; i < end; ++i) {
        const uint8_t c = src[i];
        if (c < '0' || c > '9') { return 0; }
        const uint32_t digit = (uint32_t)(c - '0');
        if (value > (limit - digit) / 10u) { return 0; }
        value = value * 10u + digit;
    }
    *out_value = negative ? (int32_t)(0u - value) : (int32_t)value;
    return 1;
}

static int set_field(const uint8_t* src, TermRowMeta* meta, uint32_t field_index, uint32_t start, uint32_t end) {
    uint32_t length = end > start ? (end - start) : 0u;
    switch (field_index) {
        case 0: meta->expression_start = start; meta->expression_length = length; break;
        case 1: meta->reading_start = start; meta->reading_length = length; break;
        case 2: meta->definition_tags_start = start; meta->definition_tags_length = length; break;
        case 3: meta->rules_start = start; meta->rules_length = length; break;
        case 4:
            if (!is_valid_json_number(src, start, end)) { return 0; }
            meta->score_start = start; break;
        case 5: meta->glossary_start = start; meta->glossary_length = length; break;
        case 6:
            if (is_null_token(src, start, length)) { meta->sequence_start = 0xffffffffu; break; }
            if (!is_valid_json_number(src, start, end)) { return 0; }
            meta->sequence_start = start; break;
        case 7: meta->term_tags_start = start; meta->term_tags_length = length; break;
        default: break;
    }
    return 1;
}

static void clear_term_row_meta(TermRowMeta* meta) {
    meta->expression_start = 0u; meta->expression_length = 0u;
    meta->reading_start = 0u; meta->reading_length = 0u;
    meta->definition_tags_start = 0u; meta->definition_tags_length = 0u;
    meta->rules_start = 0u; meta->rules_length = 0u;
    meta->score_start = 0u;
    meta->glossary_start = 0u; meta->glossary_length = 0u;
    meta->sequence_start = 0xffffffffu;
    meta->term_tags_start = 0u; meta->term_tags_length = 0u;
    meta->glossary_may_contain_media = 0u;
    meta->glossary_requires_normalization = 0u;
    meta->glossary_requires_text_normalization = 0u;
}

/* A span is [offset, length] in one immutable arena. All row metadata retains
 * arena-relative offsets, so interning/deduplication survives bank transitions.
 * The same cursor is used by the non-fused fallback: an early capacity/escaped
 * key fallback must not accidentally turn malformed separate banks into valid
 * concatenated JSON. */
typedef struct {
    const uint8_t* src;
    const uint32_t* spans;
    uint32_t length;
    uint32_t count;
    uint32_t next_bank;
    uint32_t end;
    uint32_t position;
} TermBankCursor;

static int next_term_bank(TermBankCursor* cursor) {
    while (cursor->next_bank < cursor->count) {
        const uint32_t bank = cursor->next_bank++;
        const uint32_t start = cursor->spans != 0 ? cursor->spans[bank * 2u] : 0u;
        const uint32_t length = cursor->spans != 0 ? cursor->spans[bank * 2u + 1u] : cursor->length;
        if (start < cursor->end || start > cursor->length || length > cursor->length - start) { return -1; }
        cursor->end = start + length;
        uint32_t i = skip_ws(cursor->src, cursor->end, start);
        if (i >= cursor->end || cursor->src[i] != '[') { return -1; }
        i = skip_ws(cursor->src, cursor->end, i + 1u);
        if (i >= cursor->end) { return -1; }
        if (cursor->src[i] != ']') {
            cursor->position = i;
            return 1;
        }
        if (skip_ws(cursor->src, cursor->end, i + 1u) != cursor->end) { return -1; }
    }
    return 0;
}

static int next_term_row(TermBankCursor* cursor, uint32_t row_end) {
    uint32_t i = skip_ws(cursor->src, cursor->end, row_end);
    if (i >= cursor->end) { return -1; }
    if (cursor->src[i] == ']') {
        if (skip_ws(cursor->src, cursor->end, i + 1u) != cursor->end) { return -1; }
        return next_term_bank(cursor);
    }
    if (cursor->src[i] != ',') { return -1; }
    i = skip_ws(cursor->src, cursor->end, i + 1u);
    if (i >= cursor->end || cursor->src[i] == ']') { return -1; }
    cursor->position = i;
    return 1;
}

static int content_bytes_equal_between(const uint8_t*, uint32_t, const uint8_t*, uint32_t, uint32_t);

/* Samples only reject candidates. Only full equality with a successful earlier
 * row of THIS parse grants grammar/hint reuse. Nothing survives heap reset.
 * A witness also lets content dedup avoid comparing this same glossary twice. */
static int reuse_validated_glossary(
    const uint8_t* src, uint32_t end, uint32_t start,
    const TermRowMeta* rows, uint32_t row_count,
    TermRowMeta* meta, uint32_t* value_end, uint32_t* witness
) {
    if (start >= end || (src[start] != '[' && src[start] != '{')) { return 0; }
    const uint32_t first = row_count > RECENT_CONTENT_DEDUP_WINDOW ? row_count - RECENT_CONTENT_DEDUP_WINDOW : 0u;
    for (uint32_t k = row_count; k > first;) {
        const TermRowMeta* prior = &rows[--k];
        const uint32_t n = prior->glossary_length;
        const uint32_t p = prior->glossary_start;
        if (n == 0u || n > end - start || src[start] != src[p]) { continue; }
        const uint32_t sample = n < 8u ? n : 8u;
        if (!content_bytes_equal_between(src, start + n - sample, src, p + n - sample, sample) ||
            !content_bytes_equal_between(src, start + (n - sample) / 2u, src, p + (n - sample) / 2u, sample) ||
            !content_bytes_equal_between(src, start, src, p, n)) { continue; }
        meta->glossary_may_contain_media = prior->glossary_may_contain_media;
        meta->glossary_requires_normalization = prior->glossary_requires_normalization;
        meta->glossary_requires_text_normalization = prior->glossary_requires_text_normalization;
        *value_end = start + n;
        *witness = k;
        return 1;
    }
    return 0;
}

static int parse_row_single_pass(
    const uint8_t* src,
    uint32_t len,
    uint32_t row_start,
    TermRowMeta* out_meta,
    int media_hints,
    uint32_t* out_next,
    const TermRowMeta* prior_rows,
    uint32_t prior_count,
    uint32_t* glossary_witness
) {
    if (row_start >= len || src[row_start] != '[') { return 0; }
    clear_term_row_meta(out_meta);

    uint32_t i = row_start + 1u;
    uint32_t field_index = 0u;
    while (i < len) {
        i = skip_ws(src, len, i);
        if (i >= len) { return 0; }
        if (src[i] == ']') {
            *out_next = i + 1u;
            return out_meta->expression_length > 0u;
        }
        uint32_t value_end = 0u;
        if (field_index == 4u || field_index == 6u) {
            if (!scan_scalar_span(src, len, i, &value_end)) { return 0; }
        } else if (field_index == 5u) {
            uint32_t* media_hint = media_hints ? &out_meta->glossary_may_contain_media : 0;
            if (
                !(glossary_witness != 0 && reuse_validated_glossary(
                    src, len, i, prior_rows, prior_count, out_meta, &value_end, glossary_witness
                )) &&
                !parse_value_span_with_glossary_hints(
                    src,
                    len,
                    i,
                    &value_end,
                    media_hint,
                    &out_meta->glossary_requires_normalization,
                    &out_meta->glossary_requires_text_normalization
                )) { return 0; }
        } else if (!parse_value_span(src, len, i, &value_end)) {
            return 0;
        }
        if (field_index < 8u) {
            if (!set_field(src, out_meta, field_index, i, value_end)) { return 0; }
        }
        ++field_index;
        i = skip_ws(src, len, value_end);
        if (i >= len) { return 0; }
        if (src[i] == ']') {
            *out_next = i + 1u;
            return out_meta->expression_length > 0u;
        }
        if (src[i] != ',') { return 0; }
        i = skip_ws(src, len, i + 1u);
        if (i >= len || src[i] == ']') { return 0; }
    }
    return 0;
}

static int is_null_token(const uint8_t* src, uint32_t start, uint32_t length) {
    return length == 4u &&
        src[start] == 'n' &&
        src[start + 1u] == 'u' &&
        src[start + 2u] == 'l' &&
        src[start + 3u] == 'l';
}

static inline uint32_t rotl32(uint32_t value, uint32_t amount) {
    return (uint32_t)((value << amount) | (value >> (32u - amount)));
}

static inline uint32_t read_u32_le(const uint8_t* src) {
    return ((uint32_t)src[0]) |
        ((uint32_t)src[1] << 8u) |
        ((uint32_t)src[2] << 16u) |
        ((uint32_t)src[3] << 24u);
}

static inline uint32_t xxh32_round(uint32_t acc, uint32_t input) {
    acc += input * 2246822519u;
    acc = rotl32(acc, 13u);
    acc *= 2654435761u;
    return acc;
}

static uint32_t hash_content_xxh32(const uint8_t* src, uint32_t length, uint32_t seed) {
    const uint8_t* p = src;
    const uint8_t* const end = src + length;
    uint32_t h32;
    if (length >= 16u) {
        const uint8_t* const limit = end - 16u;
        uint32_t v1 = seed + 2654435761u + 2246822519u;
        uint32_t v2 = seed + 2246822519u;
        uint32_t v3 = seed;
        uint32_t v4 = seed - 2654435761u;
        do {
            v1 = xxh32_round(v1, read_u32_le(p)); p += 4u;
            v2 = xxh32_round(v2, read_u32_le(p)); p += 4u;
            v3 = xxh32_round(v3, read_u32_le(p)); p += 4u;
            v4 = xxh32_round(v4, read_u32_le(p)); p += 4u;
        } while (p <= limit);
        h32 = rotl32(v1, 1u) + rotl32(v2, 7u) + rotl32(v3, 12u) + rotl32(v4, 18u);
    } else {
        h32 = seed + 374761393u;
    }
    h32 += length;
    while ((p + 4u) <= end) {
        h32 += read_u32_le(p) * 3266489917u;
        h32 = rotl32(h32, 17u) * 668265263u;
        p += 4u;
    }
    while (p < end) {
        h32 += ((uint32_t)(*p)) * 374761393u;
        h32 = rotl32(h32, 11u) * 2654435761u;
        ++p;
    }
    h32 ^= h32 >> 15u;
    h32 *= 2246822519u;
    h32 ^= h32 >> 13u;
    h32 *= 3266489917u;
    h32 ^= h32 >> 16u;
    return h32;
}

static inline uint32_t xxh32_finalize(uint32_t h32) {
    h32 ^= h32 >> 15u;
    h32 *= 2246822519u;
    h32 ^= h32 >> 13u;
    h32 *= 3266489917u;
    h32 ^= h32 >> 16u;
    return h32;
}

static void hash_content_xxh32_pair(const uint8_t* src, uint32_t length, uint32_t seed1, uint32_t seed2, uint32_t* out1, uint32_t* out2) {
    const uint8_t* p = src;
    const uint8_t* const end = src + length;
    uint32_t h1;
    uint32_t h2;
    if (length >= 16u) {
        const uint8_t* const limit = end - 16u;
        uint32_t a1 = seed1 + 2654435761u + 2246822519u;
        uint32_t b1 = seed1 + 2246822519u;
        uint32_t c1 = seed1;
        uint32_t d1 = seed1 - 2654435761u;
        uint32_t a2 = seed2 + 2654435761u + 2246822519u;
        uint32_t b2 = seed2 + 2246822519u;
        uint32_t c2 = seed2;
        uint32_t d2 = seed2 - 2654435761u;
        do {
            uint32_t value = read_u32_le(p); p += 4u;
            a1 = xxh32_round(a1, value);
            a2 = xxh32_round(a2, value);
            value = read_u32_le(p); p += 4u;
            b1 = xxh32_round(b1, value);
            b2 = xxh32_round(b2, value);
            value = read_u32_le(p); p += 4u;
            c1 = xxh32_round(c1, value);
            c2 = xxh32_round(c2, value);
            value = read_u32_le(p); p += 4u;
            d1 = xxh32_round(d1, value);
            d2 = xxh32_round(d2, value);
        } while (p <= limit);
        h1 = rotl32(a1, 1u) + rotl32(b1, 7u) + rotl32(c1, 12u) + rotl32(d1, 18u);
        h2 = rotl32(a2, 1u) + rotl32(b2, 7u) + rotl32(c2, 12u) + rotl32(d2, 18u);
    } else {
        h1 = seed1 + 374761393u;
        h2 = seed2 + 374761393u;
    }
    h1 += length;
    h2 += length;
    while ((p + 4u) <= end) {
        const uint32_t value = read_u32_le(p);
        h1 += value * 3266489917u;
        h1 = rotl32(h1, 17u) * 668265263u;
        h2 += value * 3266489917u;
        h2 = rotl32(h2, 17u) * 668265263u;
        p += 4u;
    }
    while (p < end) {
        const uint32_t value = (uint32_t)(*p);
        h1 += value * 374761393u;
        h1 = rotl32(h1, 11u) * 2654435761u;
        h2 += value * 374761393u;
        h2 = rotl32(h2, 11u) * 2654435761u;
        ++p;
    }
    *out1 = xxh32_finalize(h1);
    *out2 = xxh32_finalize(h2);
}

static inline int write_byte_and_hash(
    uint8_t* out,
    uint32_t out_capacity,
    uint32_t* cursor,
    uint8_t value,
    uint32_t* h1,
    uint32_t* h2
) {
    if (*cursor >= out_capacity) { return 0; }
    out[*cursor] = value;
    *cursor += 1u;
    (void)h1;
    (void)h2;
    return 1;
}

static inline int write_bytes_and_hash(
    uint8_t* out,
    uint32_t out_capacity,
    uint32_t* cursor,
    const uint8_t* src,
    uint32_t length,
    uint32_t* h1,
    uint32_t* h2
) {
    const uint32_t start = *cursor;
    const uint32_t end = start + length;
    if (end < start || end > out_capacity) { return 0; }
    __builtin_memcpy(out + start, src, length);
    (void)h1;
    (void)h2;
    *cursor = end;
    return 1;
}

static int glossary_object_try_extract_text_value(
    const uint8_t* src,
    uint32_t src_len,
    uint32_t start,
    uint32_t end,
    uint32_t* out_text_start,
    uint32_t* out_text_length
) {
    if (start >= end || end > src_len || src[start] != '{') { return 0; }
    uint32_t i = skip_ws(src, end, start + 1u);
    int has_type_text = 0;
    int has_text_value = 0;
    uint32_t text_start = 0u;
    uint32_t text_length = 0u;
    while (i < end) {
        if (src[i] == '}') {
            if (!(has_type_text && has_text_value)) { return 0; }
            *out_text_start = text_start;
            *out_text_length = text_length;
            return 1;
        }
        uint32_t key_end = 0u;
        if (!parse_string_span(src, end, i, &key_end)) { return 0; }
        const int is_type = json_string_matches_ascii(src, i, key_end, "type", 4u);
        const int is_text = json_string_matches_ascii(src, i, key_end, "text", 4u);
        /* Schema-valid text objects contain only these keys. Reject other
         * shapes before walking large structured-content values again. */
        if (!is_type && !is_text) { return 0; }
        i = skip_ws(src, end, key_end);
        if (i >= end || src[i] != ':') { return 0; }
        i = skip_ws(src, end, i + 1u);
        uint32_t value_end = 0u;
        if (!parse_value_span(src, end, i, &value_end)) { return 0; }
        /* JSON.parse keeps the last occurrence, including a later value that
         * invalidates an earlier match. Never return before the object ends. */
        if (is_type) {
            has_type_text = json_string_matches_ascii(src, i, value_end, "text", 4u);
        } else {
            has_text_value = i < value_end && src[i] == '"';
            text_start = i;
            text_length = value_end - i;
        }
        i = skip_ws(src, end, value_end);
        if (i >= end) { return 0; }
        if (src[i] == ',') {
            i = skip_ws(src, end, i + 1u);
        } else if (src[i] != '}') {
            return 0;
        }
    }
    return 0;
}

static int glossary_text_object_try_extract_fast(
    const uint8_t* src,
    uint32_t src_len,
    uint32_t start,
    uint32_t limit,
    uint32_t* out_end,
    uint32_t* out_text_start,
    uint32_t* out_text_length
) {
    if (start >= limit || src[start] != '{') { return 0; }
    uint32_t i = skip_ws(src, src_len, start + 1u);
    int has_type_text = 0;
    int has_text_value = 0;
    uint32_t text_start = 0u;
    uint32_t text_length = 0u;
    uint32_t field_count = 0u;
    while (i < limit) {
        i = skip_ws(src, src_len, i);
        if (i >= limit) { return 0; }
        if (src[i] == '}') {
            if (field_count != 2u || !has_type_text || !has_text_value) { return 0; }
            *out_end = i + 1u;
            *out_text_start = text_start;
            *out_text_length = text_length;
            return 1;
        }
        if (field_count >= 2u || src[i] != '"') { return 0; }
        uint32_t key_end = 0u;
        if (!parse_string_span(src, src_len, i, &key_end)) { return 0; }
        const uint32_t key_start = i;
        const int is_type = json_string_matches_ascii(src, key_start, key_end, "type", 4u);
        const int is_text = json_string_matches_ascii(src, key_start, key_end, "text", 4u);
        if (!is_type && !is_text) { return 0; }
        i = skip_ws(src, src_len, key_end);
        if (i >= limit || src[i] != ':') { return 0; }
        i = skip_ws(src, src_len, i + 1u);
        uint32_t value_end = 0u;
        if (!parse_value_span(src, src_len, i, &value_end) || value_end > limit) { return 0; }
        if (is_type) {
            if (!json_string_matches_ascii(src, i, value_end, "text", 4u)) { return 0; }
            has_type_text = 1;
        } else {
            if (i >= value_end || src[i] != '"') { return 0; }
            has_text_value = 1;
            text_start = i;
            text_length = value_end - i;
        }
        ++field_count;
        i = skip_ws(src, src_len, value_end);
        if (i < limit && src[i] == ',') { ++i; }
    }
    return 0;
}

/*
 * Fast path for the overwhelmingly common normalized glossary shape: a
 * top-level array containing scalar/string values and schema-valid
 * {"type":"text","text":...} objects. Any nested/general structured content
 * falls back to the complete recursive normalizer. Partial output is rolled
 * back, so this is byte-identical or a no-op.
 */
static int write_fast_top_level_glossary(
    const uint8_t* src,
    uint32_t src_len,
    uint32_t value_start,
    uint32_t value_end,
    uint8_t* out,
    uint32_t out_capacity,
    uint32_t* cursor
) {
    if (value_start >= value_end || src[value_start] != '[') { return 0; }
    const uint32_t original_cursor = *cursor;
    if (!write_byte_and_hash(out, out_capacity, cursor, '[', 0, 0)) { goto fail; }
    uint32_t i = value_start + 1u;
    int first = 1;
    while (i < value_end) {
        i = skip_ws(src, src_len, i);
        if (i >= value_end) { goto fail; }
        if (src[i] == ']') {
            if (!write_byte_and_hash(out, out_capacity, cursor, ']', 0, 0)) { goto fail; }
            return 1;
        }
        uint32_t element_end = 0u;
        uint32_t text_start = 0u;
        uint32_t text_length = 0u;
        const int text_object = src[i] == '{' && glossary_text_object_try_extract_fast(
            src, src_len, i, value_end, &element_end, &text_start, &text_length
        );
        if (src[i] == '{' && !text_object) { goto fail; }
        if (src[i] == '[') { goto fail; }
        if (!text_object && (!parse_value_span(src, src_len, i, &element_end) || element_end > value_end)) { goto fail; }
        if (!first && !write_byte_and_hash(out, out_capacity, cursor, ',', 0, 0)) { goto fail; }
        if (text_object) {
            if (!write_bytes_and_hash(out, out_capacity, cursor, src + text_start, text_length, 0, 0)) { goto fail; }
        } else if (!write_bytes_and_hash(out, out_capacity, cursor, src + i, element_end - i, 0, 0)) {
            goto fail;
        }
        first = 0;
        i = skip_ws(src, src_len, element_end);
        if (i < value_end && src[i] == ',') { ++i; }
    }
fail:
    *cursor = original_cursor;
    return 0;
}

static int write_normalized_glossary_value_and_hash(
    const uint8_t* src,
    uint32_t src_len,
    uint32_t value_start,
    uint32_t value_end,
    uint8_t* out,
    uint32_t out_capacity,
    uint32_t* cursor,
    uint32_t* h1,
    uint32_t* h2
) {
    if (value_start >= value_end) { return 0; }
    const uint8_t c = src[value_start];
    if (c == '[') {
        if (!write_byte_and_hash(out, out_capacity, cursor, '[', h1, h2)) { return 0; }
        uint32_t i = value_start + 1u;
        int first = 1;
        while (i < value_end) {
            i = skip_ws(src, src_len, i);
            if (i >= value_end) { return 0; }
            if (src[i] == ']') { break; }

            uint32_t element_end = 0u;
            if (!parse_value_span(src, src_len, i, &element_end)) { return 0; }
            if (!first) {
                if (!write_byte_and_hash(out, out_capacity, cursor, ',', h1, h2)) { return 0; }
            }
            if (!write_normalized_glossary_value_and_hash(src, src_len, i, element_end, out, out_capacity, cursor, h1, h2)) {
                return 0;
            }
            first = 0;
            i = skip_ws(src, src_len, element_end);
            if (i < value_end && src[i] == ',') {
                i += 1u;
            }
        }
        if (!write_byte_and_hash(out, out_capacity, cursor, ']', h1, h2)) { return 0; }
        return 1;
    }

    if (c == '{') {
        uint32_t text_start = 0u;
        uint32_t text_length = 0u;
        if (glossary_object_try_extract_text_value(src, src_len, value_start, value_end, &text_start, &text_length)) {
            return write_bytes_and_hash(out, out_capacity, cursor, src + text_start, text_length, h1, h2);
        }
    }

    return write_bytes_and_hash(out, out_capacity, cursor, src + value_start, value_end - value_start, h1, h2);
}

static int encode_term_content_row(
    const uint8_t* src,
    const TermRowMeta* row,
    uint8_t* out,
    uint32_t out_capacity,
    uint32_t* cursor,
    uint32_t* out_h1,
    uint32_t* out_h2,
    int compute_hashes
) {
    static const uint8_t PREFIX_RULES[] = "{\"rules\":";
    static const uint8_t PREFIX_DEFINITION_TAGS[] = ",\"definitionTags\":";
    static const uint8_t PREFIX_TERM_TAGS[] = ",\"termTags\":";
    static const uint8_t PREFIX_GLOSSARY[] = ",\"glossary\":";
    static const uint8_t SUFFIX[] = "}";
    static const uint8_t EMPTY_QUOTED[] = "\"\"";

    const uint32_t row_start = *cursor;
    uint32_t h1 = 0u;
    uint32_t h2 = 0u;

    if (!write_bytes_and_hash(out, out_capacity, cursor, PREFIX_RULES, sizeof(PREFIX_RULES) - 1u, 0, 0)) { return 0; }
    if (row->rules_length > 0u && !is_null_token(src, row->rules_start, row->rules_length)) {
        if (!write_bytes_and_hash(out, out_capacity, cursor, src + row->rules_start, row->rules_length, 0, 0)) { return 0; }
    } else {
        if (!write_bytes_and_hash(out, out_capacity, cursor, EMPTY_QUOTED, sizeof(EMPTY_QUOTED) - 1u, 0, 0)) { return 0; }
    }

    if (!write_bytes_and_hash(out, out_capacity, cursor, PREFIX_DEFINITION_TAGS, sizeof(PREFIX_DEFINITION_TAGS) - 1u, 0, 0)) { return 0; }
    if (row->definition_tags_length > 0u && !is_null_token(src, row->definition_tags_start, row->definition_tags_length)) {
        if (!write_bytes_and_hash(out, out_capacity, cursor, src + row->definition_tags_start, row->definition_tags_length, 0, 0)) { return 0; }
    } else {
        if (!write_bytes_and_hash(out, out_capacity, cursor, EMPTY_QUOTED, sizeof(EMPTY_QUOTED) - 1u, 0, 0)) { return 0; }
    }

    if (!write_bytes_and_hash(out, out_capacity, cursor, PREFIX_TERM_TAGS, sizeof(PREFIX_TERM_TAGS) - 1u, 0, 0)) { return 0; }
    if (row->term_tags_length > 0u && !is_null_token(src, row->term_tags_start, row->term_tags_length)) {
        if (!write_bytes_and_hash(out, out_capacity, cursor, src + row->term_tags_start, row->term_tags_length, 0, 0)) { return 0; }
    } else {
        if (!write_bytes_and_hash(out, out_capacity, cursor, EMPTY_QUOTED, sizeof(EMPTY_QUOTED) - 1u, 0, 0)) { return 0; }
    }

    if (!write_bytes_and_hash(out, out_capacity, cursor, PREFIX_GLOSSARY, sizeof(PREFIX_GLOSSARY) - 1u, 0, 0)) { return 0; }
    if (row->glossary_length > 0u && row->glossary_requires_normalization == 0u) {
        if (!write_bytes_and_hash(
                out,
                out_capacity,
                cursor,
                src + row->glossary_start,
                row->glossary_length,
                0,
                0
            )) { return 0; }
    } else if (row->glossary_length > 0u) {
        if (!write_normalized_glossary_value_and_hash(
            src,
            row->glossary_start + row->glossary_length,
            row->glossary_start,
            row->glossary_start + row->glossary_length,
            out,
            out_capacity,
            cursor,
            0,
            0
        )) { return 0; }
    } else {
        static const uint8_t EMPTY_ARRAY[] = "[]";
        if (!write_bytes_and_hash(out, out_capacity, cursor, EMPTY_ARRAY, sizeof(EMPTY_ARRAY) - 1u, 0, 0)) { return 0; }
    }

    if (!write_bytes_and_hash(out, out_capacity, cursor, SUFFIX, sizeof(SUFFIX) - 1u, 0, 0)) { return 0; }

    if (compute_hashes) {
        const uint32_t row_length = *cursor - row_start;
        hash_content_xxh32_pair(out + row_start, row_length, FNV1A_OFFSET, MIX_OFFSET, &h1, &h2);
        if ((h1 | h2) == 0u) {
            h1 = 1u;
        }
    }
    *out_h1 = h1;
    *out_h2 = h2;
    return 1;
}

static int encode_term_content_token_binary_row(
    const uint8_t* src,
    const TermRowMeta* row,
    uint8_t* out,
    uint32_t out_capacity,
    uint32_t* cursor,
    uint32_t* out_h1,
    uint32_t* out_h2,
    uint32_t experiment_mask,
    uint32_t* experiment_stats
) {
    static const uint8_t MAGIC[] = "MBR6";
    static const uint8_t EMPTY_QUOTED[] = "\"\"";
    const uint32_t row_start = *cursor;
    if (!write_bytes_and_hash(out, out_capacity, cursor, MAGIC, sizeof(MAGIC) - 1u, 0, 0)) { return 0; }

    const uint32_t field_starts[3] = {
        row->rules_start,
        row->definition_tags_start,
        row->term_tags_start,
    };
    const uint32_t field_lengths[3] = {
        row->rules_length,
        row->definition_tags_length,
        row->term_tags_length,
    };
    for (uint32_t i = 0u; i < 3u; ++i) {
        const uint32_t field_length = field_lengths[i];
        if (field_length > 0u && !is_null_token(src, field_starts[i], field_length)) {
            if (!write_bytes_and_hash(out, out_capacity, cursor, src + field_starts[i], field_length, 0, 0)) { return 0; }
        } else {
            if (!write_bytes_and_hash(out, out_capacity, cursor, EMPTY_QUOTED, sizeof(EMPTY_QUOTED) - 1u, 0, 0)) { return 0; }
        }
        if (!write_byte_and_hash(out, out_capacity, cursor, 0u, 0, 0)) { return 0; }
    }

    if (row->glossary_length > 0u && row->glossary_requires_text_normalization == 0u) {
        if (!write_bytes_and_hash(
                out,
                out_capacity,
                cursor,
                src + row->glossary_start,
                row->glossary_length,
                0,
                0
            )) { return 0; }
    } else if (row->glossary_length > 0u) {
        int normalized = 0;
        if ((experiment_mask & EXPERIMENT_FAST_GLOSSARY_NORMALIZATION) != 0u) {
            normalized = write_fast_top_level_glossary(
                src,
                row->glossary_start + row->glossary_length,
                row->glossary_start,
                row->glossary_start + row->glossary_length,
                out,
                out_capacity,
                cursor
            );
            if (experiment_stats != 0) {
                if (normalized) { ++experiment_stats[3]; }
                else { ++experiment_stats[4]; }
            }
        }
        if (!normalized && !write_normalized_glossary_value_and_hash(
            src,
            row->glossary_start + row->glossary_length,
            row->glossary_start,
            row->glossary_start + row->glossary_length,
            out,
            out_capacity,
            cursor,
            0,
            0
        )) { return 0; }
    } else {
        static const uint8_t EMPTY_ARRAY[] = "[]";
        if (!write_bytes_and_hash(out, out_capacity, cursor, EMPTY_ARRAY, sizeof(EMPTY_ARRAY) - 1u, 0, 0)) { return 0; }
    }

    const uint32_t row_length = *cursor - row_start;
    uint32_t h1 = 0u;
    uint32_t h2 = 0u;
    hash_content_xxh32_pair(out + row_start, row_length, FNV1A_OFFSET, MIX_OFFSET, &h1, &h2);
    if ((h1 | h2) == 0u) {
        h1 = 1u;
    }
    *out_h1 = h1;
    *out_h2 = h2;
    return 1;
}

/* Keep the ordinary contiguous fallback on its established tight loop. Span
 * traversal is selected once per call, not charged per row when disabled. */
static int32_t parse_contiguous_term_bank(uint32_t json_ptr, uint32_t json_len, uint32_t out_ptr, uint32_t out_capacity, int media_hints) {
    if (json_ptr == 0u || json_len == 0u || out_ptr == 0u || out_capacity == 0u) {
        return -1;
    }
    const uint8_t* src = (const uint8_t*)(uintptr_t)json_ptr;
    TermRowMeta* rows = (TermRowMeta*)(uintptr_t)out_ptr;
    last_parse_capacity = out_capacity;

    uint32_t i = skip_ws(src, json_len, 0u);
    if (i >= json_len || src[i] != '[') { return -1; }
    i = skip_ws(src, json_len, i + 1u);
    if (i < json_len && src[i] == ']') {
        i = skip_ws(src, json_len, i + 1u);
        return i == json_len ? 0 : -1;
    }

    uint32_t row_count = 0u;
    while (i < json_len) {
        if (row_count >= out_capacity) {
            if (!grow_term_row_buffer(out_ptr, out_capacity, &out_capacity)) {
                return -2;
            }
        }
        uint32_t row_end = 0u;
        if (!parse_row_single_pass(src, json_len, i, &rows[row_count], media_hints, &row_end, 0, 0u, 0)) {
            return -1;
        }
        ++row_count;
        i = skip_ws(src, json_len, row_end);
        if (i >= json_len) { return -1; }
        if (src[i] == ']') {
            i = skip_ws(src, json_len, i + 1u);
            return i == json_len ? (int32_t)row_count : -1;
        }
        if (src[i] != ',') { return -1; }
        i = skip_ws(src, json_len, i + 1u);
        if (i >= json_len || src[i] == ']') { return -1; }
    }
    return -1;
}


static int32_t parse_term_bank_impl(
    uint32_t json_ptr, uint32_t json_len, uint32_t out_ptr, uint32_t out_capacity,
    int media_hints, uint32_t bank_spans_ptr, uint32_t bank_count
) {
    if (bank_spans_ptr == 0u) {
        if (bank_count != 0u) { return -1; }
        return parse_contiguous_term_bank(json_ptr, json_len, out_ptr, out_capacity, media_hints);
    }
    if (json_ptr == 0u || json_len == 0u || out_ptr == 0u || out_capacity == 0u ||
        ((bank_spans_ptr == 0u) != (bank_count == 0u))) { return -1; }
    const uint8_t* src = (const uint8_t*)(uintptr_t)json_ptr;
    TermRowMeta* rows = (TermRowMeta*)(uintptr_t)out_ptr;
    last_parse_capacity = out_capacity;
    TermBankCursor source = {src, (const uint32_t*)(uintptr_t)bank_spans_ptr,
        json_len, bank_count == 0u ? 1u : bank_count, 0u, 0u, 0u};
    int status = next_term_bank(&source);
    uint32_t row_count = 0u;
    while (status > 0) {
        if (row_count >= out_capacity && !grow_term_row_buffer(out_ptr, out_capacity, &out_capacity)) { return -2; }
        uint32_t row_end = 0u;
        if (!parse_row_single_pass(src, source.end, source.position, &rows[row_count], media_hints, &row_end, 0, 0u, 0)) {
            return -1;
        }
        ++row_count;
        status = next_term_row(&source, row_end);
    }
    return status < 0 ? -1 : (int32_t)row_count;
}

__attribute__((visibility("default")))
int32_t parse_term_bank(uint32_t json_ptr, uint32_t json_len, uint32_t out_ptr, uint32_t out_capacity, uint32_t bank_spans_ptr, uint32_t bank_count) {
    return parse_term_bank_impl(json_ptr, json_len, out_ptr, out_capacity, 0, bank_spans_ptr, bank_count);
}

__attribute__((visibility("default")))
int32_t parse_term_bank_with_media_hints(uint32_t json_ptr, uint32_t json_len, uint32_t out_ptr, uint32_t out_capacity, uint32_t bank_spans_ptr, uint32_t bank_count) {
    return parse_term_bank_impl(json_ptr, json_len, out_ptr, out_capacity, 1, bank_spans_ptr, bank_count);
}

__attribute__((visibility("default")))
static int32_t encode_term_content_impl(
    uint32_t json_ptr,
    uint32_t metas_ptr,
    uint32_t row_count,
    uint32_t out_ptr,
    uint32_t out_capacity,
    uint32_t row_meta_ptr,
    int compute_hashes
) {
    if (json_ptr == 0u || metas_ptr == 0u || out_ptr == 0u || row_meta_ptr == 0u) {
        return -1;
    }
    const uint8_t* src = (const uint8_t*)(uintptr_t)json_ptr;
    const TermRowMeta* rows = (const TermRowMeta*)(uintptr_t)metas_ptr;
    uint8_t* out = (uint8_t*)(uintptr_t)out_ptr;
    uint32_t* row_meta = (uint32_t*)(uintptr_t)row_meta_ptr;
    uint32_t cursor = 0u;
    last_content_capacity = out_capacity;
    for (uint32_t i = 0u; i < row_count; ++i) {
        const uint32_t start = cursor;
        uint32_t h1 = 0u;
        uint32_t h2 = 0u;
        while (!encode_term_content_row(src, &rows[i], out, out_capacity, &cursor, &h1, &h2, compute_hashes)) {
            cursor = start;
            if (!grow_content_buffer(out_ptr, out_capacity, &out_capacity)) { return -2; }
        }
        const uint32_t o = i * 4u;
        row_meta[o + 0u] = start;
        row_meta[o + 1u] = cursor - start;
        row_meta[o + 2u] = h1;
        row_meta[o + 3u] = h2;
    }
    return (int32_t)cursor;
}

__attribute__((visibility("default")))
int32_t encode_term_content(
    uint32_t json_ptr,
    uint32_t metas_ptr,
    uint32_t row_count,
    uint32_t out_ptr,
    uint32_t out_capacity,
    uint32_t row_meta_ptr
) {
    return encode_term_content_impl(json_ptr, metas_ptr, row_count, out_ptr, out_capacity, row_meta_ptr, 1);
}

__attribute__((visibility("default")))
int32_t encode_term_content_no_hash(
    uint32_t json_ptr,
    uint32_t metas_ptr,
    uint32_t row_count,
    uint32_t out_ptr,
    uint32_t out_capacity,
    uint32_t row_meta_ptr
) {
    return encode_term_content_impl(json_ptr, metas_ptr, row_count, out_ptr, out_capacity, row_meta_ptr, 0);
}

__attribute__((visibility("default")))
int32_t encode_term_content_token_binary(
    uint32_t json_ptr,
    uint32_t metas_ptr,
    uint32_t row_count,
    uint32_t out_ptr,
    uint32_t out_capacity,
    uint32_t row_meta_ptr
) {
    if (json_ptr == 0u || metas_ptr == 0u || out_ptr == 0u || row_meta_ptr == 0u) {
        return -1;
    }
    const uint8_t* src = (const uint8_t*)(uintptr_t)json_ptr;
    const TermRowMeta* rows = (const TermRowMeta*)(uintptr_t)metas_ptr;
    uint8_t* out = (uint8_t*)(uintptr_t)out_ptr;
    uint32_t* row_meta = (uint32_t*)(uintptr_t)row_meta_ptr;
    uint32_t cursor = 0u;
    last_content_capacity = out_capacity;
    for (uint32_t i = 0u; i < row_count; ++i) {
        const uint32_t start = cursor;
        uint32_t h1 = 0u;
        uint32_t h2 = 0u;
        while (!encode_term_content_token_binary_row(src, &rows[i], out, out_capacity, &cursor, &h1, &h2, 0u, 0)) {
            cursor = start;
            if (!grow_content_buffer(out_ptr, out_capacity, &out_capacity)) { return -2; }
        }
        const uint32_t o = i * 4u;
        row_meta[o + 0u] = start;
        row_meta[o + 1u] = cursor - start;
        row_meta[o + 2u] = h1;
        row_meta[o + 3u] = h2;
    }
    return (int32_t)cursor;
}

static int content_bytes_equal(
    const uint8_t* bytes,
    uint32_t first_offset,
    uint32_t second_offset,
    uint32_t length
) {
    uint32_t i = 0u;
    while (i + 8u <= length) {
        uint64_t first;
        uint64_t second;
        __builtin_memcpy(&first, bytes + first_offset + i, sizeof(first));
        __builtin_memcpy(&second, bytes + second_offset + i, sizeof(second));
        if (first != second) { return 0; }
        i += 8u;
    }
    while (i < length) {
        if (bytes[first_offset + i] != bytes[second_offset + i]) { return 0; }
        ++i;
    }
    return 1;
}

static int content_bytes_equal_between(
    const uint8_t* first_bytes,
    uint32_t first_offset,
    const uint8_t* second_bytes,
    uint32_t second_offset,
    uint32_t length
) {
    uint32_t i = 0u;
    while (i + 8u <= length) {
        uint64_t first;
        uint64_t second;
        __builtin_memcpy(&first, first_bytes + first_offset + i, sizeof(first));
        __builtin_memcpy(&second, second_bytes + second_offset + i, sizeof(second));
        if (first != second) { return 0; }
        i += 8u;
    }
    while (i < length) {
        if (first_bytes[first_offset + i] != second_bytes[second_offset + i]) {
            return 0;
        }
        ++i;
    }
    return 1;
}

static int raw_term_content_tokens_equal(
    const uint8_t* src,
    const TermRowMeta* first,
    const TermRowMeta* second,
    int glossary_equal
) {
    return (
        first->glossary_length == second->glossary_length &&
        (glossary_equal || content_bytes_equal_between(
            src,
            first->glossary_start,
            src,
            second->glossary_start,
            first->glossary_length
        )) &&
        first->rules_length == second->rules_length &&
        content_bytes_equal_between(
            src,
            first->rules_start,
            src,
            second->rules_start,
            first->rules_length
        ) &&
        first->definition_tags_length == second->definition_tags_length &&
        content_bytes_equal_between(
            src,
            first->definition_tags_start,
            src,
            second->definition_tags_start,
            first->definition_tags_length
        ) &&
        first->term_tags_length == second->term_tags_length &&
        content_bytes_equal_between(
            src,
            first->term_tags_start,
            src,
            second->term_tags_start,
            first->term_tags_length
        )
    );
}

static uint32_t raw_term_content_quick_signature(
    const uint8_t* src,
    const TermRowMeta* row
) {
    const uint32_t length = row->glossary_length;
    uint32_t first = 0u;
    uint32_t middle = 0u;
    uint32_t last = 0u;
    if (length > 0u) {
        const uint32_t sample_length = length < 4u ? length : 4u;
        __builtin_memcpy(&first, src + row->glossary_start, sample_length);
        __builtin_memcpy(&middle, src + row->glossary_start + ((length - sample_length) / 2u), sample_length);
        __builtin_memcpy(&last, src + row->glossary_start + length - sample_length, sample_length);
    }
    uint32_t signature = length * 0x9e3779b1u;
    signature ^= row->rules_length * 0x85ebca6bu;
    signature ^= row->definition_tags_length * 0xc2b2ae35u;
    signature ^= row->term_tags_length * 0x27d4eb2fu;
    signature ^= first;
    signature = (signature << 13u) | (signature >> 19u);
    signature ^= middle * 0x165667b1u;
    signature = (signature << 11u) | (signature >> 21u);
    return signature ^ last;
}

static uint32_t raw_term_content_hash(
    const uint8_t* src,
    const TermRowMeta* row
) {
    uint32_t hash = hash_content_xxh32(src + row->glossary_start, row->glossary_length, FNV1A_OFFSET);
    hash ^= rotl32(hash_content_xxh32(src + row->rules_start, row->rules_length, MIX_OFFSET), 5u);
    hash ^= rotl32(hash_content_xxh32(src + row->definition_tags_start, row->definition_tags_length, 0x85ebca6bu), 11u);
    hash ^= rotl32(hash_content_xxh32(src + row->term_tags_start, row->term_tags_length, 0xc2b2ae35u), 17u);
    hash ^= hash >> 16u;
    return hash == 0u ? 1u : hash;
}

static int json_string_token_has_escape(
    const uint8_t* src,
    uint32_t start,
    uint32_t length
) {
    if (length < 2u || src[start] != '"' || src[start + length - 1u] != '"') {
        return 1;
    }
    const uint32_t end = start + length - 1u;
    for (uint32_t i = start + 1u; i < end; ++i) {
        if (src[i] == '\\') { return 1; }
    }
    return 0;
}


static uint32_t key_hex4(const uint8_t* p) {
    uint32_t value = 0u;
    for (uint32_t j = 0u; j < 4u; ++j) {
        const uint8_t c = p[j];
        uint32_t digit;
        if (c >= '0' && c <= '9') { digit = c - '0'; }
        else if (c >= 'a' && c <= 'f') { digit = c - 'a' + 10u; }
        else if (c >= 'A' && c <= 'F') { digit = c - 'A' + 10u; }
        else { return 0xffffffffu; }
        value = (value << 4u) | digit;
    }
    return value;
}

/* Decode only an exceptional JSON key, never every key in a source group.
 * Unpaired escaped UTF-16 surrogates become U+FFFD, as TextEncoder does after
 * JSON.parse. Invalid raw UTF-8 deliberately uses the old replacement-decoder
 * fallback. Decode into the unused interner tail: no extra scratch allocation
 * or copy is needed. A duplicate leaves this tail available for the next key. */
static int32_t decode_escaped_key(const uint8_t* token, uint32_t length, uint8_t* output, uint32_t capacity) {
    if (capacity > MAX_INTERNED_KEY_BYTES) { capacity = MAX_INTERNED_KEY_BYTES; }
    if (length < 2u || token[0] != '"' || token[length - 1u] != '"') { return -1; }
    const uint32_t end = length - 1u;
    uint32_t cursor = 0u;
    for (uint32_t i = 1u; i < end;) {
        uint32_t c = token[i++];
        if (c != '\\') {
            if (c < 0x20u || c == '"') { return -1; }
            uint32_t width = 1u;
            if (c >= 0x80u) {
                if (c >= 0xc2u && c <= 0xdfu) { width = 2u; }
                else if (c >= 0xe0u && c <= 0xefu) { width = 3u; }
                else if (c >= 0xf0u && c <= 0xf4u) { width = 4u; }
                else { return -1; }
                if (width - 1u > end - i) { return -1; }
                const uint8_t second = token[i];
                if ((c == 0xe0u && second < 0xa0u) || (c == 0xedu && second > 0x9fu) ||
                    (c == 0xf0u && second < 0x90u) || (c == 0xf4u && second > 0x8fu)) { return -1; }
                for (uint32_t j = 0u; j < width - 1u; ++j) {
                    if ((token[i + j] & 0xc0u) != 0x80u) { return -1; }
                }
            }
            if (width > capacity - cursor) { return -1; }
            output[cursor++] = (uint8_t)c;
            for (uint32_t j = 1u; j < width; ++j) { output[cursor++] = token[i++]; }
            continue;
        }
        if (i >= end) { return -1; }
        c = token[i++];
        switch (c) {
            case '"': case '\\': case '/': break;
            case 'b': c = 8u; break;
            case 'f': c = 12u; break;
            case 'n': c = 10u; break;
            case 'r': c = 13u; break;
            case 't': c = 9u; break;
            case 'u': {
                if (end - i < 4u) { return -1; }
                c = key_hex4(token + i);
                if (c == 0xffffffffu) { return -1; }
                i += 4u;
                if (c >= 0xd800u && c <= 0xdbffu) {
                    uint32_t low = 0u;
                    if (end - i >= 6u && token[i] == '\\' && token[i + 1u] == 'u') {
                        low = key_hex4(token + i + 2u);
                    }
                    if (low >= 0xdc00u && low <= 0xdfffu) {
                        c = 0x10000u + ((c - 0xd800u) << 10u) + low - 0xdc00u;
                        i += 6u;
                    } else { c = 0xfffdu; }
                } else if (c >= 0xdc00u && c <= 0xdfffu) { c = 0xfffdu; }
                break;
            }
            default: return -1;
        }
        const uint32_t width = c < 0x80u ? 1u : (c < 0x800u ? 2u : (c < 0x10000u ? 3u : 4u));
        if (width > capacity - cursor) { return -1; }
        if (width == 1u) { output[cursor++] = (uint8_t)c; }
        else {
            output[cursor++] = (uint8_t)((width == 2u ? 0xc0u : (width == 3u ? 0xe0u : 0xf0u)) | (c >> (6u * (width - 1u))));
            for (uint32_t j = width - 1u; j > 0u; --j) {
                output[cursor++] = (uint8_t)(0x80u | ((c >> (6u * (j - 1u))) & 0x3fu));
            }
        }
    }
    return (int32_t)cursor;
}

static uint32_t mix_string_hash(uint32_t hash, uint32_t length) {
    uint32_t value = hash ^ (length * 0x85ebca6bu);
    value ^= value >> 16u;
    return value;
}

__attribute__((visibility("default")))
int32_t build_term_string_plan(
    uint32_t json_ptr,
    uint32_t metas_ptr,
    uint32_t row_start,
    uint32_t row_count,
    uint32_t strings_ptr,
    uint32_t strings_capacity,
    uint32_t string_lengths_ptr,
    uint32_t string_offsets_ptr,
    uint32_t string_hashes_ptr,
    uint32_t expression_indexes_ptr,
    uint32_t reading_indexes_ptr,
    uint32_t hash_table_ptr,
    uint32_t hash_table_size,
    uint32_t unique_count_ptr
) {
    if (
        json_ptr == 0u ||
        metas_ptr == 0u ||
        strings_ptr == 0u ||
        string_lengths_ptr == 0u ||
        string_offsets_ptr == 0u ||
        string_hashes_ptr == 0u ||
        expression_indexes_ptr == 0u ||
        reading_indexes_ptr == 0u ||
        hash_table_ptr == 0u ||
        unique_count_ptr == 0u ||
        hash_table_size == 0u ||
        (hash_table_size & (hash_table_size - 1u)) != 0u
    ) {
        return -1;
    }
    const uint8_t* src = (const uint8_t*)(uintptr_t)json_ptr;
    const TermRowMeta* rows = (const TermRowMeta*)(uintptr_t)metas_ptr;
    uint8_t* strings = (uint8_t*)(uintptr_t)strings_ptr;
    uint16_t* string_lengths = (uint16_t*)(uintptr_t)string_lengths_ptr;
    uint32_t* string_offsets = (uint32_t*)(uintptr_t)string_offsets_ptr;
    uint32_t* string_hashes = (uint32_t*)(uintptr_t)string_hashes_ptr;
    uint32_t* expression_indexes = (uint32_t*)(uintptr_t)expression_indexes_ptr;
    uint32_t* reading_indexes = (uint32_t*)(uintptr_t)reading_indexes_ptr;
    uint32_t* hash_table = (uint32_t*)(uintptr_t)hash_table_ptr;
    const uint32_t table_mask = hash_table_size - 1u;
    const uint32_t max_unique_count = row_count * 2u;
    uint32_t unique_count = 0u;
    uint32_t strings_cursor = 0u;

    for (uint32_t local_row = 0u; local_row < row_count; ++local_row) {
        const TermRowMeta* row = &rows[row_start + local_row];
        const uint32_t token_starts[2] = {
            row->expression_start,
            row->reading_start,
        };
        const uint32_t token_lengths[2] = {
            row->expression_length,
            row->reading_length,
        };
        uint32_t indexes[2] = {0u, 0u};
        int reading_equals_expression = (
            token_lengths[1] == 2u &&
            src[token_starts[1]] == '"' &&
            src[token_starts[1] + 1u] == '"'
        );
        if (
            !reading_equals_expression &&
            token_lengths[0] == token_lengths[1] &&
            content_bytes_equal(src, token_starts[0], token_starts[1], token_lengths[0])
        ) {
            reading_equals_expression = 1;
        }

        for (uint32_t field = 0u; field < 2u; ++field) {
            if (field == 1u && reading_equals_expression) {
                indexes[1] = indexes[0];
                continue;
            }
            const uint32_t token_start = token_starts[field];
            const uint32_t token_length = token_lengths[field];
            if (json_string_token_has_escape(src, token_start, token_length)) {
                return -4;
            }
            const uint32_t value_start = token_start + 1u;
            const uint32_t value_length = token_length - 2u;
            if (value_length > MAX_INTERNED_KEY_BYTES) { return -5; }
            const uint32_t hash = hash_content_xxh32(src + value_start, value_length, FNV1A_OFFSET);
            uint32_t slot = mix_string_hash(hash, value_length) & table_mask;
            uint32_t matched_index = 0xffffffffu;
            for (uint32_t probes = 0u; probes < hash_table_size; ++probes) {
                const uint32_t stored = hash_table[slot];
                if (stored == 0u) { break; }
                const uint32_t candidate = stored - 1u;
                if (candidate >= unique_count) { return -3; }
                if (
                    string_hashes[candidate] == hash &&
                    string_lengths[candidate] == value_length &&
                    content_bytes_equal_between(
                        strings,
                        string_offsets[candidate],
                        src,
                        value_start,
                        value_length
                    )
                ) {
                    matched_index = candidate;
                    break;
                }
                slot = (slot + 1u) & table_mask;
            }
            if (matched_index != 0xffffffffu) {
                indexes[field] = matched_index;
                continue;
            }
            if (
                unique_count >= max_unique_count ||
                hash_table[slot] != 0u ||
                strings_cursor + value_length > strings_capacity
            ) {
                return -2;
            }
            for (uint32_t i = 0u; i < value_length; ++i) {
                strings[strings_cursor + i] = src[value_start + i];
            }
            string_lengths[unique_count] = (uint16_t)value_length;
            string_offsets[unique_count] = strings_cursor;
            string_hashes[unique_count] = hash;
            hash_table[slot] = unique_count + 1u;
            indexes[field] = unique_count;
            strings_cursor += value_length;
            ++unique_count;
        }
        expression_indexes[local_row] = indexes[0];
        reading_indexes[local_row] = indexes[1];
    }
    *(uint32_t*)(uintptr_t)unique_count_ptr = unique_count;
    return (int32_t)strings_cursor;
}

#define TERM_LOOKUP_CONTAINER_HEADER_BYTES 16u
#define TERM_LOOKUP_BASE_HEADER_BYTES 32u
#define TERM_LOOKUP_DERIVED_HEADER_BYTES 32u
#define TERM_LOOKUP_CONTAINER_MAGIC 0x37494c4du
#define TERM_LOOKUP_FORMAT_VERSION 7u
#define TERM_LOOKUP_U16_NULL 0xffffu
#define TERM_LOOKUP_HASH_SLOT_TARGET_LOAD 4u

static uint32_t align4(uint32_t value) {
    return (value + 3u) & ~3u;
}

static uint32_t term_lookup_hash_slot_count(uint32_t count) {
    const uint32_t target = (count + TERM_LOOKUP_HASH_SLOT_TARGET_LOAD - 1u) /
        TERM_LOOKUP_HASH_SLOT_TARGET_LOAD;
    uint32_t value = 1u;
    while (value < target) { value <<= 1u; }
    return value;
}

static uint32_t term_lookup_sequence_hash(uint32_t value) {
    uint32_t hash = FNV1A_OFFSET;
    for (uint32_t shift = 0u; shift < 32u; shift += 8u) {
        hash = (hash ^ ((value >> shift) & 0xffu)) * 0x01000193u;
    }
    return hash;
}

static void term_lookup_insert_hash(
    uint16_t* heads,
    uint16_t* next,
    uint32_t value,
    uint32_t hash,
    uint32_t slot_count
) {
    const uint32_t slot = hash & (slot_count - 1u);
    next[value] = heads[slot];
    heads[slot] = (uint16_t)value;
}

/**
 * Encodes the persisted v7 lookup container directly from parser-owned columns.
 * The output is byte-identical to the validated JavaScript encoder. Scratch
 * buffers are caller-owned so repeated parser chunks do not retain C state.
 */
__attribute__((visibility("default")))
int32_t encode_term_lookup_index(
    uint32_t strings_ptr,
    uint32_t strings_length,
    uint32_t string_lengths_ptr,
    uint32_t string_offsets_ptr,
    uint32_t string_hashes_ptr,
    uint32_t key_count,
    uint32_t expression_indexes_ptr,
    uint32_t reading_indexes_ptr,
    uint32_t reading_equals_ptr,
    uint32_t sequences_ptr,
    uint32_t row_count,
    uint32_t output_ptr,
    uint32_t output_capacity,
    uint32_t sequence_keys_scratch_ptr,
    uint32_t sequence_key_by_row_scratch_ptr,
    uint32_t sequence_slots_scratch_ptr,
    uint32_t sequence_slots_count
) {
    if (
        strings_ptr == 0u || string_lengths_ptr == 0u || string_offsets_ptr == 0u ||
        string_hashes_ptr == 0u || expression_indexes_ptr == 0u ||
        reading_indexes_ptr == 0u || reading_equals_ptr == 0u || sequences_ptr == 0u ||
        output_ptr == 0u || sequence_keys_scratch_ptr == 0u ||
        sequence_key_by_row_scratch_ptr == 0u || sequence_slots_scratch_ptr == 0u ||
        row_count == 0u || row_count >= TERM_LOOKUP_U16_NULL ||
        key_count == 0u || key_count >= TERM_LOOKUP_U16_NULL ||
        sequence_slots_count < row_count ||
        (sequence_slots_count & (sequence_slots_count - 1u)) != 0u
    ) {
        return -1;
    }
    const uint8_t* strings = (const uint8_t*)(uintptr_t)strings_ptr;
    const uint16_t* string_lengths = (const uint16_t*)(uintptr_t)string_lengths_ptr;
    const uint32_t* string_offsets = (const uint32_t*)(uintptr_t)string_offsets_ptr;
    const uint32_t* string_hashes = (const uint32_t*)(uintptr_t)string_hashes_ptr;
    const uint32_t* expression_indexes = (const uint32_t*)(uintptr_t)expression_indexes_ptr;
    const uint32_t* reading_indexes = (const uint32_t*)(uintptr_t)reading_indexes_ptr;
    const uint8_t* reading_equals = (const uint8_t*)(uintptr_t)reading_equals_ptr;
    const int32_t* sequences = (const int32_t*)(uintptr_t)sequences_ptr;
    int32_t* sequence_keys = (int32_t*)(uintptr_t)sequence_keys_scratch_ptr;
    uint16_t* sequence_key_by_row = (uint16_t*)(uintptr_t)sequence_key_by_row_scratch_ptr;
    uint16_t* sequence_slots = (uint16_t*)(uintptr_t)sequence_slots_scratch_ptr;
    const uint32_t sequence_slot_mask = sequence_slots_count - 1u;
    uint32_t sequence_key_count = 0u;
    uint32_t sequence_posting_count = 0u;
    uint32_t reading_posting_count = 0u;
    memset(sequence_slots, 0, sequence_slots_count * sizeof(uint16_t));

    for (uint32_t row = 0u; row < row_count; ++row) {
        const uint32_t expression_key = expression_indexes[row];
        const uint32_t reading_key = reading_indexes[row];
        if (
            expression_key >= key_count ||
            (reading_equals[row] > 1u) ||
            (reading_equals[row] == 0u && reading_key >= key_count)
        ) {
            return -2;
        }
        if (reading_equals[row] == 0u) { ++reading_posting_count; }
        const int32_t sequence = sequences[row];
        if (sequence < 0) {
            sequence_key_by_row[row] = TERM_LOOKUP_U16_NULL;
            continue;
        }
        uint32_t slot = term_lookup_sequence_hash((uint32_t)sequence) & sequence_slot_mask;
        uint32_t key = 0u;
        for (;;) {
            const uint16_t entry = sequence_slots[slot];
            if (entry == 0u) {
                if (sequence_key_count >= TERM_LOOKUP_U16_NULL) { return -3; }
                key = sequence_key_count++;
                sequence_keys[key] = sequence;
                sequence_slots[slot] = (uint16_t)(key + 1u);
                break;
            }
            key = (uint32_t)entry - 1u;
            if (sequence_keys[key] == sequence) { break; }
            slot = (slot + 1u) & sequence_slot_mask;
        }
        sequence_key_by_row[row] = (uint16_t)key;
        ++sequence_posting_count;
    }

    const uint32_t key_slot_count = term_lookup_hash_slot_count(key_count);
    const uint32_t sequence_hash_slot_count = term_lookup_hash_slot_count(sequence_key_count);
    const uint64_t aligned_string_length_64 = ((uint64_t)strings_length + 3u) & ~UINT64_C(3);
    const uint32_t base_u16_bytes = align4(
        (key_count + (row_count * 3u)) * (uint32_t)sizeof(uint16_t)
    );
    const uint32_t derived_u16_count =
        key_slot_count + key_count +
        (key_count + 1u) + row_count +
        (key_count + 1u) + reading_posting_count +
        sequence_hash_slot_count + sequence_key_count +
        (sequence_key_count + 1u) + sequence_posting_count;
    const uint32_t derived_u16_bytes = align4(derived_u16_count * (uint32_t)sizeof(uint16_t));
    const uint64_t base_length_64 =
        TERM_LOOKUP_BASE_HEADER_BYTES + aligned_string_length_64 + base_u16_bytes +
        sequence_key_count * (uint32_t)sizeof(int32_t);
    const uint64_t derived_length_64 = TERM_LOOKUP_DERIVED_HEADER_BYTES + derived_u16_bytes;
    const uint64_t output_length_64 =
        TERM_LOOKUP_CONTAINER_HEADER_BYTES + base_length_64 + derived_length_64;
    if (output_length_64 > output_capacity || output_length_64 > 0x7fffffffu) { return -4; }
    const uint32_t aligned_string_length = (uint32_t)aligned_string_length_64;
    const uint32_t base_length = (uint32_t)base_length_64;
    const uint32_t derived_length = (uint32_t)derived_length_64;
    const uint32_t output_length = (uint32_t)output_length_64;

    uint8_t* output = (uint8_t*)(uintptr_t)output_ptr;
    memset(output, 0, output_length);
    uint32_t* container_header = (uint32_t*)output;
    container_header[0] = TERM_LOOKUP_CONTAINER_MAGIC;
    container_header[1] = TERM_LOOKUP_FORMAT_VERSION;
    container_header[2] = base_length;
    container_header[3] = derived_length;
    uint8_t* base = output + TERM_LOOKUP_CONTAINER_HEADER_BYTES;
    uint32_t* base_header = (uint32_t*)base;
    base_header[0] = row_count;
    base_header[1] = key_count;
    base_header[2] = strings_length;
    base_header[3] = TERM_LOOKUP_FORMAT_VERSION;
    base_header[4] = sequence_key_count;
    base_header[5] = reading_posting_count;
    __builtin_memcpy(base + TERM_LOOKUP_BASE_HEADER_BYTES, strings, strings_length);

    uint32_t cursor = TERM_LOOKUP_BASE_HEADER_BYTES + aligned_string_length;
    uint16_t* persisted_key_lengths = (uint16_t*)(base + cursor);
    cursor += key_count * (uint32_t)sizeof(uint16_t);
    uint16_t* persisted_expression_keys = (uint16_t*)(base + cursor);
    cursor += row_count * (uint32_t)sizeof(uint16_t);
    uint16_t* persisted_reading_keys = (uint16_t*)(base + cursor);
    cursor += row_count * (uint32_t)sizeof(uint16_t);
    uint16_t* persisted_sequence_row_keys = (uint16_t*)(base + cursor);
    cursor += row_count * (uint32_t)sizeof(uint16_t);
    cursor = align4(cursor);
    int32_t* persisted_sequence_keys = (int32_t*)(base + cursor);
    __builtin_memcpy(
        persisted_sequence_keys,
        sequence_keys,
        sequence_key_count * sizeof(int32_t)
    );
    uint32_t expected_start = 0u;
    for (uint32_t key = 0u; key < key_count; ++key) {
        const uint32_t start = string_offsets[key];
        const uint32_t length = string_lengths[key];
        if (start != expected_start || length == 0u || length >= TERM_LOOKUP_U16_NULL) {
            return -5;
        }
        if (start > strings_length || length > strings_length - start) { return -5; }
        persisted_key_lengths[key] = (uint16_t)length;
        expected_start = start + length;
    }
    if (expected_start != strings_length) { return -5; }

    uint8_t* derived = base + base_length;
    uint32_t* derived_header = (uint32_t*)derived;
    derived_header[0] = row_count;
    derived_header[1] = key_count;
    derived_header[2] = key_slot_count;
    derived_header[3] = sequence_hash_slot_count;
    derived_header[4] = reading_posting_count;
    derived_header[5] = sequence_key_count;
    derived_header[6] = sequence_posting_count;
    derived_header[7] = TERM_LOOKUP_FORMAT_VERSION;
    cursor = TERM_LOOKUP_DERIVED_HEADER_BYTES;
    uint16_t* key_heads = (uint16_t*)(derived + cursor);
    cursor += key_slot_count * (uint32_t)sizeof(uint16_t);
    uint16_t* key_next = (uint16_t*)(derived + cursor);
    cursor += key_count * (uint32_t)sizeof(uint16_t);
    uint16_t* expression_offsets = (uint16_t*)(derived + cursor);
    cursor += (key_count + 1u) * (uint32_t)sizeof(uint16_t);
    uint16_t* expression_rows = (uint16_t*)(derived + cursor);
    cursor += row_count * (uint32_t)sizeof(uint16_t);
    uint16_t* reading_offsets = (uint16_t*)(derived + cursor);
    cursor += (key_count + 1u) * (uint32_t)sizeof(uint16_t);
    uint16_t* reading_rows = (uint16_t*)(derived + cursor);
    cursor += reading_posting_count * (uint32_t)sizeof(uint16_t);
    uint16_t* sequence_heads = (uint16_t*)(derived + cursor);
    cursor += sequence_hash_slot_count * (uint32_t)sizeof(uint16_t);
    uint16_t* sequence_next = (uint16_t*)(derived + cursor);
    cursor += sequence_key_count * (uint32_t)sizeof(uint16_t);
    uint16_t* sequence_offsets = (uint16_t*)(derived + cursor);
    cursor += (sequence_key_count + 1u) * (uint32_t)sizeof(uint16_t);
    uint16_t* sequence_rows = (uint16_t*)(derived + cursor);
    cursor += sequence_posting_count * (uint32_t)sizeof(uint16_t);
    memset(key_heads, 0xff, key_slot_count * sizeof(uint16_t));
    memset(key_next, 0xff, key_count * sizeof(uint16_t));
    memset(sequence_heads, 0xff, sequence_hash_slot_count * sizeof(uint16_t));
    memset(sequence_next, 0xff, sequence_key_count * sizeof(uint16_t));
    for (uint32_t key = 0u; key < key_count; ++key) {
        term_lookup_insert_hash(key_heads, key_next, key, string_hashes[key], key_slot_count);
    }
    for (uint32_t key = 0u; key < sequence_key_count; ++key) {
        term_lookup_insert_hash(
            sequence_heads,
            sequence_next,
            key,
            term_lookup_sequence_hash((uint32_t)sequence_keys[key]),
            sequence_hash_slot_count
        );
    }

    for (uint32_t row = 0u; row < row_count; ++row) {
        persisted_expression_keys[row] = (uint16_t)expression_indexes[row];
        persisted_reading_keys[row] = reading_equals[row] == 0u ?
            (uint16_t)reading_indexes[row] : TERM_LOOKUP_U16_NULL;
        const uint16_t sequence_key = sequence_key_by_row[row];
        persisted_sequence_row_keys[row] = sequence_key;
        ++expression_offsets[(uint32_t)persisted_expression_keys[row] + 1u];
        if (persisted_reading_keys[row] != TERM_LOOKUP_U16_NULL) {
            ++reading_offsets[(uint32_t)persisted_reading_keys[row] + 1u];
        }
        if (sequence_key != TERM_LOOKUP_U16_NULL) { ++sequence_offsets[(uint32_t)sequence_key + 1u]; }
    }
    for (uint32_t key = 1u; key <= key_count; ++key) {
        expression_offsets[key] = (uint16_t)(expression_offsets[key] + expression_offsets[key - 1u]);
        reading_offsets[key] = (uint16_t)(reading_offsets[key] + reading_offsets[key - 1u]);
    }
    for (uint32_t key = 1u; key <= sequence_key_count; ++key) {
        sequence_offsets[key] = (uint16_t)(sequence_offsets[key] + sequence_offsets[key - 1u]);
    }
    for (uint32_t row = row_count; row > 0u;) {
        --row;
        const uint32_t expression_key = persisted_expression_keys[row];
        expression_rows[--expression_offsets[expression_key + 1u]] = (uint16_t)row;
        if (persisted_reading_keys[row] != TERM_LOOKUP_U16_NULL) {
            const uint32_t reading_key = persisted_reading_keys[row];
            reading_rows[--reading_offsets[reading_key + 1u]] = (uint16_t)row;
        }
        const uint16_t sequence_key = sequence_key_by_row[row];
        if (sequence_key != TERM_LOOKUP_U16_NULL) {
            sequence_rows[sequence_offsets[sequence_key]++] = (uint16_t)row;
        }
    }
    for (uint32_t key = 1u; key < key_count; ++key) {
        expression_offsets[key] = expression_offsets[key + 1u];
        reading_offsets[key] = reading_offsets[key + 1u];
    }
    expression_offsets[key_count] = (uint16_t)row_count;
    reading_offsets[key_count] = (uint16_t)reading_posting_count;
    for (uint32_t key = sequence_key_count; key > 0u; --key) {
        sequence_offsets[key] = sequence_offsets[key - 1u];
    }
    sequence_offsets[0] = 0u;
    return (int32_t)output_length;
}

__attribute__((visibility("default")))
int32_t encode_term_content_token_binary_dedup(
    uint32_t json_ptr,
    uint32_t metas_ptr,
    uint32_t row_count,
    uint32_t out_ptr,
    uint32_t out_capacity,
    uint32_t row_meta_ptr,
    uint32_t hash_table_ptr,
    uint32_t hash_table_size,
    uint32_t unique_indexes_ptr,
    uint32_t unique_count_ptr
) {
    if (
        json_ptr == 0u ||
        metas_ptr == 0u ||
        out_ptr == 0u ||
        row_meta_ptr == 0u ||
        hash_table_ptr == 0u ||
        unique_indexes_ptr == 0u ||
        unique_count_ptr == 0u ||
        hash_table_size == 0u ||
        (hash_table_size & (hash_table_size - 1u)) != 0u
    ) {
        return -1;
    }
    const uint8_t* src = (const uint8_t*)(uintptr_t)json_ptr;
    const TermRowMeta* rows = (const TermRowMeta*)(uintptr_t)metas_ptr;
    uint8_t* out = (uint8_t*)(uintptr_t)out_ptr;
    uint32_t* row_meta = (uint32_t*)(uintptr_t)row_meta_ptr;
    uint32_t* hash_table = (uint32_t*)(uintptr_t)hash_table_ptr;
    uint32_t* unique_indexes = (uint32_t*)(uintptr_t)unique_indexes_ptr;
    uint32_t cursor = 0u;
    uint32_t unique_count = 0u;
    const uint32_t table_mask = hash_table_size - 1u;
    last_content_capacity = out_capacity;

    for (uint32_t row = 0u; row < row_count; ++row) {
        const uint32_t row_offset = row * 4u;
        const uint32_t start = cursor;
        uint32_t hash1 = 0u;
        uint32_t hash2 = 0u;
        while (!encode_term_content_token_binary_row(
            src,
            &rows[row],
            out,
            out_capacity,
            &cursor,
            &hash1,
            &hash2,
            0u,
            0
        )) {
            cursor = start;
            if (!grow_content_buffer(out_ptr, out_capacity, &out_capacity)) { return -2; }
        }
        const uint32_t length = cursor - start;
        uint32_t mixed = hash1 ^ (hash2 * 0x9e3779b1u);
        mixed ^= mixed >> 16u;
        uint32_t slot = mixed & table_mask;
        uint32_t matched_row = 0xffffffffu;

        for (uint32_t probes = 0u; probes < hash_table_size; ++probes) {
            const uint32_t stored = hash_table[slot];
            if (stored == 0u) { break; }
            const uint32_t candidate_row = stored - 1u;
            if (candidate_row >= row) { return -3; }
            const uint32_t candidate_row_offset = candidate_row * 4u;
            if (
                row_meta[candidate_row_offset + 2u] == hash1 &&
                row_meta[candidate_row_offset + 3u] == hash2 &&
                row_meta[candidate_row_offset + 1u] == length &&
                content_bytes_equal(
                    out,
                    row_meta[candidate_row_offset + 0u],
                    start,
                    length
                )
            ) {
                matched_row = candidate_row;
                break;
            }
            slot = (slot + 1u) & table_mask;
        }

        if (matched_row != 0xffffffffu) {
            const uint32_t canonical_row_offset = matched_row * 4u;
            row_meta[row_offset + 0u] = row_meta[canonical_row_offset + 0u];
            row_meta[row_offset + 1u] = length;
            row_meta[row_offset + 2u] = hash1;
            row_meta[row_offset + 3u] = hash2;
            unique_indexes[row] = unique_indexes[matched_row];
            cursor = start;
        } else {
            if (hash_table[slot] != 0u || unique_count == 0xffffffffu) { return -3; }
            row_meta[row_offset + 0u] = start;
            row_meta[row_offset + 1u] = length;
            row_meta[row_offset + 2u] = hash1;
            row_meta[row_offset + 3u] = hash2;
            unique_indexes[row] = unique_count;
            hash_table[slot] = row + 1u;
            ++unique_count;
        }
    }
    *(uint32_t*)(uintptr_t)unique_count_ptr = unique_count;
    return (int32_t)cursor;
}

__attribute__((visibility("default")))
int32_t parse_and_encode_term_bank_token_binary_dedup(
    uint32_t json_ptr,
    uint32_t json_len,
    uint32_t metas_ptr,
    uint32_t metas_capacity,
    uint32_t out_ptr,
    uint32_t out_capacity,
    uint32_t row_meta_ptr,
    uint32_t hash_table_ptr,
    uint32_t hash_table_size,
    uint32_t unique_indexes_ptr,
    uint32_t unique_count_ptr,
    uint32_t unique_signatures_ptr,
    uint32_t row_count_ptr,
    uint32_t strings_ptr,
    uint32_t strings_capacity,
    uint32_t string_lengths_ptr,
    uint32_t string_offsets_ptr,
    uint32_t string_hashes_ptr,
    uint32_t expression_indexes_ptr,
    uint32_t reading_indexes_ptr,
    uint32_t string_hash_table_ptr,
    uint32_t string_hash_table_size,
    uint32_t string_unique_count_ptr,
    uint32_t string_bytes_count_ptr,
    uint32_t reading_equals_ptr,
    uint32_t scores_ptr,
    uint32_t sequences_ptr,
    uint32_t recent_content_hits_ptr,
    uint32_t media_hints,
    uint32_t experiment_mask,
    uint32_t bank_spans_ptr,
    uint32_t bank_count,
    uint32_t experiment_stats_ptr,
    uint32_t raw_content_hash_table_ptr,
    uint32_t raw_content_hash_table_size,
    uint32_t raw_content_hashes_ptr
) {
    if (
        json_ptr == 0u || json_len == 0u || metas_ptr == 0u || metas_capacity == 0u ||
        out_ptr == 0u || row_meta_ptr == 0u || hash_table_ptr == 0u ||
        unique_indexes_ptr == 0u || unique_count_ptr == 0u || unique_signatures_ptr == 0u || row_count_ptr == 0u ||
        strings_ptr == 0u || string_lengths_ptr == 0u || string_offsets_ptr == 0u ||
        string_hashes_ptr == 0u || expression_indexes_ptr == 0u || reading_indexes_ptr == 0u ||
        string_hash_table_ptr == 0u || string_unique_count_ptr == 0u || string_bytes_count_ptr == 0u ||
        reading_equals_ptr == 0u || scores_ptr == 0u || sequences_ptr == 0u ||
        recent_content_hits_ptr == 0u ||
        hash_table_size == 0u || (hash_table_size & (hash_table_size - 1u)) != 0u ||
        string_hash_table_size == 0u || (string_hash_table_size & (string_hash_table_size - 1u)) != 0u
    ) {
        return -1;
    }
    if (((bank_spans_ptr == 0u) != (bank_count == 0u)) ||
        (bank_count != 0u && (experiment_mask & EXPERIMENT_BANK_SPANS) == 0u)) { return -1; }
    if ((experiment_mask & EXPERIMENT_GLOBAL_EXACT_CONTENT_REUSE) != 0u && (
        raw_content_hash_table_ptr == 0u ||
        raw_content_hashes_ptr == 0u ||
        raw_content_hash_table_size == 0u ||
        (raw_content_hash_table_size & (raw_content_hash_table_size - 1u)) != 0u
    )) { return -1; }
    uint32_t* experiment_stats = (uint32_t*)(uintptr_t)experiment_stats_ptr;
    if (experiment_stats != 0) {
        for (uint32_t i = 0u; i < 5u; ++i) { experiment_stats[i] = 0u; }
    }
    const uint8_t* src = (const uint8_t*)(uintptr_t)json_ptr;
    TermRowMeta* rows = (TermRowMeta*)(uintptr_t)metas_ptr;
    uint8_t* out = (uint8_t*)(uintptr_t)out_ptr;
    uint32_t* row_meta = (uint32_t*)(uintptr_t)row_meta_ptr;
    uint32_t* hash_table = (uint32_t*)(uintptr_t)hash_table_ptr;
    uint32_t* raw_content_hash_table = (uint32_t*)(uintptr_t)raw_content_hash_table_ptr;
    uint32_t* raw_content_hashes = (uint32_t*)(uintptr_t)raw_content_hashes_ptr;
    uint32_t* unique_indexes = (uint32_t*)(uintptr_t)unique_indexes_ptr;
    uint32_t* unique_signatures = (uint32_t*)(uintptr_t)unique_signatures_ptr;
    uint8_t* strings = (uint8_t*)(uintptr_t)strings_ptr;
    uint16_t* string_lengths = (uint16_t*)(uintptr_t)string_lengths_ptr;
    uint32_t* string_offsets = (uint32_t*)(uintptr_t)string_offsets_ptr;
    uint32_t* string_hashes = (uint32_t*)(uintptr_t)string_hashes_ptr;
    uint32_t* expression_indexes = (uint32_t*)(uintptr_t)expression_indexes_ptr;
    uint32_t* reading_indexes = (uint32_t*)(uintptr_t)reading_indexes_ptr;
    uint32_t* string_hash_table = (uint32_t*)(uintptr_t)string_hash_table_ptr;
    uint8_t* reading_equals = (uint8_t*)(uintptr_t)reading_equals_ptr;
    int32_t* scores = (int32_t*)(uintptr_t)scores_ptr;
    int32_t* sequences = (int32_t*)(uintptr_t)sequences_ptr;
    uint32_t cursor = 0u;
    uint32_t unique_count = 0u;
    uint32_t string_unique_count = 0u;
    uint32_t strings_cursor = 0u;
    uint32_t row_count = 0u;
    uint32_t recent_content_hits = 0u;
#if RECENT_CONTENT_DEDUP_WINDOW > 0
    uint32_t recent_content_signatures[RECENT_CONTENT_DEDUP_WINDOW];
#endif
    const uint32_t table_mask = hash_table_size - 1u;
    const uint32_t raw_content_table_mask = raw_content_hash_table_size > 0u ? raw_content_hash_table_size - 1u : 0u;
    const uint32_t string_table_mask = string_hash_table_size - 1u;
    last_parse_capacity = metas_capacity;
    last_content_capacity = out_capacity;

    TermBankCursor source = {src, (const uint32_t*)(uintptr_t)bank_spans_ptr,
        json_len, bank_count == 0u ? 1u : bank_count, 0u, 0u, 0u};
    int status = next_term_bank(&source);
    while (status > 0) {
        if (row_count >= metas_capacity) {
            *(uint32_t*)(uintptr_t)row_count_ptr = row_count;
            return -4;
        }
        uint32_t row_end = 0u;
        uint32_t glossary_witness = 0xffffffffu;
        if (!parse_row_single_pass(src, source.end, source.position, &rows[row_count], media_hints != 0u, &row_end,
                rows, row_count, (experiment_mask & EXPERIMENT_VALIDATED_GLOSSARY_REUSE) != 0u ? &glossary_witness : 0)) {
            return -1;
        }
        if (glossary_witness != 0xffffffffu && experiment_stats != 0) { ++experiment_stats[1]; }

        const TermRowMeta* parsed_row = &rows[row_count];
        const uint32_t token_starts[2] = {
            parsed_row->expression_start,
            parsed_row->reading_start,
        };
        const uint32_t token_lengths[2] = {
            parsed_row->expression_length,
            parsed_row->reading_length,
        };
        uint32_t string_indexes[2] = {0u, 0u};
        int reading_equals_expression = (
            token_lengths[1] == 2u &&
            src[token_starts[1]] == '"' &&
            src[token_starts[1] + 1u] == '"'
        );
        if (
            !reading_equals_expression &&
            token_lengths[0] == token_lengths[1] &&
            content_bytes_equal_between(
                src,
                token_starts[0],
                src,
                token_starts[1],
                token_lengths[0]
            )
        ) {
            reading_equals_expression = 1;
        }
        for (uint32_t field = 0u; field < 2u; ++field) {
            if (field == 1u && reading_equals_expression) {
                string_indexes[1] = string_indexes[0];
                continue;
            }
            const uint32_t token_start = token_starts[field];
            const uint32_t token_length = token_lengths[field];
            const uint8_t* value_source = src;
            uint32_t value_start = token_start + 1u;
            uint32_t value_length = token_length - 2u;
            if (json_string_token_has_escape(src, token_start, token_length)) {
                if ((experiment_mask & EXPERIMENT_NATIVE_ESCAPED_KEYS) == 0u) { *(uint32_t*)(uintptr_t)row_count_ptr = row_count; return -5; }
                const int32_t decoded_length = decode_escaped_key(
                    src + token_start, token_length, strings + strings_cursor, strings_capacity - strings_cursor
                );
                if (decoded_length < 0) { *(uint32_t*)(uintptr_t)row_count_ptr = row_count; return -5; }
                value_source = strings;
                value_start = strings_cursor;
                value_length = (uint32_t)decoded_length;
                if (experiment_stats != 0) { ++experiment_stats[0]; }
            }
            if (value_length > MAX_INTERNED_KEY_BYTES) { *(uint32_t*)(uintptr_t)row_count_ptr = row_count; return -5; }
            const uint32_t string_hash = hash_content_xxh32(value_source + value_start, value_length, FNV1A_OFFSET);
            uint32_t string_slot = mix_string_hash(string_hash, value_length) & string_table_mask;
            uint32_t matched_index = 0xffffffffu;
            for (uint32_t probes = 0u; probes < string_hash_table_size; ++probes) {
                const uint32_t stored = string_hash_table[string_slot];
                if (stored == 0u) { break; }
                const uint32_t candidate = stored - 1u;
                if (candidate >= string_unique_count) { return -3; }
                if (
                    string_hashes[candidate] == string_hash &&
                    string_lengths[candidate] == value_length &&
                    content_bytes_equal_between(
                        strings,
                        string_offsets[candidate],
                        value_source,
                        value_start,
                        value_length
                    )
                ) {
                    matched_index = candidate;
                    break;
                }
                string_slot = (string_slot + 1u) & string_table_mask;
            }
            if (matched_index != 0xffffffffu) {
                string_indexes[field] = matched_index;
                continue;
            }
            if (
                string_unique_count >= metas_capacity * 2u ||
                string_hash_table[string_slot] != 0u ||
                strings_cursor + value_length > strings_capacity
            ) {
                *(uint32_t*)(uintptr_t)row_count_ptr = row_count; return -5;
            }
            if (value_source != strings) {
                __builtin_memcpy(strings + strings_cursor, value_source + value_start, value_length);
            }
            string_lengths[string_unique_count] = (uint16_t)value_length;
            string_offsets[string_unique_count] = strings_cursor;
            string_hashes[string_unique_count] = string_hash;
            string_hash_table[string_slot] = string_unique_count + 1u;
            string_indexes[field] = string_unique_count;
            strings_cursor += value_length;
            ++string_unique_count;
        }
        expression_indexes[row_count] = string_indexes[0];
        reading_indexes[row_count] = string_indexes[1];
        reading_equals[row_count] = reading_equals_expression ? 1u : 0u;
        uint32_t score_end = 0u;
        int32_t score = 0;
        if (
            !parse_scalar_span(src, source.end, parsed_row->score_start, &score_end) ||
            !parse_int32_token(src, parsed_row->score_start, score_end, 0, &score) ||
            // Integer storage cannot preserve a negative zero score. Use the
            // ordinary number-preserving path, even in otherwise integer banks.
            (score == 0 && src[parsed_row->score_start] == '-')
        ) {
            *(uint32_t*)(uintptr_t)row_count_ptr = row_count;
            return -5;
        }
        scores[row_count] = score;
        int32_t sequence = -1;
        if (parsed_row->sequence_start != 0xffffffffu) {
            uint32_t sequence_end = 0u;
            if (
                !parse_scalar_span(src, source.end, parsed_row->sequence_start, &sequence_end) ||
                !parse_int32_token(src, parsed_row->sequence_start, sequence_end, -1, &sequence)
            ) {
                *(uint32_t*)(uintptr_t)row_count_ptr = row_count;
                return -5;
            }
        }
        sequences[row_count] = sequence;

        const uint32_t row_offset = row_count * 4u;
        uint32_t recent_match = 0xffffffffu;
        if ((experiment_mask & EXPERIMENT_GLOBAL_EXACT_CONTENT_REUSE) != 0u) {
            const uint32_t raw_hash = raw_term_content_hash(src, parsed_row);
            raw_content_hashes[row_count] = raw_hash;
            uint32_t raw_slot = raw_hash & raw_content_table_mask;
            for (uint32_t probes = 0u; probes < raw_content_hash_table_size; ++probes) {
                const uint32_t stored = raw_content_hash_table[raw_slot];
                if (stored == 0u) {
                    raw_content_hash_table[raw_slot] = row_count + 1u;
                    break;
                }
                const uint32_t candidate = stored - 1u;
                if (candidate >= row_count) { return -3; }
                if (
                    raw_content_hashes[candidate] == raw_hash &&
                    raw_term_content_tokens_equal(src, parsed_row, &rows[candidate], candidate == glossary_witness)
                ) {
                    recent_match = candidate;
                    if (experiment_stats != 0) { ++experiment_stats[2]; }
                    break;
                }
                raw_slot = (raw_slot + 1u) & raw_content_table_mask;
            }
        } else {
#if RECENT_CONTENT_DEDUP_WINDOW > 0
            const uint32_t raw_content_signature = raw_term_content_quick_signature(src, parsed_row);
            const uint32_t recent_start = row_count > RECENT_CONTENT_DEDUP_WINDOW ?
                row_count - RECENT_CONTENT_DEDUP_WINDOW :
                0u;
            for (uint32_t candidate = row_count; candidate > recent_start;) {
                --candidate;
                if (
                    recent_content_signatures[candidate % RECENT_CONTENT_DEDUP_WINDOW] == raw_content_signature &&
                    raw_term_content_tokens_equal(src, parsed_row, &rows[candidate], candidate == glossary_witness)
                ) {
                    recent_match = candidate;
                    break;
                }
            }
            recent_content_signatures[row_count % RECENT_CONTENT_DEDUP_WINDOW] = raw_content_signature;
#endif
        }
        if (recent_match != 0xffffffffu) {
            const uint32_t canonical_offset = recent_match * 4u;
            row_meta[row_offset] = row_meta[canonical_offset];
            row_meta[row_offset + 1u] = row_meta[canonical_offset + 1u];
            row_meta[row_offset + 2u] = row_meta[canonical_offset + 2u];
            row_meta[row_offset + 3u] = row_meta[canonical_offset + 3u];
            unique_indexes[row_count] = unique_indexes[recent_match];
            ++recent_content_hits;
        } else {
            const uint32_t start = cursor;
            uint32_t hash1 = 0u;
            uint32_t hash2 = 0u;
            while (!encode_term_content_token_binary_row(
                src,
                &rows[row_count],
                out,
                out_capacity,
                &cursor,
                &hash1,
                &hash2,
                experiment_mask,
                experiment_stats
            )) {
                cursor = start;
                if (!grow_content_buffer(out_ptr, out_capacity, &out_capacity)) { return -2; }
            }
            const uint32_t length = cursor - start;
            uint32_t mixed = hash1 ^ (hash2 * 0x9e3779b1u);
            mixed ^= mixed >> 16u;
            uint32_t slot = mixed & table_mask;
            uint32_t matched_row = 0xffffffffu;
            for (uint32_t probes = 0u; probes < hash_table_size; ++probes) {
                const uint32_t stored = hash_table[slot];
                if (stored == 0u) { break; }
                const uint32_t candidate_row = stored - 1u;
                if (candidate_row >= row_count) { return -3; }
                const uint32_t candidate_offset = candidate_row * 4u;
                if (
                    row_meta[candidate_offset + 2u] == hash1 &&
                    row_meta[candidate_offset + 3u] == hash2 &&
                    row_meta[candidate_offset + 1u] == length &&
                    content_bytes_equal(out, row_meta[candidate_offset], start, length)
                ) {
                    matched_row = candidate_row;
                    break;
                }
                slot = (slot + 1u) & table_mask;
            }
            if (matched_row != 0xffffffffu) {
                const uint32_t canonical_offset = matched_row * 4u;
                row_meta[row_offset] = row_meta[canonical_offset];
                row_meta[row_offset + 1u] = length;
                row_meta[row_offset + 2u] = hash1;
                row_meta[row_offset + 3u] = hash2;
                unique_indexes[row_count] = unique_indexes[matched_row];
                cursor = start;
            } else {
                if (hash_table[slot] != 0u || unique_count == 0xffffffffu) { return -3; }
                row_meta[row_offset] = start;
                row_meta[row_offset + 1u] = length;
                row_meta[row_offset + 2u] = hash1;
                row_meta[row_offset + 3u] = hash2;
                unique_indexes[row_count] = unique_count;
                const uint32_t last_offset = length > 4u ? length - 4u : 0u;
                const uint32_t signature_offset = unique_count * 3u;
                unique_signatures[signature_offset] = read_content_signature(out + start, length, 0u);
                unique_signatures[signature_offset + 1u] = read_content_signature(out + start, length, last_offset / 2u);
                unique_signatures[signature_offset + 2u] = read_content_signature(out + start, length, last_offset);
                hash_table[slot] = row_count + 1u;
                ++unique_count;
            }
        }

        ++row_count;
        status = next_term_row(&source, row_end);
    }
    if (status < 0) { return -1; }
    *(uint32_t*)(uintptr_t)unique_count_ptr = unique_count;
    *(uint32_t*)(uintptr_t)row_count_ptr = row_count;
    *(uint32_t*)(uintptr_t)string_unique_count_ptr = string_unique_count;
    *(uint32_t*)(uintptr_t)string_bytes_count_ptr = strings_cursor;
    *(uint32_t*)(uintptr_t)recent_content_hits_ptr = recent_content_hits;
    return (int32_t)cursor;
}

/* Segment compaction consumes only parser-owned columns. Each call revalidates
 * the source arena and row references; the next call resets dirty remap scratch.
 * The caller reuses ONE segment arena rather than retaining per-run WASM slabs. */
__attribute__((visibility("default")))
int32_t compact_term_lookup_keys(
    uint32_t strings_ptr, uint32_t strings_length,
    uint32_t lengths_ptr, uint32_t offsets_ptr, uint32_t hashes_ptr, uint32_t key_count,
    uint32_t expressions_ptr, uint32_t readings_ptr, uint32_t equals_ptr, uint32_t row_count,
    uint32_t remap_ptr, uint32_t out_lengths_ptr, uint32_t out_offsets_ptr,
    uint32_t out_hashes_ptr, uint32_t out_expressions_ptr, uint32_t out_readings_ptr,
    uint32_t out_strings_ptr, uint32_t out_strings_capacity, uint32_t out_key_capacity,
    uint32_t info_ptr
) {
    if (row_count == 0u || row_count >= 0xffffu || key_count == 0u ||
        out_key_capacity >= 0xffffu || strings_ptr == 0u || lengths_ptr == 0u ||
        offsets_ptr == 0u || hashes_ptr == 0u || expressions_ptr == 0u || readings_ptr == 0u ||
        equals_ptr == 0u || remap_ptr == 0u || info_ptr == 0u ||
        out_lengths_ptr == 0u || out_offsets_ptr == 0u || out_hashes_ptr == 0u ||
        out_expressions_ptr == 0u || out_readings_ptr == 0u || out_strings_ptr == 0u ||
        key_count > UINT32_MAX / sizeof(uint32_t)) { return -1; }
    const uint8_t* strings = (const uint8_t*)(uintptr_t)strings_ptr;
    const uint16_t* lengths = (const uint16_t*)(uintptr_t)lengths_ptr;
    const uint32_t* offsets = (const uint32_t*)(uintptr_t)offsets_ptr;
    const uint32_t* hashes = (const uint32_t*)(uintptr_t)hashes_ptr;
    const uint32_t* expressions = (const uint32_t*)(uintptr_t)expressions_ptr;
    const uint32_t* readings = (const uint32_t*)(uintptr_t)readings_ptr;
    const uint8_t* equals = (const uint8_t*)(uintptr_t)equals_ptr;
    uint32_t* remap = (uint32_t*)(uintptr_t)remap_ptr;
    uint16_t* out_lengths = (uint16_t*)(uintptr_t)out_lengths_ptr;
    uint32_t* out_offsets = (uint32_t*)(uintptr_t)out_offsets_ptr;
    uint32_t* out_hashes = (uint32_t*)(uintptr_t)out_hashes_ptr;
    uint32_t* out_expressions = (uint32_t*)(uintptr_t)out_expressions_ptr;
    uint32_t* out_readings = (uint32_t*)(uintptr_t)out_readings_ptr;
    uint8_t* out_strings = (uint8_t*)(uintptr_t)out_strings_ptr;
    uint32_t* info = (uint32_t*)(uintptr_t)info_ptr;
    uint32_t expected = 0u;
    for (uint32_t key = 0u; key < key_count; ++key) {
        if (offsets[key] != expected || expected > strings_length || lengths[key] > strings_length - expected) { return -2; }
        expected += lengths[key];
    }
    if (expected != strings_length) { return -2; }
    memset(remap, 0, key_count * sizeof(uint32_t));
    uint32_t count = 0u, cursor = 0u;
    for (uint32_t row = 0u; row < row_count; ++row) {
        if (equals[row] > 1u) { return -3; }
        const uint32_t keys[2] = {expressions[row], equals[row] ? expressions[row] : readings[row]};
        for (uint32_t field = 0u; field < 2u; ++field) {
            const uint32_t key = keys[field];
            if (key >= key_count || lengths[key] == 0u) { return -3; }
            uint32_t mapped = remap[key];
            if (mapped == 0u) {
                if (count >= out_key_capacity || lengths[key] > out_strings_capacity - cursor) { return -4; }
                out_lengths[count] = lengths[key];
                out_offsets[count] = cursor;
                out_hashes[count] = hashes[key];
                __builtin_memcpy(out_strings + cursor, strings + offsets[key], lengths[key]);
                cursor += lengths[key];
                mapped = ++count;
                remap[key] = mapped;
            }
            if (field == 0u) { out_expressions[row] = mapped - 1u; }
            else { out_readings[row] = mapped - 1u; }
        }
    }
    info[0] = cursor;
    return (int32_t)count;
}
