from pathlib import Path
import hashlib
import json
import math
import statistics
import sys

ROOT = Path('/workspace/scratch/3aacd533c01f')
BASE = ROOT / 'manabitan'
EXPECTED = {
    'A': {'commit': '3d65e403c644b9a5a6be3128d72f9d30050b70e0', 'tree': 'c540375466fc921ab05a5526a6130bc2d48010d5'},
    'B': {'commit': 'd2ab3344a483af52ac6d0765f3fbeaf8d1e2a0ca', 'tree': '24e3e31fb86f8c2587f1753f940da359162427cf'},
}
EXPECTED['C'] = EXPECTED['A']
RUNTIME = {
    'A': 'f1cdc2f7d471d805d8cfe35d0cd8bcdbeb339dc97268f9772f545f9779028cd9',
    'B': 'fa29e41b5ddd7bf99bc0aa2de1bf76c972baad795b67d4ce4215fa244bafd087',
}
RUNTIME['C'] = RUNTIME['A']
WASM = '25149bac5db0dda3bba85fe8e133fb06d51881a822f27565e4587ba223dde41c'
ORDERS = ['ABC', 'CBA', 'BAC', 'CAB', 'BCA', 'ACB']


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    return json.loads(path.read_text())


def verify(dictionary):
    root = ROOT / 'evidence' / f'fields-{dictionary}'
    metadata = read(root / 'artifact-metadata.json')
    assert digest(root / 'archive.zip') == metadata['digest'].removeprefix('sha256:')
    protocol = read(root / 'protocol.json')
    assert protocol['sourceIdentities'] == EXPECTED
    assert protocol['github']['GITHUB_RUN_ID'] == '45264553669'
    assert protocol['toolingCommit'] == 'a784ff1706c57189f36eca5cbff832f82be7c822'
    assert protocol['runnerSha256'] == digest(root / 'runner.py')
    assert protocol['nodeVersion'] == 'v22.22.0'
    assert protocol['stage'] == 'screen' and protocol['orders'] == ORDERS
    assert protocol['harnessOverlay'] is None
    for name, expected in protocol['unchangedHarnessSha256'].items():
        assert digest(BASE / name) == expected, name
    fixture = read(BASE / 'test/perf/dictionaries.lock.json')['dictionaries'][dictionary]
    assert protocol['fixture'] == fixture
    actual_fixture = read(root / 'fixture.json')
    assert actual_fixture['fixture'] == fixture
    assert actual_fixture['sha256'] == fixture['sha256']
    assert actual_fixture['sizeBytes'] == fixture['sizeBytes']
    packages = {arm: read(root / f'package-{arm}.json') for arm in 'ABC'}
    for arm, package in packages.items():
        assert package['source'] == EXPECTED[arm]
        assert package['entries']['js/dictionary/term-record-opfs-store.js'] == RUNTIME[arm]
        assert package['entries']['lib/term-bank-parser.wasm'] == WASM
    assert packages['C']['archiveSha256'] == packages['A']['archiveSha256']
    assert packages['C']['entries'] == packages['A']['entries']
    difference = sorted(name for name in set(packages['A']['entries']) | set(packages['B']['entries'])
                        if packages['A']['entries'].get(name) != packages['B']['entries'].get(name))
    assert difference == ['js/dictionary/term-record-opfs-store.js']
    assert difference == read(root / 'package-differences.json')
    assert (root / 'source-status-A.txt').read_text().strip() == ''
    assert (root / 'source-status-B.txt').read_text().strip() == ''
    observations = read(root / 'observations.json')
    names = [f'warmup-{arm}' for arm in 'ABC']
    names += [f'block-{i:02d}-{position}-{arm}' for i, order in enumerate(ORDERS, 1)
              for position, arm in enumerate(order, 1)]
    names += ['diagnostic-A', 'diagnostic-B']
    assert [item['name'] for item in observations] == names
    assert all(item['status'] == 'success' for item in observations)
    receipts, media, storage, lookup, values, cold, warm, phases = [], {}, set(), [], {arm: [] for arm in 'ABC'}, {}, {}, []
    for item in observations:
        arm = item['arm']
        summary = read(root / item['summary'])
        assert item['source'] == EXPECTED[arm]
        assert summary['gitSha'] == summary['source']['gitSha'] == EXPECTED[arm]['commit']
        assert summary['source']['dirty'] is False
        assert summary['schemaVersion'] == 3 and summary['buildTarget'] == 'chrome'
        assert summary['fixture'] == fixture and summary['dictionary'] == dictionary
        assert summary['traceEnabled'] is False and summary['importFlags'] is None
        assert summary['authoritativeTiming'] is True
        assert summary['browserVersion'] == '153.0.8010.12'
        assert summary['hostEnvironment']['nodeVersion'] == 'v22.22.0'
        for name, expected in summary['source']['sha256'].items():
            if name in protocol['unchangedHarnessSha256']:
                assert protocol['unchangedHarnessSha256'][name] == expected
        assert len(summary['runs']) == 1
        run = summary['runs'][0]
        assert run['packageSha256'] == packages[arm]['archiveSha256']
        assert summary['source']['sha256']['builds/manabitan-chrome.zip'] == packages[arm]['archiveSha256']
        assert run['browserVersion'] == summary['browserVersion']
        assert run['totalImportMs'] == item['totalImportMs'] > 0
        assert run['tracePath'] is None
        validation = run['validation']
        for key, expected in [('title', fixture['expectedTitle']), ('revision', fixture['revision']), ('termRows', fixture['termRows']), ('contentReadable', True), ('probeCount', 12)]:
            assert validation[key] == expected, (item['name'], key)
            assert validation['restart'][key] == expected, (item['name'], 'restart', key)
        assert validation['restart']['mediaFiles'] == fixture['mediaFiles']
        rows = validation['lookup']['observations']
        assert len(rows) == 72 and {row['pass'] for row in rows} == set(range(6))
        assert all(sum(row['pass'] == index for row in rows) == 12 for index in range(6))
        assert all(row['hasExactHeadwordMatch'] and row['results'] > 0 for row in rows)
        receipt = sorted([row['pass'], row['term'], row['results'], row['sha256']] for row in rows)
        if lookup:
            assert receipt == lookup
        lookup = receipt
        assert validation['media']['mode'] == item['mediaCheck'] == summary['mediaCheck']
        assert validation['media']['totalFiles'] == fixture['mediaFiles']
        assert validation['media']['totalBytes'] == fixture['mediaBytes']
        if item['mediaCheck'] == 'all':
            assert validation['media']['files'] == fixture['mediaFiles']
            assert validation['media']['bytes'] == fixture['mediaBytes']
        if item['mediaCheck'] in media:
            assert media[item['mediaCheck']] == validation['media']
        media[item['mediaCheck']] = validation['media']
        sizes = validation['storage']
        assert sum(file['bytes'] for file in sizes['files']) == sizes['bytes'] == item['storageBytes']
        storage.add(sizes['bytes'])
        receipts.append(validation['outputDigestSha256'])
        if item['cohort'] == 'timed':
            values[arm].append(item['totalImportMs'])
            cold[item['name']] = sum(row['elapsedMs'] for row in rows if row['pass'] == 0)
            warm[item['name']] = sum(row['elapsedMs'] for row in rows if row['pass'] > 0) / 5
        details = [row['details'] for row in read(root / item['phaseCounters']) if row['phase'].startswith('term-file-fast-path:')]
        phases.append({'name': item['name'], 'rows': sum(row['rows'] for row in details),
                       'groups': sum(row['parserParallelGroupCount'] for row in details),
                       'compactMetadataGroups': sum(row['parserCompactContentMetadataGroups'] for row in details),
                       'fieldEncodeMs': sum(row['termRecordFieldEncodeMs'] for row in details)})
    assert len(storage) == 1 and len(set(receipts)) == 1
    expected_correctness = read(root / 'correctness.json')
    assert expected_correctness['status'] == 'passed'
    assert expected_correctness['identicalReceipts']['lookup'] == lookup
    assert expected_correctness['identicalReceipts']['storageBytes'] == next(iter(storage))
    assert expected_correctness['identicalReceipts']['media-all'] == media['all']
    assert expected_correctness['identicalReceipts']['media-sample'] == media['sample']
    analysis = read(root / 'analysis.json')
    assert analysis['allTimingsMs'] == values
    for name, first, second in [('candidate', 'A', 'B'), ('candidateVsSecondBaseline', 'C', 'B'), ('identicalProductControl', 'A', 'C')]:
        changes = [(b / a - 1) * 100 for a, b in zip(values[first], values[second])]
        assert changes == analysis[name]['pairedChangesPercent']
        assert statistics.median(changes) == analysis[name]['pairedMedianPercent']
        assert math.isclose((sum(values[second]) / sum(values[first]) - 1) * 100, analysis[name]['equalWorkPercent'])
    state = read(root / 'state.json')
    assert state['status'] == 'success' and state['attemptedObservations'] == 23 and state['timedObservations'] == 18
    result = {'status': 'passed', 'dictionary': dictionary, 'archiveSha256': digest(root / 'archive.zip'),
              'sourceIdentities': EXPECTED, 'packageSha256': {arm: p['archiveSha256'] for arm, p in packages.items()},
              'packageEntryCount': len(packages['A']['entries']), 'packageDifferences': difference,
              'observationsVerified': len(observations), 'failures': [], 'storageBytes': next(iter(storage)),
              'outputDigestSha256': receipts[0], 'lookupReceiptsPerObservation': len(lookup), 'media': media,
              'timing': values, 'phaseObservations': phases, 'coldLookup12ProbeTotalMs': cold,
              'warmLookup12ProbeMeanPassTotalMs': warm,
              'limits': 'Manifest and recorded per-observation package hashes verified; release ZIP bytes are not contained in the artifact. Lookup receipts are 12 sampled probes over six passes, not exhaustive persisted-row equality. Phase sums remain scoped and are not added to whole-import elapsed time.'}
    (root / 'independent-verification.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({key: value for key, value in result.items() if key not in ['phaseObservations', 'coldLookup12ProbeTotalMs', 'warmLookup12ProbeMeanPassTotalMs']}, indent=2))


for dictionary in sys.argv[1:]:
    verify(dictionary)
