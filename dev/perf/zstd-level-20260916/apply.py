from pathlib import Path
import hashlib,json,sys
variant=sys.argv[1]
levels={'level-2':-2,'level-3':-3}
assert variant in levels
p=Path('ext/js/dictionary/zstd-term-content.js')
s=p.read_text()
old='const JMDICT_COMPRESSION_LEVEL = -1;'
assert s.count(old)==1
s=s.replace(old,f'const JMDICT_COMPRESSION_LEVEL = {levels[variant]};')
p.write_text(s)
print(json.dumps({'source':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}))
