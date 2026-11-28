"""Build one preserved attempt of the isolated helper, without acquiring time."""
from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import subprocess

here = Path(__file__).resolve().parent
attempts = here / 'build-attempts'
attempts.mkdir(exist_ok=True)
number = len(list(attempts.iterdir())) + 1
attempt = attempts / f'{number:03d}'
attempt.mkdir()
source = here / 'record-fields.c'
shutil.copyfile(source, attempt / source.name)
compiler = Path('/workspace/scratch/f34c9c9fae89/toolchains/llvm21/usr/lib/llvm-21/bin/clang')
linker = compiler.parent / 'wasm-ld'
arguments = ['--target=wasm32', '-O3', '-nostdlib', '-mbulk-memory', '-Wl,--no-entry', '-Wl,--import-memory', '-Wl,-z,stack-size=65536', '-Wl,--strip-all']
command = [str(compiler), '-fuse-ld=' + str(linker), *arguments, '-o', str(attempt / 'record-fields.wasm'), str(source)]
env = dict(os.environ)
env['LD_LIBRARY_PATH'] = '/workspace/scratch/f34c9c9fae89/toolchains/llvm21/usr/lib/x86_64-linux-gnu'
env['TMPDIR'] = str(attempt)
receipt = {'complete': False, 'attempt': number, 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'command': command, 'arguments': arguments, 'timingAcquisition': False, 'requiredWasmFeatures': ['bulk-memory']}
try:
    for name, path in [('compiler', compiler), ('linker', linker)]:
        version = subprocess.check_output([str(path), '--version'], env=env, text=True).strip()
        assert re.search(r'\b21\.1\.8\b', version), version
        receipt[name + 'Version'] = version
    result = subprocess.run(command, env=env, capture_output=True, text=True)
    (attempt / 'build.log').write_text(result.stdout + result.stderr)
    receipt['exitCode'] = result.returncode
    assert result.returncode == 0, result.stderr
    binary = (attempt / 'record-fields.wasm').read_bytes()
    receipt['wasmBytes'] = len(binary)
    receipt['wasmSha256'] = hashlib.sha256(binary).hexdigest()
    (here / 'record-fields.wasm').write_bytes(binary)
    receipt['complete'] = True
except BaseException as error:
    receipt['error'] = repr(error)
    raise
finally:
    (attempt / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt, indent=2))
