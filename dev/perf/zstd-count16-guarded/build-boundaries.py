"""Build small probes from actual pinned headers in a caller-owned source tree."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('repository', type=Path)
parser.add_argument('source', type=Path)
parser.add_argument('emcc', type=Path)
parser.add_argument('output', type=Path)
args = parser.parse_args()
repository = args.repository.resolve()
source = args.source.resolve()
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=False)
scripts = Path(__file__).resolve().parent
header_name = 'lib/compress/zstd_compress_internal.h'
header = source / header_name
patch = repository / 'dev/data/zstd-wasm32-count.patch'
sha = lambda data: hashlib.sha256(data).hexdigest()
original = subprocess.check_output(['git', '-C', source, 'show', f'HEAD:{header_name}'])
assert subprocess.check_output(['git', '-C', source, 'rev-parse', 'HEAD'], text=True).strip() == '82d322c4973d9e2968d94047a40892bc6d9a9bdf'
tracked_changes = subprocess.check_output(['git', '-C', source, 'diff', '--name-only', 'HEAD'], text=True).splitlines()
assert set(tracked_changes).issubset({header_name}), tracked_changes
assert sha(original) == 'e99de778a2a733bde856172057fe380256c379f082bd3513cac600b005ac2b98'
assert sha(patch.read_bytes()) == '9bd9847abd7b0fec06ebe6f13d372e9796faeb363865671baf1ec10ed65fd816'
saved_header = header.read_bytes()
assert sha(saved_header) in [sha(original), 'a4121756c5735ca90241d46f7054b0d1345538e854f1fc721a6656c3046b6ba9']
version = subprocess.check_output([args.emcc, '--version'], text=True)
assert '5.0.1-git' in version and '8c5f43157a3f069ade75876e23061330521eabde' in version
records = []
try:
    header.write_bytes(original)
    subprocess.run(['git', '-C', source, 'apply', '--check', patch], check=True)
    subprocess.run(['git', '-C', source, 'apply', patch], check=True)
    guarded = header.read_bytes()
    assert sha(guarded) == 'a4121756c5735ca90241d46f7054b0d1345538e854f1fc721a6656c3046b6ba9'
    guard = b'    if (pIn > pInLimit) return 0;\n'
    assert guarded.count(guard) == 1
    superseded = guarded.replace(guard, b'', 1)
    assert sha(superseded) == '2e0f8383beeef1ecf4fb63ccaa12fb825e1bf87a3e63a11731e3380f223f5829'
    for name, contents in [('baseline', original), ('superseded', superseded), ('guarded', guarded)]:
        header.write_bytes(contents)
        command = [str(args.emcc), str(scripts / 'count-boundaries.c'),
                   '-I', str(source / 'lib/compress'), '-O3', '-flto', '-msimd128',
                   '-s', 'STANDALONE_WASM=1', '-s', 'INITIAL_MEMORY=131072',
                   '-s', 'MAXIMUM_MEMORY=131072', '-s', 'STACK_SIZE=16384',
                   '-s', 'EXPORTED_FUNCTIONS=["_countMatch","_countSegments"]',
                   '-Wl,--no-entry', '-o', str(output / f'{name}.wasm')]
        subprocess.run(command, check=True, env=dict(os.environ, EMCC_CORES='1', BINARYEN_CORES='1'))
        records.append({'name': name, 'headerSha256': sha(contents), 'wasmSha256': sha((output / f'{name}.wasm').read_bytes()), 'command': command})
finally:
    header.write_bytes(saved_header)
report = {'complete': True, 'compilerVersion': version, 'patchSha256': sha(patch.read_bytes()),
          'upstreamCommit': '82d322c4973d9e2968d94047a40892bc6d9a9bdf', 'initialTrackedChanges': tracked_changes,
          'wrapperSha256': sha((scripts / 'count-boundaries.c').read_bytes()),
          'builderSha256': sha(Path(__file__).read_bytes()), 'records': records}
(output / 'build.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'complete': True, 'records': [{key: record[key] for key in ['name', 'headerSha256', 'wasmSha256']} for record in records]}, indent=2))
