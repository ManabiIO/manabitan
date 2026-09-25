from pathlib import Path
import hashlib, json, os, subprocess, zipfile

out = Path('builds/hotpath-source')
out.mkdir(parents=True, exist_ok=True)
sha = lambda data: hashlib.sha256(data).hexdigest()
parser = Path('ext/js/dictionary/term-bank-wasm-parser.js')
native = Path('ext/js/dictionary/wasm/term-bank-parser.c')
assert sha(parser.read_bytes()) == '26f1eee368eaee1f68674beccc7f01737a3c64d4ae18d7c7a0c2a2453e2bfe4d'
assert sha(native.read_bytes()) == 'b65eebac1d7a83eeb6ae14969069afc376a0084ddb0f6ffa01a84d1266dde108'
if os.environ.get('INCLUDE_NUMERIC') == '1':
    old = '    const value = Number(decodeParserText(source.subarray(start, end)));'
    new = '''    const negative = source[start] === 0x2d;
    const digitsStart = negative ? start + 1 : start;
    // Every step of a <=15-digit integer conversion is exact. Keep longer
    // tokens on Number's existing path, including fractions and exponents.
    if (end > digitsStart && end - digitsStart <= 15) {
        let integer = 0;
        let i = digitsStart;
        for (; i < end; ++i) {
            const digit = source[i] - 0x30;
            if (digit < 0 || digit > 9) { break; }
            integer = integer * 10 + digit;
        }
        if (i === end) { return negative ? -integer : integer; }
    }
''' + old
    s = parser.read_text()
    assert s.count(old) == 1
    parser.write_text(s.replace(old, new))
    assert sha(parser.read_bytes()) == 'f617cce1a6c253a86470d4dc0a38d0edc08a38b957c77390e64460da791014aa'
info = {'pin': '76362775484661b3cd8b9d2c84b228802c023a76', 'numericProjectionInBothArms': os.environ.get('INCLUDE_NUMERIC') == '1', 'packages': {}}
for arm in ['base', 'candidate']:
    if arm == 'candidate':
        subprocess.run(['git', 'apply', 'dev/perf/hotpath-round-20260925/fallback-native.patch'], check=True)
        assert sha(native.read_bytes()) == '1a849b3e13b6eebf21f21ae4ed02d93f559665b7643e05ab50b9982ec3865acb'
        if not info['numericProjectionInBothArms']:
            assert sha(parser.read_bytes()) == 'e5ae42166558f5a923434db3d638565af192ba2caf268ff936dcc01bb1f5b636'
    subprocess.run(['npm', 'run', 'build:libs'], check=True)
    subprocess.run(['npm', 'run', 'build', '--', '--target', 'chrome-dev'], check=True)
    package = Path('builds/manabitan-chrome-dev.zip').read_bytes()
    (out / (arm + '.zip')).write_bytes(package)
    info['packages'][arm] = {'path': str(out / (arm + '.zip')), 'sha256': sha(package), 'sourceJS': sha(parser.read_bytes()), 'sourceC': sha(native.read_bytes()), 'wasm': sha(Path('ext/lib/term-bank-parser.wasm').read_bytes())}

def members(arm):
    with zipfile.ZipFile(out / (arm + '.zip')) as z:
        return {n: sha(z.read(n)) for n in z.namelist() if not n.endswith('/')}
a, b = members('base'), members('candidate')
assert a.keys() == b.keys()
changed = sorted(n for n in a if a[n] != b[n])
assert changed == ['js/dictionary/term-bank-wasm-parser.js', 'js/dictionary/wasm/term-bank-parser.c', 'lib/term-bank-parser.wasm'], changed
for arm, entries in [('base', a), ('candidate', b)]:
    assert entries['js/dictionary/term-bank-wasm-parser.js'] == info['packages'][arm]['sourceJS']
    assert entries['js/dictionary/wasm/term-bank-parser.c'] == info['packages'][arm]['sourceC']
    assert entries['lib/term-bank-parser.wasm'] == info['packages'][arm]['wasm']
info['changedMembers'] = changed
info['memberHashes'] = {'base': a, 'candidate': b}
(out / 'build-identities.json').write_text(json.dumps(info, indent=2) + '\n')

# Reuse the audited complete-import protocol, changing only package selection.
p = Path('dev/perf/hotpath-round-20260925/run.mjs')
s = p.read_text()
replacements = [
    ("import {mkdir, readFile, writeFile}", "import {copyFile, mkdir, readFile, writeFile}"),
    ("const flags = {base: {...commonFlags, [flag]: false}, candidate: {...commonFlags, [flag]: true}}", "const sourceBuild = JSON.parse(await readFile(path.join(root, 'builds/hotpath-source/build-identities.json'), 'utf8'))\nconst flags = {base: {...commonFlags}, candidate: {...commonFlags}}"),
    ("const summary = {dictionary, fixture,", "const summary = {build: sourceBuild, dictionary, fixture,"),
    ("        console.log(`start ${dictionary} ${id}`)", "        const packageInfo = sourceBuild.packages[arm]\n        await copyFile(path.join(root, packageInfo.path), path.join(root, 'builds/manabitan-chrome-dev.zip'))\n        assert.equal(hash(await readFile(path.join(root, 'builds/manabitan-chrome-dev.zip'))), packageInfo.sha256)\n        console.log(`start ${dictionary} ${id}`)"),
    ("summary.observations.push({id, block, position, arm, kind:", "summary.observations.push({id, block, position, arm, packageSha256: packageInfo.sha256, kind:"),
]
for old, new in replacements:
    assert s.count(old) == 1, old
    s = s.replace(old, new)
Path('dev/perf/hotpath-round-20260925/run-source.generated.mjs').write_text(s)
print(json.dumps({k:v for k,v in info.items() if k != 'memberHashes'}, indent=2))
