"""Retain every non-package artifact byte after complete independent audit.

Usage: python3 retain-confirmation-raw.py ORIGINAL_ZIP AUDIT_DIRECTORY RETAINED_ZIP
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
assert 'complete-package-bytes-and-frozen-runtime-identity' in audit['independentlyRecomputed']
assert file_hash(original) == audit['artifactSha256']
assert not retained.exists()
source_identity_bytes = (audit_directory / 'source-identities.json').read_bytes()
source_identities = json.loads(source_identity_bytes)
assert set(source_identities['arms']) == {'A', 'B'}
assert source_identities['arms']['A']['sha'] == '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
assert source_identities['arms']['A']['tree'] == 'd99ea4d04658f7ec1c76acdc5f3684594212a471'
assert source_identities['arms']['B']['sha'] == '3e1e602d0cac73055dfd85bf6ec2674b10ca0a59'
assert source_identities['arms']['B']['tree'] == '91a826e08f703a395dd5527f0e05d984d87f9ebe'
runtime_entry = 'js/dictionary/term-record-opfs-store.js'
assert set(source_identities['changedPackageEntries']) == {runtime_entry}
assert source_identities['arms']['A']['entries'][runtime_entry] == '7325a63fa3d054a3c8b426c87880671ca57f5956dce842d9daef4acd4d617594'
assert source_identities['arms']['B']['entries'][runtime_entry] == '62d44f3cda14be7a93d6da69fe3f34cd5a0edb786543af662cfaf119ba529437'
assert audit['dictionary'] in {'jmdict', 'jitendex', 'vndb'}
kept = []
excluded = []
with zipfile.ZipFile(original) as source, zipfile.ZipFile(retained, 'x', compression=zipfile.ZIP_DEFLATED) as target:
    assert len(source.namelist()) == len(set(source.namelist()))
    assert source.read('source-identities.json') == source_identity_bytes
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
