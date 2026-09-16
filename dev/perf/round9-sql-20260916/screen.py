from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import time
import zipfile

BASE = '895b2adf6c8cf2eec3d45602173ec48e1f3cfb4a'
TREE = 'de6e56e27ebb5503cdd36a07e0e1eba475b2eb33'
root = Path.cwd()
inputs = Path(__file__).parent
lane = os.environ['LANE']
dictionary = os.environ.get('DICTIONARY', '')
pairs = int(os.environ.get('PAIRS', '6'))
order = os.environ.get('INITIAL_ORDER', 'AB')
assert lane in ('import', 'sql') and order in ('AB', 'BA') and 2 <= pairs <= 16
assert lane != 'import' or dictionary in ('jmdict', 'jitendex')
output = root / 'builds/round9-screen'
output.mkdir(parents=True, exist_ok=True)
candidate = Path(os.environ['RUNNER_TEMP']) / 'round9-candidate'
package = Path('builds/manabitan-chrome-dev.zip')
sources = ['ext/js/dictionary/dictionary-database.js', 'ext/js/dictionary/term-record-opfs-store.js']
expected = ['bb4cf5bfa66f7a33a6535335533a8f8b75f10e1a37287717dd79808bb06e41c0', '789c302d3bb5a40637090f59185b0ec868a5bcf3b34655988d4849fe280b68f8']


def run(args, cwd=root):
    return subprocess.check_output(args, cwd=cwd, text=True, stderr=subprocess.STDOUT).strip()


def logrun(args, filename, cwd=root, timeout=360):
    with (output / filename).open('w') as log:
        subprocess.run(args, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, timeout=timeout, check=True)


def sha(file):
    with Path(file).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


assert run(['git', 'rev-parse', 'HEAD']) == BASE
assert run(['git', 'rev-parse', 'HEAD^{tree}']) == TREE
assert sha(inputs / 'combined.patch') == '601bfa182d0be90b83dd6f01b7bdb6793de79d614a3fea148ae4a440d8cc4bda'
run(['git', 'worktree', 'add', '--detach', str(candidate), BASE])
(candidate / 'node_modules').symlink_to(root / 'node_modules', target_is_directory=True)
with (root / '.git/info/exclude').open('a') as stream:
    stream.write('\n/node_modules\n')
(candidate / 'builds').mkdir(exist_ok=True)
(candidate / 'builds/e2e-dictionary-cache').symlink_to(root / 'builds/e2e-dictionary-cache', target_is_directory=True)
run(['git', 'apply', '--check', str(inputs / 'combined.patch')], candidate)
run(['git', 'apply', str(inputs / 'combined.patch')], candidate)
assert [sha(candidate / source) for source in sources] == expected
run(['git', 'add', *sources], candidate)
run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Manabitan contributors', '-c',
    'user.email=contributors@manabi.io', 'commit', '-m', 'Isolated SQL correctness and count comparison'], candidate)
shutil.copy(inputs / 'combined.patch', output / 'candidate.patch')
shutil.copytree(inputs, output / 'driver-inputs')

# Build both actual packages at the same path. Do not substitute ZIP members,
# normalize code comments, or compare unrelated worktree-dependent bundles.
logrun(['node', 'dev/bin/build.js', '--target', 'chrome-dev'], 'baseline-build.log')
saved_package = (root / package).read_bytes()
saved_sources = {source: (root / source).read_bytes() for source in sources}
saved_libraries = Path(os.environ['RUNNER_TEMP']) / 'round9-baseline-libraries'
shutil.copytree(root / 'ext/lib', saved_libraries)
try:
    for source in sources:
        (root / source).write_bytes((candidate / source).read_bytes())
    logrun(['node', 'dev/bin/build.js', '--target', 'chrome-dev'], 'candidate-build.log')
    shutil.copy(root / package, candidate / package)
    shutil.copytree(root / 'ext/lib', candidate / 'ext/lib')
finally:
    for source, data in saved_sources.items():
        (root / source).write_bytes(data)
    (root / package).write_bytes(saved_package)
    shutil.copytree(saved_libraries, root / 'ext/lib', dirs_exist_ok=True)
