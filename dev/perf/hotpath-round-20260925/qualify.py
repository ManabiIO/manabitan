from pathlib import Path
import hashlib, json, os, shutil, subprocess

pin = '76362775484661b3cd8b9d2c84b228802c023a76'
branch = 'perf/native-fallback-escaped-key-interning-20260925'
root = Path.cwd()
evidence = root / 'builds/hotpath-qualification'
evidence.mkdir(parents=True, exist_ok=True)
source = root / 'dev/perf/hotpath-round-20260925'
work = Path(os.environ['RUNNER_TEMP']) / 'native-fallback-product'
subprocess.run(['git', 'fetch', '--depth=1', 'origin', pin], check=True)
subprocess.run(['git', 'worktree', 'add', '--detach', str(work), pin], check=True)
subprocess.run(['git', 'apply', str(source / 'fallback-native.patch'), str(source / 'test-expectations.patch')], cwd=work, check=True)
shutil.copyfile(source / 'tests/term-bank-fallback-escaped-keys.test.js', work / 'test/term-bank-fallback-escaped-keys.test.js')
expected = {
    'ext/js/dictionary/term-bank-wasm-parser.js': 'e5ae42166558f5a923434db3d638565af192ba2caf268ff936dcc01bb1f5b636',
    'ext/js/dictionary/wasm/term-bank-parser.c': '1a849b3e13b6eebf21f21ae4ed02d93f559665b7643e05ab50b9982ec3865acb',
    'test/term-bank-fallback-escaped-keys.test.js': '2f722a364c88a3f9e21421ea2aaa488bff1e8da2da0523535c382e134d21e179',
}
for name, digest in expected.items():
    assert hashlib.sha256((work/name).read_bytes()).hexdigest() == digest, name
os.symlink(root / 'node_modules', work / 'node_modules', target_is_directory=True)
commands = [
    ['npm', 'run', 'build:libs'],
    ['npx', 'vitest', 'run'],
    ['npm', 'run', 'test:unit:options'],
    ['npm', 'run', 'test:ts'],
    ['npx', 'eslint', 'ext/js/dictionary/term-bank-wasm-parser.js', 'test/term-bank-wasm-parser.test.js', 'test/term-bank-fallback-escaped-keys.test.js'],
    ['npm', 'run', 'test:build'],
    ['npm', 'run', 'build', '--', '--target', 'chrome-dev'],
]
results = []
for i, command in enumerate(commands):
    print('qualify', ' '.join(command), flush=True)
    with (evidence / (str(i) + '.log')).open('w') as f:
        result = subprocess.run(command, cwd=work, stdout=f, stderr=subprocess.STDOUT)
    results.append({'command': command, 'exitCode': result.returncode})
    (evidence / 'checks.json').write_text(json.dumps(results, indent=2)+'\n')
    assert result.returncode == 0, command
paths = [*expected, 'test/term-bank-wasm-parser.test.js']
subprocess.run(['git', 'add', '--', *paths], cwd=work, check=True)
changed = subprocess.check_output(['git', 'diff', '--cached', '--name-only'], cwd=work, text=True).splitlines()
assert sorted(changed) == sorted(paths), changed
subprocess.run(['git', '-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '-m', 'perf(import): keep escaped fallback keys in the native interner'], cwd=work, check=True)
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=work, text=True).strip()
tree = subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], cwd=work, text=True).strip()
assert subprocess.check_output(['git', 'rev-parse', 'HEAD^'], cwd=work, text=True).strip() == pin
assert not subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=work, text=True).strip()
remote = subprocess.check_output(['git', 'ls-remote', 'origin', 'refs/heads/' + branch], cwd=work, text=True).split()
assert len(remote) == 2 and remote[0] == pin and remote[1] == 'refs/heads/' + branch, remote
# Only fast-forward the dedicated product branch; never rewrite or merge develop.
subprocess.run(['git', 'push', 'origin', 'HEAD:refs/heads/' + branch], cwd=work, check=True)
info = {'pin':pin, 'branch':branch, 'commit':commit, 'tree':tree, 'paths':paths, 'sourceSHA256':{p:hashlib.sha256((work/p).read_bytes()).hexdigest() for p in paths}, 'checks':results}
(evidence/'published.json').write_text(json.dumps(info,indent=2)+'\n')
(evidence/'product.patch').write_bytes(subprocess.check_output(['git','diff',pin,'HEAD'],cwd=work))
print(json.dumps(info,indent=2),flush=True)
