#!/usr/bin/env python3
"""Restore only the exact successfully tested native product; no compilation."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

HERE = Path(__file__).resolve().parent
REPO = Path(os.environ['GITHUB_WORKSPACE']).resolve()
BASE = Path(os.environ['BASE_ROOT']).resolve()
CANDIDATE = Path(os.environ['CANDIDATE_ROOT']).resolve()
ARTIFACT = Path(os.environ['BUILT_ROOT']).resolve()
OUTPUT = Path(os.environ['OUTPUT_ROOT']).resolve()
BINDING = json.loads((HERE / 'binding.json').read_text())
assert BINDING['finalized'] is True
assert hashlib.sha256((REPO / '.github/workflows/import-suffix-proof-component-c563d487.yml').read_bytes()).hexdigest() == BINDING['workflowSha256']
sha = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
git = lambda root, *args: subprocess.check_output(['git', *args], cwd=root, text=True).strip()
load = lambda name: json.loads((ARTIFACT / name).read_text())
assert not BASE.exists() and not CANDIDATE.exists(), 'Fresh component worktrees are required'
OUTPUT.mkdir(parents=True, exist_ok=True)
assert not (OUTPUT / 'component-setup.json').exists()
for name, digest in BINDING['toolingFiles'].items():
    assert sha(HERE / name) == digest, name
start, compiled, result = load('preparation-start.json'), load('compiled-source-binding.json'), load('result.json')
assert start['toolingHead'] == git(REPO, 'rev-parse', 'HEAD')
assert start['toolingTree'] == git(REPO, 'rev-parse', 'HEAD^{tree}')
assert start['bindingSha256'] == sha(HERE / 'binding.json') and start['binding'] == BINDING
assert result['complete'] is True and result['correctnessPass'] is True
assert result['bindingSha256'] == sha(HERE / 'binding.json')
assert result['baseline'] == compiled['baseline'] == BINDING['baseline']
assert result['productFilesSha256'] == compiled['productFilesSha256']
assert compiled['candidateSource'] == BINDING['candidateCSourceSha256']
native_paths = {'ext/js/dictionary/wasm/term-bank-parser.c',
                'dev/data/dictionary-wasm/term-bank-parser.wasm',
                'dev/data/dictionary-wasm/manifest.json'}
assert set(result['productFilesSha256']) == native_paths | {'test/' + name for name in BINDING['qualificationFiles']}
for name, digest in result['productFilesSha256'].items():
    assert sha(ARTIFACT / 'product' / name) == digest, name
assert compiled['extWasmSha256'] == result['productFilesSha256']['dev/data/dictionary-wasm/term-bank-parser.wasm']
assert sha(ARTIFACT / 'rebuilt-candidate.diff') == compiled['rebuiltDiffSha256']
assert sha(ARTIFACT / 'diagnostic.wasm') == result['diagnosticWasmSha256']
assert sha(ARTIFACT / 'diagnostic-source.c') == result['diagnosticSourceSha256']
assert sha(ARTIFACT / 'diagnostic-build.json') == result['diagnosticBuildSha256']
diagnostic = load('diagnostic-build.json')
assert diagnostic['sourceOnly'] is False
assert diagnostic['productSourceSha256'] == BINDING['candidateCSourceSha256']
assert diagnostic['diagnosticWasmSha256'] == result['diagnosticWasmSha256']
assert diagnostic['diagnosticSourceSha256'] == result['diagnosticSourceSha256']
assert diagnostic['diagnosticFieldsSha256'] == sha(HERE / 'diagnostic-fields.json')
assert sha(ARTIFACT / 'smoke-parity.json') == result['smokeParitySha256'] and load('smoke-parity.json')['passed'] is True
assert sha(ARTIFACT / 'synthetic-native-oracle/native-oracle.json') == result['syntheticNativeOracleSha256']
assert load('synthetic-native-oracle/native-oracle.json')['complete'] is True
expected_labels = {
    'fetch-baseline', 'create-baseline', 'create-candidate', 'dependencies-baseline', 'dependencies-candidate',
    'reproduce-baseline', 'build-baseline-libraries', 'apply-check', 'apply-patch', 'build-native-candidate',
    'build-candidate-libraries', 'reproduce-candidate', 'scoped-lint', 'strict-main-types', 'strict-test-types',
    'complete-unit-suite', 'options-unit-suite', 'all-dry-build-targets', 'build-counter-only-module',
    'synthetic-raw-native-oracle', 'smoke-baseline', 'smoke-candidate', 'smoke-diagnostic',
    'smoke-disabled-baseline', 'smoke-disabled-candidate', 'smoke-disabled-diagnostic',
}
assert set(result['commandReceiptSha256']) == {name + '.receipt.json' for name in expected_labels}
for name, digest in result['commandReceiptSha256'].items():
    assert sha(ARTIFACT / name) == digest, name
    receipt = load(name)
    assert receipt['exitCode'] == 0 and receipt['label'] + '.receipt.json' == name
    if 'logSha256' in receipt:
        assert sha(ARTIFACT / (receipt['label'] + '.log')) == receipt['logSha256']
    else:
        assert sha(ARTIFACT / (receipt['label'] + '.json')) == receipt['stdoutSha256']
        assert sha(ARTIFACT / (receipt['label'] + '.stderr.log')) == receipt['stderrSha256']

subprocess.run(['git', 'fetch', '--no-tags', 'origin', BINDING['baseline']['commit']], cwd=REPO, check=True)
for target in [BASE, CANDIDATE]:
    subprocess.run(['git', 'worktree', 'add', '--detach', str(target), BINDING['baseline']['commit']], cwd=REPO, check=True)
    assert git(target, 'rev-parse', 'HEAD^{tree}') == BINDING['baseline']['tree']
    subprocess.run(['cp', '-a', str(REPO / 'node_modules'), str(target / 'node_modules')], cwd=REPO, check=True)
subprocess.run(['git', 'apply', '--check', str(ARTIFACT / 'rebuilt-candidate.diff')], cwd=CANDIDATE, check=True)
subprocess.run(['git', 'apply', str(ARTIFACT / 'rebuilt-candidate.diff')], cwd=CANDIDATE, check=True)
assert hashlib.sha256(subprocess.check_output(['git', 'diff', '--binary'], cwd=CANDIDATE)).hexdigest() == compiled['rebuiltDiffSha256']
for name, digest in BINDING['qualificationFiles'].items():
    source, target = ARTIFACT / 'product/test' / name, CANDIDATE / 'test' / name
    assert sha(source) == digest and not target.exists()
    shutil.copyfile(source, target)
for target in [BASE, CANDIDATE]:
    subprocess.run(['npm', 'run', 'build:libs'], cwd=target, check=True)
    assert sha(target / 'ext/lib/term-bank-parser.wasm') == sha(target / 'dev/data/dictionary-wasm/term-bank-parser.wasm')
    assert sha(target / 'package-lock.json') == BINDING['dependencyLockSha256']
    assert sha(target / 'test/perf/dictionaries.lock.json') == BINDING['fixtureLockSha256']
assert not git(BASE, 'status', '--porcelain', '--untracked-files=no')
assert set(git(CANDIDATE, 'diff', '--name-only').splitlines()) == native_paths
for name, digest in result['productFilesSha256'].items():
    assert sha(CANDIDATE / name) == digest, name
for name in ['compiled-source-binding.json', 'diagnostic.wasm', 'diagnostic-source.c', 'diagnostic-build.json', 'smoke-parity.json']:
    shutil.copyfile(ARTIFACT / name, OUTPUT / name)
shutil.copyfile(ARTIFACT / 'result.json', OUTPUT / 'correctness-result.json')
receipt = {'schemaVersion': 1, 'scope': 'Restore previously tested exact compiled bytes only; no local compiler or timing.',
    'baseline': BINDING['baseline'], 'candidateCSourceSha256': BINDING['candidateCSourceSha256'],
    'productFilesSha256': result['productFilesSha256'], 'diagnosticWasmSha256': result['diagnosticWasmSha256'],
    'correctnessResultSha256': sha(ARTIFACT / 'result.json'),
    'compiledSourceBindingSha256': sha(ARTIFACT / 'compiled-source-binding.json'),
    'correctnessReceiptCount': len(expected_labels),
    'sourceArtifactId': os.environ['SOURCE_ARTIFACT_ID'], 'sourceArtifactDigest': os.environ['SOURCE_ARTIFACT_DIGEST'],
    'toolingHead': git(REPO, 'rev-parse', 'HEAD'), 'toolingTree': git(REPO, 'rev-parse', 'HEAD^{tree}'),
    'bindingSha256': sha(HERE / 'binding.json'), 'complete': True}
(OUTPUT / 'component-setup.json').write_text(json.dumps(receipt, indent=2) + '\n')
print('SUFFIX_PROOF_COMPONENT_SETUP ' + json.dumps(receipt, separators=(',', ':')), flush=True)
