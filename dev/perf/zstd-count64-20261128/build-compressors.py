import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--project-root', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--emcc', default='emcc')
parser.add_argument('--source', type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parent
project = args.project_root.resolve()
output = args.output.resolve()
binding = json.loads((root / 'source-binding.json').read_text())
output.mkdir(parents=True, exist_ok=False)
(output / 'package.json').write_text('{"type":"module"}\n')

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

version = subprocess.check_output([args.emcc, '--version'], text=True)
assert binding['emscripten'] in version, version
assert binding['emscriptenRevision'] in version, version
(output / 'compiler-version.txt').write_text(version)
assert sha(root / 'zstd-count64.patch') == binding['patchSha256']
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=project, text=True).strip() == binding['sourceHead']
source = output / 'source-baseline'
if args.source is None:
    source.mkdir()
    subprocess.run(['git', 'init', '--quiet'], cwd=source, check=True)
    subprocess.run(['git', 'remote', 'add', 'origin', 'https://github.com/facebook/zstd.git'], cwd=source, check=True)
    subprocess.run(['git', 'fetch', '--quiet', '--depth=1', 'origin', binding['zstdCommit']], cwd=source, check=True)
    subprocess.run(['git', 'checkout', '--quiet', 'FETCH_HEAD'], cwd=source, check=True)
else:
    assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=args.source, text=True).strip() == binding['zstdCommit']
    shutil.copytree(args.source, source, ignore=shutil.ignore_patterns('.git'))
assert sha(source / binding['sourcePath']) == binding['sourceSha256']
candidate = output / 'source-count64'
shutil.copytree(source, candidate, ignore=shutil.ignore_patterns('.git'))
subprocess.run(['git', 'init', '--quiet'], cwd=candidate, check=True)
subprocess.run(['git', 'apply', '--check', str(root / 'zstd-count64.patch')], cwd=candidate, check=True)
subprocess.run(['git', 'apply', str(root / 'zstd-count64.patch')], cwd=candidate, check=True)
assert sha(candidate / binding['sourcePath']) == binding['candidateSha256']

exports = [
    '_ZSTD_isError', '_ZSTD_compressBound', '_ZSTD_createCCtx', '_ZSTD_freeCCtx',
    '_ZSTD_compress_usingDict', '_ZSTD_compress', '_ZSTD_createDCtx', '_ZSTD_freeDCtx',
    '_ZSTD_getFrameContentSize', '_ZSTD_decompress_usingDict', '_ZSTD_decompress',
    '_manabitan_write_block_envelope', '_malloc', '_free',
]
reports = []
for arm in ['baseline', 'count64']:
    arm_source = output / f'source-{arm}'
    arm_output = output / arm
    arm_output.mkdir()
    begin = time.monotonic()
    with (arm_output / 'build.log').open('w') as log:
        subprocess.run(['./create_single_file_library.sh'], cwd=arm_source / 'build/single_file_libs', stdout=log, stderr=subprocess.STDOUT, check=True)
        command = [args.emcc, str(arm_source / 'build/single_file_libs/zstd.c'), str(project / 'dev/data/zstd-block-envelope.c'),
                   '-O3', '-flto', '-msimd128', '--emit-symbol-map', '-o', str(arm_output / 'zstd-simd-module.js'),
                   '-s', 'EXPORTED_FUNCTIONS=' + json.dumps(exports, separators=(',', ':')),
                   '-s', 'EXPORTED_RUNTIME_METHODS=["HEAPU8"]',
                   '-s', 'FILESYSTEM=0', '-s', 'ALLOW_MEMORY_GROWTH=1', '-s', 'MODULARIZE=1',
                   '-s', 'EXPORT_ES6=1', '-s', 'EXPORT_NAME=createZstdModule', '-s', 'ENVIRONMENT=web,worker']
        (arm_output / 'command.json').write_text(json.dumps(command, indent=2) + '\n')
        subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True)
    report = {
        'arm': arm,
        'seconds': time.monotonic() - begin,
        'wasmBytes': (arm_output / 'zstd-simd-module.wasm').stat().st_size,
        'wasmSha256': sha(arm_output / 'zstd-simd-module.wasm'),
        'jsSha256': sha(arm_output / 'zstd-simd-module.js'),
        'checkedInWasmEqual': (arm_output / 'zstd-simd-module.wasm').read_bytes() == (project / 'dev/data/zstd-simd.wasm').read_bytes(),
        'checkedInJsEqual': (arm_output / 'zstd-simd-module.js').read_bytes() == (project / 'dev/lib/zstd-simd-module.js').read_bytes(),
        'wrapperSourceSha256': sha(project / 'dev/data/zstd-block-envelope.c'),
        'buildScriptSha256': sha(project / 'dev/bin/build-zstd-wasm.js'),
    }
    reports.append(report)
    (output / 'build-report.json').write_text(json.dumps(reports, indent=2) + '\n')
    print(json.dumps(report), flush=True)
    if arm == 'baseline':
        assert report['checkedInWasmEqual'], 'Pinned baseline WASM is not reproducible; stop before measuring'
        assert report['checkedInJsEqual'], 'Pinned baseline JS is not reproducible; stop before measuring'
