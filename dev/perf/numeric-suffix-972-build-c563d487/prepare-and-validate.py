#!/usr/bin/env python3
"""Build and validate the fixed #972 composition; acquire no performance observations."""
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
    print('NUMERIC_972_BUILD_STEP ' + json.dumps(receipt, separators=(',', ':')), flush=True)
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
    assert not git(target, 'status', '--porcelain', '--untracked-files=no')
    assert sha(target / 'ext/js/dictionary/wasm/term-bank-parser.c') == BINDING['baseline']['cSha256']
    assert sha(target / 'dev/data/dictionary-wasm/term-bank-parser.wasm') == BINDING['baseline']['wasmSha256']
    run('dependencies-' + ('baseline' if target == BASE else 'candidate'), ['cp', '-a', str(REPO / 'node_modules'), str(target / 'node_modules')], REPO)

run('reproduce-baseline', ['npm', 'run', 'build:dictionary-wasm', '--', '--check'], BASE)
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

assert {name: sha(CANDIDATE / name) for name in product_files} == product_hashes
assert sha(CANDIDATE / 'ext/lib/term-bank-parser.wasm') == product_hashes[native_files[1]]
assert set(git(CANDIDATE, 'diff', '--name-only').splitlines()) == set(native_files)
assert not git(BASE, 'status', '--porcelain', '--untracked-files=no')
result = {
    'status': 'Build and all declared correctness gates passed; no performance observations acquired',
    'baseline': BINDING['baseline'], 'productFilesSha256': product_hashes,
    'fixedSource': True, 'oldBaselineGainTransferred': False,
    'productPrOpened': False, 'performanceQualificationPending': True,
}
record('result.json', result)
print('NUMERIC_972_BUILD_RESULT ' + json.dumps(result, separators=(',', ':')), flush=True)
