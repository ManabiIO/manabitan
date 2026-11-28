#!/usr/bin/env python3
"""Verify the portable evidence files only; never execute product code."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent
manifest_path = root / 'PACK-MANIFEST.json'
manifest = json.loads(manifest_path.read_bytes())
expected = {entry['path']: entry for entry in manifest['files']}
actual = {path.relative_to(root).as_posix() for path in root.rglob('*') if path.is_file() and path != manifest_path}
assert set(expected) == actual, {'missing': sorted(set(expected) - actual), 'unexpected': sorted(actual - set(expected))}
for name, entry in expected.items():
    data = (root / name).read_bytes()
    assert len(data) == entry['bytes'], name
    assert hashlib.sha256(data).hexdigest() == entry['sha256'], name
aliases = json.loads((root / 'source-aliases.json').read_bytes())
for record in aliases['records']:
    entry = expected[record['storedAt']]
    assert record['bytes'] == entry['bytes'] and record['sha256'] == entry['sha256']
    assert record['bytePreserved'] is True
assert len(aliases['excludedLargeCaptures']) == 12
print(json.dumps({'status': 'passed', 'files': len(expected), 'bytes': sum(x['bytes'] for x in expected.values()), 'sourceAliases': len(aliases['records']), 'nativeOrPerformanceExecution': False}, indent=2))
