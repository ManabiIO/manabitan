"""Reproduce the pinned codec, then build explicitly hashed local experiments."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.request

scripts = Path(__file__).resolve().parent
manifest = json.loads((scripts / 'manifest.json').read_text())
repo = Path(sys.argv[1]).resolve()
out = Path(sys.argv[2]).resolve()
out.mkdir(parents=True, exist_ok=True)
(out / 'package.json').write_text('{"type":"module"}\n')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(args, **options):
    return subprocess.run([str(x) for x in args], check=True, **options)


assert sha(repo / 'dev/data/zstd-block-envelope.c') == manifest['envelopeSourceSha256']
assert sha(repo / 'dev/lib/zstd-wasm.js') == manifest['wrapperSha256']
assert sha(repo / 'dev/data/zstd-simd.wasm') == manifest['expected']['baseline']['wasmSha256']
assert sha(repo / 'dev/lib/zstd-simd-module.js') == manifest['expected']['baseline']['jsSha256']

sdk = out / 'sdk'
upstream_override = os.environ.get('MANABITAN_EMSCRIPTEN_UPSTREAM')
upstream = Path(upstream_override).resolve() if upstream_override else sdk / 'upstream'
if not upstream_override:
    sdk.mkdir(parents=True, exist_ok=True)
    upstream.mkdir(parents=True, exist_ok=True)
    archive = sdk / 'wasm-binaries.tar.xz'
    expected = manifest['emscripten']
    digest = hashlib.sha256()
    count = 0
    with urllib.request.urlopen(expected['url']) as response, archive.open('wb') as target:
        while True:
            block = response.read(1024 * 1024)
            if not block:
                break
            target.write(block)
            digest.update(block)
            count += len(block)
    assert count == expected['bytes'], count
    assert digest.hexdigest() == expected['sha256'], digest.hexdigest()
    run(['tar', '-xJf', archive, '-C', upstream, '--strip-components=1'], env=dict(os.environ, XZ_OPT='--threads=1 --memlimit-decompress=128MiB'))
    archive.unlink()
config = out / 'emscripten-config'
node = shutil.which('node')
assert node
config.write_text(f'LLVM_ROOT = {str(upstream / "bin")!r}\nBINARYEN_ROOT = {str(upstream)!r}\nNODE_JS = {node!r}\n')
env = dict(os.environ, EM_CONFIG=str(config), EMCC_CORES='1', BINARYEN_CORES='1')
emcc = upstream / 'emscripten/emcc'
version = subprocess.check_output([str(emcc), '--version'], env=env, text=True)
assert manifest['emscripten']['version'] in version
assert manifest['emscripten']['revision'] in version

source = out / 'zstd-source'
assert not source.exists(), f'Choose a fresh output directory: {source}'
local_source = os.environ.get('MANABITAN_ZSTD_SOURCE')
if local_source:
    run(['git', 'clone', '--quiet', '--shared', local_source, source])
    run(['git', '-C', source, 'checkout', '--quiet', manifest['zstdCommit']])
else:
    run(['git', 'init', '--quiet', source])
    run(['git', '-C', source, 'remote', 'add', 'origin', 'https://github.com/facebook/zstd.git'])
    run(['git', '-C', source, 'fetch', '--quiet', '--depth=1', 'origin', manifest['zstdCommit']])
    run(['git', '-C', source, 'checkout', '--quiet', 'FETCH_HEAD'])
assert subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip() == manifest['zstdCommit']
exports = ['_ZSTD_isError', '_ZSTD_compressBound', '_ZSTD_createCCtx', '_ZSTD_freeCCtx', '_ZSTD_compress_usingDict', '_ZSTD_compress', '_ZSTD_createDCtx', '_ZSTD_freeDCtx', '_ZSTD_getFrameContentSize', '_ZSTD_decompress_usingDict', '_ZSTD_decompress', '_manabitan_write_block_envelope', '_malloc', '_free']
results = []
for mode in ['baseline', *manifest['candidates']]:
    run(['git', '-C', source, 'reset', '--hard', '--quiet', 'HEAD'])
    if mode == 'cstream64':
        run([sys.executable, scripts / 'patch-cstream64.py', source])
    else:
        run([sys.executable, scripts / 'patch-zstd.py', source, mode])
    single = source / 'build/single_file_libs'
    run(['./create_single_file_library.sh'], cwd=single)
    output = out / f'wasm-{mode}'
    output.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(single / 'zstd.c', output / 'zstd.c')
    args = [emcc, output / 'zstd.c', repo / 'dev/data/zstd-block-envelope.c', '-O3', '-flto', '-msimd128', '-o', output / 'zstd-simd-module.js', '-s', f'EXPORTED_FUNCTIONS={json.dumps(exports)}', '-s', 'EXPORTED_RUNTIME_METHODS=["HEAPU8"]', '-s', 'FILESYSTEM=0', '-s', 'ALLOW_MEMORY_GROWTH=1', '-s', 'MODULARIZE=1', '-s', 'EXPORT_ES6=1', '-s', 'EXPORT_NAME=createZstdModule', '-s', 'ENVIRONMENT=web,worker']
    run(args, env=env)
    actual = {'jsSha256': sha(output / 'zstd-simd-module.js'), 'wasmSha256': sha(output / 'zstd-simd-module.wasm'), 'wasmBytes': (output / 'zstd-simd-module.wasm').stat().st_size}
    assert actual == manifest['expected'][mode], (mode, actual, manifest['expected'][mode])
    shutil.copyfile(repo / 'dev/lib/zstd-wasm.js', output / 'zstd-wasm.js')
    results.append({'mode': mode, 'artifacts': actual, 'amalgamationSha256': sha(output / 'zstd.c'), 'command': [str(x) for x in args]})
    print(json.dumps({'built': mode, **actual}), flush=True)
(out / 'build.json').write_text(json.dumps({'toolchain': version, 'manifest': manifest, 'builds': results}, indent=2) + '\n')
