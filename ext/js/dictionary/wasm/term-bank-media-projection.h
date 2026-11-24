/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

#ifndef TERM_BANK_MEDIA_PROJECTION_H
#define TERM_BANK_MEDIA_PROJECTION_H

/* Included after the bounded JSON scanners. Projection never replaces source
 * validation. It produces only quoted path spans; JavaScript retains string
 * decoding and the supported-image-extension policy. */
typedef struct {
    const uint8_t* source;
    uint32_t* paths;
    uint32_t capacity;
    uint32_t count;
} MediaProjection;

static int media_projection_value(
    MediaProjection* projection, uint32_t start, uint32_t limit,
    uint32_t depth, int structured, uint32_t* out_end
);

static int media_projection_array(
    MediaProjection* projection, uint32_t start, uint32_t limit,
    uint32_t depth, int structured, uint32_t* out_end
) {
    if (depth > MAX_JSON_NESTING || start >= limit || projection->source[start] != '[') { return 0; }
    const uint8_t* source = projection->source;
    uint32_t cursor = skip_ws(source, limit, start + 1u);
    if (cursor < limit && source[cursor] == ']') {
        *out_end = cursor + 1u;
        return 1;
    }
    for (;;) {
        uint32_t value_end;
        if (!media_projection_value(projection, cursor, limit, depth + 1u, structured, &value_end)) { return 0; }
        cursor = skip_ws(source, limit, value_end);
        if (cursor >= limit) { return 0; }
        if (source[cursor] == ']') {
            *out_end = cursor + 1u;
            return 1;
        }
        if (source[cursor] != ',') { return 0; }
        cursor = skip_ws(source, limit, cursor + 1u);
    }
}

static int media_projection_object(
    MediaProjection* projection, uint32_t start, uint32_t limit,
    uint32_t depth, int structured, uint32_t* out_end
) {
    if (depth > MAX_JSON_NESTING) { return 0; }
    const uint8_t* source = projection->source;
    const uint32_t first_path = projection->count;
    uint32_t kind = 0u;
    uint32_t path_start = 0u;
    uint32_t path_length = 0u;
    uint32_t cursor = skip_ws(source, limit, start + 1u);
    if (cursor < limit && source[cursor] == '}') {
        *out_end = cursor + 1u;
        return 1;
    }
    for (;;) {
        uint32_t key_end;
        uint32_t key_has_escape;
        if (!parse_string_span_with_escape(source, limit, cursor, &key_end, &key_has_escape) || key_has_escape != 0u) {
            /* A decoded key can alias a prior literal property. Decline the
             * entire glossary, not just this object or the remaining suffix. */
            return 0;
        }
        const int is_kind = structured ?
            json_string_matches_ascii(source, cursor, key_end, "tag", 3u) :
            json_string_matches_ascii(source, cursor, key_end, "type", 4u);
        const int is_path = json_string_matches_ascii(source, cursor, key_end, "path", 4u);
        const int is_content = json_string_matches_ascii(source, cursor, key_end, "content", 7u);
        cursor = skip_ws(source, limit, key_end);
        if (cursor >= limit || source[cursor] != ':') { return 0; }
        cursor = skip_ws(source, limit, cursor + 1u);
        uint32_t value_end;
        if (is_content) {
            /* Only the last content property survives JSON.parse. Children
             * are provisional until the final type/tag is known, so they can
             * be discarded without allocating or rescanning their objects. */
            projection->count = first_path;
            if (!media_projection_value(projection, cursor, limit, depth + 1u, 1, &value_end)) { return 0; }
        } else {
            if (!parse_value_span(source, limit, cursor, &value_end)) { return 0; }
            if (is_kind) {
                kind = structured ?
                    (json_string_matches_ascii(source, cursor, value_end, "img", 3u) ? 1u : 0u) :
                    (json_string_matches_ascii(source, cursor, value_end, "image", 5u) ? 1u :
                        (json_string_matches_ascii(source, cursor, value_end, "structured-content", 18u) ? 2u : 0u));
            } else if (is_path) {
                path_start = cursor;
                path_length = source[cursor] == '"' ? value_end - cursor : 0u;
            }
        }
        cursor = skip_ws(source, limit, value_end);
        if (cursor >= limit) { return 0; }
        if (source[cursor] == '}') {
            if (kind == 1u) {
                /* Image nodes never traverse their content, including when
                 * the last path is absent or has a nonstring value. */
                projection->count = first_path;
                if (path_length != 0u) {
                    if (projection->count >= projection->capacity) { return 0; }
                    projection->paths[projection->count * 2u] = path_start;
                    projection->paths[projection->count * 2u + 1u] = path_length;
                    ++projection->count;
                }
            } else if (!structured && kind != 2u) {
                projection->count = first_path;
            }
            *out_end = cursor + 1u;
            return 1;
        }
        if (source[cursor] != ',') { return 0; }
        cursor = skip_ws(source, limit, cursor + 1u);
    }
}

