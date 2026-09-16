from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
a = s.index("logrun(['node', 'dev/bin/build.js', '--target', 'chrome-dev'], 'base-build.log')")
b = s.index("logrun(['node', str(inputs / 'verify-codec.mjs')", a)
new = '''# Build both arms at the identical filesystem path: esbuild includes module
# identifiers derived from worktree paths, not just comments or source maps.
logrun(['node', 'dev/bin/build.js', '--target', 'chrome-dev'], 'base-build.log')
saved_package = (root / package).read_bytes()
saved_libraries = Path(os.environ['RUNNER_TEMP']) / 'round5-base-libraries'
shutil.copytree(root / 'ext/lib', saved_libraries)
files = run(['git', 'diff', '--name-only', BASE, 'HEAD'], candidate).splitlines()
assert files and all(not f.startswith(('.github/', 'test/', 'builds/')) for f in files)
backups = {f: (root / f).read_bytes() for f in files}
try:
    for f in files:
        (root / f).write_bytes((candidate / f).read_bytes())
    logrun(['node', 'dev/bin/build.js', '--target', 'chrome-dev'], 'candidate-build.log')
    shutil.copy(root / package, candidate / package)
    shutil.copytree(root / 'ext/lib', candidate / 'ext/lib')
finally:
    for f, data in backups.items():
        (root / f).write_bytes(data)
    (root / package).write_bytes(saved_package)
    shutil.copytree(saved_libraries, root / 'ext/lib', dirs_exist_ok=True)
allowed = {
    'overlap': {'js/dictionary/zstd-term-content.js'},
    'shared': {'js/dictionary/zstd-term-content.js', 'js/dictionary/zstd-term-content-compression-worker.js',
        'lib/zstd-wasm.js', 'lib/zstd-wasm.js.map'},
    'cdict': {'lib/zstd-wasm.js', 'lib/zstd-wasm.js.map'},
}[variant]
with zipfile.ZipFile(root / package) as a, zipfile.ZipFile(candidate / package) as b:
    assert a.namelist() == b.namelist()
    changed = {n for n in a.namelist() if a.read(n) != b.read(n)}
    assert changed <= allowed, changed - allowed
    assert changed, 'Candidate package has no effect'
(output / 'member-changes.json').write_text(json.dumps({
    'allowed': sorted(allowed), 'observed': sorted(changed),
    'buildMode': 'Actual A and B packages built at the same path; no member substitution or comment normalization'}, indent=2))
'''
s = s[:a] + new + s[b:]
p.write_text(s)
