"""Verify every original memory receipt without importing a dictionary or sampling processes."""

import argparse
import hashlib
import json
import lzma
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tarfile
import tempfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def safe_path(name):
    path = PurePosixPath(name)
    require(not path.is_absolute() and '..' not in path.parts and '\\' not in name and path.as_posix() == name and name not in ('', '.'), 'Unsafe path')
    return path.parts


def verify(package, node):
    manifest = json.loads((package / 'package-manifest.json').read_text())
    require(manifest['schemaVersion'] == 1 and manifest['runId'] == 45114745900 and manifest['harness'] == '75dc67eb4a4f67e56c7270a278c4d034b1955c6f', 'Wrong campaign')
    names = set()
    for row in manifest['files']:
        require(row['path'] not in names, 'Duplicate package member')
        names.add(row['path'])
        path = package.joinpath(*safe_path(row['path']))
        require(not path.is_symlink() and path.is_file(), 'Missing or unsafe member')
        data = path.read_bytes()
        require(len(data) == row['bytes'] and sha(data) == row['sha256'], 'Package hash differs: ' + row['path'])
    require(names == {'audit_memory.py', 'memory-audit.json', 'freeze_memory_package.py', 'verify_memory_package.py', 'README.md', 'raw-members.json', 'original-zips.json', 'raw-receipts.tar.xz'}, 'Unexpected package inventory')
    archive_path = package / manifest['archive']
    uncompressed = hashlib.sha256()
    total = 0
    with lzma.open(archive_path, 'rb') as stream:
        while chunk := stream.read(1024 * 1024):
            total += len(chunk)
            require(total <= 512 * 1024 * 1024, 'Unexpected expanded size')
            uncompressed.update(chunk)
    require(total == manifest['uncompressedTarBytes'] and uncompressed.hexdigest() == manifest['uncompressedTarSha256'], 'Uncompressed TAR identity differs')
    inventory = json.loads((package / 'raw-members.json').read_text())
    require(len(inventory) == manifest['rawMemberCount'] and sum(row['bytes'] for row in inventory) == manifest['rawMemberBytes'], 'Raw inventory totals differ')
    require([row['path'] for row in inventory] == sorted(row['path'] for row in inventory), 'Raw inventory order differs')
    expected = {row['path']: row for row in inventory}
    require(len(expected) == len(inventory), 'Duplicate raw member')
    with tempfile.TemporaryDirectory(prefix='manabitan-original-memory-') as temporary:
        root = Path(temporary)
        seen = []
        with tarfile.open(archive_path, 'r:xz') as archive:
            for entry in archive:
                require(entry.name in expected and entry.name not in seen and entry.isfile(), 'Unexpected archive member')
                row = expected[entry.name]
                require(entry.size == row['bytes'] and entry.mtime == entry.uid == entry.gid == 0 and entry.mode == 0o644, 'Archive metadata differs')
                data = archive.extractfile(entry).read()
                require(sha(data) == row['sha256'], 'Raw member hash differs')
                target = root.joinpath(*safe_path(entry.name))
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                seen.append(entry.name)
        require(seen == [row['path'] for row in inventory], 'Archive inventory differs')
        originals = json.loads((package / 'original-zips.json').read_text())
        require(len(originals['artifacts']) == 6, 'Missing original artifact provenance')
        for artifact in originals['artifacts']:
            collection = json.loads((root / artifact['manifestPath']).read_text())
            require(collection['artifact']['id'] == artifact['artifactId'] and collection['verifiedZipSha256'] == artifact['sha256'] and collection['verifiedZipBytes'] == artifact['bytes'] and collection['members'] == artifact['members'], 'Original ZIP provenance differs')
        process = subprocess.run([sys.executable, str(package / 'audit_memory.py'), str(root), '--node', node], check=True, capture_output=True, text=True, timeout=120)
        recomputed = json.loads(process.stdout)
        receipt = json.loads((package / 'memory-audit.json').read_text())
        require(recomputed == receipt, 'Independent source/sample/qualification/semantic audit differs')
        require(receipt['qualifiedWholeCampaign'] is False and receipt['memoryNonRegressionEstablished'] is False, 'Original failures were reclassified')
    return {'status': 'verified', 'runId': manifest['runId'], 'manifestSha256': sha((package / 'package-manifest.json').read_bytes()),
            'rawMembers': manifest['rawMemberCount'], 'rawBytes': manifest['rawMemberBytes'], 'totals': receipt['totals'],
            'originalQualificationPreserved': True, 'memoryNonRegressionEstablished': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('package', nargs='?', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--node', default='node')
    args = parser.parse_args()
    print(json.dumps(verify(args.package.resolve(), args.node), indent=2))
