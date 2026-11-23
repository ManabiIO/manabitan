"""Independently audit retained PR 848 receipts without executing study code."""

import hashlib
import json
import math
from pathlib import Path
import random
import statistics


ROOT = Path('/workspace/scratch/3aacd533c01f')
BASE = ROOT / 'evidence'
SOURCE = {
    'A': {'commit': '3d65e403c644b9a5a6be3128d72f9d30050b70e0', 'tree': 'c540375466fc921ab05a5526a6130bc2d48010d5'},
    'B': {'commit': '09dfb90d926758205ff52d127ef3d950f0b15a65', 'tree': '1f9015b2176056ce75c26b5e02054fcd1fd673be'},
    'C': {'commit': '3d65e403c644b9a5a6be3128d72f9d30050b70e0', 'tree': 'c540375466fc921ab05a5526a6130bc2d48010d5'},
}
FIXTURE_HASH = 'e914c76596220dffc6ee0c069cd05992f03adb2988c12c3cebe817a3ac271356'
FORWARD = ['ABC', 'CBA', 'BAC', 'CAB', 'BCA', 'ACB', 'ACB', 'BCA', 'CAB', 'BAC', 'CBA', 'ABC']
DIFFERENCES = ['js/dictionary/wasm/term-bank-parser.c', 'lib/term-bank-parser.wasm']


