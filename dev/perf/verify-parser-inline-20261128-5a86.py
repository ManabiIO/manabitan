#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Audit retained original inline-study evidence without acquiring new imports."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import random
import re
import statistics
import sys
import tarfile
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / 'builds/perf/parser-inline-20261128-5a86'
BASELINE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
CANDIDATE = 'ed09ddbd9c20352e4690ade354e91a9bd70392a4'
PACKAGE_DELTA = {'js/dictionary/wasm/term-bank-parser.c', 'lib/term-bank-parser.wasm'}
PARSER = {'A': '8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee',
          'B': '1cb15eda380145fe66c98e2b8397d1146552fc520dfdb600f22a0e478d7f6245'}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    return json.loads(path.read_text())


def paired(items, kind, right):
    pairs = {}
    for item in items:
        if item['kind'] == kind:
            pair = pairs.setdefault(item['pair'], {})
            assert item['arm'] not in pair
            pair[item['arm']] = item['totalImportMs']
    assert len(pairs) == (6 if kind == 'candidate' else 2)
    assert all(set(pair) == {'A', right} for pair in pairs.values())
    ratios = [pair[right] / pair['A'] for pair in pairs.values()]
    rng = random.Random(897)
    bootstrap = sorted(statistics.median(rng.choices(ratios, k=len(ratios))) for _ in range(10000))
    return {'count': len(pairs), 'ratios': ratios,
            'medianPairedChangePercent': (statistics.median(ratios) - 1) * 100,
            'equalWorkChangePercent': (sum(pair[right] for pair in pairs.values()) / sum(pair['A'] for pair in pairs.values()) - 1) * 100,
            'worstPairChangePercent': (max(ratios) - 1) * 100,
            'descriptiveBootstrap95Percent': [(bootstrap[i] - 1) * 100 for i in (249, 9749)],
            'fasterPairs': sum(value < 1 for value in ratios)}


def expected_schedule(order):
    result = []
    for pair, current in enumerate((order, order[::-1]), 1):
        result.extend({'id': f'warmup-{pair}-{arm}', 'kind': 'warmup', 'pair': pair, 'arm': arm} for arm in current)
    for pair in range(1, 7):
        result.extend({'id': f'pair-{pair:02d}-{arm}', 'kind': 'candidate', 'pair': pair, 'arm': arm}
                      for arm in (order if pair % 2 else order[::-1]))
        if pair % 3 == 0:
            control = pair // 3
            current = 'AC' if (control + (order == 'BA')) % 2 else 'CA'
            result.extend({'id': f'control-{control:02d}-{arm}', 'kind': 'control', 'pair': control, 'arm': arm} for arm in current)
    return result


def original_archive(path, identity, source_identities=None):
    assert path.stat().st_size == identity['sizeBytes']
    assert sha(path.read_bytes()) == identity['sha256']
    with zipfile.ZipFile(path) as archive:
        assert len(archive.namelist()) == len(set(archive.namelist()))
        assert set(archive.namelist()) == set(identity['members'])
        assert archive.testzip() is None
        for info in archive.infolist():
            data = archive.read(info)
            assert {'bytes': len(data), 'sha256': sha(data), 'crc32': info.CRC} == identity['members'][info.filename]
            if info.filename.endswith(('/package-A.zip', '/package-B.zip')):
                arm = info.filename[-5]
                expected = source_identities['arms'][arm]
                assert sha(data) == expected['packageSha256']
                with zipfile.ZipFile(io.BytesIO(data)) as package:
                    assert len(package.namelist()) == len(set(package.namelist()))
                    assert package.testzip() is None
                    entries = {entry.filename: sha(package.read(entry)) for entry in package.infolist() if not entry.is_dir()}
                assert entries == expected['entries']


