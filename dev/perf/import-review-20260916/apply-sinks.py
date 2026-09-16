"""Independent candidates; preserve byte equality, ownership and storage policy."""
from pathlib import Path
import hashlib
import json
import re
import subprocess
import sys

variant = sys.argv[1]
p = Path('ext/js/dictionary/wasm/term-bank-parser.c' if variant == 'primitive-stack' else 'ext/js/dictionary/dictionary-database.js')
expected = '490d3e4a3f9c436e51bde32188e8bfe8cae2ee38a87b232263d651878973ca60' if variant == 'primitive-stack' else 'aed3fdfcffd9967af17519fcbaea362253a4804ff760a8cc7070e52ebf5be5df'
assert hashlib.sha256(p.read_bytes()).hexdigest() == expected
s = original = p.read_text()

def replace(old, new):
    global s
    assert s.count(old) == 1, old[:120]
    s = s.replace(old, new)

if variant == 'dataview-exact':
    for method, bview, condition in [
        ('_termContentBytesEqual', 'b.buffer, b.byteOffset, length', 'length >= 32'),
        ('_termContentBytesEqualSpan', 'buffer.buffer, buffer.byteOffset + offset, length',
         'length >= 32 && Number.isInteger(offset) && offset >= 0 && offset <= buffer.byteLength - length'),
    ]:
        start = s.index('    ' + method + '(')
        end = s.index('\n    }', start)
        old = s[start:end]
        needle = '        const unrolledLength = length & ~7;'
        assert old.count(needle) == 1
        added = f'''        // Compare exact words, not hashes. DataView supports unaligned spans
        // and shared parser buffers without allocating a copy of either input.
        if ({condition}) {{
            const first = new DataView(a.buffer, a.byteOffset, length);
            const second = new DataView({bview});
            const wordEnd = length - (length % 4);
            for (; i < wordEnd; i += 4) {{
                if (first.getUint32(i, true) !== second.getUint32(i, true)) {{ return false; }}
            }}
        }}
'''
        replace(old, old.replace(needle, added + needle))
elif variant == 'cache-copy-set':
    replace('        const owned = spans.buffer.slice(minimumOffset, maximumEnd);', '''        const owned = new Uint8Array(byteLength);
        owned.set(spans.buffer.subarray(minimumOffset, maximumEnd));''')
elif variant == 'primitive-stack':
    for component, name in [('integer-guard', 'parse_int32_token'), ('escape-words', 'json_string_token_has_escape'), ('signature-words', 'raw_term_content_quick_signature')]:
        p.write_text(original)
        subprocess.run(['python3', str(Path(__file__).with_name('apply-native.py')), component], check=True, stdout=subprocess.PIPE)
        modified = p.read_text()
        def fn(text):
            m = re.search(r'^static (?:int|uint32_t) ' + name + r'\([^;]+?\) \{', text, re.M)
            assert m, name
            end = text.index('\n}\n', m.start()) + 2
            return text[m.start():end]
        replace(fn(original), fn(modified))
else:
    raise ValueError(variant)
assert s != original
p.write_text(s)
print(json.dumps({'source': str(p), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}))
