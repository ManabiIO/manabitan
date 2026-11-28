#!/usr/bin/env python3
"""Verify original field receipts in the recovery pack; never acquire imports."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile

BASELINE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
CANDIDATE = 'ab116fa90777cd64b067d4858318923f0f4e3ee7'
MODULE = 'js/dictionary/term-record-opfs-store.js'
ARTIFACTS = {
    'AB': (15247854574, 35001825, '3c253d47260b91bb5d8b1bad06446cb80aad65fb4973278089417f6f3ab0775c'),
    'BA': (15248767297, 34942141, '67159673a6cb6cc3b579e9d01ee82334094c40a3e6932876fffd812df5f68d66'),
}
AUDITS = {'AB': '5d1244116a999f9eef544c5a58a6190c5cd3f9fd4324335d345691d10e40bad2',
          'BA': '20413b00c230974f8776074f7230da4b8e5be5a5ccdd4074426cf296d5c883e4'}
BLOBS = {'A': 'be14a6a920584c942a4304079ebb3fc5c624a0ae', 'B': '89dce0bcd56505053c39fea31a60ac5ea331afe7'}
CHECKERS = {
    'dev/perf/import-memory-20261125-a7f7/qualification_receipts.py': '4f7b4eee4f8ff71e821c9162e57524460c48f01f409487f638523a3a27aa8f51',
    'dev/perf/import-memory-20261125-a7f7/audit_memory.py': '871f29b9d87c42468714263a0eda05ee9edd2f76bff269ea9cb6d6d1fe51de7c',
    'dev/perf/import-memory-20261125-a7f7/protocol.py': 'ea0e7c20bbc1273cbe81891c32ecc72658d70ed1bbf1d57cdcfae5b347d493c7',
    'dev/perf/import-memory-20261125-a7f7/chromium_memory.py': '8044bf3f4c48a868c7e076dc5f1bef9c2663f6323fe4a4fba5c121161cada4c7',
    'test/perf/dictionaries.lock.json': '60aa981791f3b60ca17588212aea5bd3536fb8f59288855e5accd019c6e4cf89',
    'test/chromium/extension-two-dictionary-import.e2e.js': 'd0ae122bd22f7b460cedb11f06d2cb018224674abf9669e0fed567b5f3a870cf',
    'dev/perf/import-qualification-20261125-a7f7.py': 'cad1b3fb25766cbd22a1c4260718a0b92353e87276751217ca18dc9eea29c6ef',
}
ORIGINAL_AUDITOR = 'cf2b18b91d005217c59fdde6e749955734b9e8337f01f50246a20ef06a67a4f9'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    return json.loads(path.read_bytes())


def safe(name):
    path = PurePosixPath(name)
    require(not path.is_absolute() and '..' not in path.parts and path.as_posix() == name, 'Unsafe archive path')


def extract(evidence, manifest, destination):
    record = manifest['archive']
    require(record['file'] == 'evidence.tar.xz', 'Changed archive filename')
    archive = (evidence / record['file']).read_bytes()
    require(len(archive) == record['bytes'] and sha(archive) == record['sha256'], 'Archive identity mismatch')
    names = []
    total = 0
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:xz') as source:
        for item in source:
            safe(item.name)
            require(item.isfile() and item.name not in names and item.name in manifest['members'], 'Invalid archive member')
            require((item.mode, item.uid, item.gid, item.mtime, item.uname, item.gname) == (0o644, 0, 0, 0, '', ''),
                    'Changed archive metadata')
            data = source.extractfile(item).read()
            expected = manifest['members'][item.name]
            require(len(data) == item.size == expected['bytes'] and sha(data) == expected['sha256'], 'Member identity mismatch')
            path = destination / item.name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            names.append(item.name)
            total += len(data)
    require(names == sorted(manifest['members']) and len(names) == record['memberCount'] and total == record['uncompressedBytes'],
            'Archive coverage mismatch')


def check_package_proof(root, order, original_artifacts):
    host = root / ('hosted-' + order)
    proof = read(host / 'package-and-artifact-proof.json')
    identity = proof['originalArtifact']
    require((identity['id'], identity['bytes'], identity['sha256']) == ARTIFACTS[order], 'Original artifact mismatch')
    entries = proof['entries']
    require(len(entries) == len({entry['path'] for entry in entries}) == 203, 'Original inventory incomplete')
    require({entry['path'] for entry in entries if not entry['retained']} ==
            {'record-field-lengths-jmdict/package-A.zip', 'record-field-lengths-jmdict/package-B.zip'}, 'Unexpected omitted file')
    for entry in entries:
        safe(entry['path'])
        if entry['retained']:
            data = (host / entry['path']).read_bytes()
            require(len(data) == entry['bytes'] and sha(data) == entry['sha256'], 'Original member identity mismatch')
    identities = read(host / 'record-field-lengths-jmdict/source-identities.json')
    for arm in ['A', 'B']:
        package = proof['packages'][arm]
        require(package['sha256'] == identities['arms'][arm]['packageSha256'] and
                package['entries'] == identities['arms'][arm]['entries'] and len(package['entries']) == 554,
                'Package identity/inventory mismatch')
        module = (host / ('verified-module-' + arm + '.js')).read_bytes()
        blob = hashlib.sha1(b'blob ' + str(len(module)).encode() + b'\0' + module).hexdigest()
        require(blob == package['moduleGitBlob'] == BLOBS[arm] and
                sha(module) == package['moduleSha256'] == package['entries'][MODULE], 'Module source identity mismatch')
    a, b = [proof['packages'][arm]['entries'] for arm in ['A', 'B']]
    require(sorted(name for name in a.keys() | b.keys() if a.get(name) != b.get(name)) == [MODULE], 'Package allowlist mismatch')
    if original_artifacts:
        original = original_artifacts / ('hosted-' + order) / 'artifact.zip'
        data = original.read_bytes()
        require(len(data) == ARTIFACTS[order][1] and sha(data) == ARTIFACTS[order][2], 'Supplied original ZIP mismatch')
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            require(sorted(archive.namelist()) == sorted(entry['path'] for entry in entries), 'Original ZIP coverage mismatch')
            for entry in entries:
                data = archive.read(entry['path'])
                require(len(data) == entry['bytes'] and sha(data) == entry['sha256'], 'Original ZIP member mismatch')
            for arm in ['A', 'B']:
                with zipfile.ZipFile(io.BytesIO(archive.read('record-field-lengths-jmdict/package-' + arm + '.zip'))) as package:
                    actual = {name: sha(package.read(name)) for name in package.namelist() if not name.endswith('/')}
                    require(actual == proof['packages'][arm]['entries'], 'Original product package mismatch')


def adapted_original_auditor(root):
    data = (root / 'recovery/original-audit-hosted.py').read_bytes()
    require(len(data) == 7360 and sha(data) == ORIGINAL_AUDITOR, 'Original audit source changed')
    source = data.decode()
    old_repo = "repo=Path('/workspace/scratch/5a86d1e7822a/manabitan')"
    require(source.count(old_repo) == 1, 'Original repository binding changed')
    source = source.replace(old_repo, 'repo=Path(sys.argv[4]).resolve()')
    start = source.index("try:\n    archive=root/'artifact.zip'")
    end = source.index("    fixture=read(repo/'test/perf/dictionaries.lock.json')", start)
    # Package/inventory proof is checked above. Only original ZIP extraction and
    # bootstrap are replaced; every original receipt/memory/statistical check
    # from the fixture line onward executes unchanged against verified files.
    bootstrap = """try:
    evidence=root/'record-field-lengths-jmdict'
    plan=read(evidence/'registered-plan.json');obs=read(evidence/'observations.json');ids=read(evidence/'source-identities.json');browser=read(evidence/'browser-identity.json')
    assert plan['baseline']=='9e10d3b3fcf66d344ab31bc42c9b522fa5215da2' and plan['candidate']=='ab116fa90777cd64b067d4858318923f0f4e3ee7'
    assert plan['dictionary']=='jmdict' and plan['pairs']==6 and plan['initialOrder']==expected_order and plan['flags']=={}
    assert plan['expectedPackageEntries']==ids['changedPackageEntries']==['js/dictionary/term-record-opfs-store.js']
    assert len(obs)==20 and [{k:v for k,v in item.items() if k!='totalImportMs'} for item in obs]==plan['schedule']
    assert sha((checker_dir/'qualification_receipts.py').read_bytes())=='4f7b4eee4f8ff71e821c9162e57524460c48f01f409487f638523a3a27aa8f51'
