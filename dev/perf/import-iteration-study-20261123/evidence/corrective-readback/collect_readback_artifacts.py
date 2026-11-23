"""Preserve and verify the two immutable owned-shared corrective campaigns."""

import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent
RUNS = {
    45112249581: ('a2bd2b8266898983ea1f7df0c44282495df0c0f3', 'import-readback-20261123'),
    45113545482: ('d9268d445d528da74a452e75d07872eebd9b7e00', 'import-readback-final-20261123'),
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def collect(request):
    metadata = request['metadata']
    workflow = metadata['workflow_run']
    run_id = workflow['id']
    head, artifact_prefix = RUNS[run_id]
    if (workflow['head_sha'] != head or workflow['repository_id'] != 1165902460 or
            workflow['head_repository_id'] != 1165902460):
        raise ValueError('Unexpected immutable workflow identity')
    match = re.fullmatch(re.escape(artifact_prefix) + r'-(owned-shared)-(jmdict|jitendex|vndb)-([12])', metadata['name'])
    if match is None:
        raise ValueError('Unexpected artifact name')
    candidate, dictionary, replication = match.groups()
    if run_id == 45113545482 and dictionary != 'jitendex':
        raise ValueError('Unexpected final-campaign dictionary')
    prefix = f'{candidate}/{dictionary}/{replication}/'
    destination = ROOT / str(run_id) / f'{candidate}-{dictionary}-{replication}'
    for path in [destination, *destination.parents]:
        if path == ROOT.parent:
            break
        if path.is_symlink():
            raise ValueError('Refusing a symlink destination')
    destination.mkdir(parents=True, exist_ok=True)
    archive_path = destination / 'artifact.zip'
    expected_digest = metadata['digest'].removeprefix('sha256:')
    if re.fullmatch(r'[0-9a-f]{64}', expected_digest) is None:
        raise ValueError('Missing advertised archive digest')
    if archive_path.is_symlink():
        raise ValueError('Archive is a symlink')
    if archive_path.exists():
        raw = archive_path.read_bytes()
    else:
        with urllib.request.urlopen(request['downloadUrl'], timeout=60) as response:
            raw = response.read(64 * 1024 * 1024 + 1)
    if len(raw) > 64 * 1024 * 1024 or len(raw) != metadata['size_in_bytes'] or digest(raw) != expected_digest:
        raise ValueError('Advertised archive size or SHA-256 differs')
    if not archive_path.exists():
        archive_path.write_bytes(raw)
    inventory = []
    with zipfile.ZipFile(archive_path) as archive:
        entries = archive.infolist()
        if len(entries) > 10000 or sum(entry.file_size for entry in entries) > 256 * 1024 * 1024:
            raise ValueError('Unexpected expanded archive size')
        names = set()
        for entry in entries:
            path = PurePosixPath(entry.filename)
            canonical = path.as_posix()
            if (canonical in names or entry.filename.rstrip('/') != canonical or path.is_absolute() or
                    '..' in path.parts or '\\' in entry.filename or not entry.filename.startswith(prefix) or
                    stat.S_ISLNK(entry.external_attr >> 16) or entry.flag_bits & 1):
                raise ValueError('Unsafe or unexpected archive member: ' + entry.filename)
            names.add(canonical)
            target = destination.joinpath(*path.parts)
            for parent in [target, *target.parents]:
                if parent == ROOT:
                    break
                if parent.is_symlink():
                    raise ValueError('Refusing an extraction symlink')
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            data = archive.read(entry)
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                if target.read_bytes() != data:
                    raise ValueError('Existing member differs: ' + entry.filename)
            else:
                target.write_bytes(data)
            inventory.append({'path': entry.filename, 'bytes': len(data), 'sha256': digest(data)})
    receipt = {'artifact': metadata, 'verifiedZipSha256': expected_digest,
               'verifiedZipBytes': len(raw), 'safeExtraction': True,
               'memberCount': len(inventory), 'members': inventory}
    manifest_path = destination / 'artifact-manifest.json'
    encoded = (json.dumps(receipt, indent=2) + '\n').encode()
    if manifest_path.is_symlink():
        raise ValueError('Manifest is a symlink')
    if manifest_path.exists() and manifest_path.read_bytes() != encoded:
        raise ValueError('Refusing to replace an original collection manifest')
    if not manifest_path.exists():
        manifest_path.write_bytes(encoded)
    print(json.dumps({'runId': run_id, 'artifactId': metadata['id'], 'name': metadata['name'],
                      'sha256': expected_digest, 'bytes': len(raw), 'members': len(inventory)}), flush=True)


if __name__ == '__main__':
    for request in json.load(sys.stdin):
        collect(request)
