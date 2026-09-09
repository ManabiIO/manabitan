import base64
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess

root = Path.cwd()
config = json.loads((root / 'dev/perf/native-source-config.json').read_text())
evidence = Path(os.environ['RUNNER_TEMP']) / 'evidence'
product = Path(os.environ['RUNNER_TEMP']) / 'product'
evidence.mkdir(parents=True, exist_ok=True)
(evidence / 'config.json').write_text(json.dumps(config, indent=2) + '\n')
encoded = (root / config['transport']).read_text()
for old, new in config['fixups']:
    assert encoded.count(old) == 1
    encoded = encoded.replace(old, new)
patch = gzip.decompress(base64.b64decode(encoded, validate=False))
assert hashlib.sha256(patch).hexdigest() == config['patchSha256']
(evidence / 'source.patch').write_bytes(patch)
subprocess.run(['git', 'worktree', 'add', '--detach', str(product), config['base']], check=True)
subprocess.run(['cp', '-al', str(root / 'node_modules'), str(product / 'node_modules')], check=True)
subprocess.run(['git', 'apply', '--index', str(evidence / 'source.patch')], cwd=product, check=True)
for index, supplement in enumerate(config['supplements']):
    data = (root / supplement['path']).read_bytes()
    assert hashlib.sha256(data).hexdigest() == supplement['sha256']
    path = evidence / f'supplement-{index}.patch'
    path.write_bytes(data)
    subprocess.run(['git', 'apply', '--index', str(path)], cwd=product, check=True)

def git(*args):
    return subprocess.check_output(['git', *args], cwd=product, text=True).strip()

assert git('write-tree') == config['tree']
assert sorted(git('diff', '--cached', '--name-only').splitlines()) == sorted(config['files'])
commands = [
    ('libraries', ['node', 'dev/bin/build-libs.js']),
    ('unit', ['node', 'node_modules/vitest/vitest.mjs', 'run']),
    ('options', ['node', 'node_modules/vitest/vitest.mjs', 'run', '--config', 'test/data/vitest.options.config.json']),
    ('types', ['npm', 'run', 'test:ts']),
    ('lint', ['npm', 'run', 'test:js']),
    ('build', ['node', 'dev/bin/build.js', '--dryRun', '--all']),
]
results = {}
for name, command in commands:
    with (evidence / f'{name}.log').open('w') as log:
        result = subprocess.run(command, cwd=product, stdout=log, stderr=subprocess.STDOUT, check=False)
    results[name] = result.returncode
    (evidence / 'status.json').write_text(json.dumps(results, indent=2) + '\n')
    print(name, result.returncode, flush=True)
    if name == 'libraries' and result.returncode != 0:
        break
assert git('write-tree') == config['tree']
assert not git('diff', '--name-only')
assert len(results) == len(commands) and all(code == 0 for code in results.values()), results
(evidence / 'qualified-tree.txt').write_text(config['tree'] + '\n')
