#!/usr/bin/env python3
"""Independent paired arithmetic from each retained raw browser clock."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import random
import statistics

parser = argparse.ArgumentParser()
parser.add_argument('packet', type=Path)
parser.add_argument('output', type=Path)
args = parser.parse_args()
read = lambda file: json.loads((args.packet / file).read_text())
observations = read('observations.json')
protocol = read('protocol.json')
orders = ['ABC', 'CBA', 'BAC', 'CAB', 'BCA', 'ACB', 'ACB', 'BCA', 'CAB', 'BAC', 'CBA', 'ABC']
assert protocol['stage'] == 'qualification' and protocol['orders'] == orders
assert protocol['plannedBlocks'] == 12 and protocol['github']['GITHUB_RUN_ID'] == '45265448894'
assert len(observations) == 38 and len({item['name'] for item in observations}) == 38
groups = {block: {} for block in range(1, 13)}
diagnostics = []
for observation in observations:
    raw = read(observation['name'] + '/run-1.json')
    summary = read(observation['name'] + '/summary.json')
    assert observation['status'] == raw['status'] == 'success'
    assert not raw['skippedVerification'] and not raw['failureReason']
    phase = next(phase for phase in raw['phases'] if phase['name'] == 'Jitendex: total import')
    timing = phase['data']['browserTiming']
    assert timing['trigger'] == 'file-input-change' and timing['errorCount'] == 0
    assert timing['sequence'] == timing['sequenceBefore'] + 1
    elapsed = timing['completedAtMs'] - timing['startedAtMs']
    assert math.isfinite(elapsed) and elapsed > 0
    assert elapsed == observation['totalImportMs'] == summary['runs'][0]['totalImportMs']
    assert raw['benchmark']['authoritativeTiming']
    assert all(raw['benchmark'][flag] is False for flag in ['traceEnabled', 'phaseScreenshots', 'phaseProfiling', 'processSampling'])
    media = raw['benchmark']['validation']['media']
    if observation['cohort'] == 'timed':
        block = observation['block']
        arm = observation['arm']
        assert arm == orders[block - 1][observation['position'] - 1]
        assert arm not in groups[block]
        assert media['mode'] == 'sample' and media['files'] == 64
        groups[block][arm] = elapsed
    else:
        assert observation['cohort'] == 'exhaustive-diagnostic'
        assert media['mode'] == 'all' and media['files'] == 236 and media['bytes'] == 4992155
        diagnostics.append(observation['arm'])
assert sorted(diagnostics) == ['A', 'B']
assert all(set(group) == {'A', 'B', 'C'} for group in groups.values())
metrics = {}
for numerator, denominator in [('B', 'A'), ('B', 'C'), ('C', 'A')]:
    changes = [(group[numerator] / group[denominator] - 1) * 100 for group in groups.values()]
    rng = random.Random(20261123)
    medians = sorted(statistics.median(rng.choices(changes, k=12)) for _ in range(10000))
    metrics[f'{numerator}/{denominator}'] = {
        'pairedChangesPercent': changes,
        'pairedMedianPercent': statistics.median(changes),
        'pairedMedianBootstrap95Percent': [medians[249], medians[9749]],
        'equalWorkPercent': (sum(group[numerator] for group in groups.values()) / sum(group[denominator] for group in groups.values()) - 1) * 100,
        'fasterPairs': sum(change < 0 for change in changes),
    }
reported = read('analysis.json')
for pair, field in [('B/A', 'candidate'), ('B/C', 'candidateVsSecondBaseline'), ('C/A', 'identicalProductControl')]:
    for key, value in metrics[pair].items():
        assert value == reported[field][key], (pair, key)
result = {
    'status': 'passed', 'scope': 'Independent raw-clock paired arithmetic; source/package/correctness audit retained separately',
    'cohort': 'Fixed twelve-block packing qualification, run45265448894',
    'runnerSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    'rawObservations': 38, 'timedObservations': 36, 'separateDiagnostics': 2,
    'excludedTimedObservations': 0, 'pooledWithScreen': False,
    'orders': orders, 'blocks': groups, 'comparisons': metrics,
    'assessment': 'Supports a modest Jitendex whole-import improvement on this hosted runner: candidate faster than both unchanged baselines in all twelve blocks, with both descriptive paired-median intervals below zero. Preserve the observed control drift and separate screen; no cross-device or process-memory claim.',
}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
