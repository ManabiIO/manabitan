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
EXPECTED = {
    'int-span': '37906a98494fbc28dcc9e8a0170e516d8abb4f4ddb4070704fb54539ee973a1c',
    'equal-simd': 'cfb2c0f96b522ef76946324075cf50eb81cee3d5380ef27fd952511aaeef36be',
    'escape-word': '7cbdcad28743945379de8655194647b06bb8f09f020a8bdaa9e4ed47ff10ccfc',
    'cheap-guards': '8cc33f9710c80833f86192ee1c850084491a60c4202e0c6f22f7d1d4892ed358',
}
variant, dictionary = os.environ['CANDIDATE'], os.environ['DICTIONARY']
pairs = int(os.environ.get('PAIRS', '6'))
order = os.environ.get('INITIAL_ORDER', 'AB')
assert variant in EXPECTED and dictionary in ('jmdict', 'jitendex')
assert 2 <= pairs <= 24 and order in ('AB', 'BA')
root = Path.cwd()
candidate = Path(os.environ['RUNNER_TEMP']) / 'round2-candidate'
output = root / 'builds/round2-screen'
output.mkdir(parents=True, exist_ok=True)
source = Path('ext/js/dictionary/wasm/term-bank-parser.c')
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
assert sha(candidate / source) == EXPECTED[variant]
run(['git', 'add', str(source)], cwd=candidate)
run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Manabitan contributors', '-c',
     'user.email=contributors@manabi.io', 'commit', '-m', f'Isolated round2 source candidate: {variant}'], cwd=candidate)
shutil.copy(patch, output / 'candidate.patch')
shutil.copy(__file__, output / 'driver.py')
exports = ['wasm_reset_heap', 'wasm_alloc', 'wasm_get_last_parse_capacity', 'wasm_get_last_content_capacity',
    'inflate_and_join_term_banks', 'parse_term_bank', 'parse_term_bank_with_media_hints',
    'parse_and_encode_term_bank_token_binary_dedup', 'build_term_string_plan', 'encode_term_lookup_index',
    'compact_term_lookup_keys', 'encode_term_content', 'encode_term_content_no_hash',
    'encode_term_content_token_binary', 'encode_term_content_token_binary_dedup']
run(['clang', '--target=wasm32-freestanding', '-O3', '-matomics', '-mbulk-memory', '-msimd128', '-nostdlib',
    '-Wl,--no-entry', '-Wl,--shared-memory', '-Wl,--max-memory=4294967296',
    *[f'-Wl,--export={name}' for name in exports], '-Wl,--strip-all', '-o',
    str(candidate / 'ext/lib/term-bank-parser.wasm'), str(candidate / source)])
replacements = {'lib/term-bank-parser.wasm', 'js/dictionary/wasm/term-bank-parser.c'}
with zipfile.ZipFile(root / package) as a, zipfile.ZipFile(candidate / package, 'w') as b:
    for member in a.infolist():
        data = (candidate / 'ext' / member.filename).read_bytes() if member.filename in replacements else a.read(member.filename)
        b.writestr(member, data)
with zipfile.ZipFile(root / package) as a, zipfile.ZipFile(candidate / package) as b:
    assert a.namelist() == b.namelist()
    assert {n for n in a.namelist() if a.read(n) != b.read(n)} == replacements

# Correctness and complete resident-corpus byte comparisons precede timing.
with (output / 'focused.log').open('w') as log:
    subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', 'test/term-bank-wasm-parser.test.js',
        'test/term-bank-experiments.test.js', 'test/term-bank-composite-state.test.js',
        'test/lookup-construction-experiments.test.js', 'test/term-bank-parser-string-scan.test.js'],
        cwd=candidate, stdout=log, stderr=subprocess.STDOUT, timeout=180, check=True)
with (output / 'component.log').open('w') as log:
    subprocess.run(['node', 'dev/perf/import-lookup-screen.js', dictionary, '--pairs', '4', '--flags', '{}',
        '--baseline-root', str(root), '--cache-dir', str(root / 'builds/e2e-dictionary-cache'),
        '--out', str(output / 'component.json')], cwd=candidate, stdout=log,
        stderr=subprocess.STDOUT, timeout=240, check=True)

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
    observations.append({**item, 'ordinal': ordinal, 'ms': measurement['totalImportMs'],
        'workerMs': measurement['workerImportMs'], 'validation': measurement['validation'],
        'browser': summary['browserVersion'], 'wallSeconds': time.monotonic() - started})
    (output / 'observations.json').write_text(json.dumps(observations, indent=2))
    print(json.dumps(observations[-1]), flush=True)
for arm, directory in roots.items():
    assert identity(directory) == identities[arm]
(output / 'complete.json').write_text(json.dumps({'completed': len(observations), 'planned': len(plan)}, indent=2))