def audit_host(root, order, manifest, originals, helpers):
    validate, match, audit_memory, memory_schedule, overlay = helpers
    evidence = root / 'hosted' / order
    invocation = read(root / 'hosted' / (order + '-driver') / 'invocation.json')
    assert invocation['status'] == 'complete' and invocation['exitCode'] == 0
    assert invocation['candidate'] == CANDIDATE and invocation['baseline'] == BASELINE
    assert invocation['flags'] == {} and invocation['pairs'] == 6 and invocation['retries'] == 0
    plan = read(evidence / 'registered-plan.json')
    assert plan['baseline'] == BASELINE and plan['candidate'] == CANDIDATE
    assert plan['initialOrder'] == order and plan['pairs'] == 6 and plan['flags'] == {}
    assert set(plan['expectedPackageEntries']) == PACKAGE_DELTA
    assert plan['schedule'] == expected_schedule(order)
    assert plan['memorySchedule'] == memory_schedule(1 if order == 'AB' else 2)
    observed = read(evidence / 'observations.json')
    assert len(observed) == len(plan['schedule']) == 20
    for prescribed, item in zip(plan['schedule'], observed):
        assert all(item[key] == value for key, value in prescribed.items())
    identities = read(evidence / 'source-identities.json')
    assert set(identities['changedPackageEntries']) == PACKAGE_DELTA
    origin = manifest['originalArtifacts'][order]
    for arm in ('A', 'B'):
        identity = identities['arms'][arm]
        assert identity['sha'] == (BASELINE if arm == 'A' else CANDIDATE)
        assert origin['members'][f'{order}/package-{arm}.zip']['sha256'] == identity['packageSha256']
        assert identity['entries']['lib/term-bank-parser.wasm'] == PARSER[arm]
        assert len(identity['entries']) == 554
    a, b = (identities['arms'][arm]['entries'] for arm in ('A', 'B'))
    assert set(a) == set(b)
    assert {name for name in a if a[name] != b[name]} == PACKAGE_DELTA
    if originals:
        original_archive(originals / (order + '.zip'), origin, identities)
    browser = read(evidence / 'browser-identity.json')
    assert browser['version'] == '153.0.8010.12'
    assert browser['sha256'] == '8c599d43aec53f2460a31ae2f4af6bd863f8258b34ff519564bc5d4726bfaa1e'
    fixture = manifest['fixture']
    expected = [(item['id'], 'B' if item['arm'] == 'B' else 'A', 'sample', False) for item in observed]
    expected += [('exhaustive-media-' + arm, arm, 'all', False) for arm in order]
    expected += [('memory/' + item['name'], item['arm'], 'sample', True) for item in plan['memorySchedule']]
    assert len(expected) == 26
    original_harness = (evidence / 'memory/harness-original.js').read_text()
    instrumented_harness = (evidence / 'memory/harness-instrumented.js').read_text()
    assert instrumented_harness == overlay(original_harness)
    receipts, policy, common_hashes = [], set(), set()
    for name, arm, media, memory in expected:
        location = evidence / name
        summary, report = read(location / 'summary.json'), read(location / 'run-1.json')
        identity = identities['arms'][arm]
        hashes = identity['sourceHashes'].copy()
        if memory:
            hashes['test/chromium/extension-two-dictionary-import.e2e.js'] = sha(instrumented_harness.encode())
        rebuilt = validate(summary, report, dictionary='jmdict', fixture=fixture,
                           source_sha=identity['sha'], package_sha256=identity['packageSha256'],
                           browser_version=browser['version'], import_flags=None, source_hashes=hashes,
                           source_dirty=memory, media_check=media)
        assert rebuilt == read(location / 'canonical-receipt.json')
        if receipts:
            match(receipts[0], rebuilt, compare_media=media == 'sample')
        receipts.append(rebuilt)
        common_hashes.add(sha(json.dumps(rebuilt['common'], sort_keys=True).encode()))
        for dictionary in summary['runs'][0]['step4Breakdown']['dictionaries']:
            policy.add((dictionary['parserWorkerCount'], dictionary['parserGroupCount']))
        item = next((item for item in observed if item['id'] == name), None)
        if item:
            assert summary['runs'][0]['totalImportMs'] == item['totalImportMs']
    assert len(common_hashes) == 1 and policy == {(3, 12)}
    analysis = read(evidence / 'analysis.json')
    assert analysis['candidateVsBaseline'] == paired(observed, 'candidate', 'B')
    assert analysis['identicalCodeControl'] == paired(observed, 'control', 'C')
    memory = audit_memory(evidence / 'memory')
    assert memory == read(evidence / 'memory/memory-audit.json')
    assert memory['passesProspectiveMemoryScreen']
    assert analysis['status'] == 'correctness-memory-passed' and analysis['memoryPassed']
    return {'imports': len(receipts), 'commonReceiptSha256': next(iter(common_hashes)),
            'browser': browser, 'policy': [list(value) for value in sorted(policy)], 'analysis': analysis, 'memoryAudit': memory}


