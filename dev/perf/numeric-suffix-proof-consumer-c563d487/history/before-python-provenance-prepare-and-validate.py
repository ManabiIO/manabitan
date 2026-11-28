#!/usr/bin/env python3
"""Build and validate one frozen proof-consumer source; acquire no performance observations."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

HERE = Path(__file__).resolve().parent
REPO = Path(os.environ['GITHUB_WORKSPACE']).resolve()
OUTPUT = Path(os.environ['OUTPUT_ROOT']).resolve()
BASE = Path(os.environ['BASE_ROOT']).resolve()
CANDIDATE = Path(os.environ['CANDIDATE_ROOT']).resolve()
BINDING = json.loads((HERE / 'binding.json').read_text())
assert BINDING['finalized'] is True, 'Unresolved source/tooling cannot be built or measured'
assert hashlib.sha256((REPO / '.github/workflows/import-suffix-proof-component-c563d487.yml').read_bytes()).hexdigest() == BINDING['workflowSha256']
sha = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()

def git(root, *arguments):
    return subprocess.check_output(['git', *arguments], cwd=root, text=True).strip()

def record(name, value):
    (OUTPUT / name).write_text(json.dumps(value, indent=2) + '\n')

def run(label, command, cwd):
    log = OUTPUT / (label + '.log')
    assert not log.exists(), 'Never replace an earlier command result'
    started = time.time()
    with log.open('w') as stream:
        result = subprocess.run(command, cwd=cwd, stdout=stream, stderr=subprocess.STDOUT, text=True)
    receipt = {'label': label, 'command': command, 'cwd': str(cwd),
        'startedEpoch': started, 'finishedEpoch': time.time(), 'exitCode': result.returncode,
        'logSha256': sha(log), 'scope': 'Build/correctness command, not a benchmark observation'}
    record(label + '.receipt.json', receipt)
    print('SUFFIX_PROOF_BUILD_STEP ' + json.dumps(receipt, separators=(',', ':')), flush=True)
    print(log.read_text(errors='replace')[-2000:], flush=True)
    if result.returncode != 0:
        raise RuntimeError(label + ' failed; exact log and receipt retained')

assert not (OUTPUT / 'preparation-start.json').exists(), 'No resumed/replacement preparation'
OUTPUT.mkdir(parents=True, exist_ok=True)
record('preparation-start.json', {
    'scope': 'One separately source-bound build and correctness preparation, no corpus or performance acquisition',
    'toolingHead': git(REPO, 'rev-parse', 'HEAD'),
    'toolingTree': git(REPO, 'rev-parse', 'HEAD^{tree}'),
    'bindingSha256': sha(HERE / 'binding.json'),
    'binding': BINDING,
    'node': subprocess.check_output(['node', '--version'], text=True).strip(),
    'compiler': subprocess.check_output(['clang-21', '--version'], text=True),
    'linker': subprocess.check_output(['wasm-ld-21', '--version'], text=True),
})
for name, expected in BINDING['toolingFiles'].items():
    assert sha(HERE / name) == expected, name
assert subprocess.check_output(['node', '--version'], text=True).strip() == 'v22.22.0'
assert '21.1.8' in subprocess.check_output(['clang-21', '--version'], text=True)
assert '21.1.8' in subprocess.check_output(['wasm-ld-21', '--version'], text=True)

run('fetch-baseline', ['git', 'fetch', '--no-tags', 'origin', BINDING['baseline']['commit']], REPO)
run('create-baseline', ['git', 'worktree', 'add', '--detach', str(BASE), BINDING['baseline']['commit']], REPO)
run('create-candidate', ['git', 'worktree', 'add', '--detach', str(CANDIDATE), BINDING['baseline']['commit']], REPO)
for target in [BASE, CANDIDATE]:
    assert git(target, 'rev-parse', 'HEAD') == BINDING['baseline']['commit']
    assert git(target, 'rev-parse', 'HEAD^{tree}') == BINDING['baseline']['tree']
    assert not git(target, 'status', '--porcelain', '--untracked-files=no')
    assert sha(target / 'ext/js/dictionary/wasm/term-bank-parser.c') == BINDING['baseline']['cSha256']
    assert sha(target / 'dev/data/dictionary-wasm/term-bank-parser.wasm') == BINDING['baseline']['wasmSha256']
    assert sha(target / 'dev/data/dictionary-wasm/manifest.json') == BINDING['baseline']['manifestSha256']
    assert sha(target / 'package-lock.json') == BINDING['dependencyLockSha256']
    assert sha(target / 'test/perf/dictionaries.lock.json') == BINDING['fixtureLockSha256']
    run('dependencies-' + ('baseline' if target == BASE else 'candidate'), ['cp', '-a', str(REPO / 'node_modules'), str(target / 'node_modules')], REPO)

run('reproduce-baseline', ['npm', 'run', 'build:dictionary-wasm', '--', '--check'], BASE)
run('build-baseline-libraries', ['npm', 'run', 'build:libs'], BASE)
run('apply-check', ['git', 'apply', '--check', str(HERE / 'candidate.patch')], CANDIDATE)
run('apply-patch', ['git', 'apply', str(HERE / 'candidate.patch')], CANDIDATE)
assert sha(CANDIDATE / 'ext/js/dictionary/wasm/term-bank-parser.c') == BINDING['candidateCSourceSha256']
run('build-native-candidate', ['npm', 'run', 'build:dictionary-wasm', '--', '--write'], CANDIDATE)
run('build-candidate-libraries', ['npm', 'run', 'build:libs'], CANDIDATE)
run('reproduce-candidate', ['npm', 'run', 'build:dictionary-wasm', '--', '--check'], CANDIDATE)

native_files = [
    'ext/js/dictionary/wasm/term-bank-parser.c',
    'dev/data/dictionary-wasm/term-bank-parser.wasm',
    'dev/data/dictionary-wasm/manifest.json',
]
assert set(git(CANDIDATE, 'diff', '--name-only').splitlines()) == set(native_files)
assert sha(CANDIDATE / 'ext/lib/term-bank-parser.wasm') == sha(CANDIDATE / native_files[1])
assert sha(BASE / 'package-lock.json') == sha(CANDIDATE / 'package-lock.json') == sha(REPO / 'package-lock.json')
diff = subprocess.check_output(['git', 'diff', '--binary'], cwd=CANDIDATE)
(OUTPUT / 'rebuilt-candidate.diff').write_bytes(diff)
for name, expected in BINDING['qualificationFiles'].items():
    source = HERE / 'qualification' / name
    assert sha(source) == expected, name
    destination = CANDIDATE / 'test' / name
    assert not destination.exists(), name
    shutil.copyfile(source, destination)

product_files = native_files + ['test/' + name for name in BINDING['qualificationFiles']]
product_hashes = {name: sha(CANDIDATE / name) for name in product_files}
for name in product_files:
    destination = OUTPUT / 'product' / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(CANDIDATE / name, destination)
record('compiled-source-binding.json', {
    'baseline': BINDING['baseline'],
    'candidateSource': BINDING['candidateCSourceSha256'],
    'productFilesSha256': product_hashes,
    'extWasmSha256': sha(CANDIDATE / 'ext/lib/term-bank-parser.wasm'),
    'rebuiltDiffSha256': sha(OUTPUT / 'rebuilt-candidate.diff'),
    'candidateTrackedChanges': git(CANDIDATE, 'status', '--porcelain', '--untracked-files=no'),
    'qualification': 'Compiled artifacts only at this point; all following correctness gates remain required',
})

run('scoped-lint', ['npx', 'eslint'] + ['test/' + name for name in BINDING['qualificationFiles']], CANDIDATE)
run('strict-main-types', ['npm', 'run', 'test:ts:main'], CANDIDATE)
run('strict-test-types', ['npm', 'run', 'test:ts:test'], CANDIDATE)
run('complete-unit-suite', ['npm', 'run', 'test:unit', '--', '--maxWorkers=2'], CANDIDATE)
run('options-unit-suite', ['npm', 'run', 'test:unit:options', '--', '--maxWorkers=2'], CANDIDATE)
run('all-dry-build-targets', ['npm', 'run', 'test:build'], CANDIDATE)

run('build-counter-only-module', ['python3', str(HERE / 'prepare-diagnostic.py'), str(CANDIDATE), str(OUTPUT)], REPO)
run('synthetic-raw-native-oracle', ['node', str(HERE / 'native-oracle.mjs'),
    '--baseline', str(BASE), '--candidate', str(CANDIDATE), '--output', str(OUTPUT / 'synthetic-native-oracle'), '--synthetic-only'], REPO)
smoke_results = []
for label, root, diagnostic, disabled in [
    ('baseline', BASE, False, False), ('candidate', CANDIDATE, False, False),
    ('diagnostic', CANDIDATE, True, False), ('disabled-baseline', BASE, False, True),
    ('disabled-candidate', CANDIDATE, False, True), ('disabled-diagnostic', CANDIDATE, True, True),
]:
    command = ['node', str(HERE / 'smoke.mjs'), str(root)]
    if diagnostic:
        command.append(str(OUTPUT / 'diagnostic.wasm'))
    if disabled:
        command.append('--disabled-reuse')
    stdout_path = OUTPUT / ('smoke-' + label + '.json')
    stderr_path = OUTPUT / ('smoke-' + label + '.stderr.log')
    assert not stdout_path.exists() and not stderr_path.exists()
    started = time.time()
    with stdout_path.open('w') as stdout, stderr_path.open('w') as stderr:
        completed = subprocess.run(command, cwd=REPO, stdout=stdout, stderr=stderr, text=True)
    receipt = {'label': 'smoke-' + label, 'command': command, 'cwd': str(REPO),
        'startedEpoch': started, 'finishedEpoch': time.time(), 'exitCode': completed.returncode,
        'stdoutSha256': sha(stdout_path), 'stderrSha256': sha(stderr_path),
        'scope': 'Untimed adversarial semantic/diagnostic parity; not a benchmark observation'}
    record('smoke-' + label + '.receipt.json', receipt)
    print('SUFFIX_PROOF_BUILD_STEP ' + json.dumps(receipt, separators=(',', ':')), flush=True)
    assert completed.returncode == 0, label
    smoke_results.append(json.loads(stdout_path.read_text()))
assert all(value['results'] == smoke_results[0]['results'] for value in smoke_results)
assert smoke_results[2]['diagnosticHits'] > 0
assert smoke_results[5]['diagnosticAttempts'] == smoke_results[5]['diagnosticHits'] == 0
record('smoke-parity.json', {'passed': True, 'validCases': smoke_results[0]['validCases'],
    'malformedCases': smoke_results[0]['malformedCases'], 'resultRecords': len(smoke_results[0]['results']),
    'diagnosticHits': smoke_results[2]['diagnosticHits'], 'disabledAttempts': smoke_results[5]['diagnosticAttempts'],
    'disabledHits': smoke_results[5]['diagnosticHits']})

assert {name: sha(CANDIDATE / name) for name in product_files} == product_hashes
assert sha(CANDIDATE / 'ext/lib/term-bank-parser.wasm') == product_hashes[native_files[1]]
assert set(git(CANDIDATE, 'diff', '--name-only').splitlines()) == set(native_files)
assert not git(BASE, 'status', '--porcelain', '--untracked-files=no')
result = {
    'status': 'Build and all declared correctness gates passed; no performance observations acquired',
    'complete': True, 'correctnessPass': True,
    'bindingSha256': sha(HERE / 'binding.json'),
    'diagnosticWasmSha256': sha(OUTPUT / 'diagnostic.wasm'),
    'diagnosticSourceSha256': sha(OUTPUT / 'diagnostic-source.c'),
    'diagnosticBuildSha256': sha(OUTPUT / 'diagnostic-build.json'),
    'smokeParitySha256': sha(OUTPUT / 'smoke-parity.json'),
    'syntheticNativeOracleSha256': sha(OUTPUT / 'synthetic-native-oracle/native-oracle.json'),
    'commandReceiptSha256': {path.name: sha(path) for path in sorted(OUTPUT.glob('*.receipt.json'))},
    'baseline': BINDING['baseline'], 'productFilesSha256': product_hashes,
    'fixedSource': True, 'oldBaselineGainTransferred': False,
    'productPrOpened': False, 'performanceQualificationPending': True,
}
record('result.json', result)
print('SUFFIX_PROOF_BUILD_RESULT ' + json.dumps(result, separators=(',', ':')), flush=True)
