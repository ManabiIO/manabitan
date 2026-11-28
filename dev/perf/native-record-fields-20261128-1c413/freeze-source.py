"""Bind this prospective kit; no import or timing is acquired."""
from pathlib import Path
import hashlib
import json

here = Path(__file__).resolve().parent
repository = here.parents[2]
workflow = '.github/workflows/native-record-fields-1c413.yml'
files = []
for path in sorted(here.rglob('*')):
    if path.is_file() and path != here / 'source.json':
        data = path.read_bytes()
        files.append({'path': str(path.relative_to(here)), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
digest = hashlib.sha256(''.join(f"{file['path']}\0{file['sha256']}\n" for file in files).encode()).hexdigest()
source = {
    'baseline': '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2',
    'kitPath': str(here.relative_to(repository)),
    'kitDigest': digest,
    'digestRule': 'SHA256 of sorted relative path + NUL + SHA256 + newline for every file except source.json',
    'files': files,
    'totalBytes': sum(file['bytes'] for file in files),
    'workflow': {'path': workflow, 'sha256': hashlib.sha256((repository / workflow).read_bytes()).hexdigest()},
    'noProductDelta': True,
    'timingAcquiredBeforeFreeze': False,
}
(here / 'source.json').write_text(json.dumps(source, indent=2) + '\n')
print(json.dumps({'kitDigest': digest, 'files': len(files), 'bytes': source['totalBytes']}, indent=2))
