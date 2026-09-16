"""Compare one inlining decision; preserve all parser logic and data formats."""
from pathlib import Path
import sys,json,hashlib
variant=sys.argv[1]
functions={'inline-string':'parse_string_span','inline-composite':'parse_composite_span_impl'}
assert variant in functions
p=Path('ext/js/dictionary/wasm/term-bank-parser.c')
s=p.read_text()
old='static int '+functions[variant]+'('
new='static __attribute__((always_inline)) inline int '+functions[variant]+'('
assert s.count(old)==1
s=s.replace(old,new)
p.write_text(s)
print(json.dumps({'source':p.as_posix(),'sha256':hashlib.sha256(s.encode()).hexdigest()}))
