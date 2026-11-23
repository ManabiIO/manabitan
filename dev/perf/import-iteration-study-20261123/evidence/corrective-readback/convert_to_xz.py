"""Create a separate lossless XZ transport variant of a frozen gzip evidence package."""

import argparse
import gzip
import hashlib
import json
import lzma
from pathlib import Path
import re
import shutil
import sys
import tarfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


TRANSPORT_VERIFY = '''def verify_transport(root, manifest):
    derivation = json.loads((root / 'transport-derivation.json').read_text())
    if (derivation['schemaVersion'] != 1 or not derivation['rawTarBytesIdentical'] or
            derivation['sourceManifest']['sha256'] != manifest['sourceGzipManifestSha256']):
        raise ValueError('Wrong transport derivation')
    archive = root / derivation['destinationArchive']['path']
    data = archive.read_bytes()
    if (len(data) != derivation['destinationArchive']['bytes'] or
            hashlib.sha256(data).hexdigest() != derivation['destinationArchive']['sha256']):
        raise ValueError('XZ transport identity differs')
    hasher = hashlib.sha256()
    total = 0
    with lzma.open(archive, 'rb') as stream:
        while chunk := stream.read(1024 * 1024):
            total += len(chunk)
            if total > 512 * 1024 * 1024:
                raise ValueError('Unexpected expanded TAR size')
            hasher.update(chunk)
    if (total != derivation['sourceArchive']['uncompressedTarBytes'] or
            total != derivation['destinationArchive']['uncompressedTarBytes'] or
            hasher.hexdigest() != derivation['sourceArchive']['uncompressedTarSha256'] or
            hasher.hexdigest() != derivation['destinationArchive']['uncompressedTarSha256']):
        raise ValueError('Uncompressed TAR differs from frozen gzip source')


'''


