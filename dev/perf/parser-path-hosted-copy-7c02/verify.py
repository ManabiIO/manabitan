#!/usr/bin/env python3
"""Verify and independently audit the saved hosted copy receipts; no benchmark."""
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tempfile
import zipfile

root = Path(__file__).resolve().parent
index = json.loads((root / 'index.json').read_text())
manifest_bytes = (root / 'manifest.json').read_bytes()
assert hashlib.sha256(manifest_bytes).hexdigest() == index['manifestSha256']
manifest = json.loads(manifest_bytes)
payload = (root / 'hosted-copy-evidence.zip').read_bytes()
assert len(payload) == index['bytes']
assert hashlib.sha256(payload).hexdigest() == index['sha256']
with zipfile.ZipFile(io.BytesIO(payload)) as archive:
    assert set(archive.namelist()) == set(manifest['files'])
    for name, entry in manifest['files'].items():
        path = PurePosixPath(name)
        assert not path.is_absolute() and '..' not in path.parts
        raw = archive.read(name)
        assert len(raw) == entry['bytes']
        assert hashlib.sha256(raw).hexdigest() == entry['sha256']
    with tempfile.TemporaryDirectory(prefix='manabitan-hosted-copy-audit-') as folder:
        target = Path(folder)
        archive.extractall(target)
        saved = target / 'path-copy-hosted-20261128'
        original_audit = saved / 'independent-audit.json'
        assert hashlib.sha256(original_audit.read_bytes()).hexdigest() == index['independentAuditSha256']
        with zipfile.ZipFile(saved / 'artifact.zip') as artifact:
            for name in artifact.namelist():
                path = PurePosixPath(name)
                assert not path.is_absolute() and '..' not in path.parts
            artifact.extractall(saved / 'artifact')
        # The captured audit writes a fresh timestamped receipt only in this
        # temporary copy. All published source and original receipts stay intact.
        subprocess.run([sys.executable, str(saved / 'audit-receipts.py')], check=True)
print(json.dumps({'integrity': 'passed', 'savedFiles': len(manifest['files']),
                  'independentHostedCopyAudit': 'passed', 'newMeasurements': 0}))
