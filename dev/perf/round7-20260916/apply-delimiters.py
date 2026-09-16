"""Fuse adjacent structural punctuation only after a successfully parsed string."""
from pathlib import Path
import sys,json,hashlib
v=sys.argv[1]
assert v in ('key-colon','string-delimiters')
p=Path('ext/js/dictionary/wasm/term-bank-parser.c')
s=p.read_text();a=s.index('static int parse_composite_span_impl(');b=s.index('static int parse_composite_span(',a)
part=s[a:b]
old='''            i = s_end;
            continue;'''
new='''            // Consume an adjacent delimiter while the validated string's
            // transition is still local. Whitespace and all other bytes retain
            // the general state-machine path.
            if (s_end < len && src[s_end] == ':' && state == OBJECT_COLON) {
                state = OBJECT_VALUE;
                ++s_end;
            }'''
if v=='string-delimiters':
 new+=''' else if (s_end < len && src[s_end] == ',') {
                if (state == ARRAY_AFTER_VALUE) {
                    state = ARRAY_VALUE;
                    ++s_end;
                } else if (state == OBJECT_AFTER_VALUE) {
                    state = OBJECT_KEY;
                    ++s_end;
                }
            }'''
new+='''
            i = s_end;
            continue;'''
assert part.count(old)==1
s=s[:a]+part.replace(old,new)+s[b:]
p.write_text(s)
print(json.dumps({'source':p.as_posix(),'sha256':hashlib.sha256(s.encode()).hexdigest()}))
