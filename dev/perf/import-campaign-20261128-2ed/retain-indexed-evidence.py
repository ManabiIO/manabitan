"""Retain every original observation after complete package audit.

Only the two independently audited generated package ZIPs are omitted. This is
storage compaction, not resampling or removal of any benchmark observation.
"""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

source = Path(sys.argv[1])
destination = Path(sys.argv[2])
audit_path = Path(sys.argv[3])
audit = json.loads(audit_path.read_text())
assert audit['complete'] is True
assert 'complete-package-bytes-and-frozen-runtime-identity' in audit['independentlyRecomputed']
assert audit['verifiedSemanticObservations'] == 26
assert hashlib.sha256(source.read_bytes()).hexdigest() == audit['artifactSha256']
assert not destination.exists()
destination.parent.mkdir(parents=True, exist_ok=True)
temporary = destination.with_suffix('.tmp.zip')
omitted_names = {'package-A.zip', 'package-B.zip'}
retained_hashes = {}
omitted = {}
with zipfile.ZipFile(source) as original:
    names = original.namelist()
    assert len(names) == len(set(names))
    assert omitted_names <= set(names)
    with zipfile.ZipFile(temporary, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as retained:
        for entry in original.infolist():
            data = original.read(entry)
            digest = hashlib.sha256(data).hexdigest()
            if entry.filename in omitted_names:
                omitted[entry.filename] = {'bytes': len(data), 'sha256': digest}
            else:
                retained.writestr(entry.filename, data)
                retained_hashes[entry.filename] = digest
with zipfile.ZipFile(temporary) as retained:
    assert set(retained.namelist()) == set(names) - omitted_names
    assert len(retained.namelist()) == len(retained_hashes)
    for entry in retained.namelist():
        assert hashlib.sha256(retained.read(entry)).hexdigest() == retained_hashes[entry]
temporary.rename(destination)
receipt = {
    'originalArtifactSha256': audit['artifactSha256'],
    'originalArtifactBytes': source.stat().st_size,
    'retainedArchive': str(destination),
    'retainedArchiveSha256': hashlib.sha256(destination.read_bytes()).hexdigest(),
    'retainedArchiveBytes': destination.stat().st_size,
    'allRetainedEntriesVerified': len(retained_hashes),
    'omittedAuditedGeneratedPackages': omitted,
    'observationPolicy': 'Every raw observation, marker, process sample, log, receipt and registration retained unchanged. Original remote artifact remains available.',
}
(audit_path.parent / 'retention-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
source.unlink()
print(json.dumps(receipt, indent=2))
