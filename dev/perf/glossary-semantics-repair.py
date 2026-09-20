from pathlib import Path
import hashlib

p = Path('ext/js/dictionary/wasm/term-bank-parser.c')
b = p.read_bytes()
assert hashlib.sha1(b'blob ' + str(len(b)).encode() + b'\0' + b).hexdigest() == '142a11b6c4a8fc3a0811c7c436fac361f69a1baf'
s = b.decode()
start = s.index('static int is_media_marker_at(')
end = s.index('static int scan_scalar_span(', start)
s = s[:start] + r'''static uint32_t key_hex4(const uint8_t* p);

/* Compare a short ASCII keyword without allocating or decoding an arbitrary
 * JSON string. Escapes and literal characters have the same field identity.
 * end is a logical token/bank boundary, never the size of the WASM heap. */
static int json_string_matches_ascii(
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

''' + s[end:]
start = s.index('static int token_equals_literal(')
end = s.index('static int glossary_text_object_try_extract_fast(', start)
s = s[:start] + r'''static int glossary_object_try_extract_text_value(
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

''' + s[end:]
start = s.index('static int glossary_text_object_try_extract_fast(')
end = s.index('/*\n * Fast path for', start)
part = s[start:end]
for name, value in [('KEY_TYPE', 'type'), ('KEY_TEXT', 'text'), ('VALUE_TEXT', 'text')]:
    part = part.replace(f'    static const uint8_t {name}[] = "\\"{value}\\"";\n', '')
part = part.replace('        const uint32_t key_length = key_end - key_start;\n', '')
part = part.replace('token_equals_literal(src, key_start, key_length, KEY_TYPE, sizeof(KEY_TYPE) - 1u)', 'json_string_matches_ascii(src, key_start, key_end, "type", 4u)')
part = part.replace('token_equals_literal(src, key_start, key_length, KEY_TEXT, sizeof(KEY_TEXT) - 1u)', 'json_string_matches_ascii(src, key_start, key_end, "text", 4u)')
part = part.replace('token_equals_literal(src, i, value_end - i, VALUE_TEXT, sizeof(VALUE_TEXT) - 1u)', 'json_string_matches_ascii(src, i, value_end, "text", 4u)')
s = s[:start] + part + s[end:]
p.write_text(s)

p = Path('ext/js/dictionary/dictionary-importer.js')
b = p.read_bytes()
assert hashlib.sha1(b'blob ' + str(len(b)).encode() + b'\0' + b).hexdigest() == 'f48d0a111c78f296809da477159f84b3f99190ec'
s = b.decode()
s = s.replace('    _tryAddFastMediaRequirementsFromGlossaryJson(glossaryJson, entry, requirements) {\n', "    _tryAddFastMediaRequirementsFromGlossaryJson(glossaryJson, entry, requirements) {\n        // Escaped property names require semantic traversal, not a partial path scan.\n        if (glossaryJson.includes('\\\\u')) { return false; }\n", 1)
s = s.replace('        for (let i = 0, ii = bytes.length - JSON_PATH_KEY_BYTES.length; i <= ii; ++i) {\n', '        for (let i = 0, ii = bytes.length - JSON_PATH_KEY_BYTES.length; i <= ii; ++i) {\n            // No caller-visible requirements have been added yet; discard partial results.\n            if (bytes[i] === 0x5c && bytes[i + 1] === 0x75) { return null; }\n', 1)
s = s.replace('    _glossaryJsonLikelyContainsMedia(glossaryJson) {\n', "    _glossaryJsonLikelyContainsMedia(glossaryJson) {\n        if (glossaryJson.includes('\\\\u')) { return true; }\n", 1)
s = s.replace('    _glossaryJsonLikelyContainsMediaFast(glossaryJson) {\n', "    _glossaryJsonLikelyContainsMediaFast(glossaryJson) {\n        if (glossaryJson.includes('\\\\u')) { return true; }\n", 1)
p.write_text(s)
