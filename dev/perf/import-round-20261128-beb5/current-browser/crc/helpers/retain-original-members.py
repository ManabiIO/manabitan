"""Retain original CRC artifact bytes after the unchanged full auditor completes."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile


def read(path):
    return json.loads(path.read_text())


def file_sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--census', required=True, type=Path)
parser.add_argument('--audit', required=True, type=Path)
parser.add_argument('--out', required=True, type=Path)
parser.add_argument('--receipt', required=True, type=Path)
args = parser.parse_args()
census = read(args.census)
assert census['complete'] is True and census['omittedMembers'] == []
assert census['runId'] == 46127721419 and census['runAttempt'] == 1
assert census['studyCommit'] == '477fb271ef25fac533fb1faf737a5dab898190e3'
original = Path(census['archive'])
assert original.stat().st_size == census['bytes'] and file_sha(original) == census['sha256']
assert not args.out.exists() and not args.receipt.exists(), 'Never overwrite a retained artifact or receipt'
audit = read(args.audit) if args.audit.exists() else None
receipt = {
    'runId': census['runId'], 'runAttempt': 1, 'studyCommit': census['studyCommit'],
    'dictionary': census['dictionary'], 'artifactId': census['artifactId'], 'jobId': census['jobId'],
    'originalOuterSha256': census['sha256'], 'originalOuterBytes': census['bytes'],
    'originalOuterPath': str(original), 'completeOriginalCensusSha256': file_sha(args.census),
    'independentAuditSha256': file_sha(args.audit) if args.audit.exists() else None,
    'retentionHelperSha256': file_sha(Path(__file__)),
}
if audit is None or audit.get('complete') is not True:
    receipt.update({'mode': 'verbatim-original-artifact', 'byteAuditComplete': False,
                    'retainedPath': str(original), 'omittedOriginalMembers': []})
else:
    assert audit['dictionary'] == census['dictionary'] and audit['validatedObservationCount'] == 42
    assert audit['baseline'] == 'dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16'
    assert audit['candidateSourceCommit'] == '19db774b564064a7e339d3c3a79ea8da04ab48b5'
    assert args.audit.resolve().parent == Path(census['extraction']).resolve()
    members = {row['name']: row for row in census['members']}
    excluded = {'package-A.zip', 'package-B.zip'}
    for arm in ['A', 'B']:
        member = members[f'package-{arm}.zip']
        assert member['sha256'] == audit['packages'][arm]['sha256']
        assert member['bytes'] == audit['packages'][arm]['bytes']
    omitted = []
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(original) as source, zipfile.ZipFile(args.out, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as target:
        assert source.namelist() == [row['name'] for row in census['members']]
        for entry in source.infolist():
            member = members[entry.filename]
            data = source.read(entry)
            assert len(data) == member['bytes']
            if not member.get('directory'):
                assert hashlib.sha256(data).hexdigest() == member['sha256']
            if entry.filename in excluded:
                omitted.append(member)
                continue
            info = zipfile.ZipInfo(entry.filename, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o40755 << 16) | 0x10 if entry.is_dir() else 0o100644 << 16
            target.writestr(info, data)
    assert {row['name'] for row in omitted} == excluded
    receipt.update({
        'mode': 'all-original-member-bytes-except-listed-reproducible-package-zips',
        'byteAuditComplete': True, 'memoryPassed': audit['memoryPassed'],
        'retainedPath': str(args.out), 'retainedArchiveSha256': file_sha(args.out),
        'retainedArchiveBytes': args.out.stat().st_size,
        'retainedMemberCount': len(members) - 2, 'omittedOriginalMembers': omitted,
        'limitations': 'This is a reconstructed ZIP, not the original outer archive. Every original member byte except exact package-A.zip and package-B.zip is retained, including the original CI audit; ZIP container metadata is normalized. The complete original census and outer SHA256/size are retained separately. The full frozen byte audit completed before omission, independently of the memory gate. A complete package/byte re-audit requires the original package ZIPs; the full original artifact and packages remain locally available. Local audit and derived analysis outputs are separate, not substituted for original members.',
    })
args.receipt.parent.mkdir(parents=True, exist_ok=True)
args.receipt.write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt))
