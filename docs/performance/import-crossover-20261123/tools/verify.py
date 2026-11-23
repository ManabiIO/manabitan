#!/usr/bin/env python3
"""Verify the staged bytes without downloading data or running benchmarks."""
import gzip
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sha = lambda data: hashlib.sha256(data).hexdigest()
manifest_bytes = (root / 'manifest.json').read_bytes()
assert (root / 'manifest.sha256').read_text().split()[0] == sha(manifest_bytes)
manifest = json.loads(manifest_bytes)
for item in manifest['files']:
    data = (root / item['path']).read_bytes()
    assert len(data) == item['bytes'], item['path']
    assert sha(data) == item['sha256'], item['path']
    source = item['source']
    if source.get('transformation', '').startswith('gzip'):
        decoded = gzip.decompress(data)
        assert len(decoded) == source['bytes'], item['path']
        assert sha(decoded) == source['sha256'], item['path']
print(f'Verified {len(manifest["files"])} files and manifest identity')
