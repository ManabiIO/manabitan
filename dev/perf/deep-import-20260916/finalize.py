from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import sys

assert sys.argv[1] == 'media-prefetch4m'
inputs = Path(__file__).parent
subprocess.run([sys.executable, str(inputs / 'prefetch.py'), 'media-prefetch4m'], check=True, stdout=subprocess.PIPE)
source = Path('ext/js/dictionary/dictionary-importer.js')
assert hashlib.sha256(source.read_bytes()).hexdigest() == 'aaddded565242f399eaf24cba02868e3e9c2f0aac819d46e829b89df6f0457d8'
text = source.read_text()
changes = [
    ("                                const file = requirement.type === 'structured-content-media-link' ?\n                                    void 0 : fileMap.get(requirement.source.path);", "                                const file = requirement.type === 'structured-content-media-link' ? void 0 : fileMap.get(requirement.source.path);", 1),
    ("const size = typeof file === 'undefined' ? void 0 : Reflect.get(file, 'uncompressedSize');", "const size = /** @type {unknown} */ (typeof file === 'undefined' ? void 0 : Reflect.get(file, 'uncompressedSize'));", 1),
    ('throw mediaPrefetchFailure;', 'throw toError(mediaPrefetchFailure);', 2),
    ('        let mediaPrefetch = Promise.resolve();', '        // Overlap only referenced, metadata-free media with term processing.\n        // The final join keeps the archive alive until every started read settles.\n        let mediaPrefetch = Promise.resolve();', 1),
]
for old, new, count in changes:
    assert text.count(old) == count, old
    text = text.replace(old, new)
source.write_text(text)
source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
assert source_hash == '4a8a50151166fa317dc18723992e0bcf423455aa3f0fea2b2cc5de8d08f9a1e2'
test = Path('test/dictionary-importer-media-prefetch.test.js')
shutil.copyfile(inputs / 'media-prefetch-test.txt', test)
assert hashlib.sha256(test.read_bytes()).hexdigest() == '9dbf7611ea5727be4c932d78f39d350484872ff40f1ac294eb6a8d42860c1814'
print(json.dumps({'source': str(source), 'sha256': source_hash, 'tests': [str(test)]}))
