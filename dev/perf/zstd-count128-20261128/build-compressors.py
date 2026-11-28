import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--project-root', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--emcc', default='emcc')
parser.add_argument('--source', type=Path)
parser.add_argument(
    '--diagnostic-symbol-map', action=argparse.BooleanOptionalAction, default=True,
    help='Build a separately named diagnostic baseline after both production builds (default: enabled)',
)
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
expected_version = binding['emscripten'].removesuffix('-git')
expected_identity = re.escape(expected_version) + r'(?:-git)?\s+\(' + re.escape(binding['emscriptenRevision']) + r'\)'
assert re.search(r'\b' + expected_identity, version), version
(output / 'compiler-version.txt').write_text(version)
assert sha(root / 'zstd-count128.patch') == binding['patchSha256']
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
candidate = output / 'source-count128'
shutil.copytree(source, candidate, ignore=shutil.ignore_patterns('.git'))
subprocess.run(['git', 'init', '--quiet'], cwd=candidate, check=True)
subprocess.run(['git', 'apply', '--check', str(root / 'zstd-count128.patch')], cwd=candidate, check=True)
subprocess.run(['git', 'apply', str(root / 'zstd-count128.patch')], cwd=candidate, check=True)
assert sha(candidate / binding['sourcePath']) == binding['candidateSha256']

exports = [
    '_ZSTD_isError', '_ZSTD_compressBound', '_ZSTD_createCCtx', '_ZSTD_freeCCtx',
    '_ZSTD_compress_usingDict', '_ZSTD_compress', '_ZSTD_createDCtx', '_ZSTD_freeDCtx',
    '_ZSTD_getFrameContentSize', '_ZSTD_decompress_usingDict', '_ZSTD_decompress',
    '_manabitan_write_block_envelope', '_malloc', '_free',
]

def compiler_command(arm_source, js_output, *, symbol_map=False):
    command = [args.emcc, str(arm_source / 'build/single_file_libs/zstd.c'), str(project / 'dev/data/zstd-block-envelope.c'),
               '-O3', '-flto', '-msimd128']
    if symbol_map:
        command.append('--emit-symbol-map')
    command.extend([
        '-o', str(js_output),
        '-s', 'EXPORTED_FUNCTIONS=' + json.dumps(exports, separators=(',', ':')),
        '-s', 'EXPORTED_RUNTIME_METHODS=["HEAPU8"]',
        '-s', 'FILESYSTEM=0', '-s', 'ALLOW_MEMORY_GROWTH=1', '-s', 'MODULARIZE=1',
        '-s', 'EXPORT_ES6=1', '-s', 'EXPORT_NAME=createZstdModule', '-s', 'ENVIRONMENT=web,worker',
    ])
    return command

reports = []
for arm in ['baseline', 'count128']:
    arm_source = output / f'source-{arm}'
    arm_output = output / arm
    arm_output.mkdir()
    begin = time.monotonic()
    with (arm_output / 'build.log').open('w') as log:
        subprocess.run(['./create_single_file_library.sh'], cwd=arm_source / 'build/single_file_libs', stdout=log, stderr=subprocess.STDOUT, check=True)
        command = compiler_command(arm_source, arm_output / 'zstd-simd-module.js')
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

if args.diagnostic_symbol_map:
    # Symbol-map emission retains names through Binaryen optimization, which can
    # change function ordering. It must never alter either production asset or
    # supply function indices to the production profile without separate proof.
    diagnostic_root = output / 'baseline'
    diagnostic_js = diagnostic_root / 'zstd-simd-module.diagnostic.js'
    diagnostic_wasm = diagnostic_js.with_suffix('.wasm')
    diagnostic_symbols = diagnostic_js.with_name(diagnostic_js.name + '.symbols')
    command = compiler_command(source, diagnostic_js, symbol_map=True)
    (diagnostic_root / 'diagnostic-command.json').write_text(json.dumps(command, indent=2) + '\n')
    begin = time.monotonic()
    with (diagnostic_root / 'diagnostic-build.log').open('w') as log:
        subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True)
    diagnostic_report = {
        'purpose': 'Separate symbolization build; never used for timing or as a production replacement',
        'seconds': time.monotonic() - begin,
        'wasmFile': str(diagnostic_wasm.relative_to(output)),
        'wasmBytes': diagnostic_wasm.stat().st_size,
        'wasmSha256': sha(diagnostic_wasm),
        'jsFile': str(diagnostic_js.relative_to(output)),
        'jsSha256': sha(diagnostic_js),
        'symbolMapFile': str(diagnostic_symbols.relative_to(output)),
        'symbolMapSha256': sha(diagnostic_symbols),
        'productionBaselineWasmSha256': reports[0]['wasmSha256'],
        'productionBaselineJsSha256': reports[0]['jsSha256'],
        'productionWasmEqual': diagnostic_wasm.read_bytes() == (output / 'baseline/zstd-simd-module.wasm').read_bytes(),
        'productionJsEqual': diagnostic_js.read_bytes() == (output / 'baseline/zstd-simd-module.js').read_bytes(),
    }
    (output / 'diagnostic-build-report.json').write_text(json.dumps(diagnostic_report, indent=2) + '\n')
    for report in reports:
        arm_output = output / report['arm']
        assert sha(arm_output / 'zstd-simd-module.wasm') == report['wasmSha256']
        assert sha(arm_output / 'zstd-simd-module.js') == report['jsSha256']
    print(json.dumps(diagnostic_report), flush=True)
