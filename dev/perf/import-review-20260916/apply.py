"""One isolated candidate against pinned production source; no generated files."""
from pathlib import Path
import hashlib
import json
import sys

p = Path('ext/js/dictionary/wasm/term-bank-parser.c')
s = original = p.read_text()
assert hashlib.sha256(p.read_bytes()).hexdigest() == '490d3e4a3f9c436e51bde32188e8bfe8cae2ee38a87b232263d651878973ca60'
variant = sys.argv[1]

def replace(old, new):
    global s
    assert s.count(old) == 1, old[:80]
    s = s.replace(old, new)

if variant == 'integer-guard':
    replace('    const uint32_t limit = negative ? 0x80000000u : 0x7fffffffu;',
        '    const uint32_t final_digit_limit = negative ? 8u : 7u;')
    replace('        if (value > (limit - digit) / 10u) { return 0; }', '''        /* Both signed limits have the same decimal quotient. Check before
         * multiplication so arbitrarily long input cannot wrap the accumulator. */
        if (value > 214748364u || (value == 214748364u && digit > final_digit_limit)) { return 0; }''')
elif variant == 'escape-words':
    replace('''    const uint32_t end = start + length - 1u;
    for (uint32_t i = start + 1u; i < end; ++i) {
        if (src[i] == '\\\\') { return 1; }
    }''', '''    const uint32_t end = start + length - 1u;
    uint32_t i = start + 1u;
    while (end - i >= 8u) {
        uint64_t word;
        __builtin_memcpy(&word, src + i, sizeof(word));
        if (has_zero_byte64(word ^ UINT64_C(0x5c5c5c5c5c5c5c5c)) != 0u) { return 1; }
        i += 8u;
    }
    for (; i < end; ++i) {
        if (src[i] == '\\\\') { return 1; }
    }''')
elif variant == 'equality-tail':
    for function, first, second in [
        ('content_bytes_equal', 'bytes + first_offset', 'bytes + second_offset'),
        ('content_bytes_equal_between', 'first_bytes + first_offset', 'second_bytes + second_offset'),
    ]:
        start = s.index('static int ' + function + '(\n')
        end = s.index('\n}\n', start) + 2
        old = s[start:end]
        body = old[:old.index('    uint32_t i = 0u;')] + f'''    uint32_t i = 0u;
    if (length >= 8u) {{
        const uint32_t tail = length - 8u;
        while (i < tail) {{
            uint64_t first;
            uint64_t second;
            __builtin_memcpy(&first, {first} + i, sizeof(first));
            __builtin_memcpy(&second, {second} + i, sizeof(second));
            if (first != second) {{ return 0; }}
            i += 8u;
        }}
        /* Overlap already-checked bytes instead of reading beyond either span. */
        uint64_t first;
        uint64_t second;
        __builtin_memcpy(&first, {first} + tail, sizeof(first));
        __builtin_memcpy(&second, {second} + tail, sizeof(second));
        return first == second;
    }}
    while (i < length) {{
        if (*({first} + i) != *({second} + i)) {{ return 0; }}
        ++i;
    }}
    return 1;
}}'''
        replace(old, body)
elif variant == 'signature-words':
    replace('''    if (length > 0u) {
        const uint32_t sample_length = length < 4u ? length : 4u;
        __builtin_memcpy(&first, src + row->glossary_start, sample_length);''', '''    if (length >= 4u) {
        /* Fixed-width loads on the common path; every sample stays in span. */
        first = read_u32_le(src + row->glossary_start);
        middle = read_u32_le(src + row->glossary_start + ((length - 4u) / 2u));
        last = read_u32_le(src + row->glossary_start + length - 4u);
    } else if (length > 0u) {
        const uint32_t sample_length = length;
        __builtin_memcpy(&first, src + row->glossary_start, sample_length);''')
else:
    raise ValueError(variant)
assert s != original
p.write_text(s)
print(json.dumps({'source': str(p), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}))
