/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/* Projection is bounded independently of the complete JSON parser. A large
 * or deeply nested glossary keeps the established JavaScript collector. The
 * static spans are consumed synchronously before another projection call. */
#define MAX_PROJECTED_IMAGE_PATHS 32u
#define MAX_IMAGE_PROJECTION_DEPTH 32u
#define MAX_IMAGE_PROJECTION_BYTES 65536u
static uint32_t projected_image_paths[1u + MAX_PROJECTED_IMAGE_PATHS * 2u];

typedef struct {
    uint32_t start;
    uint32_t end;
} ImageProjectionSpan;

static int project_image_value(
    const uint8_t* src, uint32_t start, uint32_t end, uint32_t depth,
    int glossary_item, uint32_t* count
);

static int project_image_array(
    const uint8_t* src, uint32_t start, uint32_t end, uint32_t depth,
    int glossary_items, uint32_t* count
) {
    uint32_t i = skip_ws(src, end, start + 1u);
    if (i < end && src[i] == ']') { return i + 1u == end; }
    while (i < end) {
        uint32_t value_end;
        if (!parse_value_span(src, end, i, &value_end) ||
            !project_image_value(src, i, value_end, depth + 1u, glossary_items, count)) { return 0; }
        i = skip_ws(src, end, value_end);
        if (i >= end) { return 0; }
        if (src[i] == ']') { return i + 1u == end; }
        if (src[i] != ',') { return 0; }
        i = skip_ws(src, end, i + 1u);
        if (i >= end || src[i] == ']') { return 0; }
    }
    return 0;
}

static int project_image_object(
    const uint8_t* src, uint32_t start, uint32_t end, uint32_t depth,
    int glossary_item, uint32_t* count
) {
    ImageProjectionSpan kind = {0u, 0u};
    ImageProjectionSpan path = {0u, 0u};
    ImageProjectionSpan content = {0u, 0u};
    uint32_t i = skip_ws(src, end, start + 1u);
    if (i < end && src[i] == '}') { return i + 1u == end; }
    while (i < end) {
        uint32_t key_end;
        if (!parse_string_span(src, end, i, &key_end)) { return 0; }
        ImageProjectionSpan* target =
            json_string_matches_ascii(src, i, key_end, glossary_item ? "type" : "tag", glossary_item ? 4u : 3u) ? &kind :
            json_string_matches_ascii(src, i, key_end, "path", 4u) ? &path :
            json_string_matches_ascii(src, i, key_end, "content", 7u) ? &content : 0;
        i = skip_ws(src, end, key_end);
        if (i >= end || src[i] != ':') { return 0; }
        i = skip_ws(src, end, i + 1u);
        uint32_t value_end;
        if (!parse_value_span(src, end, i, &value_end)) { return 0; }
        /* Remember the final value, including a nonstring/null overwrite.
         * Descending only after object close matches JSON.parse duplicate keys. */
        if (target != 0) { target->start = i; target->end = value_end; }
        i = skip_ws(src, end, value_end);
        if (i >= end) { return 0; }
        if (src[i] == '}') {
            if (i + 1u != end) { return 0; }
            break;
        }
        if (src[i] != ',') { return 0; }
        i = skip_ws(src, end, i + 1u);
        if (i >= end || src[i] == '}') { return 0; }
    }
    if (i >= end) { return 0; }
    const int image = json_string_matches_ascii(src, kind.start, kind.end,
        glossary_item ? "image" : "img", glossary_item ? 5u : 3u);
    if (image) {
        if (path.start < path.end && src[path.start] == '"') {
            if (*count >= MAX_PROJECTED_IMAGE_PATHS) { return 0; }
            projected_image_paths[1u + *count * 2u] = path.start;
            projected_image_paths[2u + *count * 2u] = path.end - path.start;
            ++*count;
        }
        /* Image nodes do not recurse through content, even without a path. */
        return 1;
    }
    if (content.start < content.end && (!glossary_item ||
        json_string_matches_ascii(src, kind.start, kind.end, "structured-content", 18u))) {
        return project_image_value(src, content.start, content.end, depth + 1u, 0, count);
    }
    return 1;
}

static int project_image_value(
    const uint8_t* src, uint32_t start, uint32_t end, uint32_t depth,
    int glossary_item, uint32_t* count
) {
    if (depth > MAX_IMAGE_PROJECTION_DEPTH || start >= end) { return 0; }
    if (src[start] == '{') { return project_image_object(src, start, end, depth, glossary_item, count); }
    if (!glossary_item && src[start] == '[') { return project_image_array(src, start, end, depth, 0, count); }
    return 1;
}

/* Every value is bounded and validated by the existing JSON span parser.
 * This remains safe if a caller changes its borrowed glossary before copying.
 * UINT32_MAX means no projection is usable; partial spans must be discarded. */
uint32_t project_term_glossary_image_paths(uint32_t json_ptr, uint32_t json_len) {
    projected_image_paths[0] = UINT32_MAX;
    const uint64_t memory_length = (uint64_t)__builtin_wasm_memory_size(0) * WASM_PAGE_SIZE;
    if (json_len == 0u || json_len > MAX_IMAGE_PROJECTION_BYTES ||
        (uint64_t)json_ptr + json_len > memory_length) { return (uint32_t)(uintptr_t)projected_image_paths; }
    const uint8_t* src = (const uint8_t*)(uintptr_t)json_ptr;
    const uint32_t start = skip_ws(src, json_len, 0u);
    uint32_t end = json_len;
    while (end > start && is_ws(src[end - 1u])) { --end; }
    uint32_t count = 0u;
    if (start < end && src[start] == '[' && project_image_array(src, start, end, 0u, 1, &count)) {
        projected_image_paths[0] = count;
    }
    return (uint32_t)(uintptr_t)projected_image_paths;
}
