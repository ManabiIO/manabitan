
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
