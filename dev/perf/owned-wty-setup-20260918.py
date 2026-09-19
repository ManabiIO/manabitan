from pathlib import Path
import json

p = Path('dev/perf/owned-handoff-20260918.py')
text = p.read_text()
old = "choices=['jmdict', 'jmnedict', 'jitendex']"
assert text.count(old) == 1
p.write_text(text.replace(old, "choices=['jmdict', 'jmnedict', 'jitendex', 'wty-en-en']"))
p = Path('test/perf/dictionaries.lock.json')
lock = json.loads(p.read_text())
assert 'wty-en-en' not in lock['dictionaries']
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
text = p.read_text()
old = "new Set(['jmdict', 'jmnedict', 'jitendex'])"
assert text.count(old) == 1
text = text.replace(old, "new Set(['jmdict', 'jmnedict', 'jitendex', 'wty-en-en'])")
old = 'maxBuffer: 32 * 1024 * 1024'
assert text.count(old) == 2
text = text.replace(old, 'maxBuffer: 256 * 1024 * 1024')
old = "            jitendex: {label: 'Jitendex', filePath: cachedDictionaries.jitendexPath},"
assert text.count(old) == 1
text = text.replace(old, old + "\n            'wty-en-en': {label: 'wty-en-en', filePath: path.join(dictionaryCacheDir, 'wty-en-en.zip')},")
p.write_text(text)
