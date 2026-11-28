#!/usr/bin/env python3
"""Independent pinned-ZIP directory oracle for VNDB image-path identities.

This reads only the central directory after hashing the complete source archive.
It does not stand in for image content validation or term-bank source parsing.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source-root', required=True)
parser.add_argument('--cache-dir', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
root = Path(args.source_root).resolve()
output = Path(args.output).resolve()
if output.exists():
    raise RuntimeError('Refusing to overwrite an existing acquisition')
lock_bytes = (root / 'test/perf/dictionaries.lock.json').read_bytes()
fixture = json.loads(lock_bytes)['dictionaries']['vndb']
archive = Path(args.cache_dir).resolve() / fixture['cacheFile']
assert archive.stat().st_size == fixture['sizeBytes']
archive_hash = hashlib.sha256()
with archive.open('rb') as stream:
    for data in iter(lambda: stream.read(1024 * 1024), b''):
        archive_hash.update(data)
assert archive_hash.hexdigest() == fixture['sha256']
metadata_pattern = re.compile(r'(?:term|tag|kanji|term_meta|kanji_meta)_bank_[0-9]+\.json|index\.json')
with zipfile.ZipFile(archive) as source:
    infos = source.infolist()
    assert len({entry.filename for entry in infos}) == len(infos)
    media = [entry for entry in infos if not metadata_pattern.fullmatch(entry.filename)]
    assert all(not entry.is_dir() and re.fullmatch(r'img/cc[0-9]+\.webp', entry.filename) for entry in media)
    paths = sorted(entry.filename for entry in media)
    assert len(paths) == fixture['mediaFiles']
    media_bytes = sum(entry.file_size for entry in media)
    assert media_bytes == fixture['mediaBytes']
    digest = hashlib.sha256()
    for name in paths:
        digest.update((json.dumps(name, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8'))
receipt = {
    'success': True,
    'scope': 'Independent Python zipfile Central Directory image names and uncompressed lengths; no image extraction or payload digest.',
    'fixtureSha256': archive_hash.hexdigest(),
    'fixtureBytes': fixture['sizeBytes'],
    'lockSha256': hashlib.sha256(lock_bytes).hexdigest(),
    'archiveEntryCount': len(infos),
    'uniqueImagePaths': len(paths),
    'imagePathsSha256': digest.hexdigest(),
    'digestEncoding': 'Ascending ASCII path order, compact JSON string plus LF, UTF-8',
    'mediaBytes': media_bytes,
    'helperSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
}
output.write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt))
