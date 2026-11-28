#!/usr/bin/env python3
"""Verify and restore regular evidence files; never execute them or make links."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import tarfile


def check(value, message):
    if not value:
        raise RuntimeError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('payload', type=Path)
    parser.add_argument('--expected-payload-sha256', required=True)
    parser.add_argument('--prior-payload', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    check(not args.output.exists(), 'Never overwrite an existing restoration')
    check(sha(args.payload.read_bytes()) == args.expected_payload_sha256, 'Wrong addendum payload')
    with tarfile.open(args.payload, 'r:gz') as archive:
        members = {}
        for member in archive:
            name = PurePosixPath(member.name)
            check(member.isfile() and not name.is_absolute() and '..' not in name.parts and member.name not in members,
                  'Unsafe or duplicate addendum member')
            members[member.name] = archive.extractfile(member).read()
    manifest = json.loads(members['manifest.json'])
    expected_members = {'manifest.json', *manifest['controls']}
    expected_members.update(record['storage']['archivePath'] for record in manifest['files']
                            if record['storage']['kind'] == 'addendum-object')
    check(set(members) == expected_members, 'Unexpected or missing addendum member')
    for name, expected in manifest['controls'].items():
        check(len(members[name]) == expected['bytes'] and sha(members[name]) == expected['sha256'], 'Control file differs')
    needed_prior = {record['storage']['archivePath']: record
                    for record in manifest['files'] if record['storage']['kind'] == 'prior-checkpoint'}
    prior_objects = {}
    if needed_prior:
        check(args.prior_payload is not None, 'This additive checkpoint requires its immutable prior payload')
        check(sha(args.prior_payload.read_bytes()) == manifest['prior']['payloadSha256'], 'Wrong prior payload')
        with tarfile.open(args.prior_payload, 'r:gz') as archive:
            for member in archive:
                if member.name in needed_prior:
                    check(member.isfile(), 'Prior reference is not a regular file')
                    prior_objects[member.name] = archive.extractfile(member).read()
        check(set(prior_objects) == set(needed_prior), 'Missing referenced prior member')
    restoration = []
    for record in manifest['files']:
        name = PurePosixPath(record['path'])
        check(not name.is_absolute() and '..' not in name.parts, 'Unsafe evidence output path')
        check(name.parts[0] in {'workspace', 'source-objects', 'source-patches'}, 'Unexpected evidence namespace')
        storage = record['storage']
        if storage['kind'] == 'prior-checkpoint':
            data = prior_objects[storage['archivePath']]
        else:
            check(storage['kind'] == 'addendum-object', 'Unknown evidence storage')
            data = members[storage['archivePath']]
        check(len(data) == record['bytes'] and sha(data) == record['sha256'], 'Evidence digest differs')
        restoration.append((name, data, record['mode']))
    check(len({str(name) for name, _, _ in restoration}) == len(restoration), 'Duplicate evidence output path')
    args.output.mkdir()
    for name, data, mode in restoration:
        target = args.output / str(name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(mode & 0o777)
    for name in manifest['controls']:
        (args.output / name).write_bytes(members[name])
    (args.output / 'manifest.json').write_bytes(members['manifest.json'])
    print(json.dumps({'status': 'restored-verified-regular-files', 'files': len(restoration),
        'symlinksCreated': 0, 'experimentsExecuted': 0, 'output': str(args.output)}))


if __name__ == '__main__':
    main()
