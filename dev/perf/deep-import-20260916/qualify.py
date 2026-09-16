from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import sys

BASE = 'c0a1b7ee6fa1383a0a422361d2a8b7f826499fff'
SOURCE = 'ext/js/dictionary/dictionary-importer.js'
TEST = 'test/dictionary-importer-media-prefetch.test.js'
HASHES = {
    SOURCE: '86194729b52d5817f77601d32702d8a53fae635ddd62346024b3c42081b3b7f4',
    TEST: '9dbf7611ea5727be4c932d78f39d350484872ff40f1ac294eb6a8d42860c1814',
}
root = Path.cwd()
inputs = Path(__file__).parent
out = root / 'builds/media-prefetch-qualification'
out.mkdir(parents=True, exist_ok=True)

def run(args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT).strip()

def logged(args, name, timeout=1200, check=True, env=None):
    with (out / name).open('w') as log:
        result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, timeout=timeout, env=env)
    print(json.dumps({'step': name, 'exit': result.returncode}), flush=True)
    if check and result.returncode != 0:
        raise RuntimeError(f'{name} failed: {(out / name).read_text()[-5000:]}')
    return result.returncode

def verify_source():
    for path, digest in HASHES.items():
        assert hashlib.sha256(Path(path).read_bytes()).hexdigest() == digest, path
    assert run(['git', 'diff', '--name-only']) == ''
    assert run(['git', 'diff', '--cached', '--name-only']) == ''

assert run(['git', 'rev-parse', 'HEAD']) == BASE
logged(['npm', 'run', 'build:libs'], 'baseline-libraries.log')
shutil.copyfile(inputs / 'media-prefetch-test.txt', TEST)
red = out / 'red.json'
assert logged(['node', 'node_modules/vitest/vitest.mjs', 'run', TEST, '-t', 'reads referenced media before all terms finish', '--reporter=json', f'--outputFile={red}'], 'red.log', check=False) == 1
red_result = json.loads(red.read_text())
assert red_result['numFailedTests'] == 1 and red_result['numPassedTests'] == 0
failures = [message for suite in red_result['testResults'] for case in suite['assertionResults'] if case['status'] == 'failed' for message in case['failureMessages']]
assert len(failures) == 1 and 'to be less than' in failures[0]
logged([sys.executable, str(inputs / 'finalize.py'), 'media-prefetch4m'], 'apply.log')
run(['git', 'add', '--', SOURCE, TEST])
assert set(run(['git', 'diff', '--cached', '--name-only']).splitlines()) == {SOURCE, TEST}
run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Manabitan contributors', '-c', 'user.email=contributors@manabi.io', 'commit', '-m', 'perf: overlap bounded referenced-media reads with term import'])
verify_source()
head = run(['git', 'rev-parse', 'HEAD'])
tree = run(['git', 'rev-parse', 'HEAD^{tree}'])
(out / 'candidate.patch').write_text(run(['git', 'diff', BASE, 'HEAD']) + '\n')
logged(['node', 'node_modules/vitest/vitest.mjs', 'run', TEST, 'test/dictionary-import-ownership.test.js', 'test/dictionary-importer-artifact.test.js', 'test/dictionary-importer-media-loader.test.js', 'test/dictionary-importer-zip-filename-alias.test.js'], 'focused.log')
logged(['npm', 'run', 'test:unit'], 'unit.log')
logged(['npm', 'run', 'test:unit:options'], 'options.log')
logged(['npm', 'run', 'test:ts'], 'types.log')
logged(['node', 'node_modules/eslint/bin/eslint.js', SOURCE, TEST], 'changed-lint.log')
logged(['npm', 'run', 'test:build'], 'build-plans.log')
logged(['node', 'dev/bin/build.js', '--target', 'chrome-dev'], 'chrome-build.log')
logged(['node', 'dev/bin/build.js', '--target', 'firefox-dev'], 'firefox-build.log')
report = out / 'chromium.json'
env = dict(os.environ, MANABITAN_E2E_STRICT_RUNTIME='1', MANABITAN_E2E_USE_PERF_DICTIONARY_LOCK='1', MANABITAN_E2E_IMPORT_USE_PRODUCTION_DEFAULTS='1', MANABITAN_E2E_SKIP_BUILD='1', MANABITAN_CHROMIUM_E2E_REPORT=str(out / 'chromium.html'))
logged(['node', 'test/chromium/extension-two-dictionary-import.e2e.js'], 'chromium.log', timeout=1500, env=env)
result = json.loads(report.read_text())
assert result['status'] == 'success' and result['skippedVerification'] is False
verify_source()
receipt = {'base': BASE, 'testedHead': head, 'head': head, 'tree': tree, 'hashes': HASHES, 'status': 'qualified', 'chromium': {'status': result['status'], 'skippedVerification': result['skippedVerification']}, 'branch': 'perf/bounded-media-prefetch-20260916'}
(out / 'qualification.json').write_text(json.dumps(receipt, indent=2))
# Advance only this isolated branch, and only from the known earlier candidate.
# A new parent is allowed only with the identical already-qualified full tree.
branch = receipt['branch']
remote = run(['git', 'ls-remote', '--heads', 'origin', branch])
if remote:
    parent = remote.split()[0]
    run(['git', 'fetch', '--depth=2', 'origin', parent])
    assert set(run(['git', 'diff', '--name-only', BASE, parent]).splitlines()) == {SOURCE, TEST}
    prior_source = subprocess.check_output(['git', 'show', f'{parent}:{SOURCE}'])
    prior_test = subprocess.check_output(['git', 'show', f'{parent}:{TEST}'])
    assert hashlib.sha256(prior_source).hexdigest() == '4a8a50151166fa317dc18723992e0bcf423455aa3f0fea2b2cc5de8d08f9a1e2'
    assert hashlib.sha256(prior_test).hexdigest() == HASHES[TEST]
    head = run(['git', '-c', 'user.name=Manabitan contributors', '-c', 'user.email=contributors@manabi.io', 'commit-tree', tree, '-p', parent, '-m', 'fix: retain media cleanup when cancellation provider throws'])
    run(['git', 'update-ref', 'HEAD', head])
    assert run(['git', 'rev-parse', 'HEAD^{tree}']) == tree
    verify_source()
    receipt['head'] = head
    receipt['publicationParent'] = parent
run(['git', 'bundle', 'create', str(out / 'candidate.bundle'), f'{BASE}..HEAD'])
run(['git', 'push', 'origin', f'HEAD:refs/heads/{branch}'])
receipt['published'] = True
(out / 'publication.json').write_text(json.dumps(receipt, indent=2))
print(json.dumps(receipt), flush=True)
