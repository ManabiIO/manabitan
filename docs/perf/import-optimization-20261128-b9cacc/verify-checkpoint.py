#!/usr/bin/env python3
"""Verify this evidence tree without executing any product or benchmark code."""
import hashlib
import json
from pathlib import Path


root = Path(__file__).resolve().parent
manifest_path = root / 'CHECKPOINT-MANIFEST.json'
manifest = json.loads(manifest_path.read_bytes())
expected = {entry['path']: entry for entry in manifest['files']}
actual = {
    path.relative_to(root).as_posix()
    for path in root.rglob('*')
    if path.is_file() and path != manifest_path
}
assert set(expected) == actual, {
    'missing': sorted(set(expected) - actual),
    'unexpected': sorted(actual - set(expected)),
}
for name, entry in expected.items():
    path = root / name
    assert not path.is_symlink(), name
    content = path.read_bytes()
    assert len(content) == entry['bytes'], name
    assert hashlib.sha256(content).hexdigest() == entry['sha256'], name
    git_blob = b'blob ' + str(len(content)).encode('ascii') + b'\0' + content
    assert hashlib.sha1(git_blob).hexdigest() == entry['gitBlob'], name
for package in manifest['nestedPacks']:
    package_root = root / package['path']
    package_manifest = package_root / 'PACK-MANIFEST.json'
    assert hashlib.sha256(package_manifest.read_bytes()).hexdigest() == package['manifestSha256']
    nested = json.loads(package_manifest.read_bytes())
    entries = {entry['path']: entry for entry in nested['files']}
    aliases = json.loads((package_root / 'source-aliases.json').read_bytes())
    for alias in aliases['records']:
        stored = entries[alias['storedAt']]
        assert alias['bytePreserved'] is True
        assert alias['sha256'] == stored['sha256']
        assert alias['bytes'] == stored['bytes']
print(json.dumps({
    'status': 'passed',
    'hashedFiles': len(expected),
    'hashedBytes': sum(entry['bytes'] for entry in expected.values()),
    'nativeOrPerformanceExecution': False,
}, indent=2))
