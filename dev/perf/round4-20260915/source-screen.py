#!/usr/bin/env python3
"""Fixed source-revision comparison; preserve every observation and failure."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import signal
import subprocess
import time
import zipfile

BASE = '30ffb604e0a87f0aa252bd4331bc54668062b1e1'
CANDIDATES = {
    'record-direct': ('term-record-opfs-store.js', 'bdb1db17a0fb1bf5bbad1360e5400527b9870240e51a0587d15e6694884286cd'),
    'dedup-scalars': ('dictionary-database.js', 'b18d2e59a75d86ff30c48ec88077f17537978d74d626d354f347efb3cdd3c093'),
    'reference-runs': ('term-content-block-store.js', 'e20eb879a218b0a1698c4cc186266a1380a7bf2be9b00bc55630e152410a7cc8'),
}
variant, dictionary = os.environ['CANDIDATE'], os.environ['DICTIONARY']
pairs = int(os.environ.get('PAIRS', '6'))
order = os.environ.get('INITIAL_ORDER', 'AB')
assert variant in CANDIDATES and dictionary in ('jmdict', 'jitendex')
assert 2 <= pairs <= 24 and order in ('AB', 'BA')
root = Path.cwd()
candidate = Path(os.environ['RUNNER_TEMP']) / 'round4-candidate'
output = root / 'builds/round4-screen'
output.mkdir(parents=True, exist_ok=True)
source = Path('ext/js/dictionary') / CANDIDATES[variant][0]
package = Path('builds/manabitan-chrome-dev.zip')


def run(args, cwd=root):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def sha(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


assert run(['git', 'rev-parse', 'HEAD']) == BASE
assert run(['git', 'rev-parse', 'HEAD^{tree}']) == 'c069f4ca92d8e6902a1a182281a06b2579610c05'
run(['git', 'worktree', 'add', '--detach', str(candidate), BASE])
(candidate / 'node_modules').symlink_to(root / 'node_modules', target_is_directory=True)
with (root / '.git/info/exclude').open('a') as stream:
    stream.write('\n/node_modules\n')
shutil.copytree(root / 'ext/lib', candidate / 'ext/lib', dirs_exist_ok=True)
(candidate / 'builds').mkdir(exist_ok=True)
(candidate / 'builds/e2e-dictionary-cache').symlink_to(root / 'builds/e2e-dictionary-cache', target_is_directory=True)
patch = Path(__file__).parent / (variant + '.patch')
run(['git', 'apply', '--check', str(patch)], cwd=candidate)
run(['git', 'apply', str(patch)], cwd=candidate)
assert sha(candidate / source) == CANDIDATES[variant][1]
run(['git', 'add', str(source)], cwd=candidate)
run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Manabitan contributors', '-c',
     'user.email=contributors@manabi.io', 'commit', '-m', f'Isolated round4 source candidate: {variant}'], cwd=candidate)
shutil.copy(patch, output / 'candidate.patch')
shutil.copy(__file__, output / 'driver.py')
replacements = {source.relative_to('ext').as_posix()}
with zipfile.ZipFile(root / package) as a, zipfile.ZipFile(candidate / package, 'w') as b:
    for member in a.infolist():
        data = (candidate / 'ext' / member.filename).read_bytes() if member.filename in replacements else a.read(member.filename)
        b.writestr(member, data)
with zipfile.ZipFile(root / package) as a, zipfile.ZipFile(candidate / package) as b:
    assert a.namelist() == b.namelist()
    assert {n for n in a.namelist() if a.read(n) != b.read(n)} == replacements

# Qualification precedes timing. The parser component does not exercise this change.
with (output / 'focused.log').open('w') as log:
    subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run',
        'test/dictionary-database-content-dedup.test.js', 'test/term-record-opfs-store.test.js',
        'test/term-content-block-store.test.js'], cwd=candidate,
        stdout=log, stderr=subprocess.STDOUT, timeout=180, check=True)
(output / 'component-not-applicable.json').write_text(json.dumps({
    'reason': 'Changed storage path is outside the parser/lookup component runner',
    'wasmUnchanged': sha(root / 'ext/lib/term-bank-parser.wasm') == sha(candidate / 'ext/lib/term-bank-parser.wasm')}))

roots = {'A': root, 'B': candidate}


def identity(directory):
    return {'commit': run(['git', 'rev-parse', 'HEAD'], cwd=directory),
        'tree': run(['git', 'rev-parse', 'HEAD^{tree}'], cwd=directory),
        'status': run(['git', 'status', '--porcelain'], cwd=directory),
        'source': sha(directory / source), 'wasm': sha(directory / 'ext/lib/term-bank-parser.wasm'),
        'package': sha(directory / package), 'lock': sha(directory / 'test/perf/dictionaries.lock.json'),
        'harness': sha(directory / 'test/chromium/extension-two-dictionary-import.e2e.js')}


identities = {arm: identity(directory) for arm, directory in roots.items()}
assert all(not item['status'] for item in identities.values())
plan = [{'kind': 'warmup', 'pair': 0, 'arm': arm, 'binary': arm} for arm in order]
for pair in range(1, pairs + 1):
    plan.extend({'kind': 'measured', 'pair': pair, 'arm': arm, 'binary': arm}
        for arm in (order if pair % 2 else order[::-1]))
    if pair % 2 == 0:
        plan.extend({'kind': 'aa', 'pair': pair // 2, 'arm': arm, 'binary': 'A'}
            for arm in ('AB' if pair % 4 else 'BA'))
(output / 'plan.json').write_text(json.dumps({'baseline': BASE, 'candidate': variant, 'dictionary': dictionary,
    'identities': identities, 'compiler': run(['clang', '--version']), 'node': run(['node', '--version']),
    'plan': plan, 'noRetries': True, 'noOutlierRemoval': True, 'flags': {},
    'wasmBytes': {arm: (directory / 'ext/lib/term-bank-parser.wasm').stat().st_size for arm, directory in roots.items()},
    'purpose': 'Source screening; fixed independent cohorts, no cross-host pooling'}, indent=2))
observations = []
for ordinal, item in enumerate(plan, 1):
    directory = roots[item['binary']]
    assert identity(directory) == identities[item['binary']]
    destination = output / f"{ordinal:02}-{item['kind']}-{item['pair']}-{item['arm']}"
    started = time.monotonic()
    with Path(str(destination) + '.log').open('w') as log:
        process = subprocess.Popen(['node', 'dev/perf/import-benchmark.js', dictionary, '--runs', '1', '--no-build',
            '--flags', '{}', '--output', str(destination)], cwd=directory, stdout=log,
            stderr=subprocess.STDOUT, start_new_session=True)
        try:
            status = process.wait(timeout=240)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise
    assert status == 0, f'Failed observation {ordinal}; raw failure retained'
    summary = json.loads((destination / 'summary.json').read_text())
    report = json.loads((destination / 'run-1.json').read_text())
    assert report['status'] == 'success' and report['skippedVerification'] is False
    assert summary['source']['dirty'] is False
    assert summary['source']['sha256']['builds/manabitan-chrome-dev.zip'] == identities[item['binary']]['package']
    measurement = summary['runs'][0]
    debug = measurement['importDebug']
    receipts = []
    for phase in debug['importerPhaseTimings']:
        details = phase.get('details') or {}
        for key in ('parserExperiments', 'fastPathParserEffectiveExperiments'):
            if key in details:
                receipt = details[key]
                assert isinstance(receipt, dict) and len(receipt) == 10
                assert all(value is False for value in receipt.values()), receipt
                receipts.append(receipt)
    assert receipts, 'Missing actual default-off worker receipts'
    observations.append({**item, 'ordinal': ordinal, 'ms': measurement['totalImportMs'],
        'workerMs': measurement['workerImportMs'], 'validation': measurement['validation'],
        'browser': summary['browserVersion'], 'wallSeconds': time.monotonic() - started})
    (output / 'observations.json').write_text(json.dumps(observations, indent=2))
    print(json.dumps(observations[-1]), flush=True)
for arm, directory in roots.items():
    assert identity(directory) == identities[arm]
(output / 'complete.json').write_text(json.dumps({'completed': len(observations), 'planned': len(plan)}, indent=2))