def read(path):
    return json.loads(path.read_text())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def audit_host(host):
    folder = BASE / f'structured-confirmation-{host}'
    protocol = read(folder / 'protocol.json')
    state = read(folder / 'state.json')
    artifact = read(BASE / f'structured-confirmation-{host}-archive-receipt.json')
    packages = {arm: read(folder / f'package-{arm}.json') for arm in 'ABC'}
    analysis = read(folder / 'analysis.json')
    observations = read(folder / 'observations.json')
    correctness = read(folder / 'correctness.json')
    expected = correctness['identicalReceipts']

    assert protocol['sourceIdentities'] == SOURCE
    assert protocol['toolingCommit'] == '3a7ef48cf76e4f5ff52d41aefc41909018ee9fbd'
    assert protocol['runnerSha256'] == sha(folder / 'runner.py')
    assert protocol['github']['GITHUB_RUN_ID'] == '45263702223'
    assert protocol['github']['GITHUB_RUN_ATTEMPT'] == '1'
    assert protocol['harnessOverlay'] is None
    assert protocol['plannedBlocks'] == 12 and protocol['warmupsExcluded'] == 3
    assert protocol['reversedSchedule'] is (host == 2)
    orders = FORWARD if host == 1 else [value[::-1] for value in reversed(FORWARD)]
    assert protocol['orders'] == orders
    assert protocol['nodeVersion'] == 'v22.22.0'
    assert protocol['stage'] == 'qualification'
    assert state['status'] == 'success' and state['buildComplete'] is True
    assert state['attemptedObservations'] == len(observations) == 41
    assert state['timedObservations'] == 36 and state['exhaustiveDiagnostics'] == 2
    assert analysis['status'] == 'complete' and analysis['screeningOnly'] is False
    assert correctness['status'] == 'passed'
    assert read(folder / 'fixture.json')['sha256'] == FIXTURE_HASH
    assert read(folder / 'fixture.json')['sizeBytes'] == 38831822
    assert protocol['fixture']['sha256'] == FIXTURE_HASH
    assert protocol['expectedPackageDifferences'] == DIFFERENCES
    assert read(folder / 'package-differences.json') == DIFFERENCES
    assert not (folder / 'source-status-A.txt').read_text().strip()
    assert not (folder / 'source-status-B.txt').read_text().strip()
    for filename, digest in protocol['unchangedHarnessSha256'].items():
        assert sha(ROOT / 'manabitan' / filename) == digest, filename
    assert packages['C']['identicalArchiveFromArm'] == 'A'
    assert packages['A']['archiveSha256'] == packages['C']['archiveSha256']
    assert packages['A']['entries'] == packages['C']['entries']
    assert sorted(name for name in packages['A']['entries'].keys() | packages['B']['entries'].keys()
                  if packages['A']['entries'].get(name) != packages['B']['entries'].get(name)) == DIFFERENCES
    for arm in 'ABC':
        assert packages[arm]['source'] == SOURCE[arm]
        checkout = ROOT / ('jitendex-structured' if arm == 'B' else 'manabitan')
        assert packages[arm]['entries']['lib/term-bank-parser.wasm'] == sha(checkout / 'dev/data/dictionary-wasm/term-bank-parser.wasm')
        assert packages[arm]['entries']['js/dictionary/wasm/term-bank-parser.c'] == sha(checkout / 'ext/js/dictionary/wasm/term-bank-parser.c')

    timed = [entry for entry in observations if entry['cohort'] == 'timed']
    assert len(timed) == 36
    assert len({entry['name'] for entry in observations}) == 41
    assert [entry['arm'] for entry in observations[:3]] == list('ABC' if host == 1 else 'CBA')
    assert all(entry['cohort'] == 'excluded-warmup' for entry in observations[:3])
    assert [(entry['block'], entry['position'], entry['arm']) for entry in timed] == [
        (block, position, arm)
        for block, order in enumerate(orders, 1)
        for position, arm in enumerate(order, 1)
    ]
    assert [(entry['cohort'], entry['arm']) for entry in observations[-2:]] == [
        ('exhaustive-diagnostic', 'A'), ('exhaustive-diagnostic', 'B')
    ]
    hardware = set()
    output_digests = set()
    for entry in observations:
        arm = entry['arm']
        summary = read(folder / entry['summary'])
        run = summary['runs'][0]
        report = read(folder / entry['name'] / 'run-1.json')
        benchmark = report['benchmark']
        validation = run['validation']
        assert entry['status'] == 'success' and entry['source'] == SOURCE[arm]
        assert summary['schemaVersion'] == 3 and summary['dictionary'] == 'jitendex'
        assert summary['fixture'] == protocol['fixture']
        assert summary['source']['gitSha'] == summary['gitSha'] == SOURCE[arm]['commit']
        assert summary['source']['dirty'] is False
        assert summary['source']['sha256']['builds/manabitan-chrome.zip'] == packages[arm]['archiveSha256']
        for filename, digest in summary['source']['sha256'].items():
            if filename in protocol['unchangedHarnessSha256']:
                assert digest == protocol['unchangedHarnessSha256'][filename]
        assert report['status'] == 'success' and not report['failureReason']
        assert report['skippedVerification'] is False
        assert run['packageSha256'] == report['packageSha256'] == packages[arm]['archiveSha256']
        assert summary['browserVersion'] == run['browserVersion'] == report['browserVersion'] == '153.0.8010.12'
        assert summary['hostEnvironment']['nodeVersion'] == report['hostEnvironment']['nodeVersion'] == 'v22.22.0'
        assert summary['authoritativeTiming'] is True and summary['traceEnabled'] is False
        assert summary['importFlags'] is None and benchmark['importFlags'] is None
        assert all(benchmark[key] is False for key in ['traceEnabled', 'phaseProfiling', 'phaseScreenshots', 'processSampling'])
        assert all(benchmark[key] is True for key in ['authoritativeTiming', 'productionImportDefaults', 'pinnedDictionaries'])
        assert len(summary['runs']) == 1
        assert math.isfinite(run['totalImportMs']) and run['totalImportMs'] > 0
        assert run['totalImportMs'] == entry['totalImportMs']
        assert summary['mediaCheck'] == entry['mediaCheck'] == benchmark['mediaCheck']
        assert entry['mediaCheck'] == ('all' if entry['cohort'] == 'exhaustive-diagnostic' else 'sample')
        assert report['runtimeDiagnostics']['openStorageMode'] == 'opfs-sahpool'
        assert run['importDebug']['usesFallbackStorage'] is False
        assert run['importDebug']['errorCount'] == run['importDebug']['addSettingsErrorCount'] == 0
        assert benchmark['validation'] == validation
        assert validation['termRows'] == 436555 and validation['probeCount'] == 12 and validation['contentReadable'] is True
        assert validation['title'] == protocol['fixture']['expectedTitle']
        assert validation['revision'] == protocol['fixture']['revision']
        assert validation['restart'] == {
            'title': protocol['fixture']['expectedTitle'], 'revision': '2026.10.03.0',
            'termRows': 436555, 'mediaFiles': 236, 'contentReadable': True, 'probeCount': 12,
        }
        lookup = validation['lookup']['observations']
        assert len(lookup) == 72
        assert all(row['hasExactHeadwordMatch'] for row in lookup)
        assert sorted([[row['pass'], row['term'], row['results'], row['sha256']] for row in lookup]) == expected['lookup']
        assert validation['media'] == expected['media-' + entry['mediaCheck']]
        assert validation['storage']['bytes'] == entry['storageBytes'] == expected['storageBytes'] == 67466332
        assert sum(item['bytes'] for item in validation['storage']['files']) == 67466332
        output_digests.add(validation['outputDigestSha256'])
        hardware.add((report['hostEnvironment']['cpuModel'], report['hostEnvironment']['logicalCpuCount']))
    assert len(output_digests) == 1 and len(hardware) == 1
    assert expected['media-all']['files'] == 236 and expected['media-all']['bytes'] == 4992155

    values = {arm: [entry['totalImportMs'] for entry in timed if entry['arm'] == arm] for arm in 'ABC'}
    assert values == analysis['allTimingsMs']
    result = {}
    for key, baseline, candidate in [('candidate', 'A', 'B'), ('candidateVsSecondBaseline', 'C', 'B'), ('identicalProductControl', 'A', 'C')]:
        before, after = values[baseline], values[candidate]
        changes = [(b / a - 1) * 100 for a, b in zip(before, after)]
        rng = random.Random(20261123)
        samples = sorted(statistics.median(rng.choices(changes, k=12)) for _ in range(10000))
        computed = {
            'pairs': 12, 'fasterPairs': sum(value < 0 for value in changes),
            'pairedChangesPercent': changes, 'pairedMedianPercent': statistics.median(changes),
            'pairedMedianBootstrap95Percent': [samples[249], samples[9749]],
            'equalWorkPercent': (sum(after) / sum(before) - 1) * 100,
            'baselineMedianMs': statistics.median(before), 'candidateMedianMs': statistics.median(after),
        }
        assert all(analysis[key][name] == value for name, value in computed.items())
        result[key] = {**computed, 'bestPairPercent': min(changes), 'worstPairPercent': max(changes)}
    receipt = {
        'host': host, 'status': 'passed', 'archive': artifact, 'sourceIdentities': SOURCE,
        'hardware': list(hardware)[0], 'observations': 41, 'timedObservations': 36,
        'excludedWarmups': 3, 'exhaustiveDiagnostics': 2, 'sourceHashesMatchLocalFrozenBaseline': True,
        'packageDifferences': DIFFERENCES, 'identicalBaselineControl': True,
        'packageArchives': {arm: packages[arm]['archiveSha256'] for arm in 'ABC'},
        'outputProbeDigest': list(output_digests)[0], 'storageBytes': expected['storageBytes'],
        'exhaustiveMedia': expected['media-all'], 'sampledMedia': expected['media-sample'],
        'lookupReceiptsPerObservation': 72, 'statisticsRecomputed': True, 'comparisons': result,
        'scope': 'Audits retained receipts and all reported observations; no benchmark rerun, no claim of exhaustive persisted definition/index byte equality or process-memory qualification',
        'recommendation': 'Reject promotion as an import optimization: no material complete-import gain on this host; retain the draft and evidence',
    }
    (BASE / f'structured-confirmation-{host}-verification.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({key: value for key, value in receipt.items() if key != 'comparisons'}))
    print(json.dumps({key: {name: value for name, value in comparison.items() if name != 'pairedChangesPercent'} for key, comparison in result.items()}))


for HOST in (1, 2):
    audit_host(HOST)