static int media_projection_value(
    MediaProjection* projection, uint32_t start, uint32_t limit,
    uint32_t depth, int structured, uint32_t* out_end
) {
    if (start >= limit) { return 0; }
    if (projection->source[start] == '{') {
        return media_projection_object(projection, start, limit, depth, structured, out_end);
    }
    if (structured && projection->source[start] == '[') {
        return media_projection_array(projection, start, limit, depth, 1, out_end);
    }
    /* Top-level nested arrays are not glossary image objects. Unrelated
     * values and object properties still receive bounded JSON validation. */
    return parse_value_span(projection->source, limit, start, out_end);
}

static int media_projection_ranges_overlap(uint32_t first, uint64_t first_length, uint32_t second, uint64_t second_length) {
    return first_length != 0u && second_length != 0u &&
        (uint64_t)first < (uint64_t)second + second_length &&
        (uint64_t)second < (uint64_t)first + first_length;
}

/* Each input/result is a pair of uint32 values. Results contain a first path
 * and count, or UINT32_MAX for a complete JavaScript fallback. Failed rows
 * roll back all provisional spans before another row uses the output arena.
 * The caller lends retired lookup scratch only during one synchronous copy. */
__attribute__((visibility("default")))
int32_t project_term_media_paths(
    uint32_t source_ptr, uint32_t source_length,
    uint32_t inputs_ptr, uint32_t count,
    uint32_t results_ptr, uint32_t paths_ptr, uint32_t path_capacity
) {
    const uint64_t memory_length = (uint64_t)__builtin_wasm_memory_size(0) * 65536u;
    const uint64_t row_bytes = (uint64_t)count * 8u;
    const uint64_t path_bytes = (uint64_t)path_capacity * 8u;
    if (source_ptr == 0u || inputs_ptr == 0u || results_ptr == 0u || paths_ptr == 0u ||
        count == 0u || path_capacity > 0x7fffffffu ||
        ((inputs_ptr | results_ptr | paths_ptr) & 3u) != 0u ||
        (uint64_t)source_ptr + source_length > memory_length ||
        (uint64_t)inputs_ptr + row_bytes > memory_length ||
        (uint64_t)results_ptr + row_bytes > memory_length ||
        (uint64_t)paths_ptr + path_bytes > memory_length ||
        media_projection_ranges_overlap(source_ptr, source_length, inputs_ptr, row_bytes) ||
        media_projection_ranges_overlap(source_ptr, source_length, results_ptr, row_bytes) ||
        media_projection_ranges_overlap(source_ptr, source_length, paths_ptr, path_bytes) ||
        media_projection_ranges_overlap(inputs_ptr, row_bytes, results_ptr, row_bytes) ||
        media_projection_ranges_overlap(inputs_ptr, row_bytes, paths_ptr, path_bytes) ||
        media_projection_ranges_overlap(results_ptr, row_bytes, paths_ptr, path_bytes)) { return -1; }
    const uint8_t* source = (const uint8_t*)(uintptr_t)source_ptr;
    const uint32_t* inputs = (const uint32_t*)(uintptr_t)inputs_ptr;
    uint32_t* results = (uint32_t*)(uintptr_t)results_ptr;
    MediaProjection projection = {source, (uint32_t*)(uintptr_t)paths_ptr, path_capacity, 0u};
    for (uint32_t row = 0u; row < count; ++row) {
        const uint32_t start = inputs[row * 2u];
        const uint32_t length = inputs[row * 2u + 1u];
        const uint32_t first_path = projection.count;
        uint32_t end;
        if (start > source_length || length > source_length - start ||
            !media_projection_array(&projection, start, start + length, 1u, 0, &end) ||
            skip_ws(source, start + length, end) != start + length) {
            projection.count = first_path;
            results[row * 2u] = 0u;
            results[row * 2u + 1u] = UINT32_MAX;
        } else {
            results[row * 2u] = first_path;
            results[row * 2u + 1u] = projection.count - first_path;
        }
    }
    return (int32_t)projection.count;
}

#endif
