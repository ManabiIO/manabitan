from pathlib import Path
import hashlib, json, urllib.request, zipfile, re

ROOT = Path.cwd()
OUT = ROOT / 'builds/wty-profile'
OUT.mkdir(parents=True, exist_ok=True)
CACHE = ROOT / 'builds/e2e-dictionary-cache'
CACHE.mkdir(parents=True, exist_ok=True)
REV = '21b1b22cd655d7936d62b127e6404fbb8a88c7c3'
URL = f'https://huggingface.co/datasets/daxida/wty-release/resolve/{REV}/latest/dict/en/en/wty-en-en.zip'
archive = CACHE / 'wty-en-en.zip'
if not archive.exists():
    req = urllib.request.Request(URL, headers={'User-Agent': 'Manabitan-wty-benchmark'})
    with urllib.request.urlopen(req, timeout=180) as response, archive.with_suffix('.tmp').open('wb') as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    archive.with_suffix('.tmp').replace(archive)
sha = hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest()
with zipfile.ZipFile(archive) as z:
    index = json.loads(z.read('index.json'))
    banks = sorted((i for i in z.infolist() if re.fullmatch(r'term_bank_\d+\.json', i.filename)), key=lambda i: int(re.search(r'\d+', i.filename).group()))
    assert banks
    rows = 0
    sample = None
    for info in banks:
        entries = json.loads(z.read(info))
        rows += len(entries)
        if sample is None:
            sample = entries[:5]
            (OUT / 'term_bank_1.json').write_bytes(z.read(info))
    stats = {'index': index, 'termBanks': len(banks), 'termRows': rows, 'inflatedTermBytes': sum(i.file_size for i in banks), 'compressedTermBytes': sum(i.compress_size for i in banks), 'otherFiles': [{'name': i.filename, 'size': i.file_size} for i in z.infolist() if i not in banks][:50], 'sampleRows': sample}
fixture = {'label': index['title'], 'cacheFile': 'wty-en-en.zip', 'release': REV, 'url': URL, 'sha256': sha, 'sizeBytes': archive.stat().st_size, 'expectedTitle': index['title'], 'revision': index['revision'], 'termRows': rows}
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

replace('dev/perf/dictionary-fixtures.js', '        fixtures,\n', '        fixtures,\n        dictionaryPaths: paths,\n')
replace('dev/perf/dictionary-fixtures.js', 'fixtures: Record<string, DictionaryFixture>}>}', 'fixtures: Record<string, DictionaryFixture>, dictionaryPaths: Record<string, string>}>}')
replace('test/chromium/extension-two-dictionary-import.e2e.js', "new Set(['jmdict', 'jmnedict', 'jitendex'])", "new Set(['jmdict', 'jmnedict', 'jitendex', 'wty-en-en'])")
replace('test/chromium/extension-two-dictionary-import.e2e.js', "            jitendex: {label: 'Jitendex', filePath: cachedDictionaries.jitendexPath},", "            jitendex: {label: 'Jitendex', filePath: cachedDictionaries.jitendexPath},\n            ...Object.fromEntries(Object.entries(cachedDictionaries.fixtures ?? {}).map(([id, spec]) => [id, {label: spec.label, filePath: cachedDictionaries.dictionaryPaths[id]}])),")
print(json.dumps({'fixture': fixture, 'stats': {k: v for k, v in stats.items() if k not in ('sampleRows', 'otherFiles')}}, indent=2))
