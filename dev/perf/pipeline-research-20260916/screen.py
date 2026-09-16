from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import time
import zipfile

BASE = 'c0a1b7ee6fa1383a0a422361d2a8b7f826499fff'
root = Path.cwd()
inputs = Path(__file__).parent
variant, dictionary = os.environ['CANDIDATE'], os.environ['DICTIONARY']
pairs = int(os.environ.get('PAIRS', '6'))
order = os.environ.get('INITIAL_ORDER', 'AB')
assert variant in ('gather32', 'gather64', 'cache64', 'scalar-pending', 'gather-aligned', 'typed-pending')
assert dictionary in ('jmdict', 'jitendex') and 2 <= pairs <= 16 and order in ('AB', 'BA')
output = root / 'builds/pipeline-review'
output.mkdir(parents=True, exist_ok=True)
candidate = Path(os.environ['RUNNER_TEMP']) / 'pipeline-review-candidate'
package = Path('builds/manabitan-chrome-dev.zip')

def run(args, cwd=root):
    return subprocess.check_output(args, cwd=cwd, text=True, stderr=subprocess.STDOUT).strip()

def logrun(args, name, cwd=root, timeout=300):
    with (output / name).open('w') as log:
        subprocess.run(args, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, timeout=timeout, check=True)

def sha(p):
    with p.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()

assert run(['git', 'rev-parse', 'HEAD']) == BASE
assert run(['git', 'rev-parse', 'HEAD^{tree}']) == 'a48da18d4244b00661d0c6518b2ce77b9f2f9b55'
run(['git', 'worktree', 'add', '--detach', str(candidate), BASE])
(candidate / 'node_modules').symlink_to(root / 'node_modules', target_is_directory=True)
with (root / '.git/info/exclude').open('a') as f:
    f.write('\n/node_modules\n')
(candidate / 'builds').mkdir(exist_ok=True)
(candidate / 'builds/e2e-dictionary-cache').symlink_to(root / 'builds/e2e-dictionary-cache', target_is_directory=True)
change = json.loads(run(['python3', str(inputs / 'apply.py'), variant], candidate))
source = Path(change['source'])
assert str(source) in ('dev/lib/zstd-wasm.js', 'ext/js/dictionary/dictionary-database.js')
extra_tests = change.get('tests', [])
assert all(p.startswith('test/') and p.endswith('.test.js') for p in extra_tests)
run(['git', 'add', str(source), *extra_tests], candidate)
run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Manabitan contributors', '-c',
    'user.email=contributors@manabi.io', 'commit', '-m', f'Isolated pipeline {variant} candidate'], candidate)
(output / 'candidate.patch').write_text(run(['git', 'diff', BASE, 'HEAD'], candidate) + '\n')
shutil.copytree(inputs, output / 'driver-inputs')
logrun(['node', 'dev/bin/build.js', '--target', 'chrome-dev'], 'base-build.log')
saved_package = (root / package).read_bytes()
saved_source = (root / source).read_bytes()
saved_libraries = Path(os.environ['RUNNER_TEMP']) / 'pipeline-review-base-libraries'
shutil.copytree(root / 'ext/lib', saved_libraries)
try:
    (root / source).write_bytes((candidate / source).read_bytes())
    logrun(['node', 'dev/bin/build.js', '--target', 'chrome-dev'], 'candidate-build.log')
    shutil.copy(root / package, candidate / package)
    shutil.copytree(root / 'ext/lib', candidate / 'ext/lib')
finally:
    (root / source).write_bytes(saved_source)
    (root / package).write_bytes(saved_package)
    shutil.copytree(saved_libraries, root / 'ext/lib', dirs_exist_ok=True)
allowed = {'lib/zstd-wasm.js', 'lib/zstd-wasm.js.map'} if variant.startswith('gather') else {source.relative_to('ext').as_posix()}
with zipfile.ZipFile(root / package) as a, zipfile.ZipFile(candidate / package) as b:
    assert a.namelist() == b.namelist()
    changed = {n for n in a.namelist() if a.read(n) != b.read(n)}
    assert changed == allowed, changed
