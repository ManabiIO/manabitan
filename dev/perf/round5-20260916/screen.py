from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import time
import zipfile

BASE = 'b4094a423c20bb0ed424d944238f922c1b36559c'
root = Path.cwd()
inputs = Path(__file__).parent
variant = os.environ['CANDIDATE']
dictionary = os.environ['DICTIONARY']
pairs = int(os.environ.get('PAIRS', '6'))
order = os.environ.get('INITIAL_ORDER', 'AB')
assert variant in ('cdict', 'shared', 'overlap')
assert dictionary in ('jmdict', 'jitendex') and 2 <= pairs <= 16 and order in ('AB', 'BA')
output = root / 'builds/round5'
output.mkdir(parents=True, exist_ok=True)
candidate = Path(os.environ['RUNNER_TEMP']) / 'round5-candidate'
package = Path('builds/manabitan-chrome-dev.zip')

def run(args, cwd=root):
    return subprocess.check_output(args, cwd=cwd, text=True, stderr=subprocess.STDOUT).strip()

def logrun(args, name, cwd=root, timeout=300):
    with (output / name).open('w') as log:
        subprocess.run(args, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, timeout=timeout, check=True)

def sha(p):
    with p.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()

def commit(directory, title):
    run(['git', 'add', '-u'], directory)
    run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Manabitan contributors', '-c',
        'user.email=contributors@manabi.io', 'commit', '--allow-empty', '-m', title], directory)

assert run(['git', 'rev-parse', 'HEAD']) == BASE
run(['git', 'worktree', 'add', '--detach', str(candidate), BASE])
(candidate / 'node_modules').symlink_to(root / 'node_modules', target_is_directory=True)
with (root / '.git/info/exclude').open('a') as f:
    f.write('\n/node_modules\n')
(candidate / 'builds').mkdir(exist_ok=True)
(candidate / 'builds/e2e-dictionary-cache').symlink_to(root / 'builds/e2e-dictionary-cache', target_is_directory=True)
if variant == 'overlap':
    p = candidate / 'ext/js/dictionary/zstd-term-content.js'
    s = p.read_text()
    old = "        await init('/lib/zstd.wasm');\n        const response = await fetch('/lib/zstd-dicts/jmdict.zdict');"
    assert s.count(old) == 1
    p.write_text(s.replace(old, "        const [, response] = await Promise.all([init('/lib/zstd.wasm'), fetch('/lib/zstd-dicts/jmdict.zdict')]);"))
else:
    logrun(['python3', str(inputs / f'apply-{variant}.py')], 'apply.log', candidate)

control_kind = 'production baseline'
if variant == 'cdict':
    # Native exports require a rebuild. Give the source-control arm the exact
    # same expanded module so compiler/export changes cannot masquerade as reuse.
    p = candidate / 'dev/lib/zstd-wasm.js'
    s = p.read_text()
    s = s.replace('if (equal) { return cached.pointer; }', 'if (equal) { return cached; }')
    s = s.replace('    preparedDictionaries.set(context, {pointer, bytes, level});\n    return pointer;',
        '    const record = {pointer, bytes, level};\n    preparedDictionaries.set(context, record);\n    return record;')
    s = s.replace(' * @returns {number}\n */\nfunction preparedDictionary', ' * @returns {{pointer: number, bytes: Uint8Array, level: number}}\n */\nfunction preparedDictionary')
    s = s.replace('        cdict,', '        cdict.pointer,')
    s = s.replace('cdict: number', 'cdict: {pointer: number, bytes: Uint8Array, level: number}')
    s = s.replace('preparedDictionaries.get(context)?.pointer !== cdict', 'preparedDictionaries.get(context) !== cdict')
    p.write_text(s)
    logrun(['node', 'dev/bin/build-zstd-wasm.js', '--write'], 'native-build.log', candidate, 600)
    for item in ['dev/lib/zstd-simd-module.js', 'dev/data/zstd-simd.wasm']:
        shutil.copy(candidate / item, root / item)
    commit(root, 'Local expanded-export control; unchanged production compression adapter')
    control_kind = 'expanded-export rebuilt Zstd control; not the shipped binary'
commit(candidate, f'Isolated round-five {variant} experiment')
logrun(['node', 'dev/bin/build.js', '--target', 'chrome-dev'], 'base-build.log')
logrun(['node', 'dev/bin/build.js', '--target', 'chrome-dev'], 'candidate-build.log', candidate)

