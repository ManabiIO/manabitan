#!/usr/bin/env python3
"""Losslessly retain every original artifact member except release ZIP copies."""
from pathlib import Path
import datetime
import hashlib
import json
import sys
import zipfile

root = Path(sys.argv[1]).resolve()
original = root / 'original-artifact.zip'
audit = json.loads((root / 'independent-artifact-audit.json').read_text())
manifest = json.loads((root / 'artifact-member-sha256.json').read_text())
target = root / 'selected-raw-evidence.zip'
receipt_path = root / 'selected-raw-evidence-receipt.json'
assert not target.exists() and not receipt_path.exists()
excluded = {'package-A.zip', 'package-B.zip'}
selected = {}
with original.open('rb') as stream:
    original_sha = hashlib.file_digest(stream, 'sha256').hexdigest()
assert original_sha == audit['zipSha256']
with zipfile.ZipFile(original) as source, zipfile.ZipFile(target, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
    assert excluded <= set(source.namelist())
    for name in sorted(source.namelist()):
        if name in excluded:
            continue
        data = source.read(name)
        assert hashlib.sha256(data).hexdigest() == manifest[name]['sha256']
        info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        output.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        selected[name] = {'sha256': manifest[name]['sha256'], 'bytes': len(data)}
with zipfile.ZipFile(target) as output:
    assert output.namelist() == sorted(selected)
    for name, expected in selected.items():
        data = output.read(name)
        assert len(data) == expected['bytes'] and hashlib.sha256(data).hexdigest() == expected['sha256']
with target.open('rb') as stream:
    selected_sha = hashlib.file_digest(stream, 'sha256').hexdigest()
receipt = {
    'schema': 1, 'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'scope': 'Lossless selection for durable evidence; all original observations, raw reports, process scans, markers, logs and receipts retained',
    'originalArtifactId': audit['artifact']['id'], 'originalArtifactSha256': original_sha,
    'originalArtifactBytes': original.stat().st_size,
    'artifactAuditSha256': hashlib.sha256((root / 'independent-artifact-audit.json').read_bytes()).hexdigest(),
    'selectedArchiveSha256': selected_sha, 'selectedArchiveBytes': target.stat().st_size,
    'selectedMemberCount': len(selected), 'selectedRawBytes': sum(x['bytes'] for x in selected.values()),
    'excludedMembers': {name: manifest[name] for name in sorted(excluded)},
    'exclusionReason': 'Large packaged extension copies are already individually hashed and all nested entry bytes independently audited; original full artifact ZIP is retained separately.',
    'allSelectedBytesVerifiedAgainstOriginal': True, 'members': selected,
    'producerSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
}
receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps({key: receipt[key] for key in ('originalArtifactSha256', 'selectedArchiveSha256', 'selectedArchiveBytes', 'selectedMemberCount', 'selectedRawBytes')}, indent=2))
