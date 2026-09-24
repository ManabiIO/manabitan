import hashlib
import json
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import sys

root = Path.cwd()
corpus = sys.argv[1]
out = root.parent / 'repeat-results'
out.mkdir(exist_ok=True)
source = root / 'ext/js/dictionary/term-record-opfs-store.js'
base = '2185eeaac05efa0fd60eea49e3f00ce3e048aabe'
baseline = subprocess.check_output(['git', 'show', base + ':ext/js/dictionary/term-record-opfs-store.js'])
variants = {'A': baseline, 'B': source.read_bytes()}
data = {'baseSha': base, 'corpus': corpus, 'pairs': 3, 'order': ['BA', 'AB', 'BA'], 'sourceHashes': {k: hashlib.sha256(v).hexdigest() for k, v in variants.items()}, 'warmups': [], 'controls': [], 'observations': [], 'complete': False}

def save():
    (out / 'results.json').write_text(json.dumps(data, indent=2))

def run(arm, label):
    source.write_bytes(variants[arm])
    shutil.copyfile(out / (arm + '.zip'), root / 'builds/manabitan-chrome-dev.zip')
    destination = out / label
    with (out / (label + '.log')).open('w') as log:
        subprocess.run(['node', 'dev/perf/import-benchmark.js', corpus, '--runs', '1', '--no-build', '--output', str(destination)], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=360)
    summary = json.loads((destination / 'summary.json').read_text())
    timing = summary['runs'][0]
    value = {'arm': arm, 'label': label, 'ms': timing['totalImportMs'], 'workerMs': timing['workerImportMs'], 'browserVersion': summary['browserVersion']}
    print(json.dumps(value), flush=True)
    return value

try:
    for arm in ['A', 'B']:
        source.write_bytes(variants[arm])
        with (out / (arm + '-build.log')).open('w') as log:
            subprocess.run(['node', 'dev/bin/build.js', '--target', 'chrome-dev'], stdout=log, stderr=subprocess.STDOUT, check=True)
        shutil.copyfile(root / 'builds/manabitan-chrome-dev.zip', out / (arm + '.zip'))
        data.setdefault('buildHashes', {})[arm] = hashlib.sha256((out / (arm + '.zip')).read_bytes()).hexdigest()
    for arm in ['B', 'A']:
        data['warmups'].append(run(arm, 'warmup-' + arm))
        save()
    for label in ['control-before-1', 'control-before-2']:
        data['controls'].append(run('A', label))
        save()
    for pair, order in enumerate(data['order'], 1):
        for arm in order:
            result = run(arm, str(pair) + '-' + arm)
            result['pair'] = pair
            data['observations'].append(result)
            save()
    for label in ['control-after-1', 'control-after-2']:
        data['controls'].append(run('A', label))
        save()
    ratios = []
    for pair in range(1, 4):
        a, b = [next(v['ms'] for v in data['observations'] if v['pair'] == pair and v['arm'] == arm) for arm in ['A', 'B']]
        ratios.append(b / a)
    data['summary'] = {'medianPairedChangePercent': 100 * (statistics.median(ratios) - 1), 'ratios': ratios, 'fasterPairs': sum(r < 1 for r in ratios), 'controlRatios': [data['controls'][i + 1]['ms'] / data['controls'][i]['ms'] for i in [0, 2]]}
    data['complete'] = True
    save()
    print(json.dumps(data['summary']), flush=True)
except Exception as error:
    data['error'] = str(error)
    save()
    raise
finally:
    source.write_bytes(variants['B'])
    for arm in ['A', 'B']:
        (out / (arm + '.zip')).unlink(missing_ok=True)
