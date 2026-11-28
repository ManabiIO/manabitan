"""Prepare reviewed fixed CRC observations for unreferenced Git blob retention.

This does not run a benchmark, modify source, publish a Git reference, or omit
any observation. The only archive omissions are the two audited package ZIPs.
"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile


ROOT = Path('/tmp/manabitan-beb5/current-browser-artifacts')
RECEIPTS = ROOT / 'crc-receipts'
DEST = Path('/tmp/manabitan-beb5/current-crc-durable')
PREFIX = 'dev/perf/import-round-20261128-beb5/current-browser/crc/'
DICTIONARIES = ['jmdict', 'jitendex', 'vndb']
HELPER = RECEIPTS / 'retain-original-members.py'


def read(path):
    return json.loads(path.read_text())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, value):
    assert not path.exists()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


assert sha(HELPER) == '55ef10d701b4117e7bdd8260d20a24639ff4e278aceac7a790c80e44f9f1cd51'
assert not DEST.exists(), 'Never replace an earlier retention attempt'
for dictionary in DICTIONARIES:
    audit = read(ROOT / f'crc-{dictionary}/local-independent-audit.json')
    assert audit['complete'] is True and audit['validatedObservationCount'] == 42
    assert audit['baseline'] == 'dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16'
    assert audit['candidateSourceCommit'] == '19db774b564064a7e339d3c3a79ea8da04ab48b5'
    assert read(RECEIPTS / f'{dictionary}-local-stages.json')['results'][-1]['stage'] == 'absolute-summary'
    assert all(row['exitCode'] == 0 for row in read(RECEIPTS / f'{dictionary}-local-stages.json')['results'])
    assert (RECEIPTS / f'{dictionary}-job.log').is_file()
assert (RECEIPTS / 'decision.json').is_file() and (RECEIPTS / 'README.md').is_file()

DEST.mkdir()
verification = {'complete': False, 'scope': 'Re-hash original fixed bytes only; no observation execution.', 'dictionaries': []}
copies = {}
originals = []
for dictionary in DICTIONARIES:
    target = DEST / dictionary
    target.mkdir()
    archive = target / 'original-without-packages.zip'
    retention = target / 'retention.json'
    census_path = RECEIPTS / f'{dictionary}-census.json'
    audit_path = ROOT / f'crc-{dictionary}/local-independent-audit.json'
    command = [sys.executable, str(HELPER), '--census', str(census_path), '--audit', str(audit_path),
               '--out', str(archive), '--receipt', str(retention)]
    with (target / 'retention.stdout').open('xb') as stdout, (target / 'retention.stderr').open('xb') as stderr:
        result = subprocess.run(command, stdout=stdout, stderr=stderr)
    write(target / 'retention-command.json', {'command': command, 'exitCode': result.returncode})
    assert result.returncode == 0, f'{dictionary} retention failed; original failure is retained'
    receipt = read(retention)
    census = read(census_path)
    assert receipt['byteAuditComplete'] is True
    assert {row['name'] for row in receipt['omittedOriginalMembers']} == {'package-A.zip', 'package-B.zip'}
    expected = [row for row in census['members'] if row['name'] not in {'package-A.zip', 'package-B.zip'}]
    with zipfile.ZipFile(archive) as retained:
        assert retained.namelist() == [row['name'] for row in expected]
        for row in expected:
            data = retained.read(row['name'])
            assert len(data) == row['bytes']
            if not row.get('directory'):
                assert hashlib.sha256(data).hexdigest() == row['sha256']
        original_ci = retained.read('independent-audit.json')
        assert original_ci == (ROOT / f'crc-{dictionary}/independent-audit.json').read_bytes()
    verification['dictionaries'].append({
        'dictionary': dictionary, 'retainedMemberCount': len(expected), 'retainedArchiveSha256': sha(archive),
        'originalOuterSha256': census['sha256'], 'originalOuterBytes': census['bytes'],
        'originalCiAuditSha256': hashlib.sha256(original_ci).hexdigest(),
        'localAuditSha256': sha(audit_path),
        'originalAndLocalAuditBytesEqual': original_ci == audit_path.read_bytes(),
        'allRetainedMemberBytesEqualOriginalCensus': True,
        'exactOmissions': ['package-A.zip', 'package-B.zip'],
    })
    originals.append({'dictionary': dictionary, 'path': census['archive'], 'bytes': census['bytes'],
                      'sha256': census['sha256'], 'artifactId': census['artifactId'],
                      'jobId': census['jobId'], 'runId': census['runId'], 'runAttempt': census['runAttempt'],
                      'durableArchive': dictionary + '/original-without-packages.zip',
                      'originalOuterBytesUploaded': False, 'completeOriginalAndPackagesRemainLocal': True})
    mapping = {
        'local-independent-audit.json': audit_path,
        'original-ci-independent-audit.json': ROOT / f'crc-{dictionary}/independent-audit.json',
        'absolute-summary.json': RECEIPTS / f'{dictionary}-absolute-summary.json',
        'original-member-census.json': census_path,
        'artifact-api.json': RECEIPTS / f'{dictionary}-artifact-api.json',
        'run-api.json': RECEIPTS / f'{dictionary}-run-api.json',
        'job-api.json': RECEIPTS / f'{dictionary}-job-api.json',
        'full-hosted-job.log': RECEIPTS / f'{dictionary}-job.log',
        'local-stages.json': RECEIPTS / f'{dictionary}-local-stages.json',
    }
    for stage in ['extract', 'frozen-audit', 'absolute-summary']:
        for stream in ['stdout', 'stderr']:
            mapping[f'local-{stage}.{stream}'] = RECEIPTS / f'{dictionary}-{stage}.{stream}'
    if dictionary == 'jmdict':
        mapping['memory-failure-details.json'] = RECEIPTS / 'jmdict-memory-failure-details.json'
    for name, source in mapping.items():
        assert source.is_file()
        shutil.copyfile(source, target / name)
        copies[str((target / name).relative_to(DEST))] = str(source)

verification['complete'] = True
write(DEST / 'provenance/retained-member-verification.json', verification)
shared = {
    'README.md': RECEIPTS / 'README.md',
    'decision.json': RECEIPTS / 'decision.json',
    'helpers/verify-extract-and-summarize.py': RECEIPTS / 'verify-extract-and-summarize.py',
    'helpers/audit-one-crc.py': RECEIPTS / 'audit-one-crc.py',
    'helpers/retain-original-members.py': HELPER,
    'helpers/prepare-crc-durable-evidence.py': Path(__file__),
    'provenance/acquisition-registration.json': RECEIPTS / 'acquisition-registration.json',
    'provenance/acquisition-helper-independent-review.json': RECEIPTS / 'acquisition-helper-independent-review.json',
    'provenance/retention-registration.json': RECEIPTS / 'retention-registration.json',
    'provenance/retention-helper-independent-review.json': RECEIPTS / 'retention-helper-independent-review.json',
    'provenance/frozen-audit-source.json': ROOT / 'crc-audit-source.json',
    'provenance/open-pr-duplicate-search.json': ROOT / 'crc-duplicate-search-initial.json',
    'provenance/hosted-job-log-identities.json': RECEIPTS / 'hosted-job-log-identities.json',
    'provenance/final-run-api.json': RECEIPTS / 'final-run-api.json',
}
for name, source in shared.items():
    target = DEST / name
    assert source.is_file() and not target.exists()
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    copies[name] = str(source)
write(DEST / 'provenance/copied-file-sources.json', copies)
manifest = {'schemaVersion': 1, 'runId': 46127721419, 'runAttempt': 1,
            'studyCommit': '477fb271ef25fac533fb1faf737a5dab898190e3',
            'studyTree': 'f4b08d4dfc6f2493336a5318c20c4f2b64b90593',
            'baseline': 'dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16',
            'candidate': '19db774b564064a7e339d3c3a79ea8da04ab48b5',
            'repositoryPathPrefix': PREFIX, 'localOnlyFullOriginals': originals,
            'sourceGateArtifactsDuplicated': False, 'entries': []}
for path in sorted(DEST.rglob('*')):
    if not path.is_file():
        continue
    data = path.read_bytes()
    git_blob = hashlib.sha1(b'blob ' + str(len(data)).encode('ascii') + b'\0' + data).hexdigest()
    row = {'path': PREFIX + path.relative_to(DEST).as_posix(), 'localPath': str(path),
           'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'gitBlobSha': git_blob}
    if path.name == 'original-without-packages.zip':
        original = next(item for item in originals if item['dictionary'] == path.parent.name)
        row['derivesFromOriginalArchive'] = {
            'artifactId': original['artifactId'], 'bytes': original['bytes'],
            'sha256': original['sha256'], 'localPath': original['path'],
        }
    manifest['entries'].append(row)
write(ROOT / 'crc-durable-upload-manifest.json', manifest)
print(json.dumps({'manifest': str(ROOT / 'crc-durable-upload-manifest.json'),
                  'fileCount': len(manifest['entries']), 'bytes': sum(row['bytes'] for row in manifest['entries']),
                  'manifestSha256': sha(ROOT / 'crc-durable-upload-manifest.json')}))
