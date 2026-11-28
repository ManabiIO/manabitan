"""Rebuild the guarded product recipe and verify correctness without timing it."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('baseline', type=Path)
parser.add_argument('candidate', type=Path)
parser.add_argument('capture', type=Path)
parser.add_argument('output', type=Path)
args = parser.parse_args()
baseline, candidate, capture, output = (getattr(args, key).resolve() for key in ['baseline', 'candidate', 'capture', 'output'])
scripts = Path(__file__).resolve().parent
tooling_root = scripts.parents[2]
manifest = json.loads((scripts / 'manifest.json').read_text())
output.mkdir(parents=True, exist_ok=False)
(output / 'package.json').write_text('{"type":"module"}\n')
sha = lambda file: hashlib.sha256(Path(file).read_bytes()).hexdigest()

def run(command, **options):
    command = [str(part) for part in command]
    print(json.dumps({'command': command}), flush=True)
    subprocess.run(command, check=True, **options)

assert subprocess.check_output(['git', '-C', baseline, 'rev-parse', 'HEAD'], text=True).strip() == manifest['baselineCommit']
for file, digest in manifest['unchangedFiles'].items():
    assert sha(baseline / file) == sha(candidate / file) == digest, file
for file, digest in manifest['productSources'].items():
    assert sha(candidate / file) == digest, file
for file, digest in manifest['verificationSources'].items():
    assert sha(scripts / file) == digest, file
for file, digest in manifest['parityHarnesses'].items():
    assert sha(tooling_root / file) == digest, file
assert sha(capture / 'report.json') == manifest['captureReportSha256']
capture_report = json.loads((capture / 'report.json').read_text())
assert capture_report['complete'] and capture_report['dictionary'] == 'jmdict'
for group in capture_report['groups']:
    assert sha(capture / group['cacheFile']) == group['cacheSha256']
for name, root in [('baseline', baseline), ('count16guarded', candidate)]:
    expected = manifest['expected'][name]
    assert sha(root / 'dev/lib/zstd-simd-module.js') == expected['jsSha256']
    assert sha(root / 'dev/data/zstd-simd.wasm') == expected['wasmSha256']
    assert (root / 'dev/data/zstd-simd.wasm').stat().st_size == expected['wasmBytes']

# This is the same exact SDK archive and driver revision as the frozen component
# experiment. A local override reuses that verified installation; CI downloads
# and checks the complete public archive before extraction.
upstream_override = os.environ.get('MANABITAN_EMSCRIPTEN_UPSTREAM')
upstream = Path(upstream_override).resolve() if upstream_override else output / 'sdk/upstream'
if not upstream_override:
    upstream.mkdir(parents=True)
    archive = output / 'sdk/wasm-binaries.tar.xz'
    expected_sdk = manifest['emscripten']
    digest = hashlib.sha256()
    count = 0
    with urllib.request.urlopen(expected_sdk['url'], timeout=60) as response, archive.open('xb') as target:
        while block := response.read(1048576):
            count += len(block)
            assert count <= expected_sdk['bytes']
            digest.update(block)
            target.write(block)
    assert count == expected_sdk['bytes'] and digest.hexdigest() == expected_sdk['sha256']
    run(['tar', '-xJf', archive, '-C', upstream, '--strip-components=1'],
        env=dict(os.environ, XZ_OPT='--threads=1 --memlimit-decompress=128MiB'))
    archive.unlink()
node = shutil.which('node')
assert node and subprocess.check_output([node, '--version'], text=True).strip() == 'v24.22.3'
config = output / 'emscripten-config'
config.write_text(f'LLVM_ROOT = {str(upstream / "bin")!r}\nBINARYEN_ROOT = {str(upstream)!r}\nNODE_JS = {node!r}\n')
temporary = output / 'native-build'
temporary.mkdir()
env = dict(os.environ, EM_CONFIG=str(config), EMCC_CORES='1', BINARYEN_CORES='1',
           PATH=str(upstream / 'emscripten') + os.pathsep + os.environ['PATH'], TMPDIR=str(temporary))
emcc = upstream / 'emscripten/emcc'
version = subprocess.check_output([emcc, '--version'], env=env, text=True)
assert manifest['emscripten']['version'] in version and manifest['emscripten']['revision'] in version

# Run the production build command, including its source fetch and git-apply
# step, in verification mode. It must reproduce the already staged JS/WASM.
run([node, candidate / 'dev/bin/build-zstd-wasm.js', '--keepTemp'], env=env, cwd=candidate)
build_roots = list(temporary.glob('manabitan-zstd-wasm-*'))
assert len(build_roots) == 1
build_root = build_roots[0]
source = build_root / 'zstd'
assert sha(source / 'lib/compress/zstd_compress_internal.h') == manifest['guardedHeaderSha256']
assert sha(build_root / 'zstd-simd-module.wasm') == manifest['expected']['count16guarded']['wasmSha256']
for name, root in [('baseline', baseline), ('count16guarded', candidate)]:
    target = output / f'wasm-{name}'
    target.mkdir()
    shutil.copyfile(root / 'dev/lib/zstd-simd-module.js', target / 'zstd-simd-module.js')
    shutil.copyfile(root / 'dev/data/zstd-simd.wasm', target / 'zstd-simd-module.wasm')
    shutil.copyfile(root / 'dev/lib/zstd-wasm.js', target / 'zstd-wasm.js')

run([sys.executable, scripts / 'build-boundaries.py', candidate, source, emcc, output / 'boundaries'], env=env)
run([node, scripts / 'boundaries.mjs', output / 'boundaries', output / 'boundary-result.json'], env=env)
boundary = json.loads((output / 'boundary-result.json').read_text())
assert boundary['complete'] and boundary['guardedMismatches'] == 0
assert boundary['supersededFailures']['traps'] > 0 and boundary['supersededFailures']['wrongResults'] > 0

# Reuse the frozen corpus/capacity and production-wrapper parity harnesses.
# The only screen mode invoked is parity; no warm/cold timing loop is run.
parity_scripts = scripts.parent / 'wasm-word-width-v2'
run([node, '--expose-gc', parity_scripts / 'verify.mjs', baseline, capture, output,
     'count16guarded', output / 'raw-parity.json'], env=env)
run([node, '--expose-gc', parity_scripts / 'screen.mjs', baseline, capture, output,
     output / 'wrapper-parity.json', 'count16guarded', 'AB', 'parity'], env=env)
raw = json.loads((output / 'raw-parity.json').read_text())
wrapped = json.loads((output / 'wrapper-parity.json').read_text())
assert raw['parity']['cases'] == 651 and raw['parity']['mismatches'] == 0
assert raw['parity']['allCompressedBytesExact'] and raw['parity']['crossDecoderRoundTrip']
assert raw['destinationChecks'] == 1110 and raw['destinationCanariesIntact']
assert raw['destinationStatusDifferences'] == []
assert wrapped['parity']['blocks'] == 103 and wrapped['parity']['inputBytes'] == 100300626
assert wrapped['parity']['compressedBytes'] == 12326040 and wrapped['parity']['wrappedBytesExact']
report = {
    'complete': True,
    'scope': 'Pinned production rebuild, actual-header boundary proof, and existing corpus/canary parity only. No candidate performance measurement.',
    'node': subprocess.check_output([node, '--version'], text=True).strip(),
    'candidateCommit': subprocess.check_output(['git', '-C', candidate, 'rev-parse', 'HEAD'], text=True).strip(),
    'candidateTrackedChanges': subprocess.check_output(['git', '-C', candidate, 'diff', '--name-only', 'HEAD'], text=True).splitlines(),
    'manifest': manifest,
    'verificationEntryPointSha256': sha(Path(__file__)),
    'compilerVersion': version,
    'sdkOverride': upstream_override is not None,
    'boundaryCases': boundary['totalCases'],
    'supersededFailures': boundary['supersededFailures'],
    'rawCases': raw['parity']['cases'],
    'destinationChecks': raw['destinationChecks'],
    'destinationStatusDifferences': 0,
    'wrappedBlocks': wrapped['parity']['blocks'],
    'receipts': {name: sha(output / name) for name in ['boundaries/build.json', 'boundary-result.json', 'raw-parity.json', 'wrapper-parity.json']},
}
(output / 'verification.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'complete': True, 'boundaryCases': report['boundaryCases'], 'rawCases': report['rawCases'],
                  'destinationChecks': report['destinationChecks'], 'wrappedBlocks': report['wrappedBlocks']}, indent=2))
