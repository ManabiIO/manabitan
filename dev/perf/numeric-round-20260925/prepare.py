from pathlib import Path
import hashlib
import json
import os
import subprocess

out = Path('builds/numeric-round')
out.mkdir(parents=True, exist_ok=True)
p = Path('ext/js/dictionary/term-bank-wasm-parser.js')
base = p.read_bytes()
assert hashlib.sha256(base).hexdigest() == '26f1eee368eaee1f68674beccc7f01737a3c64d4ae18d7c7a0c2a2453e2bfe4d'
(out / 'base.js').write_bytes(base)
variant = os.environ.get('CANDIDATE', 'candidate')
expected = {
    'candidate': '3944437a38bf8711c43722bc29a15b2be22e9aa5c7cdbe3dc1e20e021d469834',
    'length-first': 'f617cce1a6c253a86470d4dc0a38d0edc08a38b957c77390e64460da791014aa',
}
assert variant in expected
subprocess.run(['git', 'apply', 'dev/perf/numeric-round-20260925/' + variant + '.patch'], check=True)
candidate = p.read_bytes()
assert hashlib.sha256(candidate).hexdigest() == expected[variant]
(out / 'candidate.js').write_bytes(candidate)

if os.environ.get('DICTIONARY') == 'wty-en-en':
    p = Path('test/perf/dictionaries.lock.json')
    lock = json.loads(p.read_text())
    lock['dictionaries']['wty-en-en'] = {
        'label': 'wty-en-en', 'cacheFile': 'wty-en-en.zip',
        'release': '21b1b22cd655d7936d62b127e6404fbb8a88c7c3',
        'url': 'https://huggingface.co/datasets/daxida/wty-release/resolve/21b1b22cd655d7936d62b127e6404fbb8a88c7c3/latest/dict/en/en/wty-en-en.zip',
        'sha256': 'b9603db16dee82afd811386302ccd78bab591a6513b0d3194d937dc9110dd4a5',
        'sizeBytes': 106918350, 'expectedTitle': 'wty-en-en',
        'revision': '2026.08.29', 'termRows': 1643040,
    }
    p.write_text(json.dumps(lock, indent=4) + '\n')
    p = Path('test/chromium/extension-two-dictionary-import.e2e.js')
    s = p.read_text()
    replacements = [
        ("new Set(['jmdict', 'jmnedict', 'jitendex'])", "new Set(['jmdict', 'jmnedict', 'jitendex', 'wty-en-en'])"),
        ("jitendex: {label: 'Jitendex', filePath: cachedDictionaries.jitendexPath},", "jitendex: {label: 'Jitendex', filePath: cachedDictionaries.jitendexPath},\n            'wty-en-en': {label: 'wty-en-en', filePath: path.join(dictionaryCacheDir, 'wty-en-en.zip')},"),
    ]
    for old, new in replacements:
        assert s.count(old) == 1, old
        s = s.replace(old, new)
    assert s.count('maxBuffer: 32 * 1024 * 1024') == 2
    p.write_text(s.replace('maxBuffer: 32 * 1024 * 1024', 'maxBuffer: 256 * 1024 * 1024'))