def audit_local(root):
    first = read(root / 'local/jmdict-component-ab.json')
    assert first['complete'] is False and first['observations'] == [] and 'ENOENT' in first['error']
    report = read(root / 'local/jmdict-component-ab-corrected-cache.json')
    assert report['complete'] is True and report['pairs'] == 6 and len(report['observations']) == 12
    assert report['dictionary'] == 'jmdict' and report['flags'] == {} and report['validateGlossaryTypes'] is True
    assert report['initialOrder'] == 'AB'
    identities = read(root / 'hosted/AB/source-identities.json')['arms']
    runner_hash = sha((root / 'source/component-runner.js').read_bytes())
    lock_hash = sha((root / 'source/dictionaries.lock.json').read_bytes())
    expected = [(pair, arm) for pair in range(6) for arm in ('AB' if pair % 2 == 0 else 'BA')]
    assert [(item['pair'], item['arm']) for item in report['observations']] == expected
    pairs, digests = {}, set()
    for item in report['observations']:
        value = item['result']
        assert value['rows'] == 528299 and value['flags'] == {} and value['filesPerGroup'] == 7
        assert value['validateGlossaryTypes'] is True and value['nativeSegments'] == 21
        assert value['wasmSha256'] == PARSER[item['arm']]
        assert value['runnerSha256'] == runner_hash and value['lockSha256'] == lock_hash
        assert value['archiveSha256'] == '3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f'
        for path, expected_hash in value['sourceHashes'].items():
            assert path.startswith('ext/') and identities[item['arm']]['entries'][path[4:]] == expected_hash
        digests.add(value['digest'])
        pair = pairs.setdefault(item['pair'], {})
        assert item['arm'] not in pair
        pair[item['arm']] = value['elapsedMs']
    assert len(pairs) == 6 and all(set(pair) == {'A', 'B'} for pair in pairs.values())
    assert digests == {'8f1001b400c6f34e67ae6981cf4532c0dbd7a7b8bc98a10086da224289dbfff1'}
    ratios = [pair['B'] / pair['A'] for pair in pairs.values()]
    measured = {'medianPairedChangePercent': (statistics.median(ratios) - 1) * 100,
                'equalWorkTotalChangePercent': (sum(pair['B'] for pair in pairs.values()) / sum(pair['A'] for pair in pairs.values()) - 1) * 100,
                'fasterPairs': sum(ratio < 1 for ratio in ratios)}
    assert measured == report['summary']
    return {'failedInitialObservations': 0, 'completedObservations': 12, 'summary': measured,
            'scope': 'Fixed seven-bank component grouping, not the production planner or a complete import'}