def convert(source, destination):
    require(not destination.exists(), 'Refusing to replace an existing package')
    original = (source / 'manifest.json').exists()
    manifest_name = 'manifest.json' if original else 'package-manifest.json'
    source_manifest_path = source / manifest_name
    source_manifest_bytes = source_manifest_path.read_bytes()
    manifest = json.loads(source_manifest_bytes)
    source_archive_name = manifest['rawArchive'] if original else 'raw-receipts.tar.gz'
    require(source_archive_name.endswith('.tar.gz'), 'Expected an original gzip package')
    destination_archive_name = source_archive_name.removesuffix('.gz') + '.xz'
    for row in manifest['files']:
        data = (source / row['path']).read_bytes()
        require(len(data) == row['bytes'] and sha(data) == row['sha256'], 'Frozen source file changed: ' + row['path'])
    source_archive = source / source_archive_name
    patterns = [re.compile(rb'[?&](?:X-Amz-Signature|X-Amz-Credential|sig|signature|token)=', re.I),
                re.compile(rb'https?://[^\s"<>]*(?:oaisdmntpr|oaisdsorpr|sdmntpr)[^\s"<>]*', re.I)]
    scanned_support = 0
    for path in source.rglob('*'):
        if not path.is_file() or path == source_archive:
            continue
        data = path.read_bytes()
        require(not any(pattern.search(data) for pattern in patterns), 'Signed download URL pattern in support file: ' + path.relative_to(source).as_posix())
        scanned_support += 1
    # Inspect original uncompressed members without printing URL values. This
    # includes original raw reports and all acquisition metadata they contain.
    scanned_raw = 0
    with tarfile.open(source_archive, 'r:gz') as archive:
        for entry in archive:
            require(entry.isfile(), 'Nonregular raw archive member')
            data = archive.extractfile(entry).read()
            require(not any(pattern.search(data) for pattern in patterns), 'Signed download URL pattern in raw member: ' + entry.name)
            scanned_raw += 1
    destination.mkdir(parents=True)
    for path in sorted(source.rglob('*')):
        if not path.is_file() or path == source_archive:
            continue
        target = destination / path.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
    new_archive = destination / destination_archive_name
    new_archive.parent.mkdir(parents=True, exist_ok=True)
    source_tar_hash = hashlib.sha256()
    source_tar_bytes = 0
    with gzip.open(source_archive, 'rb') as uncompressed:
        with lzma.open(new_archive, 'wb', preset=6) as compressed:
            while chunk := uncompressed.read(1024 * 1024):
                source_tar_hash.update(chunk)
                source_tar_bytes += len(chunk)
                compressed.write(chunk)
    destination_tar_hash = hashlib.sha256()
    destination_tar_bytes = 0
    with lzma.open(new_archive, 'rb') as uncompressed:
        while chunk := uncompressed.read(1024 * 1024):
            destination_tar_hash.update(chunk)
            destination_tar_bytes += len(chunk)
    require(source_tar_bytes == destination_tar_bytes and source_tar_hash.hexdigest() == destination_tar_hash.hexdigest(), 'TAR bytes changed during transport conversion')

    verifier_name = 'source/verify_campaign.py' if original else 'verify_package.py'
    verifier = (destination / verifier_name).read_text()
    require('import json\n' in verifier, 'Missing verifier JSON import')
    verifier = verifier.replace('import json\n', 'import json\nimport lzma\n', 1)
    if original:
        require('def main():\n' in verifier and "tarfile.open(root / manifest['rawArchive'], 'r:gz')" in verifier, 'Unexpected original verifier layout')
        verifier = verifier.replace('def main():\n', TRANSPORT_VERIFY + 'def main():\n', 1)
        marker = "    manifest = json.loads((root / 'manifest.json').read_text())\n"
        require(marker in verifier, 'Missing original manifest read')
        verifier = verifier.replace(marker, marker + '    verify_transport(root, manifest)\n', 1)
        verifier = verifier.replace("tarfile.open(root / manifest['rawArchive'], 'r:gz')", "tarfile.open(root / manifest['rawArchive'], 'r:xz')", 1)
        manifest['rawArchive'] = destination_archive_name
    else:
        require('def verify(package, node):\n' in verifier, 'Unexpected corrective verifier layout')
        verifier = verifier.replace('def verify(package, node):\n', TRANSPORT_VERIFY + 'def verify(package, node):\n', 1)
        marker = "    manifest = json.loads((package / 'package-manifest.json').read_text())\n"
        require(marker in verifier, 'Missing corrective manifest read')
        verifier = verifier.replace(marker, marker + '    verify_transport(package, manifest)\n', 1)
        verifier = verifier.replace('raw-receipts.tar.gz', 'raw-receipts.tar.xz')
        verifier = verifier.replace("mode='r:gz'", "mode='r:xz'")
        marker = "'README.md', 'verify_package.py'}"
        require(marker in verifier, 'Missing corrective inventory guard')
        verifier = verifier.replace(marker, "'README.md', 'verify_package.py', 'transport-derivation.json', 'convert_to_xz.py'}", 1)
    (destination / verifier_name).write_text(verifier)

    readme = (destination / 'README.md').read_text()
    readme = readme.replace(source_archive_name, destination_archive_name)
    if original:
        readme = readme.replace('Tar metadata and the gzip timestamp\nare fixed, so the archive is deterministic.', 'The complete original TAR byte stream is unchanged. XZ uses standard-library\nLZMA preset 6 with an 8 MiB dictionary and deterministic output.')
    else:
        readme = readme.replace('deterministic cross-file tar/gzip stream', 'deterministic cross-file tar/XZ stream')
    readme += '''

## XZ publication transport

This is a separate transport variant of the frozen gzip package. No raw TAR
member, order, metadata, padding byte, observation, semantic result, derived
analysis, or original failure was changed. `transport-derivation.json` records
the original gzip/package identities and identical SHA-256 hashes of the entire
uncompressed TAR from both gzip and XZ. The verifier checks that identity as well
as every original member. The original frozen package remains unchanged.

Only the transport filename, verifier, manifest and this README were adapted;
the original freezer/build helper remains byte-identical and still creates the
original gzip format. To create this publication variant from that frozen output:

```sh
python3 /path/to/this/package/convert_to_xz.py /path/to/frozen/gzip/package /path/to/new/xz/package
```

The converter uses Python standard-library `lzma` preset 6 (8 MiB dictionary),
streams the unchanged TAR bytes, independently rehashes the decompressed XZ, and
refuses to replace an existing destination. It scans support files and every raw
member for signed acquisition URL patterns without printing URLs. No tool-issued
signed download URLs or download-request scratch specifications are retained.
The variant still has the original ZIP-container provenance limitation stated
above; changing compression does not change the evidence's scope.
'''
    (destination / 'README.md').write_text(readme)
    shutil.copyfile(Path(__file__).resolve(), destination / 'convert_to_xz.py')
    changes = []
    unchanged = []
    for row in manifest['files']:
        if row['path'] == source_archive_name:
            continue
        target = destination / row['path']
        actual = sha(target.read_bytes())
        if actual != row['sha256']:
            changes.append({'path': row['path'], 'sourceSha256': row['sha256'], 'destinationSha256': actual})
        else:
            unchanged.append({'path': row['path'], 'sha256': actual})
    require({row['path'] for row in changes} == {verifier_name, 'README.md'}, 'Unexpected nontransport payload change')
    derivation = {
        'schemaVersion': 1, 'operation': 'lossless-gzip-to-xz-transport', 'rawTarBytesIdentical': True,
        'compression': 'Python stdlib lzma FORMAT_XZ preset=6 (8 MiB dictionary)',
        'sourceManifest': {'path': manifest_name, 'bytes': len(source_manifest_bytes), 'sha256': sha(source_manifest_bytes)},
        'sourceArchive': {'path': source_archive_name, 'bytes': source_archive.stat().st_size, 'sha256': sha(source_archive.read_bytes()),
                          'uncompressedTarBytes': source_tar_bytes, 'uncompressedTarSha256': source_tar_hash.hexdigest()},
        'destinationArchive': {'path': destination_archive_name, 'bytes': new_archive.stat().st_size, 'sha256': sha(new_archive.read_bytes()),
                               'uncompressedTarBytes': destination_tar_bytes, 'uncompressedTarSha256': destination_tar_hash.hexdigest()},
        'changedSupportFiles': changes, 'unchangedPayloadFiles': unchanged,
        'signedAcquisitionUrlScan': {'supportFiles': scanned_support, 'rawMembers': scanned_raw, 'matches': 0, 'downloadRequestFilesRetained': False},
    }
    (destination / 'transport-derivation.json').write_text(json.dumps(derivation, indent=2) + '\n')
    manifest['sourceGzipManifestSha256'] = sha(source_manifest_bytes)
    manifest['transportDerivation'] = 'transport-derivation.json'
    manifest['files'] = [{'path': path.relative_to(destination).as_posix(), 'bytes': path.stat().st_size, 'sha256': sha(path.read_bytes())}
                         for path in sorted(destination.rglob('*')) if path.is_file() and path != destination / manifest_name]
    (destination / manifest_name).write_text(json.dumps(manifest, indent=2) + '\n')
    return {'package': str(destination), 'manifest': manifest_name, 'manifestSha256': sha((destination / manifest_name).read_bytes()),
            'files': len(manifest['files']) + 1, 'bytes': sum(path.stat().st_size for path in destination.rglob('*') if path.is_file()),
            'sourceArchiveBytes': source_archive.stat().st_size, 'xzArchiveBytes': new_archive.stat().st_size,
            'uncompressedTarSha256': source_tar_hash.hexdigest(), 'rawMembersScanned': scanned_raw}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    print(json.dumps(convert(args.source.resolve(), args.destination.resolve()), indent=2))
