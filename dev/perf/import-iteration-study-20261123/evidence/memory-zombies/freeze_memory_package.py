"""Package the final frozen memory campaign without changing its qualification."""

import argparse
import hashlib
import json
import lzma
from pathlib import Path
import shutil
import tarfile
import zipfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def freeze(source, destination):
    require(not destination.exists(), 'Refusing to replace a frozen package')
    files = [source / name for name in ['collect_artifacts.py', 'verify_semantics.mjs', 'semantic-audit.json', 'source-manifest.json', 'source-git-verification.json']]
    for name in ['api', 'source', 'artifacts', 'local-witness']:
        files.extend(path for path in (source / name).rglob('*') if path.is_file() and path.name != 'artifact.zip')
    files.sort(key=lambda path: path.relative_to(source).as_posix())
    require(all(not path.is_symlink() for path in files), 'Unexpected source symlink')
    originals = []
    metadata = json.loads((source / 'api/artifacts-final.json').read_text())['artifacts']
    for receipt_path in sorted((source / 'artifacts').glob('*/artifact-manifest.json')):
        receipt = json.loads(receipt_path.read_text())
        advertised = next(value for value in metadata if value['id'] == receipt['artifact']['id'])
        require(receipt['artifact'] == advertised, 'API artifact metadata differs')
        archive = receipt_path.with_name('artifact.zip')
        data = archive.read_bytes()
        require(len(data) == receipt['verifiedZipBytes'] == advertised['size_in_bytes'], 'ZIP size differs')
        require(sha(data) == receipt['verifiedZipSha256'] == advertised['digest'].removeprefix('sha256:'), 'ZIP digest differs')
        with zipfile.ZipFile(archive) as zipped:
            rebuilt = []
            for entry in zipped.infolist():
                if entry.is_dir():
                    continue
                data = zipped.read(entry)
                require((receipt_path.parent / entry.filename).read_bytes() == data, 'Original ZIP member differs')
                rebuilt.append({'path': entry.filename, 'bytes': len(data), 'sha256': sha(data)})
        require(rebuilt == receipt['members'], 'Original inventory differs')
        originals.append({'artifactId': advertised['id'], 'name': advertised['name'], 'bytes': receipt['verifiedZipBytes'], 'sha256': receipt['verifiedZipSha256'],
                          'manifestPath': receipt_path.relative_to(source).as_posix(), 'members': rebuilt})
    require(len(originals) == 6, 'Missing original artifacts')
    destination.mkdir(parents=True)
    for name in ['audit_memory.py', 'memory-audit.json', 'freeze_memory_package.py', 'verify_memory_package.py', 'README-memory.md']:
        shutil.copyfile(source / name, destination / ('README.md' if name == 'README-memory.md' else name))
    inventory = [{'path': path.relative_to(source).as_posix(), 'bytes': path.stat().st_size, 'sha256': sha(path.read_bytes())} for path in files]
    (destination / 'raw-members.json').write_text(json.dumps(inventory, indent=2) + '\n')
    (destination / 'original-zips.json').write_text(json.dumps({'runId': 45116158450, 'artifacts': originals,
        'limit': 'Original API ZIP bytes were independently checked at collection and packaging. This compact transport retains every uncompressed member, but original ZIP-container hash verification additionally needs the original downloaded ZIP.'}, indent=2) + '\n')
    archive_path = destination / 'raw-receipts.tar.xz'
    with lzma.open(archive_path, 'wb', preset=6) as compressed:
        with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as archive:
            for path, row in zip(files, inventory):
                entry = tarfile.TarInfo(row['path'])
                entry.size = row['bytes']
                entry.mode = 0o644
                entry.mtime = entry.uid = entry.gid = 0
                entry.uname = entry.gname = ''
                with path.open('rb') as stream:
                    archive.addfile(entry, stream)
    uncompressed = hashlib.sha256()
    tar_bytes = 0
    with lzma.open(archive_path, 'rb') as stream:
        while chunk := stream.read(1024 * 1024):
            uncompressed.update(chunk)
            tar_bytes += len(chunk)
    manifest = {'schemaVersion': 1, 'runId': 45116158450, 'harness': '00da5cb2ec28211dd6d09d938dc6cf1e3a4334c9',
                'archive': 'raw-receipts.tar.xz', 'compression': 'Python stdlib lzma FORMAT_XZ preset=6 (8 MiB dictionary)',
                'uncompressedTarSha256': uncompressed.hexdigest(), 'uncompressedTarBytes': tar_bytes,
                'rawMemberCount': len(inventory), 'rawMemberBytes': sum(row['bytes'] for row in inventory),
                'qualification': 'frozen confirmed-zombie campaign remains unqualified; all 24 observations and failures retained',
                'files': [{'path': path.name, 'bytes': path.stat().st_size, 'sha256': sha(path.read_bytes())} for path in sorted(destination.iterdir()) if path.is_file()]}
    (destination / 'package-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return {'package': str(destination), 'files': len(manifest['files']) + 1, 'bytes': sum(path.stat().st_size for path in destination.iterdir()),
            'manifestSha256': sha((destination / 'package-manifest.json').read_bytes()), 'rawMembers': len(inventory), 'rawBytes': manifest['rawMemberBytes']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    print(json.dumps(freeze(args.source.resolve(), args.destination.resolve()), indent=2))