def main():
    if not __debug__:
        raise RuntimeError('Audit assertions must not be disabled with -O or PYTHONOPTIMIZE')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--original-artifacts', type=Path, help='Optional directory containing original AB.zip, BA.zip and validation.zip')
    args = parser.parse_args()
    manifest = read(EVIDENCE / 'manifest.json.txt')
    assert manifest['baseline'] == BASELINE and manifest['candidate'] == CANDIDATE
    assert sha(Path(__file__).read_bytes()) == manifest['auditorSha256']
    assert sha((EVIDENCE / 'summary.json.txt').read_bytes()) == manifest['summarySha256']
    archive_path = EVIDENCE / 'observations.tar.gz'
    assert archive_path.stat().st_size == manifest['retainedArchive']['sizeBytes']
    assert sha(archive_path.read_bytes()) == manifest['retainedArchive']['sha256']
    with tempfile.TemporaryDirectory(prefix='inline-evidence-audit-') as temporary:
        root = Path(temporary)
        with tarfile.open(archive_path, 'r:gz') as archive:
            entries = archive.getmembers()
            assert len(entries) == len({entry.name for entry in entries})
            assert {entry.name for entry in entries} == set(manifest['retainedArchive']['members'])
            for entry in entries:
                relative = PurePosixPath(entry.name)
                assert entry.isfile() and not relative.is_absolute() and '..' not in relative.parts
                data = archive.extractfile(entry).read()
                assert {'bytes': len(data), 'sha256': sha(data)} == manifest['retainedArchive']['members'][entry.name]
                target = root / entry.name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
        for order in ('AB', 'BA'):
            identity = manifest['originalArtifacts'][order]
            for name, member in identity['members'].items():
                if name in identity['omittedMembers']:
                    assert name in (f'{order}/package-A.zip', f'{order}/package-B.zip')
                    continue
                data = (root / 'hosted' / name).read_bytes()
                assert len(data) == member['bytes'] and sha(data) == member['sha256']
        for filename, expected in manifest['frozenAuditSupport'].items():
            assert sha((root / 'audit-support' / filename).read_bytes()) == expected
        sys.path.insert(0, str(root / 'audit-support'))
        from qualification_receipts import validate_import_summary, require_matching_receipts
        from audit_memory import audit_cell
        from protocol import schedule, memory_overlay
        helpers = (validate_import_summary, require_matching_receipts, audit_cell, schedule, memory_overlay)
        hosts = {order: audit_host(root, order, manifest, args.original_artifacts, helpers) for order in ('AB', 'BA')}
        assert hosts['AB']['commonReceiptSha256'] == hosts['BA']['commonReceiptSha256']
        local = audit_local(root)
        validation = root / 'validation.zip'
        original_archive(validation, manifest['originalArtifacts']['validation'])
        with zipfile.ZipFile(validation) as original:
            unit = re.sub(r'\x1b\[[0-9;]*m', '', original.read('unit.log').decode())
            assert '669 passed (669)' in unit and '15135 passed | 47 skipped' in unit
            assert PARSER['B'] in original.read('native-rebuild.log').decode()
        validation_job = (root / 'job-logs/validation.log').read_text()
        assert 'Ran 32 tests in ' in validation_job
        assert re.search(r'(?m)^\S+Z OK$', validation_job) is not None
        if args.original_artifacts:
            original_archive(args.original_artifacts / 'validation.zip', manifest['originalArtifacts']['validation'])
        expected = read(EVIDENCE / 'summary.json.txt')
        assert hosts == expected['hosts'] and local == expected['localComponent']
        print(json.dumps({'status': 'PASS', 'baseline': BASELINE, 'candidate': CANDIDATE,
                          'imports': sum(host['imports'] for host in hosts.values()),
                          'rawMemoryScans': sum(host['memoryAudit']['rawScanCount'] for host in hosts.values()),
                          'originalProductZipBytesReverified': args.original_artifacts is not None,
                          'hosts': hosts, 'localComponent': local,
                          'decision': 'No replicated material complete-import gain; no PR or further acquisition.'}, indent=2))


if __name__ == '__main__':
    main()
