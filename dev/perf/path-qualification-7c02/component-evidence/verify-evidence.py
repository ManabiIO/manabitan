#!/usr/bin/env python3
"""Verify the preserved component receipts without imports or timing."""
import collections
import gzip
import hashlib
import json
import math
from pathlib import Path
import statistics
import tarfile

root = Path(__file__).resolve().parent
sha = lambda data: hashlib.sha256(data).hexdigest()
manifest = json.loads((root / 'manifest.json').read_bytes())
for entry in manifest['files']:
    data = (root / entry['path']).read_bytes()
    assert len(data) == entry['sizeBytes'], entry['path']
    assert sha(data) == entry['sha256'], entry['path']
    if 'uncompressedSha256' in entry:
        raw = gzip.decompress(data)
        assert len(raw) == entry['uncompressedSizeBytes'], entry['path']
        assert sha(raw) == entry['uncompressedSha256'], entry['path']

result_raw = gzip.decompress((root / 'component-result.json.gz').read_bytes())
fixture_raw = gzip.decompress((root / 'fixture-manifest.json.gz').read_bytes())
frozen_raw = (root / 'frozen-inputs.json').read_bytes()
result = json.loads(result_raw)
fixture = json.loads(fixture_raw)
frozen = json.loads(frozen_raw)
audit = json.loads((root / 'independent-audit.json').read_bytes())
assert sha(result_raw) == '294fdad7cd4e052737597cc422f2d6ee0527cc48f5f067d58f5e56e2efe87c34'
assert sha(fixture_raw) == result['fixtureManifestSha256'] == '810c067eabf70271a5440775751420ce065e3bfc1ce2a47bfd2cb61c4876a8a2'
assert sha(frozen_raw) == result['frozenInputsSha256'] == fixture['frozenInputsSha256']
assert result['sourceIdentity'] == frozen == fixture['sourceIdentity']
assert result['complete'] and not result['failures']
assert fixture['complete'] and not fixture['failures']
assert audit['status'] == 'passed' and audit['resultSha256'] == sha(result_raw)
assert audit['fixtureManifestSha256'] == sha(fixture_raw)
schedule = [['A', 'B', 'C'], ['C', 'B', 'A'], ['B', 'C', 'A'],
            ['A', 'C', 'B'], ['C', 'A', 'B'], ['B', 'A', 'C']]
assert result['schedule'] == frozen['schedule'] == schedule
assert result['repetitions'] == frozen['repetitions'] == 8
assert frozen['excludedWarmupObservationsPerArmGroup'] == 2
groups = {entry['groupKey']: entry for entry in fixture['groups']}
assert len(groups) == len(fixture['groups']) == 170
assert fixture['rows'] == 6648310
assert fixture['copiedMediaRows'] == 146725
assert fixture['uniqueMediaPaths'] == 146570
assert sum(entry['sourceRows'] for entry in groups.values()) == 6648310
assert result['fixtureTotals'] == fixture['totals']
for key, value in fixture['totals'].items():
    assert sum(entry['counts'][key] for entry in groups.values()) == value, key

observations = result['observations']
assert len(observations) == 3060
seen = set()
aggregates = collections.defaultdict(lambda: dict(groups=0, cpuMs=0., wallMs=0., threadCpuMs=0.))
metrics = ('cpuMs', 'wallMs', 'threadCpuMs')
for item in observations:
    group, block, arm = item['group'], item['block'], item['arm']
    key = (group, block, arm)
    assert group in groups and key not in seen
    seen.add(key)
    assert item['repetitions'] == 8
    assert schedule[block][item['position']] == arm
    assert item['mediaRows'] == groups[group]['counts']['mediaRows']
    bucket = aggregates[(block, arm)]
    bucket['groups'] += 1
    for metric in metrics:
        assert math.isfinite(item[metric]) and item[metric] >= 0
        bucket[metric] += item[metric]