# Normalize only unrelated esbuild source-map path variations. Runtime members
# outside the intended change must agree byte-for-byte before timing begins.
allowed = {
    'overlap': {'js/dictionary/zstd-term-content.js'},
    'shared': {'js/dictionary/zstd-term-content.js', 'js/dictionary/zstd-term-content-compression-worker.js',
        'lib/zstd-wasm.js', 'lib/zstd-wasm.js.map'},
    'cdict': {'lib/zstd-wasm.js', 'lib/zstd-wasm.js.map'},
}[variant]
with zipfile.ZipFile(root / package) as a, zipfile.ZipFile(candidate / package) as b:
    assert a.namelist() == b.namelist()
    changed = {n for n in a.namelist() if a.read(n) != b.read(n)}
    unexpected = changed - allowed
    assert all(n.endswith('.map') for n in unexpected), unexpected
    contents = [(m, b.read(m.filename) if m.filename in allowed else a.read(m.filename)) for m in a.infolist()]
with zipfile.ZipFile(candidate / package, 'w') as z:
    for m, data in contents:
        z.writestr(m, data)
(output / 'member-changes.json').write_text(json.dumps({'allowed': sorted(allowed), 'observedBeforeNormalization': sorted(changed)}, indent=2))
logrun(['node', str(inputs / 'verify-codec.mjs'), str(root), str(candidate), str(output / 'codec.json')], 'codec.log', timeout=180)
logrun(['node', 'node_modules/vitest/vitest.mjs', 'run', 'test/zstd-term-content-pool.test.js',
    'test/term-content-block-store.test.js', 'test/dictionary-database-content-dedup.test.js'], 'focused.log', candidate)

roots = {'A': root, 'B': candidate}
def identity(directory):
    return {'commit': run(['git', 'rev-parse', 'HEAD'], directory),
        'tree': run(['git', 'rev-parse', 'HEAD^{tree}'], directory),
        'status': run(['git', 'status', '--porcelain'], directory),
        'package': sha(directory / package), 'zstdWasm': sha(directory / 'ext/lib/zstd.wasm'),
        'parserWasm': sha(directory / 'ext/lib/term-bank-parser.wasm'),
        'fixtureLock': sha(directory / 'test/perf/dictionaries.lock.json'),
        'harness': sha(directory / 'test/chromium/extension-two-dictionary-import.e2e.js')}
identities = {arm: identity(directory) for arm, directory in roots.items()}
assert all(not item['status'] for item in identities.values())
assert identities['A']['zstdWasm'] == identities['B']['zstdWasm']
assert identities['A']['parserWasm'] == identities['B']['parserWasm']
plan = [{'kind': 'warmup', 'pair': 0, 'arm': arm, 'binary': arm} for arm in order]
for pair in range(1, pairs + 1):
    plan.extend({'kind': 'measured', 'pair': pair, 'arm': arm, 'binary': arm} for arm in (order if pair % 2 else order[::-1]))
    if pair % 2 == 0:
        plan.extend({'kind': 'aa', 'pair': pair // 2, 'arm': arm, 'binary': 'A'} for arm in ('AB' if pair % 4 else 'BA'))
(output / 'plan.json').write_text(json.dumps({'productionBaseline': BASE, 'controlKind': control_kind,
    'candidate': variant, 'dictionary': dictionary, 'identities': identities, 'plan': plan,
    'compiler': run(['clang', '--version']), 'node': run(['node', '--version']),
    'retries': 0, 'outlierRemoval': False, 'flags': {}}, indent=2))
(output / 'candidate.patch').write_text(run(['git', 'diff', '--binary', BASE, 'HEAD'], candidate) + '\n')
shutil.copytree(inputs, output / 'driver-inputs', dirs_exist_ok=True)
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
            if key in phase.get('details', {}):
                receipt = phase['details'][key]
                assert len(receipt) == 10 and all(v is False for v in receipt.values())
                receipts.append(receipt)
    assert receipts
    observations.append({**item, 'ordinal': ordinal, 'ms': measurement['totalImportMs'],
        'workerMs': measurement['workerImportMs'], 'validation': measurement['validation'],
        'browser': summary['browserVersion'], 'wallSeconds': time.monotonic() - started})
    (output / 'observations.json').write_text(json.dumps(observations, indent=2))
    print(json.dumps(observations[-1]), flush=True)
for arm, directory in roots.items():
    assert identity(directory) == identities[arm]
(output / 'complete.json').write_text(json.dumps({'completed': len(observations), 'planned': len(plan)}))
