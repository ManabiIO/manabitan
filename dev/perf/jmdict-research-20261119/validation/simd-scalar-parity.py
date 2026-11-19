import hashlib
import json
import os
from pathlib import Path
import subprocess


workspace = Path('/workspace/scratch/cb98f2e06b71')
toolchain = workspace / 'toolchains/llvm-21.1.8/usr'
compiler = toolchain / 'bin/clang-21'
linker = toolchain / 'bin/wasm-ld-21'
destination = workspace / 'simd-scalar-parity'
destination.mkdir(exist_ok=False)
environment = dict(os.environ)
environment['LD_LIBRARY_PATH'] = str(toolchain / 'lib/x86_64-linux-gnu')
results = []
for directory in ['manabitan', 'manabitan-simd']:
    root = workspace / directory
    manifest = json.loads((root / 'dev/data/dictionary-wasm/manifest.json').read_text())
    target = next(item for item in manifest['targets'] if item['name'] == 'term-bank-parser.wasm')
    arguments = [value for value in target['arguments'] if value != '-msimd128']
    output = destination / (directory + '.wasm')
    subprocess.run([
        str(compiler), '-fuse-ld=' + str(linker), *arguments, '-o', str(output),
        *[str(root / source) for source in target['sources']],
    ], env=environment, check=True)
    data = output.read_bytes()
    results.append({
        'root': str(root), 'output': str(output), 'arguments': arguments,
        'byteLength': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
    })
identical = results[0]['sha256'] == results[1]['sha256']
result = {'identical': identical, 'results': results}
(destination / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
assert identical, 'Disabling SIMD must preserve the exact scalar parser module'
