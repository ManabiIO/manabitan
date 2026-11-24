#!/usr/bin/env python3
"""Summarize the retained native-kernel replay without excluding slow rounds."""
import hashlib
import json
import random
import statistics
import sys
from pathlib import Path

workspace = Path(__file__).resolve().parent
source = Path(sys.argv[1]) if len(sys.argv) > 1 else workspace / 'canonical-local-counters-bench-jitendex.json'
destination = source.with_name(source.stem + '-analysis.json')
report = json.loads(source.read_text())
assert report['complete'] is True
assert report['mode'] == 'bench'
assert report['sources']['baselineCommit'] == 'd24b4e56ceb1fe14ad96ef3853f4d397efa6fa26'
assert report['sources']['baselineWasm'] == '40948d5c20d26253e86c93d267e3cbb3817ea87c9731e02bcca0523c0eb3d6af'
assert report['sources']['candidateWasm'] == '04fdb51271a20d9152b8655f33b3e6fa36a4048380ba69010a5288761143c9f0'
permutations = [['A', 'B', 'C'], ['B', 'C', 'A'], ['C', 'A', 'B'], ['C', 'B', 'A'], ['A', 'C', 'B'], ['B', 'A', 'C']]
assert report['schedule'] == [{'warmup': True, 'order': ['A', 'B', 'C']}] * 2 + [{'warmup': False, 'order': x} for x in permutations * 2]


def paired(numerator, denominator, rows):
    values = [(row[numerator] / row[denominator] - 1) * 100 for row in rows]
    rng = random.Random(0x0a175)
    samples = sorted(statistics.median(rng.choices(values, k=len(values))) for _ in range(10000))
    return {
        'medianPercent': statistics.median(values),
        'descriptiveBootstrap95Percent': [samples[249], samples[9749]],
        'fasterRounds': sum(x < 0 for x in values),
        'rounds': len(values),
        'minPercent': min(values),
        'maxPercent': max(values),
        'pairedPercent': values,
    }


analysis = {
    'schema': 1,
    'input': source.name,
    'inputSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
    'analyzerSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    'candidateLocalCommit': '0eb65e80712eb31037792cc831f10b24b827ac7c',
    'candidateTree': 'e3b9546229ac4118cc3e539678522446d74cff1d',
    'runtimeFrozenAt': '5d35b544a7bb2c74384df470e2f43faad52dde6e',
    'wasmBytes': {'baseline': 1624, 'candidate': 1760, 'increase': 136},
    'scope': 'Each native call is captured from the production owner using four-bank component partitions. All three independent memories are restored from the complete identical snapshot before each replay. Header, config and every byte from layout.META through the end of memory compare exactly, including journal tails. The compiler private stack is excluded. This does not perform browser, compression, or storage work.',
    'statistics': 'The twelve retained round totals sum that replay position over all captured calls. Two warmup rounds per call were excluded by the fixed protocol; no measured observations were removed. The bootstrap intervals describe this local component replay and are not independent whole-import confidence intervals.',
    'limitations': 'The local host was shared with concurrent validation. Process CPU clocks can also include background work. Equal-work C is a second independent instance of the exact A module. No whole-import, browser, cross-device, or memory benefit is established.',
    'dictionaries': [],
}
for item in report['dictionaries']:
    for call in item['calls']:
        assert len(call['rounds']) == len(report['schedule'])
        assert call['returnCode'] in (0, 1)
        assert len(call['header']) == 7
        assert len(call['outputSha256']) == 64
    summary = {key: value for key, value in item.items() if key != 'calls'}
    summary['nativeCalls'] = len(item['calls'])
    baseline_stores = sum(call['header'][1] - call['cursor'] + call['header'][2] + call['header'][3] + call['header'][4] + call['header'][0] for call in item['calls'])
    candidate_stores = 5 * len(item['calls'])
    summary['sourceDerivedHeaderCounterStores'] = {
        'baseline': baseline_stores,
        'candidate': candidate_stores,
        'removed': baseline_stores - candidate_stores,
        'scope': 'Derived from successful oracle call headers and the frozen C statements for h[1] through h[5]. Includes final boundary publication; excludes the identical seven initial header stores per call and unchanged h[0] journal progress. This is not a hardware instruction or latency measurement.',
    }
    summary['metrics'] = {}
    for key, units in [('timings', 'milliseconds'), ('cpuMicros', 'microseconds')]:
        rows = [{role: sum(call['rounds'][i][key][role] for call in item['calls']) for role in 'ABC'}
                for i, step in enumerate(report['schedule']) if not step['warmup']]
        summary['metrics'][key] = {
            'units': units,
            'aggregateRounds': rows,
            'roleMedians': {role: statistics.median(row[role] for row in rows) for role in 'ABC'},
            'comparisons': {f'{a}/{b}': paired(a, b, rows) for a, b in [('B', 'A'), ('B', 'C'), ('C', 'A')]},
        }
    analysis['dictionaries'].append(summary)
analysis['conclusion'] = 'No native performance gain is established by this shared-host screen: B is nearly equal to unchanged control C, while A and C themselves drift materially. The complete native-state parity checks passed. Keep browser qualification separate.'
destination.write_text(json.dumps(analysis, indent=2) + '\n')
print(destination)
for item in analysis['dictionaries']:
    print(item['dictionary'], item['nativeCalls'], 'calls')
    for metric, summary in item['metrics'].items():
        print(metric, json.dumps({name: {k: v for k, v in values.items() if k != 'pairedPercent'} for name, values in summary['comparisons'].items()}))
