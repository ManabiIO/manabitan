#!/usr/bin/env python3
"""Retain every textual member of four frozen Actions artifacts deterministically."""

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import zipfile

ARTIFACT_IDS = [15035921814, 15036925291, 15036831091, 15035433747]
ARCHIVE_NAME = 'media-memory-45642179064.text.tar.gz'
AUDIT_FILES = [
    'independent-current-media-audit.json',
    'independent-current-media-audit.md',
    'independent-audit.py',
]


def digest_bytes(data):
    return hashlib.sha256(data).hexdigest()


def digest_file(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_archive(stream, sources):
    with gzip.GzipFile(filename='', fileobj=stream, mode='wb', compresslevel=9, mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as archive:
            for name, source in sorted(sources.items()):
                entry = tarfile.TarInfo(name)
                entry.size = source.stat().st_size
                entry.mode = 0o644
                entry.uid = entry.gid = entry.mtime = 0
                entry.uname = entry.gname = ''
                with source.open('rb') as data:
                    archive.addfile(entry, data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('artifact_root', type=Path)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    metadata_path = output / 'github-artifacts.json'
    github_metadata = json.loads(metadata_path.read_text())
    metadata = {row['id']: row for row in github_metadata['artifacts']}
    assert set(metadata) == set(ARTIFACT_IDS)
    sources = {'provenance/github-artifacts.json': metadata_path}
    artifact_records = []
    omitted = []
    for artifact_id in ARTIFACT_IDS:
        original_zip = args.artifact_root / f'{artifact_id}.zip'
        root = args.artifact_root / str(artifact_id)
        original_digest = digest_file(original_zip)
        remote = metadata[artifact_id]
        assert original_zip.stat().st_size == remote['size_in_bytes']
        assert remote['digest'] == 'sha256:' + original_digest
        assert remote['workflow_run']['id'] == 45642179064
        plan = json.loads((root / 'plan.json').read_text())
        paths = sorted(path for path in root.rglob('*') if path.is_file())
        assert all(not path.is_symlink() for path in paths)
        record = {
            'artifactId': artifact_id,
            'name': remote['name'],
            'dictionary': plan['dictionary'],
            'replication': plan['replication'],
            'sourceIdentities': plan['sourceIdentities'],
            'originalArtifactZipBytes': original_zip.stat().st_size,
            'originalArtifactZipSha256': original_digest,
            'originalArtifactZipOmitted': True,
            'artifactApiUrl': remote['url'],
            'artifactDownloadApiUrl': remote['archive_download_url'],
            'artifactWebUrl': f'https://github.com/ManabiIO/manabitan/actions/runs/45642179064/artifacts/{artifact_id}',
            'expiresAt': remote['expires_at'],
            'includedTextFiles': 0,
        }
        with zipfile.ZipFile(original_zip) as original:
            original_names = [item.filename for item in original.infolist() if not item.is_dir()]
            assert len(set(original_names)) == len(original_names)
            assert set(original_names) == {path.relative_to(root).as_posix() for path in paths}
            for path in paths:
                name = path.relative_to(root).as_posix()
                data = path.read_bytes()
                assert digest_bytes(data) == digest_bytes(original.read(name)), (artifact_id, name)
                if path.suffix == '.zip':
                    assert name in ('A-product.zip', 'B-product.zip')
                    omitted.append({
                        'artifactId': artifact_id,
                        'member': name,
                        'bytes': len(data),
                        'sha256': digest_bytes(data),
                        'reason': 'Duplicate release-package payload omitted; original artifact metadata, package identities, and every package-entry hash are retained.',
                    })
                else:
                    data.decode('utf-8')
                    sources[f'artifacts/{artifact_id}/{name}'] = path
                    record['includedTextFiles'] += 1
        artifact_records.append(record)
    for name in AUDIT_FILES:
        source = args.artifact_root / name
        source.read_bytes().decode('utf-8')
        sources[f'independent-audit/{name}'] = source
    entries = [
        {'path': name, 'bytes': path.stat().st_size, 'sha256': digest_file(path)}
        for name, path in sorted(sources.items())
    ]
    archive_path = output / ARCHIVE_NAME
    with archive_path.open('wb') as stream:
        write_archive(stream, sources)
    archive_digest = digest_file(archive_path)
    with tempfile.TemporaryFile(dir='/tmp') as repeated:
        write_archive(repeated, sources)
        repeated.seek(0)
        assert hashlib.file_digest(repeated, 'sha256').hexdigest() == archive_digest
    with tarfile.open(archive_path, 'r:gz') as retained:
        members = retained.getmembers()
        assert [member.name for member in members] == [entry['path'] for entry in entries]
        for member, entry in zip(members, entries):
            assert member.isfile() and member.size == entry['bytes']
            assert member.uid == member.gid == member.mtime == 0
            assert digest_bytes(retained.extractfile(member).read()) == entry['sha256']
    manifest = {
        'schemaVersion': 1,
        'workflowRunId': 45642179064,
        'workflowRunUrl': 'https://github.com/ManabiIO/manabitan/actions/runs/45642179064',
        'archive': {'path': ARCHIVE_NAME, 'bytes': archive_path.stat().st_size, 'sha256': archive_digest},
        'archiveFormat': 'Sorted PAX tar, regular UTF-8 text files, mode 0644, uid/gid/mtime zero; gzip level 9 with zero mtime and empty filename.',
        'omissionPolicy': 'Original four Actions ZIP containers and eight contained release-package ZIP payloads are omitted. Every other original artifact member is retained verbatim. Original ZIP digests and URLs plus omitted payload sizes/digests are retained. No raw scan, failure, marker, log, protocol, source receipt or correctness report was dropped.',
        'artifacts': artifact_records,
        'omittedReleasePackages': omitted,
        'includedFileCount': len(entries),
        'includedUncompressedBytes': sum(row['bytes'] for row in entries),
        'includedFiles': entries,
        'verification': {'originalArtifactDigestsMatchGitHub': True, 'everyIncludedMemberMatchesOriginalArtifact': True, 'repeatedBuildByteIdentical': True, 'compressedArchiveRoundTripMatchesEveryFile': True},
        'limitations': 'The raw-scan audit can run wholly offline from this archive. Reopening the exact omitted release ZIP bytes for verify_receipts.py requires the original Actions artifact ZIPs or matching previously downloaded copies; package-entry inventories and the completed independent receipt audit remain preserved.',
    }
    (output / 'archive-manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    (output / 'SHA256SUMS').write_text(f'{archive_digest}  {ARCHIVE_NAME}\n')
    for name in AUDIT_FILES[:2]:
        shutil.copyfile(args.artifact_root / name, output / name)
    print(json.dumps({'archive': manifest['archive'], 'includedFileCount': len(entries), 'includedUncompressedBytes': manifest['includedUncompressedBytes'], 'omittedReleasePackages': len(omitted), 'verification': manifest['verification']}))


if __name__ == '__main__':
    main()
