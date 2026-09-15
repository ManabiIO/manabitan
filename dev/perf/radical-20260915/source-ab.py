#!/usr/bin/env python3
"""Complete, fixed browser cohorts. No retries, trimming, or cross-host pooling."""
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
variant = os.environ['CANDIDATE']
dictionary = os.environ['DICTIONARY']
pairs = int(os.environ.get('PAIRS', '6'))
order = os.environ.get('INITIAL_ORDER', 'AB')
flags_by_variant = {
    'libdeflate': {}, 'libdeflate64': {},
    'lookup-native': {'experimentalNativeSegmentedLookup': True, 'experimentalLookupScratchReuse': True},
    'fused-pipeline': {'experimentalTermBankSpans': True, 'experimentalNativeEscapedKeys': True,
        'experimentalFusedSingleBank': True, 'experimentalGlobalExactContentReuse': True,
        'experimentalFastGlossaryNormalization': True, 'experimentalNativeSegmentedLookup': True,
        'experimentalLookupScratchReuse': True},
}
assert variant in flags_by_variant and dictionary in ('jmdict', 'jitendex')
assert 2 <= pairs <= 24 and order in ('AB', 'BA')
root = Path.cwd()
candidate = Path(os.environ['RUNNER_TEMP']) / 'radical-candidate'
output = root / 'builds/radical-screen'
output.mkdir(parents=True, exist_ok=True)
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
if variant.startswith('libdeflate'):
    run(['python3', str(Path(__file__).parent / 'install-libdeflate.py')], cwd=candidate)
    run(['git', 'add', 'ext/js/dictionary/wasm', 'dev/build-libs.js'], cwd=candidate)
    run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Manabitan contributors', '-c',
         'user.email=contributors@manabi.io', 'commit', '-m', f'Isolated radical candidate: {variant}'], cwd=candidate)
    run(['npm', 'run', 'build:libs'], cwd=candidate)
(output / 'candidate.patch').write_text(run(['git', 'diff', BASE, 'HEAD'], cwd=candidate) + '\n')
shutil.copy(__file__, output / 'driver.py')
shutil.copy(Path(__file__).parent / 'install-libdeflate.py', output / 'install-libdeflate.py')
changed_sources = run(['git', 'diff', '--name-only', BASE, 'HEAD'], cwd=candidate).splitlines()
replacements = {name[4:] for name in changed_sources if name.startswith('ext/')}
if variant.startswith('libdeflate'):
    replacements.add('lib/term-bank-parser.wasm')
with zipfile.ZipFile(root / package) as a, zipfile.ZipFile(candidate / package, 'w') as b:
    for member in a.infolist():
        data = (candidate / 'ext' / member.filename).read_bytes() if member.filename in replacements else a.read(member.filename)
        b.writestr(member, data)
    for name in sorted(replacements - set(a.namelist())):
        b.write(candidate / 'ext' / name, name, compress_type=zipfile.ZIP_DEFLATED)
with zipfile.ZipFile(root / package) as a, zipfile.ZipFile(candidate / package) as b:
    assert set(a.namelist()) - set(b.namelist()) == set()
    differences = {name for name in a.namelist() if a.read(name) != b.read(name)} | (set(b.namelist()) - set(a.namelist()))
    assert differences == replacements

# Functional native tests and full decoded-corpus comparisons precede timing.
with (output / 'focused.log').open('w') as log:
    subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', 'test/term-bank-wasm-parser.test.js',
        'test/term-bank-experiments.test.js', 'test/term-bank-composite-state.test.js',
        'test/lookup-construction-experiments.test.js', 'test/term-bank-parser-string-scan.test.js'],
        cwd=candidate, stdout=log, stderr=subprocess.STDOUT, timeout=180, check=True)
flags = flags_by_variant[variant]
with (output / 'component.log').open('w') as log:
    subprocess.run(['node', 'dev/perf/import-lookup-screen.js', dictionary, '--pairs', '2', '--flags', json.dumps(flags),
        '--baseline-root', str(root), '--cache-dir', str(root / 'builds/e2e-dictionary-cache'),
        '--out', str(output / 'component.json')], cwd=candidate, stdout=log,
        stderr=subprocess.STDOUT, timeout=240, check=True)
roots = {'A': root, 'B': candidate}


def identity(directory):
    paths = ['ext/js/dictionary/wasm/term-bank-parser.c', 'ext/lib/term-bank-parser.wasm',
             str(package), 'test/perf/dictionaries.lock.json', 'test/chromium/extension-two-dictionary-import.e2e.js']
    paths += [name for name in changed_sources if name not in paths]
    return {'commit': run(['git', 'rev-parse', 'HEAD'], cwd=directory),
        'tree': run(['git', 'rev-parse', 'HEAD^{tree}'], cwd=directory),
        'status': run(['git', 'status', '--porcelain'], cwd=directory),
        'sha256': {name: sha(directory / name) if (directory / name).exists() else 'absent' for name in paths}}


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
    'plan': plan, 'noRetries': True, 'noOutlierRemoval': True, 'candidateFlags': flags,
    'packageDifferences': sorted(replacements),
    'wasmBytes': {arm: (directory / 'ext/lib/term-bank-parser.wasm').stat().st_size for arm, directory in roots.items()},
    'packageBytes': {arm: (directory / package).stat().st_size for arm, directory in roots.items()},
    'purpose': 'Radical source and pipeline screen; complete independent cohorts only'}, indent=2))
observations = []
for ordinal, item in enumerate(plan, 1):
    directory = roots[item['binary']]
    assert identity(directory) == identities[item['binary']]
    destination = output / f"{ordinal:02}-{item['kind']}-{item['pair']}-{item['arm']}"
    effective_flags = flags if item['binary'] == 'B' else {}
    started = time.monotonic()
    with Path(str(destination) + '.log').open('w') as log:
        process = subprocess.Popen(['node', 'dev/perf/import-benchmark.js', dictionary, '--runs', '1', '--no-build',
            '--flags', json.dumps(effective_flags), '--output', str(destination)], cwd=directory, stdout=log,
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
    assert summary['source']['sha256'][str(package)] == identities[item['binary']]['sha256'][str(package)]
    measurement = summary['runs'][0]
    observations.append({**item, 'ordinal': ordinal, 'ms': measurement['totalImportMs'],
        'workerMs': measurement['workerImportMs'], 'validation': measurement['validation'],
        'browser': summary['browserVersion'], 'flags': effective_flags, 'wallSeconds': time.monotonic() - started})
    (output / 'observations.json').write_text(json.dumps(observations, indent=2))
    print(json.dumps(observations[-1]), flush=True)
for arm, directory in roots.items():
    assert identity(directory) == identities[arm]
(output / 'complete.json').write_text(json.dumps({'completed': len(observations), 'planned': len(plan)}, indent=2))