with zipfile.ZipFile(root / package) as a, zipfile.ZipFile(candidate / package) as b:
    assert a.namelist() == b.namelist()
    changed = {name for name in a.namelist() if a.read(name) != b.read(name)}
    assert changed == {Path(source).relative_to('ext').as_posix() for source in sources}, changed
(output / 'package-members.json').write_text(json.dumps({'changed': sorted(changed), 'sameBuildPath': True}, indent=2))

roots = {'A': root, 'B': candidate}


def identity(directory):
    return {'commit': run(['git', 'rev-parse', 'HEAD'], directory), 'tree': run(['git', 'rev-parse', 'HEAD^{tree}'], directory),
        'status': run(['git', 'status', '--porcelain'], directory),
        'sources': {source: sha(directory / source) for source in sources},
        'package': sha(directory / package), 'parserWasm': sha(directory / 'ext/lib/term-bank-parser.wasm'),
        'fixtureLock': sha(directory / 'test/perf/dictionaries.lock.json'),
        'harness': sha(directory / 'test/chromium/extension-two-dictionary-import.e2e.js')}


identities = {arm: identity(directory) for arm, directory in roots.items()}
assert all(not item['status'] for item in identities.values())
assert identities['A']['parserWasm'] == identities['B']['parserWasm']
(output / 'identities.json').write_text(json.dumps(identities, indent=2))
(output / 'sizes.json').write_text(json.dumps({arm: {'packageBytes': (directory / package).stat().st_size,
    'wasmBytes': (directory / 'ext/lib/term-bank-parser.wasm').stat().st_size} for arm, directory in roots.items()}, indent=2))

if lane == 'sql':
    # Copy inside the project so Node resolves the pinned package dependencies.
    driver = root / 'builds/round9-sql-benchmark.mjs'
    shutil.copy(inputs / 'sql-benchmark.mjs', driver)
    logrun(['node', '--max-old-space-size=4096', str(driver), str(root), str(candidate),
        str(root / 'builds/e2e-dictionary-cache'), str(output)], 'sql-benchmark.log', timeout=900)
    result = json.loads((output / 'sql-complete.json').read_text())
    assert result == {'status': 'success', 'completed': 18, 'planned': 18}, result
else:
    plan = [{'kind': 'warmup', 'pair': 0, 'arm': arm, 'binary': arm} for arm in order]
    for pair in range(1, pairs + 1):
        plan.extend({'kind': 'measured', 'pair': pair, 'arm': arm, 'binary': arm} for arm in (order if pair % 2 else order[::-1]))
        if pair % 2 == 0:
            plan.extend({'kind': 'aa', 'pair': pair // 2, 'arm': arm, 'binary': 'A'} for arm in ('AB' if pair % 4 else 'BA'))
    (output / 'plan.json').write_text(json.dumps({'baseline': BASE, 'candidate': 'sql-constraints-counts', 'dictionary': dictionary,
        'identities': identities, 'plan': plan, 'node': run(['node', '--version']), 'compiler': run(['clang', '--version']),
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
        raw = json.loads((destination / 'run-1.json').read_text())
        assert raw['status'] == 'success' and raw['skippedVerification'] is False
        assert summary['source']['dirty'] is False
        assert summary['source']['sha256']['builds/manabitan-chrome-dev.zip'] == identities[item['binary']]['package']
        measurement = summary['runs'][0]
        receipts = []
        for phase in measurement['importDebug']['importerPhaseTimings']:
            for key in ('parserExperiments', 'fastPathParserEffectiveExperiments'):
                if key in (phase.get('details') or {}):
                    receipt = phase['details'][key]
                    assert len(receipt) == 10 and all(value is False for value in receipt.values()), receipt
                    receipts.append(receipt)
        assert receipts
        observations.append({**item, 'ordinal': ordinal, 'ms': measurement['totalImportMs'],
            'workerMs': measurement['workerImportMs'], 'validation': measurement['validation'],
            'browser': summary['browserVersion'], 'wallSeconds': time.monotonic() - started})
        (output / 'observations.json').write_text(json.dumps(observations, indent=2))
        print(json.dumps(observations[-1]), flush=True)
    (output / 'complete.json').write_text(json.dumps({'completed': len(observations), 'planned': len(plan)}))
for arm, directory in roots.items():
    assert identity(directory) == identities[arm]
