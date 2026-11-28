"""Reproduce the failed gate on one unchanged, minimal bundled library."""
import difflib
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

HERE = Path(__file__).resolve().parent
SOURCE = Path('/home/agent/b9cacc-parser-bundle')
NODE = Path('/home/agent/.cache/manabitan-b9cacc/node-runtime/node_modules/node/bin/node')
root = HERE / 'dependency-path-reproduction-002'
root.mkdir(exist_ok=False)
candidate = root / 'candidate'
linked = candidate / '.tmp-baseline-symlink'
independent = candidate / '.tmp-baseline-hardlink'
dependency = SOURCE / 'node_modules/ajv'
files = ['package.json', 'dist/runtime/ucs2length.js',
         'dist/runtime/ucs2length.js.map', 'lib/runtime/ucs2length.ts']

for relative in files:
    source = dependency / relative
    destination = candidate / 'node_modules/ajv' / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    os.link(source, destination)

for directory in [candidate, linked, independent]:
    (directory / 'dev/lib').mkdir(parents=True, exist_ok=True)
    (directory / 'ext/lib').mkdir(parents=True, exist_ok=True)
    if directory == candidate:
        shutil.copyfile(SOURCE / 'dev/lib/ucs2length.js', directory / 'dev/lib/ucs2length.js')
    else:
        os.link(candidate / 'dev/lib/ucs2length.js', directory / 'dev/lib/ucs2length.js')

(linked / 'node_modules').symlink_to(candidate / 'node_modules', target_is_directory=True)
for relative in files:
    source = candidate / 'node_modules/ajv' / relative
    destination = independent / 'node_modules/ajv' / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    os.link(source, destination)

driver = root / 'build-one.mjs'
driver.write_text('''import esbuild from %s;
import path from 'node:path';
await esbuild.build({
  entryPoints: [path.resolve('dev/lib/ucs2length.js')],
  bundle: true, minify: false, sourcemap: true, target: 'es2020',
  format: 'esm', outfile: path.resolve('ext/lib/ucs2length.js'),
  external: ['fs'], banner: {js: '// @ts-nocheck'},
});
console.log(JSON.stringify({node: process.version, esbuild: esbuild.version}));
''' % json.dumps(str((SOURCE / 'node_modules/esbuild/lib/main.js').resolve())))

results = {}
for label, directory in [('candidate', candidate), ('symlink', linked), ('hardlink', independent)]:
    process = subprocess.run([str(NODE), str(driver)], cwd=directory,
                             capture_output=True, text=True, check=True)
    results[label] = {'tools': json.loads(process.stdout), 'outputs': {}}
    for name in ['ucs2length.js', 'ucs2length.js.map']:
        payload = (directory / 'ext/lib' / name).read_bytes()
        results[label]['outputs'][name] = {
            'bytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest()}

for name in ['ucs2length.js', 'ucs2length.js.map']:
    a = (candidate / 'ext/lib' / name).read_text()
    b = (linked / 'ext/lib' / name).read_text()
    c = (independent / 'ext/lib' / name).read_text()
    assert a != b, 'The symlink must reproduce the failed comparison'
    assert a == c, 'Independent dependency paths must restore exact JS and map bytes'
    (root / (name + '.diff')).write_text(''.join(difflib.unified_diff(
        a.splitlines(True), b.splitlines(True), fromfile='candidate/' + name,
        tofile='symlink-baseline/' + name)))

report = {
    'scope': 'One unchanged library; esbuild options match production buildLib',
    'dependencyFiles': {name: hashlib.sha256((candidate / 'node_modules/ajv' / name).read_bytes()).hexdigest()
                        for name in files},
    'source': hashlib.sha256((SOURCE / 'dev/lib/ucs2length.js').read_bytes()).hexdigest(),
    'results': results,
    'symlinkDiffers': True,
    'independentHardlinkCopyIsByteIdentical': True,
}
(HERE / 'dependency-path-reproduction.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