(output / 'member-changes.json').write_text(json.dumps({'changed': sorted(changed), 'sameBuildPath': True}, indent=2))
tests = ['test/zstd-wasm.test.js'] if variant.startswith('gather') else ['test/dictionary-database-content-dedup.test.js', 'test/term-content-block-store.test.js']
assert all((candidate / p).is_file() for p in tests)
logrun(['node', 'node_modules/vitest/vitest.mjs', 'run', *tests], 'focused.log', candidate)
roots = {'A': root, 'B': candidate}

def identity(directory):
    return {'commit': run(['git', 'rev-parse', 'HEAD'], directory), 'tree': run(['git', 'rev-parse', 'HEAD^{tree}'], directory),
        'status': run(['git', 'status', '--porcelain'], directory), 'source': sha(directory / source),
        'package': sha(directory / package), 'parserWasm': sha(directory / 'ext/lib/term-bank-parser.wasm'),
        'fixtureLock': sha(directory / 'test/perf/dictionaries.lock.json'),
        'harness': sha(directory / 'test/chromium/extension-two-dictionary-import.e2e.js')}
identities = {arm: identity(directory) for arm, directory in roots.items()}
(output / 'sizes.json').write_text(json.dumps({arm: {'wasmBytes': (directory / 'ext/lib/term-bank-parser.wasm').stat().st_size, 'packageBytes': (directory / package).stat().st_size} for arm, directory in roots.items()}, indent=2))
assert all(not v['status'] for v in identities.values())
assert identities['B']['source'] == change['sha256']
plan = [{'kind': 'warmup', 'pair': 0, 'arm': arm, 'binary': arm} for arm in order]
for pair in range(1, pairs + 1):
    plan.extend({'kind': 'measured', 'pair': pair, 'arm': arm, 'binary': arm} for arm in (order if pair % 2 else order[::-1]))
    if pair % 2 == 0:
        plan.extend({'kind': 'aa', 'pair': pair // 2, 'arm': arm, 'binary': 'A'} for arm in ('AB' if pair % 4 else 'BA'))
(output / 'plan.json').write_text(json.dumps({'baseline': BASE, 'candidate': variant, 'dictionary': dictionary,
    'identities': identities, 'plan': plan, 'compiler': run(['clang', '--version']), 'node': run(['node', '--version']),
    'retries': 0, 'outlierRemoval': False, 'flags': {}}, indent=2))
observations = []
for ordinal, item in enumerate(plan, 1):
    directory = roots[item['binary']]
    assert identity(directory) == identities[item['binary']]
    destination = output / f"{ordinal:02}-{item['kind']}-{item['pair']}-{item['arm']}"
    started = time.monotonic()
    logrun(['node', 'dev/perf/import-benchmark.js', dictionary, '--runs', '1', '--no-build', '--flags', '{}',
        '--output', str(destination)], destination.name + '.log', directory, 240)
    summary = json.loads((destination / 'summary.json').read_text())
    report = json.loads((destination / 'run-1.json').read_text())
    assert report['status'] == 'success' and report['skippedVerification'] is False
    assert summary['source']['dirty'] is False
    assert summary['source']['sha256']['builds/manabitan-chrome-dev.zip'] == identities[item['binary']]['package']
    measurement = summary['runs'][0]
    receipts = []
    for phase in measurement['importDebug']['importerPhaseTimings']:
        for key in ('parserExperiments', 'fastPathParserEffectiveExperiments'):
            if key in (phase.get('details') or {}):
                receipt = phase['details'][key]
                assert len(receipt) == 10 and all(v is False for v in receipt.values())
                receipts.append(receipt)
    assert receipts
    observations.append({**item, 'ordinal': ordinal, 'ms': measurement['totalImportMs'], 'workerMs': measurement['workerImportMs'],
        'validation': measurement['validation'], 'browser': summary['browserVersion'], 'wallSeconds': time.monotonic() - started})
    (output / 'observations.json').write_text(json.dumps(observations, indent=2))
    print(json.dumps(observations[-1]), flush=True)
for arm, directory in roots.items():
    assert identity(directory) == identities[arm]
(output / 'complete.json').write_text(json.dumps({'completed': len(observations), 'planned': len(plan)}))