"""
    adapted = source[:start] + bootstrap + source[end:]
    compile(adapted, 'adapted-original-audit', 'exec')
    path = root / 'recovery/adapted-original-audit.py'
    path.write_text(adapted)
    return path


def check_validation(root):
    snapshots = read(root / 'recovery/connector-snapshots.json')
    require(snapshots['finalRunId'] == 46102823858 and snapshots['initialRunId'] == 46102040540, 'CI source changed')
    jobs = {job['id']: job for job in snapshots['finalJobs']['jobs']}
    require(set(jobs) == {140848896866, 140853176572, 140853176579} and
            all(job['conclusion'] == 'success' and job['status'] == 'completed' for job in jobs.values()), 'Incomplete corrected gate')
    initial = {job['id']: job for job in snapshots['initialJobs']['jobs']}
    require(initial[140846425703]['conclusion'] == 'failure' and initial[140848081178]['conclusion'] == 'skipped', 'Initial failure missing')
    data = (root / 'validation/original.zip').read_bytes()
    require(len(data) == 47132 and sha(data) == '0115dae32253c88b5a8ca8ef2496971e2e1f2379df6de4be40e53f2048bab8d9', 'Validation ZIP changed')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        require(len(archive.namelist()) == 7, 'Validation coverage changed')
        for name in archive.namelist():
            require(archive.read(name) == (root / 'validation' / name).read_bytes(), 'Validation log changed')
    unit = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', (root / 'validation/unit.log').read_text())
    require(re.search(r'Test Files\s+669 passed', unit) and re.search(r'Tests\s+15137 passed\s+\|\s+47 skipped', unit), 'Unit result changed')
    require('Ran 32 tests' in (root / 'validation/observers.log').read_text(), 'Observer result missing')
    failure = (root / 'recovery/initial-failed-job-retrieved.log').read_text()
    require('@throws' in failure and 'jsdoc/require-throws' in failure, 'Original lint failure missing')


def main():
    require(__debug__, 'Do not use optimized Python (-O)')
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--evidence', type=Path, default=Path(__file__).resolve().parent)
    ap.add_argument('--extract', type=Path)
    ap.add_argument('--original-artifacts', type=Path)
    args = ap.parse_args()
    manifest = read(args.evidence / 'manifest.json')
    require(manifest['schemaVersion'] == 1 and manifest['baseline'] == BASELINE and manifest['candidate'] == CANDIDATE and
            manifest['runId'] == 46102823858 and manifest['frozenSourceHashes'] == CHECKERS, 'Manifest source mismatch')
    verifier = Path(__file__).read_bytes()
    require(manifest['verifier'] == {'file': Path(__file__).name, 'bytes': len(verifier), 'sha256': sha(verifier)}, 'Verifier identity changed')
    with tempfile.TemporaryDirectory(prefix='field-recovery-audit-') as temporary:
        root = Path(temporary)
        extract(args.evidence, manifest, root)
        for path, expected in CHECKERS.items():
            require(sha((root / 'frozen-repository' / path).read_bytes()) == expected, 'Frozen checker changed')
        audit = adapted_original_auditor(root)
        results = []
        for order in ['AB', 'BA']:
            check_package_proof(root, order, args.original_artifacts)
            host = root / ('hosted-' + order)
            completed = subprocess.run([sys.executable, '-B', str(audit), str(host), ARTIFACTS[order][2], order,
                                        str(root / 'frozen-repository')], capture_output=True, text=True)
            require(completed.returncode == 0, 'Original receipt audit failed: ' + completed.stderr)
            original = (host / 'reproduced-original-audit.json').read_bytes()
            reproduced = (host / 'independent-audit.json').read_bytes()
            require(original == reproduced and sha(reproduced) == AUDITS[order], 'Original audit output not reproduced')
            result = json.loads(reproduced)
            results.append({'order': order, 'auditSha256': sha(reproduced), 'semanticReceipts': result['semanticReceiptCount'],
                            'memory': result['memoryRawAudit'], 'analysis': result['analysisRecomputed']})
        require(sum(item['semanticReceipts'] for item in results) == 52 and
                sum(item['memory']['rawScanCount'] for item in results) == 578, 'Cohort coverage changed')
        published = read(root / 'recovery/published-component-index.json')
        require(published['source'] == '3f137c22eefa2b347cd7e0ed7e307f3528f62ac9' and len(published['files']) == 21, 'Published component source changed')
        for record in published['files']:
            data = (root / 'published-component' / record['path']).read_bytes()
            blob = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
            require(len(data) == record['bytes'] and blob == record['sha'], 'Published component file changed')
        check_validation(root)
        if args.extract:
            require(not args.extract.exists(), 'Extraction directory already exists')
            shutil.copytree(root, args.extract)
        print(json.dumps({'status': 'PASS', 'noAcquisition': True, 'baseline': BASELINE, 'candidate': CANDIDATE,
                          'semanticReceipts': 52, 'rawMemoryScans': 578, 'publishedLocalFiles': 21,
                          'hosts': results, 'originalProductZipBytesRechecked': bool(args.original_artifacts),
                          'archiveSha256': manifest['archive']['sha256'], 'recovery': manifest['recovery'],
                          'packageLimitation': manifest['packageLimitation'], 'disposition': manifest['disposition']}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('FAIL: ' + str(error), file=sys.stderr)
        raise SystemExit(1) from error
