"""Verify an advertised Actions ZIP and extract only its expected evidence tree."""

import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def collect(request):
    metadata = request['metadata']
    match = re.fullmatch(
        r'import-iteration-20261123-(owned-shared|content-validation|media-diagnostics|crc-words)-(jmdict|jitendex|vndb)-([12])',
        metadata['name'],
    )
    workflow = metadata['workflow_run']
    if (match is None or workflow['id'] != 45110694360 or
            workflow['head_sha'] != '088d9c22ccd2b0dc05b240355c76320c9660ce3e' or
            workflow['repository_id'] != 1165902460 or workflow['head_repository_id'] != 1165902460):
        raise ValueError('Unexpected artifact identity')
    candidate, dictionary, replication = match.groups()
    prefix = f'{candidate}/{dictionary}/{replication}/'
    destination = ROOT / f'{candidate}-{dictionary}-{replication}'
    destination.mkdir(exist_ok=True)
    if destination.is_symlink():
        raise ValueError('Artifact destination is a symlink')
    archive_path = destination / 'artifact.zip'
    expected_digest = metadata['digest'].removeprefix('sha256:')
    if re.fullmatch(r'[0-9a-f]{64}', expected_digest) is None:
        raise ValueError('Missing advertised archive digest')
    reused = archive_path.exists()
    if reused:
        if archive_path.is_symlink():
            raise ValueError('Archive is a symlink')
        raw = archive_path.read_bytes()
    else:
        with urllib.request.urlopen(request['downloadUrl'], timeout=60) as response:
            raw = response.read(64 * 1024 * 1024 + 1)
    if len(raw) != metadata['size_in_bytes'] or sha256(raw) != expected_digest:
        raise ValueError('Advertised ZIP size or SHA-256 does not match')
    if not reused:
        archive_path.write_bytes(raw)
    inventory = []
    with zipfile.ZipFile(archive_path) as archive:
        entries = archive.infolist()
        if len(entries) > 10000 or sum(entry.file_size for entry in entries) > 256 * 1024 * 1024:
            raise ValueError('Unexpected expanded artifact size')
        names = set()
        canonical_names = set()
        for entry in entries:
            path = PurePosixPath(entry.filename)
            canonical_name = path.as_posix()
            if (entry.filename in names or path.is_absolute() or '..' in path.parts or
                    canonical_name in canonical_names or
                    '\\' in entry.filename or not entry.filename.startswith(prefix) or
                    stat.S_ISLNK(entry.external_attr >> 16) or entry.flag_bits & 1):
                raise ValueError('Unsafe or unexpected archive member: ' + entry.filename)
            names.add(entry.filename)
            canonical_names.add(canonical_name)
            target = destination.joinpath(*path.parts)
            for parent in [target, *target.parents]:
                if parent == ROOT:
                    break
                if parent.is_symlink():
                    raise ValueError('Refusing to follow an extraction symlink')
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            data = archive.read(entry)
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                if target.read_bytes() != data:
                    raise ValueError('Existing extracted member differs: ' + entry.filename)
            else:
                target.write_bytes(data)
            inventory.append({'path': entry.filename, 'bytes': len(data), 'sha256': sha256(data)})
    receipt = {
        'artifact': metadata,
        'verifiedZipSha256': expected_digest,
        'verifiedZipBytes': len(raw),
        'preexistingZipRetained': reused,
        'safeExtraction': True,
        'memberCount': len(inventory),
        'members': inventory,
    }
    (destination / 'artifact-manifest.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({
        'artifactId': metadata['id'], 'directory': destination.name,
        'sha256': expected_digest, 'members': len(inventory), 'reused': reused,
    }), flush=True)


if __name__ == '__main__':
    for request in json.load(sys.stdin):
        collect(request)
