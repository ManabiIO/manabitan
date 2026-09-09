"""Fixed-count, adjacent source-build comparisons using the unchanged schema-3 harness."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--baseline', required=True)
parser.add_argument('--candidate', required=True)
parser.add_argument('--pairs', type=int, default=6)
parser.add_argument('--datasets', default='jmdict,jmnedict,jitendex')
parser.add_argument('--output', required=True)
parser.add_argument('--label', default='source comparison')
parser.add_argument('--warmups', type=int, default=1)
parser.add_argument('--pause-file')
args = parser.parse_args()
if args.pairs <= 0:
    raise ValueError('pairs must be positive')
roots = {'baseline': Path(args.baseline).resolve(), 'candidate': Path(args.candidate).resolve()}
output = Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=True)
if (output / 'plan.json').exists():
    raise FileExistsError('Refusing to overwrite an existing experiment')
node = os.environ.get('BENCHMARK_NODE') or shutil.which('node')
if node is None:
    raise RuntimeError('Node executable missing')
env = os.environ.copy()
env['PATH'] = str(Path(node).parent) + os.pathsep + env['PATH']
affinity = sorted(os.sched_getaffinity(0))[:4]


def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def git(root, *arguments):
    return subprocess.check_output(['git', *arguments], cwd=root, text=True).strip()


def cgroup(name):
    try:
        return (Path('/sys/fs/cgroup') / name).read_text().strip()
    except OSError:
        return None


common = [
    'package-lock.json', 'test/perf/dictionaries.lock.json',
    'dev/perf/dictionary-fixtures.js', 'dev/perf/import-benchmark.js',
    'dev/perf/benchmark-support.js', 'test/chromium/extension-two-dictionary-import.e2e.js',
    'ext/lib/zstd.wasm',
]
hashes = {arm: {file: sha(root / file) for file in common} for arm, root in roots.items()}
if hashes['baseline'] != hashes['candidate']:
    raise RuntimeError('Mismatched harness, locks, or WASM')
source = {}
for arm, root in roots.items():
    source[arm] = {
        'root': str(root), 'gitSha': git(root, 'rev-parse', 'HEAD'),
        'indexTree': git(root, 'write-tree'), 'diff': git(root, 'diff', 'HEAD', '--stat'),
        'packageSha256': sha(root / 'builds/manabitan-chrome-dev.zip'),
        'zipSha256': sha(root / 'ext/lib/zip.js'),
        'zipWorkerSha256': sha(root / 'ext/lib/z-worker.js'),
        'parserSourceSha256': sha(root / 'ext/js/dictionary/wasm/term-bank-parser.c'),
        'parserWasmSha256': sha(root / 'ext/lib/term-bank-parser.wasm'),
        'databaseSha256': sha(root / 'ext/js/dictionary/dictionary-database.js'),
        'preinternedPlanSha256': sha(root / 'ext/js/dictionary/term-record-preinterned-plan.js'),
        'diffSha256': hashlib.sha256(subprocess.check_output(['git', 'diff', 'HEAD', '--binary'], cwd=root)).hexdigest(),
    }
datasets = args.datasets.split(',')
if len(set(datasets)) != len(datasets) or not all(datasets):
    raise ValueError('Dataset names must be nonempty and unique')
schedule = []
for pair in range(1 - args.warmups, args.pairs + 1):
    for index in range(len(datasets)):
        dataset = datasets[(index + pair - 1) % len(datasets)]
        order = ['baseline', 'candidate'] if (pair + datasets.index(dataset)) % 2 else ['candidate', 'baseline']
        for arm in order:
            schedule.append({'pair': pair, 'dataset': dataset, 'arm': arm, 'order': order, 'warmup': pair <= 0})
result = {
    'label': args.label,
    'design': 'Fixed-count adjacent counterbalanced source A/B; rotating dictionaries; fresh profiles; no optional stopping',
    'source': source, 'commonHashes': hashes['baseline'],
    'runtime': subprocess.check_output([node, '--version'], text=True).strip(),
    'affinity': affinity, 'cpuMax': cgroup('cpu.max'), 'memoryMax': cgroup('memory.max'),
    'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'pairsPlanned': args.pairs, 'warmupPairsPerDataset': args.warmups, 'schedule': schedule, 'runs': [], 'warmupRuns': [], 'status': 'running',
}
(output / 'plan.json').write_text(json.dumps(result, indent=2))
try:
    for planned in schedule:
        # Pause only between runs; never interrupt an active import.
        while args.pause_file and Path(args.pause_file).exists():
            time.sleep(1)
        name = f"{planned['dataset']}-pair-{planned['pair']:02}-{planned['arm']}"
        folder = output / name
        log = output / f'{name}.log'
        root = roots[planned['arm']]
        if sha(root / 'builds/manabitan-chrome-dev.zip') != source[planned['arm']]['packageSha256']:
            raise RuntimeError('Package changed during benchmark')
        command = [
            'taskset', '-c', ','.join(map(str, affinity)), node,
            'dev/perf/import-benchmark.js', planned['dataset'], '--runs', '1',
            '--no-build', '--output', str(folder),
        ]
        before = {'loadavg': list(os.getloadavg()), 'cpuStat': cgroup('cpu.stat'), 'memoryCurrent': cgroup('memory.current')}
        started = time.monotonic()
        print('START', name, flush=True)
        with log.open('w') as stream:
            process = subprocess.run(command, cwd=root, env=env, stdout=stream, stderr=subprocess.STDOUT, timeout=600)
        if process.returncode:
            raise RuntimeError(f'{name}: exit {process.returncode}; inspect {log}')
        summary = json.loads((folder / 'summary.json').read_text())
        if not summary['authoritativeTiming'] or summary['traceEnabled'] or summary['schemaVersion'] != 3:
            raise RuntimeError('Unexpected timing mode or schema')
        run = summary['runs'][0]
        result['warmupRuns' if planned['warmup'] else 'runs'].append({
            **planned, 'totalImportMs': run['totalImportMs'], 'workerImportMs': run['workerImportMs'],
            'automationObservedImportMs': run['automationObservedImportMs'],
            'summary': str(folder / 'summary.json'), 'source': summary['source'],
            'browserVersion': summary['browserVersion'], 'hostBefore': before,
            'elapsedSeconds': time.monotonic() - started,
        })
        (output / 'results.json').write_text(json.dumps(result, indent=2))
        print('DONE', name, round(run['totalImportMs'], 1), 'ms', flush=True)
        time.sleep(0.5)
    result['completedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    result['status'] = 'complete'
except BaseException as error:
    result['status'] = 'failed'
    result['error'] = str(error)
    raise
finally:
    (output / 'results.json').write_text(json.dumps(result, indent=2))
    print(result['status'], flush=True)
