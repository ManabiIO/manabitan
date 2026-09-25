#!/usr/bin/env python3
"""Compare complete imports; keep controls, failures and every raw observation."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import statistics
import subprocess
import time
import zipfile

base = Path(os.environ['BASE_ROOT'])
candidate = Path(os.environ['CANDIDATE_ROOT'])
output = Path(os.environ['EVIDENCE_ROOT'])
output.mkdir(parents=True, exist_ok=True)
source = Path('ext/js/dictionary/term-record-opfs-store.js')
package = Path('builds/manabitan-chrome-dev.zip')
roots = {'A': base, 'B': candidate}
expected = {'A': '8896aaca2fd1ad1692ad7400cd42b25b094ebbf02c5959b940fa2a13b66dd974',
            'B': 'b101cec2345f8f1bc3a674f48fa31cfcb087dd2687ce809c29ced6d51a0ad9bb'}

def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def git(root, *args):
    return subprocess.check_output(['git', *args], cwd=root, text=True).strip()

assert git(base, 'rev-parse', 'HEAD') == 'a3925549826671bc1026035f43f0fde2e407077c'
for arm, directory in roots.items():
    assert sha(directory / source) == expected[arm]

with zipfile.ZipFile(base / package) as a, zipfile.ZipFile(candidate / package, 'w') as b:
    for member in a.infolist():
        data = (candidate / 'ext' / member.filename).read_bytes() if member.filename == source.relative_to('ext').as_posix() else a.read(member.filename)
        b.writestr(member, data)
with zipfile.ZipFile(base / package) as a, zipfile.ZipFile(candidate / package) as b:
    assert a.namelist() == b.namelist()
    assert {name for name in a.namelist() if a.read(name) != b.read(name)} == {source.relative_to('ext').as_posix()}

def identity(directory):
    return {'commit': git(directory, 'rev-parse', 'HEAD'),
            'tree': git(directory, 'rev-parse', 'HEAD^{tree}'),
            'status': git(directory, 'status', '--porcelain'),
            'sourceSha256': sha(directory / source),
            'packageSha256': sha(directory / package),
            'wasmSha256': sha(directory / 'ext/lib/term-bank-parser.wasm'),
            'lockSha256': sha(directory / 'test/perf/dictionaries.lock.json'),
            'harnessSha256': sha(directory / 'test/chromium/extension-two-dictionary-import.e2e.js')}

identities = {arm: identity(directory) for arm, directory in roots.items()}
assert all(not item['status'] for item in identities.values()), identities
assert identities['A']['wasmSha256'] == identities['B']['wasmSha256']
assert identities['A']['lockSha256'] == identities['B']['lockSha256']
assert identities['A']['harnessSha256'] == identities['B']['harnessSha256']
plan = []
for dictionary, initial in [('jmdict', 'AB'), ('jitendex', 'BA')]:
    plan.extend({'dictionary': dictionary, 'kind': 'warmup', 'pair': 0, 'arm': arm, 'binary': arm} for arm in initial)
    for pair in range(1, 9):
        order = initial if pair % 2 else initial[::-1]
        plan.extend({'dictionary': dictionary, 'kind': 'measured', 'pair': pair, 'arm': arm, 'binary': arm} for arm in order)
        if pair % 2 == 0:
            plan.extend({'dictionary': dictionary, 'kind': 'aa', 'pair': pair // 2, 'arm': arm, 'binary': 'A'} for arm in ('AB' if pair % 4 else 'BA'))
(output / 'plan.json').write_text(json.dumps({'identities': identities, 'plan': plan, 'flags': {}, 'noRetries': True, 'noOutlierRemoval': True, 'timingBoundary': 'file-input change to post-UI import completion', 'node': subprocess.check_output(['node', '--version'], text=True).strip()}, indent=2))
observations = []
for ordinal, item in enumerate(plan, 1):
    directory = roots[item['binary']]
    assert identity(directory) == identities[item['binary']]
    destination = output / f"{ordinal:02}-{item['dictionary']}-{item['kind']}-{item['pair']}-{item['arm']}"
    started = time.monotonic()
    with Path(str(destination) + '.log').open('w') as log:
        completed = subprocess.run(['node', 'dev/perf/import-benchmark.js', item['dictionary'], '--runs', '1', '--no-build', '--flags', '{}', '--output', str(destination)], cwd=directory, stdout=log, stderr=subprocess.STDOUT, timeout=240)
    assert completed.returncode == 0, f'Failed observation {ordinal}; raw failure retained'
    summary = json.loads((destination / 'summary.json').read_text())
    report = json.loads((destination / 'run-1.json').read_text())
    assert report['status'] == 'success' and report['skippedVerification'] is False
    assert summary['source']['dirty'] is False
    assert summary['source']['sha256']['builds/manabitan-chrome-dev.zip'] == identities[item['binary']]['packageSha256']
    measurement = summary['runs'][0]
    observations.append({**item, 'ordinal': ordinal, 'ms': measurement['totalImportMs'], 'workerMs': measurement['workerImportMs'], 'validation': measurement.get('validation'), 'browser': summary['browserVersion'], 'wallSeconds': time.monotonic() - started})
    (output / 'observations.json').write_text(json.dumps(observations, indent=2))
    print(json.dumps(observations[-1]), flush=True)

results = []
for dictionary in ('jmdict', 'jitendex'):
    result = {'dictionary': dictionary}
    for kind in ('measured', 'aa'):
        selected = [x for x in observations if x['dictionary'] == dictionary and x['kind'] == kind]
        pairs = []
        for pair in sorted({x['pair'] for x in selected}):
            cell = {x['arm']: x for x in selected if x['pair'] == pair}
            pairs.append({'pair': pair, 'aMs': cell['A']['ms'], 'bMs': cell['B']['ms'], 'changePct': 100 * (cell['B']['ms'] / cell['A']['ms'] - 1)})
        result[kind] = {'aMedianMs': statistics.median(x['aMs'] for x in pairs), 'bMedianMs': statistics.median(x['bMs'] for x in pairs), 'pairedMedianPct': statistics.median(x['changePct'] for x in pairs), 'fasterPairs': sum(x['changePct'] < 0 for x in pairs), 'pairs': pairs}
    results.append(result)
(output / 'comparison.json').write_text(json.dumps(results, indent=2))
(output / 'complete.json').write_text(json.dumps({'completed': len(observations), 'planned': len(plan)}, indent=2))
print(json.dumps(results, indent=2))
