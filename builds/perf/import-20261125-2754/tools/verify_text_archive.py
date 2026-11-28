#!/usr/bin/env python3
"""Verify a retained text archive and optionally extract to an empty directory."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import tarfile


def digest_file(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    arguments = argparse.ArgumentParser(description=__doc__)
    arguments.add_argument('manifest', type=Path)
    arguments.add_argument('--extract', type=Path)
    args = arguments.parse_args()
    manifest = json.loads(args.manifest.read_text())
    archive_path = args.manifest.resolve().parent / manifest['archive']['path']
    assert archive_path.stat().st_size == manifest['archive']['bytes']
    assert digest_file(archive_path) == manifest['archive']['sha256']
    expected = manifest['includedFiles']
    paths = [item['path'] for item in expected]
    assert paths == sorted(set(paths))
    destination = args.extract.resolve() if args.extract is not None else None
    if destination is not None:
        assert not destination.exists() or (destination.is_dir() and not any(destination.iterdir()))
        destination.mkdir(parents=True, exist_ok=True)
    total = 0
    with tarfile.open(archive_path, 'r:gz') as archive:
        members = archive.getmembers()
        assert [member.name for member in members] == paths
        for member, item in zip(members, expected, strict=True):
            name = PurePosixPath(member.name)
            assert not name.is_absolute() and '..' not in name.parts
            assert member.isfile() and member.size == item['bytes']
            assert member.uid == member.gid == member.mtime == 0
            assert member.mode == 0o644
            with archive.extractfile(member) as stream:
                data = stream.read()
            assert hashlib.sha256(data).hexdigest() == item['sha256']
            data.decode('utf-8')
            total += len(data)
            if destination is not None:
                output = destination.joinpath(*name.parts)
                assert output.resolve().is_relative_to(destination)
                output.parent.mkdir(parents=True, exist_ok=True)
                with output.open('xb') as stream:
                    stream.write(data)
    print(json.dumps({'status': 'passed', 'archive': archive_path.name,
                      'files': len(expected), 'uncompressedBytes': total,
                      'extractedTo': str(destination) if destination is not None else None}))


if __name__ == '__main__':
    main()
