#!/usr/bin/env python3
"""Serial full-browser cohorts. No retries, trimming, or cross-host pooling."""
import hashlib
import json
import os
import pathlib
import shutil
import statistics
import subprocess

out = pathlib.Path('builds/bounded-native')
dictionary = os.environ['DICTIONARY']
flags = {
    'P': {},
    'A': {},
    'B': {'experimentalNativeSegmentedLookup': True},
    'C': {'experimentalNativeSegmentedLookup': True, 'experimentalLookupScratchReuse': True},
}
packages = {'P': 'parent', 'A': 'candidate', 'B': 'candidate', 'C': 'parent'}
plan = [{'kind': 'warmup', 'block': -1, 'label': arm, 'arm': arm} for arm in ['P', 'A', 'B', 'C']]
for block in range(6):
    # Reverse the first control/candidate order relative to the discovery screen.
    for kind in (['control', 'candidate'] if block % 2 == 0 else ['candidate', 'control']):
        for label in ['A', 'B', 'B', 'A']:
            plan.append({'kind': kind, 'block': block, 'label': label,
                         'arm': label if kind == 'candidate' else 'A'})
for kind, pair in [('source-overhead', ('P', 'A')), ('previous-bounded-path', ('C', 'B'))]:
    for block in range(2):
        for label in ['A', 'B', 'B', 'A']:
            plan.append({'kind': kind, 'block': block, 'label': label,
                         'arm': pair[0 if label == 'A' else 1]})
(out / 'plan.json').write_text(json.dumps(plan, indent=2))
identities = {}
for variant in ['parent', 'candidate']:
    for name in ['package.zip', 'parser.js', 'parser.wasm']:
        p = out / variant / name
        identities[f'{variant}/{name}'] = hashlib.sha256(p.read_bytes()).hexdigest()
(out / 'timing-identities.json').write_text(json.dumps(identities, indent=2))
observations = []
for index, item in enumerate(plan):
    arm = item['arm']
    variant = packages[arm]
    copies = {'package.zip': 'builds/manabitan-chrome-dev.zip',
              'parser.js': 'ext/js/dictionary/term-bank-wasm-parser.js',
              'parser.wasm': 'ext/lib/term-bank-parser.wasm'}
    for name, destination in copies.items():
        source = out / variant / name
        assert hashlib.sha256(source.read_bytes()).hexdigest() == identities[f'{variant}/{name}']
        shutil.copyfile(source, destination)
    target = out / f'{index:03d}-{item["kind"]}-{arm}'
    command = ['node', 'dev/perf/import-benchmark.js', dictionary, '--runs', '1',
               '--no-build', '--flags', json.dumps(flags[arm]), '--output', str(target)]
    with (out / f'{index:03d}.log').open('w') as log:
        subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=240)
    summary = json.loads((target / 'summary.json').read_text())
    assert summary['authoritativeTiming'] and not summary['traceEnabled']
    run = summary['runs'][0]
    assert run['importDebug']['errorCount'] == 0
    phases = [p['details'] for p in run['importDebug']['importerPhaseTimings']
              if p['phase'].startswith('term-file-fast-path:')]
    assert phases
    if arm == 'B' and dictionary != 'jitendex':
        assert sum(p['parserNativeSegmentedLookupSegments'] for p in phases) > 0
        assert sum(p['parserNativeLookupScratchReusedBytes'] for p in phases) > 0
    for name, destination in copies.items():
        assert hashlib.sha256(pathlib.Path(destination).read_bytes()).hexdigest() == identities[f'{variant}/{name}']
    observation = {**item, 'index': index, 'ms': run['totalImportMs'], 'flags': flags[arm],
                   'report': str(target / 'run-1.json'), 'details': phases,
                   'reportSha256': hashlib.sha256((target / 'run-1.json').read_bytes()).hexdigest(),
                   'packageSha256': identities[f'{variant}/package.zip']}
    observations.append(observation)
    (out / 'observations.json').write_text(json.dumps(observations, indent=2))
    print(index, item['kind'], arm, round(observation['ms'], 3), flush=True)
assert len(observations) == len(plan)
results = {}
for kind in ['candidate', 'control', 'source-overhead', 'previous-bounded-path']:
    rows = [x for x in observations if x['kind'] == kind]
    changes, a, b, totals = [], [], [], []
    for offset in range(0, len(rows), 4):
        block = rows[offset:offset+4]
        assert [x['label'] for x in block] == ['A', 'B', 'B', 'A']
        totals.append(100 * ((block[1]['ms'] + block[2]['ms']) / (block[0]['ms'] + block[3]['ms']) - 1))
        for ai, bi in [(0, 1), (3, 2)]:
            aa, bb = block[ai]['ms'], block[bi]['ms']
            a.append(aa)
            b.append(bb)
            changes.append(100 * (bb / aa - 1))
    results[kind] = {'pairChangesPct': changes, 'blockChangesPct': totals,
                     'medianPairedPct': statistics.median(changes),
                     'medianAbsolutePct': statistics.median(map(abs, changes)),
                     'equalWorkPct': 100 * (sum(b) / sum(a) - 1),
                     'fasterPairs': sum(x < 0 for x in changes),
                     'aMedianMs': statistics.median(a), 'bMedianMs': statistics.median(b)}
(out / 'result.json').write_text(json.dumps(results, indent=2))
(out / 'COMPLETE').write_text(str(len(observations)) + '\n')
print(json.dumps(results, indent=2))
