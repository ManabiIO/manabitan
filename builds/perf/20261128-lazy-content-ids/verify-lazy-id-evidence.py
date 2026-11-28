"""Verify the published archives and every recovered receipt without extracting."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import tarfile


ARCHIVES = {
    'lazy-ids-initial-evidence.tar.gz': (7408886, '1a758f3f6a015a3e77adba4652184e65d6d42a824f603d62579496b5c99151c0'),
    'lazy-ids-final-first-three-evidence.tar.gz': (5745846, '5789f4bff4e3438b9cfef5079c7039812e71270b4b3041527d1c054531438661'),
    'lazy-ids-final-remaining-evidence.tar.gz': (5302296, '61761ed4ff8bc51a8d4a016122352856f1c1da619c22b83e82742253d7fbfddd'),
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path, nargs='?', default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    results = []
    for name, (size, expected_sha) in ARCHIVES.items():
        path = args.directory / name
        require(path.stat().st_size == size, f'{name}: archive size mismatch')
        with path.open('rb') as stream:
            actual_sha = hashlib.file_digest(stream, 'sha256').hexdigest()
        require(actual_sha == expected_sha, f'{name}: archive SHA-256 mismatch')
        with tarfile.open(path, 'r:gz') as archive:
            members = archive.getmembers()
            require(all(member.isfile() for member in members), f'{name}: non-file member')
            require(len({member.name for member in members}) == len(members), f'{name}: duplicate member')
            require(all(not PurePosixPath(member.name).is_absolute() and '..' not in PurePosixPath(member.name).parts for member in members), f'{name}: unsafe member name')
            index = json.load(archive.extractfile('receipt-index.json'))
            expected = {item['path']: item for item in index['files']}
            require(len(expected) == len(index['files']), f'{name}: duplicate index entry')
            require(set(expected) | {'receipt-index.json'} == {member.name for member in members}, f'{name}: inventory mismatch')
            total_bytes = 0
            for member_name, item in expected.items():
                member = archive.getmember(member_name)
                require(member.size == item['bytes'], f'{name}: {member_name}: size mismatch')
                with archive.extractfile(member) as stream:
                    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
                require(digest == item['sha256'], f'{name}: {member_name}: SHA-256 mismatch')
                total_bytes += member.size
            results.append({'archive': name, 'sha256': actual_sha, 'verifiedReceipts': len(expected), 'rawBytes': total_bytes})
    print(json.dumps({'allArchivesVerified': True, 'archives': results}, indent=2))


if __name__ == '__main__':
    main()
