"""Retain every non-package artifact byte after complete independent audit.

Usage: python3 retain-audited-raw.py ORIGINAL_ZIP AUDIT_DIRECTORY RETAINED_ZIP
The original is never deleted by this script. A caller may remove only that
owned ZIP after this script verifies the reduced archive and writes its receipt.
"""
import hashlib
import json
from pathlib import Path
import sys
import zipfile


def file_hash(path):
    result = hashlib.sha256()
    with path.open('rb') as data:
        for block in iter(lambda: data.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


original = Path(sys.argv[1])
audit_directory = Path(sys.argv[2])
retained = Path(sys.argv[3])
audit = json.loads((audit_directory / 'independent-audit.json').read_text())
assert audit['complete'] is True
assert 'complete-package-hashes-exact-eight-entry-union-and-single-added-helper' in audit['independentlyRecomputed']
assert file_hash(original) == audit['artifactSha256']
assert not retained.exists()
source_identities = json.loads((audit_directory / 'source-identities.json').read_text())
kept = []
excluded = []
with zipfile.ZipFile(original) as source, zipfile.ZipFile(retained, 'x', compression=zipfile.ZIP_DEFLATED) as target:
    assert len(source.namelist()) == len(set(source.namelist()))
    for info in source.infolist():
        hash_ = hashlib.sha256()
        if info.filename in ('package-A.zip', 'package-B.zip'):
            with source.open(info) as data:
                for block in iter(lambda: data.read(1024 * 1024), b''):
                    hash_.update(block)
            arm = info.filename.removeprefix('package-').removesuffix('.zip')
            assert hash_.hexdigest() == source_identities['arms'][arm]['packageSha256']
            excluded.append({'path': info.filename, 'bytes': info.file_size, 'sha256': hash_.hexdigest()})
            continue
        output_info = zipfile.ZipInfo(info.filename, date_time=info.date_time)
        output_info.compress_type = zipfile.ZIP_DEFLATED
        output_info.external_attr = info.external_attr
        with source.open(info) as data, target.open(output_info, 'w', force_zip64=True) as output:
            for block in iter(lambda: data.read(1024 * 1024), b''):
                hash_.update(block)
                output.write(block)
        kept.append({'path': info.filename, 'bytes': info.file_size, 'sha256': hash_.hexdigest()})
assert {row['path'] for row in excluded} == {'package-A.zip', 'package-B.zip'}
with zipfile.ZipFile(retained) as check:
    assert check.namelist() == [row['path'] for row in kept]
    for row in kept:
        info = check.getinfo(row['path'])
        assert info.file_size == row['bytes']
        hash_ = hashlib.sha256()
        with check.open(info) as data:
            for block in iter(lambda: data.read(1024 * 1024), b''):
                hash_.update(block)
        assert hash_.hexdigest() == row['sha256']
receipt = {
    'originalArtifactSha256': audit['artifactSha256'],
    'originalBytes': original.stat().st_size,
    'retainedPath': str(retained.resolve()),
    'retainedBytes': retained.stat().st_size,
    'retainedSha256': file_hash(retained),
    'independentAuditSha256': file_hash(audit_directory / 'independent-audit.json'),
    'allNonPackageEntriesRetainedAndRehashed': True,
    'excludedFullyAuditedPackages': excluded,
    'retainedEntries': kept,
}
(audit_directory / 'raw-retention-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps({key: value for key, value in receipt.items() if key != 'retainedEntries'}, indent=2))