assert seen == {(group, block, arm) for group in groups for block in range(6) for arm in 'ABC'}
close = lambda a, b: math.isclose(a, b, rel_tol=1e-12, abs_tol=1e-9)
assert len(result['aggregateObservations']) == 18
for item in result['aggregateObservations']:
    bucket = aggregates[(item['block'], item['arm'])]
    assert item['groups'] == bucket['groups'] == 170 and item['repetitions'] == 8
    for metric in metrics:
        assert close(item[metric], bucket[metric]), (item, metric)

comparisons = {}
for name, control_arm, candidate_arm in [('B/A', 'A', 'B'), ('B/C', 'C', 'B'), ('C/A', 'A', 'C')]:
    pairs = []
    for block in range(6):
        control, candidate = aggregates[(block, control_arm)], aggregates[(block, candidate_arm)]
        pairs.append({
            'cpuChangePercent': (candidate['cpuMs'] / control['cpuMs'] - 1) * 100,
            'wallChangePercent': (candidate['wallMs'] / control['wallMs'] - 1) * 100,
            'cpuSavedPerCorpusMs': (control['cpuMs'] - candidate['cpuMs']) / 8,
            'wallSavedPerCorpusMs': (control['wallMs'] - candidate['wallMs']) / 8,
        })
    expected = result['comparisons'][name]
    assert len(expected['pairs']) == 6
    for block, (saved, pair) in enumerate(zip(expected['pairs'], pairs)):
        assert saved['block'] == block
        for key, value in pair.items():
            assert close(saved[key], value), (name, block, key)
    comparison = {
        'cpuMedianPercent': statistics.median(pair['cpuChangePercent'] for pair in pairs),
        'wallMedianPercent': statistics.median(pair['wallChangePercent'] for pair in pairs),
        'cpuMedianSavedPerCorpusMs': statistics.median(pair['cpuSavedPerCorpusMs'] for pair in pairs),
        'wallMedianSavedPerCorpusMs': statistics.median(pair['wallSavedPerCorpusMs'] for pair in pairs),
        'cpuFasterPairs': sum(pair['cpuChangePercent'] < 0 for pair in pairs),
        'wallFasterPairs': sum(pair['wallChangePercent'] < 0 for pair in pairs),
    }
    for key, value in comparison.items():
        assert close(expected[key], value), (name, key)
        assert close(audit['comparisons'][name][key], value), ('audit', name, key)
    comparisons[name] = comparison
checks = {
    'completeAndMatching': True,
    'relativeGain': all(comparisons[name]['cpuMedianPercent'] <= -15 and
                        comparisons[name]['wallMedianPercent'] <= -15 and
                        comparisons[name]['cpuFasterPairs'] >= 5 and
                        comparisons[name]['wallFasterPairs'] >= 5 for name in ('B/A', 'B/C')),
    'absoluteCpuGain': all(comparisons[name]['cpuMedianSavedPerCorpusMs'] >= 15 for name in ('B/A', 'B/C')),
    'unchangedControls': abs(comparisons['C/A']['cpuMedianPercent']) <= 5 and abs(comparisons['C/A']['wallMedianPercent']) <= 5,
}
assert checks == result['gates']['checks'] == audit['gates']
assert all(checks.values()) == result['gates']['allGatesPass'] == audit['allGatesPass']
with tarfile.open(root / 'loaded-probes.tar.gz', 'r:gz') as archive:
    expected = [*frozen['probes'].values(), frozen['observer']]
    assert set(archive.getnames()) == {Path(item['path']).name for item in expected}
    for item in expected:
        data = archive.extractfile(Path(item['path']).name).read()
        assert len(data) == item['bytes'] and sha(data) == item['sha256']
for item in frozen['scripts']:
    name = Path(item['path']).name
    local = root / name if name == 'benchmark-plan.md' else root / 'reproduction' / name
    assert sha(local.read_bytes()) == item['sha256']
print(json.dumps({'status': 'passed', 'scope': 'Saved-data verification only; no imports or timings',
                  'manifestSha256': sha((root / 'manifest.json').read_bytes()),
                  'files': len(manifest['files']), 'groups': len(groups), 'observations': len(observations),
                  'aggregateMetrics': len(result['aggregateObservations']) * len(metrics),
                  'gates': checks, 'comparisons': comparisons}, sort_keys=True))
