from pathlib import Path
import sys, hashlib, json
p = Path('ext/js/dictionary/wasm/term-bank-parser.c')
s = p.read_text()
v = sys.argv[1]
def replace(a, b):
    global s
    assert s.count(a) == 1, (v, a[:90], s.count(a))
    s = s.replace(a, b)
if v == 'row-cursor':
    a = s.index('static int parse_row_single_pass(')
    b = s.index('\nstatic int is_null_token(', a)
    part = s[a:b]
    old = 'uint32_t i = row_start + 1u;'
    assert part.count(old) == 1
    part = part.replace(old, 'uint32_t i = skip_ws(src, len, row_start + 1u);')
    old = '        i = skip_ws(src, len, i);\n'
    assert part.count(old) == 1
    part = part.replace(old, '')
    s = s[:a] + part + s[b:]
elif v == 'state-tables':
    replace('''                state = OBJECT_COLON;
            } else if (state == OBJECT_VALUE) {
                state = OBJECT_AFTER_VALUE;
            } else if (state == ARRAY_FIRST || state == ARRAY_VALUE) {
                state = ARRAY_AFTER_VALUE;
            } else {
                return 0;
            }
            i = s_end;''', '''            }
            // States are internal and bounded; zero denotes an invalid transition.
            static const uint8_t STRING_NEXT[] = {2u, 0u, 2u, 5u, 0u, 7u, 0u, 5u};
            const uint8_t next = STRING_NEXT[state];
            if (next == 0u) { return 0; }
            state = next - 1u;
            i = s_end;''')
    replace('''        uint8_t next_state;
        if (state == ARRAY_FIRST || state == ARRAY_VALUE) { next_state = ARRAY_AFTER_VALUE; }
        else if (state == OBJECT_VALUE) { next_state = OBJECT_AFTER_VALUE; }
        else { return 0; }''', '''        static const uint8_t VALUE_NEXT[] = {2u, 0u, 2u, 0u, 0u, 7u, 0u, 0u};
        const uint8_t next = VALUE_NEXT[state];
        if (next == 0u) { return 0; }
        const uint8_t next_state = next - 1u;''')
elif v == 'scalar-once':
    a = s.index('static int parse_scalar_span(const uint8_t* src, uint32_t len, uint32_t start, uint32_t* out_end) {')
    b = s.index('\nstatic int parse_value_span(', a)
    s = s[:a] + '''static int parse_scalar_span(const uint8_t* src, uint32_t len, uint32_t start, uint32_t* out_end) {
    if (start >= len) { return 0; }
    uint32_t i = start;
    const uint8_t first = src[i];
    if (first == 't' || first == 'f' || first == 'n') {
        const char* token = first == 't' ? "true" : first == 'f' ? "false" : "null";
        const uint32_t length = first == 'f' ? 5u : 4u;
        if (length > len - i) { return 0; }
        for (uint32_t j = 0u; j < length; ++j) {
            if (src[i + j] != (uint8_t)token[j]) { return 0; }
        }
        i += length;
    } else {
        if (src[i] == '-') { ++i; }
        if (i >= len) { return 0; }
        if (src[i] == '0') {
            ++i;
        } else {
            if (src[i] < '1' || src[i] > '9') { return 0; }
            do { ++i; } while (i < len && src[i] >= '0' && src[i] <= '9');
        }
        if (i < len && src[i] == '.') {
            const uint32_t digits = ++i;
            while (i < len && src[i] >= '0' && src[i] <= '9') { ++i; }
            if (i == digits) { return 0; }
        }
        if (i < len && (src[i] == 'e' || src[i] == 'E')) {
            ++i;
            if (i < len && (src[i] == '+' || src[i] == '-')) { ++i; }
            const uint32_t digits = i;
            while (i < len && src[i] >= '0' && src[i] <= '9') { ++i; }
            if (i == digits) { return 0; }
        }
    }
    // A valid prefix is insufficient: retain the original token boundary.
    if (i < len && src[i] != ',' && src[i] != ']' && src[i] != '}' && !is_ws(src[i])) { return 0; }
    *out_end = i;
    return 1;
}
''' + s[b:]
elif v == 'row-unrolled':
    a = s.index('static int parse_row_single_pass(')
    b = s.index('\nstatic int is_null_token(', a)
    signature = s[a:s.index(') {', a) + 3]
    body = '''
    if (row_start >= len || src[row_start] != '[') { return 0; }
    clear_term_row_meta(out_meta);
    uint32_t i = skip_ws(src, len, row_start + 1u);
    uint32_t value_end = 0u;
    if (i >= len || src[i] == ']') { return 0; }

#define NEXT_FIELD() do { \\
    i = skip_ws(src, len, value_end); \\
    if (i >= len) { return 0; } \\
    if (src[i] == ']') { \\
        *out_next = i + 1u; \\
        return out_meta->expression_length > 0u; \\
    } \\
    if (src[i] != ',') { return 0; } \\
    i = skip_ws(src, len, i + 1u); \\
    if (i >= len || src[i] == ']') { return 0; } \\
} while (0)

'''
    for field in range(8):
        if field in (4, 6):
            name = 'score' if field == 4 else 'sequence'
            default = '0' if field == 4 else '-1'
            body += f'''    if (!scan_scalar_span(src, len, i, &value_end) ||
        !parse_int32_token(src, i, value_end, {default}, &out_meta->{name})) {{ return 0; }}
'''
        elif field == 5:
            body += '''    if (!(glossary_witness != 0 && reuse_validated_glossary(
            src, len, i, prior_rows, prior_count, out_meta, &value_end, glossary_witness
        )) && !parse_value_span_with_glossary_hints(src, len, i, &value_end,
            media_hints ? &out_meta->glossary_may_contain_media : 0,
            &out_meta->glossary_requires_normalization,
            &out_meta->glossary_requires_text_normalization)) { return 0; }
    out_meta->glossary_start = i;
    out_meta->glossary_length = value_end - i;
'''
        else:
            name = {0: 'expression', 1: 'reading', 2: 'definition_tags', 3: 'rules', 7: 'term_tags'}[field]
            body += f'''    if (!parse_value_span(src, len, i, &value_end)) {{ return 0; }}
    out_meta->{name}_start = i;
    out_meta->{name}_length = value_end - i;
'''
        body += '    NEXT_FIELD();\n\n'
    body += '''    // Extra fields are still parsed and validated, though not stored.
    while (i < len) {
        if (!parse_value_span(src, len, i, &value_end)) { return 0; }
        NEXT_FIELD();
    }
#undef NEXT_FIELD
    return 0;
}
'''
    s = s[:a] + signature + body + s[b:]
else:
    raise ValueError(v)
p.write_text(s)
print(json.dumps({'source': str(p), 'sha256': hashlib.sha256(s.encode()).hexdigest()}))
