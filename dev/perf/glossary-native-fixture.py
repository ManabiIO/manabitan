from pathlib import Path
import json, zipfile, struct, zlib
out = Path('builds/glossary-native'); out.mkdir(parents=True, exist_ok=True)
def chunk(name, data):
    return struct.pack('>I', len(data)) + name + data + struct.pack('>I', zlib.crc32(name + data))
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\0\xff\0\0\xff')) + chunk(b'IEND', b'')
fixtures = [
    ('escapedimage', r'[{"type":"im\u0061ge","path":"one.png"}]'),
    ('nestedimage', r'[{"type":"structured-content","content":{"tag":"i\u006dg","pa\u0074h":"nested.png"}}]'),
    ('mixedpaths', r'[{"type":"image","path":"control.png"},{"type":"image","pa\u0074h":"two.png"}]'),
    ('duplicatetext', r'[{"type":"text","text":"WRONG","text":"RIGHT"}]'),
    ('escapedtext', r'[{"ty\u0070e":"te\u0078t","te\u0078t":"RIGHT"}]'),
    ('duplicatetype', r'[{"type":"image","type":"text","text":"RIGHT"}]'),
    ('escapedduplicate', r'[{"type":"text","text":"WRONG","te\u0078t":"RIGHT"}]'),
    ('ordinarytext', '["RIGHT"]'),
]
rows = [f'[{json.dumps(term)},"","","",1,{glossary},{i},""]' for i, (term, glossary) in enumerate(fixtures)]
with zipfile.ZipFile(out / 'fixture.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('index.json', json.dumps({'title': 'Glossary Semantics', 'revision': '1', 'format': 3, 'sequenced': True}))
    z.writestr('term_bank_1.json', '[' + ','.join(rows) + ']')
    for name in ['one.png', 'nested.png', 'control.png', 'two.png']: z.writestr(name, png)
(out / 'image.png').write_bytes(png)
