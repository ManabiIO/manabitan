#!/usr/bin/env python3
"""Derive raw compressed-bank inputs from hash-locked archives, outside timing."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=False)
fixtures = json.loads((args.source / 'test/perf/dictionaries.lock.json').read_text())['dictionaries']
manifest = {'fixtures': fixtures, 'banks': []}
for dictionary, fixture in fixtures.items():
    path = args.source / 'builds/e2e-dictionary-cache' / fixture['cacheFile']
    data = path.read_bytes()
    assert len(data) == fixture['sizeBytes'] and hashlib.sha256(data).hexdigest() == fixture['sha256']
    rows = 0
    with zipfile.ZipFile(path) as archive:
        banks = sorted((x for x in archive.infolist() if re.fullmatch(r'term_bank_\d+\.json', x.filename)),
                       key=lambda x: int(re.search(r'\d+', x.filename).group()))
        for info in banks:
            assert info.compress_type in (0, 8) and not info.flag_bits & 1
            assert data[info.header_offset:info.header_offset + 4] == b'PK\x03\x04'
            name_size, extra_size = struct.unpack_from('<HH', data, info.header_offset + 26)
            offset = info.header_offset + 30 + name_size + extra_size
            compressed = data[offset:offset + info.compress_size]
            raw = archive.read(info)
            assert len(compressed) == info.compress_size and len(raw) == info.file_size
            terms = json.loads(raw)
            assert isinstance(terms, list)
            rows += len(terms)
            name = dictionary + '-' + info.filename + '.compressed'
            (args.output / name).write_bytes(compressed)
            manifest['banks'].append(dict(dictionary=dictionary, file=name, method=info.compress_type,
                size=info.file_size, crc=info.CRC, rows=len(terms),
                compressedSha256=hashlib.sha256(compressed).hexdigest(), rawSha256=hashlib.sha256(raw).hexdigest()))
    assert rows == fixture['termRows'], (dictionary, rows)
(args.output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print('Prepared', len(manifest['banks']), 'complete fixed source banks')
