from pathlib import Path
import sys, json, hashlib
p = Path('ext/js/dictionary/wasm/term-bank-parser.c')
s = p.read_text()
variant = sys.argv[1]
a = s.index('static int parse_composite_span_impl(')
b = s.index('\nstatic int parse_composite_span(', a)
t = s[a:b]
def change(old, new):
    global t
    assert t.count(old) == 1, (variant, old[:60], t.count(old))
    t = t.replace(old, new)
if variant == 'string-prefix':
    change('''    uint32_t i = start + 1u;
    while (i < len) {''', '''    uint32_t i = start + 1u;
    // Consume a root array's string prefix without the general state dispatch.
    // Mixed arrays resume at their first unconsumed value, without rescanning.
    if (src[start] == '[') {
        while (i < len && src[i] == '"') {
            if (media_hint != 0 && *media_hint == 0u && is_media_marker_at(src, len, i)) {
                *media_hint = 1u;
            }
            uint32_t end = 0u;
            if (!parse_string_span(src, len, i, &end)) { return 0; }
            i = skip_ws(src, len, end);
            if (i != end && normalization_hint != 0) { *normalization_hint = 1u; }
            if (i >= len) { return 0; }
            if (src[i] == ']') { *out_end = i + 1u; return 1; }
            if (src[i] != ',') { return 0; }
            end = i + 1u;
            i = skip_ws(src, len, end);
            if (i != end && normalization_hint != 0) { *normalization_hint = 1u; }
            state = ARRAY_VALUE;
        }
    }
    while (i < len) {''')
elif variant == 'local-hints':
    change('''    uint32_t i = start + 1u;
    while (i < len) {''', '''    uint32_t i = start + 1u;
    int need_media = media_hint != 0 && *media_hint == 0u;
    int need_normalization = normalization_hint != 0 && *normalization_hint == 0u;
    int need_text = text_normalization_hint != 0 && *text_normalization_hint == 0u;
    while (i < len) {''')
    change('''            if (normalization_hint != 0 && *normalization_hint == 0u) {
                *normalization_hint = 1u;
            }''', '''            if (need_normalization) {
                *normalization_hint = 1u;
                need_normalization = 0;
            }''')
    change('''            if (media_hint != 0 && *media_hint == 0u && is_media_marker_at(src, len, i)) {
                *media_hint = 1u;
            }''', '''            if (need_media && is_media_marker_at(src, len, i)) {
                *media_hint = 1u;
                need_media = 0;
            }''')
    change('''                        (normalization_hint != 0 && *normalization_hint == 0u) ||
                        (text_normalization_hint != 0 && *text_normalization_hint == 0u)''', '''                        need_normalization || need_text''')
    change('''                    if (text_normalization_hint != 0) { *text_normalization_hint = 1u; }
''', '''                    if (text_normalization_hint != 0) { *text_normalization_hint = 1u; }
                    need_normalization = 0;
                    need_text = 0;
''')
elif variant == 'composite-switch':
    change('''        if (is_ws(c)) {''', '''        switch (c) {
        case ' ': case '\\t': case '\\r': case '\\n': {''')
    change('''        if (c == '"') {''', '''        case '"': {''')
    change('''        if (c == ']' || c == '}') {''', '''        case ']': case '}': {''')
    change('''        if (c == ',') {''', '''        case ',': {''')
    change('''        if (c == ':') {''', '''        case ':': {''')
    change('''        uint8_t next_state;''', '''        default: break;
        }
        uint8_t next_state;''')
else:
    raise ValueError(variant)
s = s[:a] + t + s[b:]
p.write_text(s)
print(json.dumps({'source': str(p), 'sha256': hashlib.sha256(s.encode()).hexdigest()}))
