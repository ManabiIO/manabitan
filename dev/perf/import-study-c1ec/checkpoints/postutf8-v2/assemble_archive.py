#!/usr/bin/env python3
"""Reassemble and verify the unchanged checkpoint from its transport parts."""
import hashlib
import json
from pathlib import Path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    root = Path(__file__).resolve().parent
    manifest = json.loads((root / 'transport-manifest.json').read_text())
    archive = manifest['archive']
    require(archive['name'] == 'payload.tar.gz', 'Unexpected logical archive name')
    output = root / archive['name']
    if output.exists():
        require(output.stat().st_size == archive['bytes'], 'Existing archive size differs')
        require(digest_file(output) == archive['sha256'], 'Existing archive hash differs')
        print('The complete archive already exists and is verified.')
        return

    combined = hashlib.sha256()
    total = 0
    created = False
    try:
        with output.open('xb') as destination:
            created = True
            for part in manifest['parts']:
                name = part['name']
                require(Path(name).name == name and name.startswith('payload.tar.gz.part-'), 'Unsafe part name')
                require(part['offset'] == total, 'Part order or offset differs')
                source = root / name
                require(source.stat().st_size == part['bytes'], f'Part size differs: {name}')
                digest = hashlib.sha256()
                with source.open('rb') as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                        digest.update(chunk)
                        combined.update(chunk)
                        destination.write(chunk)
                        total += len(chunk)
                require(digest.hexdigest() == part['sha256'], f'Part hash differs: {name}')
        require(total == archive['bytes'], 'Combined archive size differs')
        require(combined.hexdigest() == archive['sha256'], 'Combined archive hash differs')
    except BaseException:
        if created:
            output.unlink(missing_ok=True)
        raise
    print(f'Verified {total} bytes: {combined.hexdigest()}')


if __name__ == '__main__':
    main()
