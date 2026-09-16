from pathlib import Path
import hashlib,json,sys
variant=sys.argv[1]
sizes={'block-8m':8,'block-16m':16}
assert variant in sizes
p=Path('ext/js/dictionary/term-content-block-store.js')
s=p.read_text(); old='const DEFAULT_BLOCK_TARGET_BYTES = 4 * 1024 * 1024;'
assert s.count(old)==1
s=s.replace(old,f"const DEFAULT_BLOCK_TARGET_BYTES = {sizes[variant]} * 1024 * 1024;")
p.write_text(s)
print(json.dumps({'source':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}))
