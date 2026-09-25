#!/usr/bin/env python3
"""Pinned, serial whole-import comparisons with unchanged-code controls."""
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess
import zipfile

BASE = '76362775484661b3cd8b9d2c84b228802c023a76'
a = Path('/tmp/more-base')
b = Path('/tmp/more-candidate')
out = Path('/tmp/more-evidence')
kind = os.environ['CANDIDATE']
assert kind in ('numeric-recheck', 'quote-first')
pairs_count = int(os.environ.get('PAIRS', '6'))
initial = os.environ.get('INITIAL', 'AB')
assert pairs_count >= 2 and pairs_count % 2 == 0 and initial in ('AB', 'BA')
source = 'ext/js/dictionary/wasm/term-bank-parser.c'
package = 'builds/manabitan-chrome-dev.zip'

def git(root, *args):
    return subprocess.check_output(['git', *args], cwd=root, text=True).strip()

def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def identity(root):
    paths = [source, package, 'ext/lib/term-bank-parser.wasm', 'ext/lib/zstd.wasm', 'test/perf/dictionaries.lock.json', 'test/chromium/extension-two-dictionary-import.e2e.js']
    return {'commit': git(root, 'rev-parse', 'HEAD'), 'tree': git(root, 'rev-parse', 'HEAD^{tree}'), 'status': git(root, 'status', '--porcelain'), 'hashes': {p: sha(root / p) for p in paths}}

assert git(a, 'rev-parse', 'HEAD') == BASE
assert git(b, 'rev-parse', 'HEAD^') == BASE
assert set(git(b, 'diff', '--name-only', 'HEAD^', 'HEAD').splitlines()) == {source, 'test/term-bank-native-pass-equivalence.test.js'}
ids = {'A': identity(a), 'B': identity(b)}
assert not ids['A']['status'] and not ids['B']['status'], ids
allowed = [source.removeprefix('ext/'), 'lib/term-bank-parser.wasm']
with zipfile.ZipFile(a / package) as za, zipfile.ZipFile(b / package) as zb:
    assert sorted(za.namelist()) == sorted(zb.namelist())
    differences = sorted(n for n in za.namelist() if za.read(n) != zb.read(n))
    assert differences == sorted(allowed), differences
for p in ids['A']['hashes']:
    if p not in [source, package, 'ext/lib/term-bank-parser.wasm']:
        assert ids['A']['hashes'][p] == ids['B']['hashes'][p], p
plan = []
for dictionary in [os.environ['DICTIONARY']]:
    plan.extend({'dictionary': dictionary, 'kind': 'warmup', 'pair': 0, 'arm': arm, 'binary': arm} for arm in initial)
    for pair in range(1, pairs_count + 1):
        order = initial if pair % 2 else initial[::-1]
        plan.extend({'dictionary': dictionary, 'kind': 'measured', 'pair': pair, 'arm': arm, 'binary': arm} for arm in order)
        if pair % 2 == 0:
            plan.extend({'dictionary': dictionary, 'kind': 'aa', 'pair': pair // 2, 'arm': arm, 'binary': 'A'} for arm in ('AB' if pair % 4 else 'BA'))
(out / 'plan.json').write_text(json.dumps({'base': BASE, 'candidate': kind, 'identities': ids, 'plan': plan, 'flags': {}, 'noRetries': True, 'noOutlierRemoval': True, 'boundary': 'file-input change through post-UI completion'}, indent=2))
observations = []
for ordinal, item in enumerate(plan, 1):
    root = a if item['binary'] == 'A' else b
    assert identity(root) == ids[item['binary']]
    destination = out / f"{ordinal:03}-{item['dictionary']}-{item['kind']}-{item['pair']}-{item['arm']}"
    with Path(str(destination) + '.log').open('w') as log:
        result = subprocess.run(['node', 'dev/perf/import-benchmark.js', item['dictionary'], '--runs', '1', '--no-build', '--flags', '{}', '--output', str(destination)], cwd=root, stdout=log, stderr=subprocess.STDOUT, timeout=240)
    assert result.returncode == 0, f'Observation {ordinal} failed; retained without retry'
    summary = json.loads((destination / 'summary.json').read_text())
    report = json.loads((destination / 'run-1.json').read_text())
    assert report['status'] == 'success' and report['skippedVerification'] is False
    assert not summary['source']['dirty']
    assert summary['source']['sha256'][package] == ids[item['binary']]['hashes'][package]
    run = summary['runs'][0]
    observations.append({**item, 'ordinal': ordinal, 'ms': run['totalImportMs'], 'workerMs': run['workerImportMs'], 'validation': run.get('validation'), 'browser': summary['browserVersion']})
    (out / 'observations.json').write_text(json.dumps(observations, indent=2))
    print(json.dumps(observations[-1]), flush=True)
comparisons = []
for dictionary in [os.environ['DICTIONARY']]:
    comparison = {'dictionary': dictionary}
    for lane in ['measured', 'aa']:
        selected = [v for v in observations if v['dictionary'] == dictionary and v['kind'] == lane]
        pairs = []
        for pair in sorted({v['pair'] for v in selected}):
            group = {v['arm']: v for v in selected if v['pair'] == pair}
            av, bv = group['A']['ms'], group['B']['ms']
            pairs.append({'pair': pair, 'aMs': av, 'bMs': bv, 'changePct': 100 * (bv / av - 1)})
        comparison[lane] = {'aMedianMs': statistics.median(v['aMs'] for v in pairs), 'bMedianMs': statistics.median(v['bMs'] for v in pairs), 'pairedMedianPct': statistics.median(v['changePct'] for v in pairs), 'fasterPairs': sum(v['changePct'] < 0 for v in pairs), 'pairs': pairs}
    comparisons.append(comparison)
(out / 'comparison.json').write_text(json.dumps(comparisons, indent=2))
(out / 'complete.json').write_text(json.dumps({'planned': len(plan), 'completed': len(observations)}))
print(json.dumps(comparisons, indent=2))
