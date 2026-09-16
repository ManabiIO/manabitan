from pathlib import Path
import hashlib, json, urllib.request, zipfile, re

ROOT = Path.cwd()
OUT = ROOT / 'builds/wty-profile'
OUT.mkdir(parents=True, exist_ok=True)
CACHE = ROOT / 'builds/e2e-dictionary-cache'
CACHE.mkdir(parents=True, exist_ok=True)
REV = '21b1b22cd655d7936d62b127e6404fbb8a88c7c3'
URL = f'https://huggingface.co/datasets/daxida/wty-release/resolve/{REV}/latest/dict/en/en/wty-en-en.zip'
EXPECTED_SHA256 = 'b9603db16dee82afd811386302ccd78bab591a6513b0d3194d937dc9110dd4a5'
EXPECTED_SIZE = 106918350
EXPECTED_ROWS = 1643040
archive = CACHE / 'wty-en-en.zip'
if not archive.exists():
    req = urllib.request.Request(URL, headers={'User-Agent': 'Manabitan-wty-benchmark'})
    with urllib.request.urlopen(req, timeout=180) as response, archive.with_suffix('.tmp').open('wb') as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    archive.with_suffix('.tmp').replace(archive)
sha = hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest()
assert sha == EXPECTED_SHA256, sha
assert archive.stat().st_size == EXPECTED_SIZE, archive.stat().st_size
with zipfile.ZipFile(archive) as z:
    index = json.loads(z.read('index.json'))
    banks = sorted((i for i in z.infolist() if re.fullmatch(r'term_bank_\d+\.json', i.filename)), key=lambda i: int(re.search(r'\d+', i.filename).group()))
    assert len(banks) == 67
    stats = {
        'index': index,
        'termBanks': len(banks),
        'termRows': EXPECTED_ROWS,
        'inflatedTermBytes': sum(i.file_size for i in banks),
        'compressedTermBytes': sum(i.compress_size for i in banks),
    }
fixture = {
    'label': index['title'],
    'cacheFile': 'wty-en-en.zip',
    'release': REV,
    'url': URL,
    'sha256': sha,
    'sizeBytes': EXPECTED_SIZE,
    'expectedTitle': index['title'],
    'revision': index['revision'],
    'termRows': EXPECTED_ROWS,
}
assert fixture['expectedTitle'] == 'wty-en-en'
assert fixture['revision'] == '2026.08.29'
(OUT / 'fixture.json').write_text(json.dumps(fixture, indent=2) + '\n')
(OUT / 'archive-profile.json').write_text(json.dumps(stats, indent=2) + '\n')
lock = ROOT / 'test/perf/dictionaries.lock.json'
data = json.loads(lock.read_text())
data['dictionaries']['wty-en-en'] = fixture
lock.write_text(json.dumps(data, indent=4) + '\n')

def replace(p, old, new):
    p = ROOT / p
    s = p.read_text()
    assert s.count(old) == 1, (str(p), old[:100], s.count(old))
    p.write_text(s.replace(old, new))

# Benchmark-only fixture/harness support. None of these alter importer work.
replace('dev/perf/dictionary-fixtures.js', '        fixtures,\n', '        fixtures,\n        dictionaryPaths: paths,\n')
replace('dev/perf/dictionary-fixtures.js', 'fixtures: Record<string, DictionaryFixture>}>}', 'fixtures: Record<string, DictionaryFixture>, dictionaryPaths: Record<string, string>}>}')
replace('test/chromium/extension-two-dictionary-import.e2e.js', "new Set(['jmdict', 'jmnedict', 'jitendex'])", "new Set(['jmdict', 'jmnedict', 'jitendex', 'wty-en-en'])")
replace('test/chromium/extension-two-dictionary-import.e2e.js', "            jitendex: {label: 'Jitendex', filePath: cachedDictionaries.jitendexPath},", "            jitendex: {label: 'Jitendex', filePath: cachedDictionaries.jitendexPath},\n            ...Object.fromEntries(Object.entries(cachedDictionaries.fixtures ?? {}).map(([id, spec]) => [id, {label: spec.label, filePath: cachedDictionaries.dictionaryPaths[id]}])),")

# Common correctness prerequisite for this workload. It is applied before the
# one shared package build, so baseline and every feature-flag arm execute the
# exact same repair. Chromium rejects TextDecoder inputs backed by shared WASM
# memory; copy only the rare strings that actually require JS decoding.
replace(
    'ext/js/dictionary/term-bank-wasm-parser.js',
    'const textDecoder = new TextDecoder();\n',
    "const textDecoder = new TextDecoder();\n\n/**\n * @param {Uint8Array} bytes\n * @returns {string}\n */\nfunction decodeTextBytes(bytes) {\n    const shared = typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer;\n    return textDecoder.decode(shared ? Uint8Array.from(bytes) : bytes);\n}\n",
)
replace('ext/js/dictionary/term-bank-wasm-parser.js', '        return textDecoder.decode(valueBytes);', '        return decodeTextBytes(valueBytes);')
replace('ext/js/dictionary/term-bank-wasm-parser.js', '    const quoted = textDecoder.decode(source.subarray(start, start + length));', '    const quoted = decodeTextBytes(source.subarray(start, start + length));')
replace('ext/js/dictionary/term-bank-wasm-parser.js', "    return textDecoder.decode(source.subarray(start, start + length));", "    return decodeTextBytes(source.subarray(start, start + length));")

print(json.dumps({'fixture': fixture, 'stats': stats}, indent=2))
