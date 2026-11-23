"""Freeze byte-exact raw members in a deterministic compressed evidence package."""

import argparse
import lzma
import hashlib
import json
from pathlib import Path
import shutil
import tarfile
import zipfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def build(source, destination):
    require(not destination.exists(), 'Refusing to overwrite an evidence package')
    source_files = []
    originals = []
    for run_id, count in [(45114362649, 6)]:
        root = source / str(run_id)
        metadata = json.loads((root / 'metadata.json').read_text())
        require(len(metadata['artifacts']) == count and len(metadata['jobs']) == count, 'Incomplete campaign metadata')
        require(all(job['status'] == 'completed' for job in metadata['jobs']), 'Campaign is still running')
        receipts = sorted(root.glob('combined-*/artifact-manifest.json'))
        require(len(receipts) == count, 'Missing original artifact')
        for path in receipts:
            receipt = json.loads(path.read_text())
            advertised = next(item for item in metadata['artifacts'] if item['id'] == receipt['artifact']['id'])
            require(receipt['artifact'] == advertised, 'Artifact metadata differs')
            archive = path.with_name('artifact.zip')
            raw = archive.read_bytes()
            require(len(raw) == advertised['size_in_bytes'] == receipt['verifiedZipBytes'], 'Original ZIP size differs')
            require(digest(raw) == advertised['digest'].removeprefix('sha256:') == receipt['verifiedZipSha256'], 'Original ZIP digest differs')
            with zipfile.ZipFile(archive) as zipped:
                rebuilt = []
                for entry in zipped.infolist():
                    if entry.is_dir():
                        continue
                    data = zipped.read(entry)
                    require((path.parent / entry.filename).read_bytes() == data, 'Extracted bytes differ from original ZIP')
                    rebuilt.append({'path': entry.filename, 'bytes': len(data), 'sha256': digest(data)})
            require(rebuilt == receipt['members'], 'Original ZIP inventory differs')
            originals.append({'runId': run_id, 'artifactId': advertised['id'], 'name': advertised['name'],
                              'sha256': digest(raw), 'bytes': len(raw),
                              'manifestPath': path.relative_to(source).as_posix(), 'members': rebuilt})
        source_files.extend(path for path in root.rglob('*') if path.is_file() and path.name != 'artifact.zip')
    source_files.sort(key=lambda path: path.relative_to(source).as_posix())
    require(all(not path.is_symlink() for path in source_files), 'Unexpected source symlink')
    inventory = [{'path': path.relative_to(source).as_posix(), 'bytes': path.stat().st_size,
                  'sha256': digest(path.read_bytes())} for path in source_files]
    destination.mkdir(parents=True)
    for name in ['audit_combined.mjs', 'combined-audit.json', 'collect_combined_artifacts.py',
                 'verify_package.py', 'build_evidence_package.py', 'README.md']:
        shutil.copyfile(source / name, destination / name)
    (destination / 'raw-members.json').write_text(json.dumps(inventory, indent=2) + '\n')
    (destination / 'original-zip-verification.json').write_text(json.dumps({
        'schemaVersion': 1, 'scope': 'Original API-advertised ZIP bytes and complete member inventories independently verified during collection and again before packaging.',
        'compactPackageLimit': 'Original ZIP containers remain in the collection workspace. This compact package retains every uncompressed member byte, complete original inventories, and advertised ZIP identities. A reviewer can verify every retained member; reproducing an original ZIP-container hash additionally requires the original downloaded ZIP.',
        'artifacts': originals,
    }, indent=2) + '\n')
    with (destination / 'raw-receipts.tar.xz').open('wb') as stream:
        with lzma.LZMAFile(stream, mode='wb', format=lzma.FORMAT_XZ, preset=6) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as archive:
                for path, row in zip(source_files, inventory):
                    entry = tarfile.TarInfo(row['path'])
                    entry.size = row['bytes']
                    entry.mode = 0o644
                    entry.mtime = 0
                    entry.uid = entry.gid = 0
                    entry.uname = entry.gname = ''
                    with path.open('rb') as member:
                        archive.addfile(entry, member)
    files = [{'path': path.name, 'bytes': path.stat().st_size, 'sha256': digest(path.read_bytes())}
             for path in sorted(destination.iterdir()) if path.is_file()]
    receipt = json.loads((destination / 'combined-audit.json').read_text())
    manifest = {'schemaVersion': 1, 'runIds': [45114362649],
                'rawMemberCount': len(inventory), 'rawMemberBytes': sum(row['bytes'] for row in inventory),
                'observations': receipt['observationCount'], 'originalFailedReplicationsPreserved': receipt['originalFailuresPreserved'],
                'files': files}
    (destination / 'package-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return {'package': str(destination), 'files': len(files) + 1,
            'bytes': sum(path.stat().st_size for path in destination.iterdir()),
            'rawMembers': len(inventory), 'rawBytes': manifest['rawMemberBytes'],
            'manifestSha256': digest((destination / 'package-manifest.json').read_bytes())}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path, help='Collection directory containing the combined run-ID directory and audit files')
    parser.add_argument('destination', type=Path, help='New package directory; must not already exist')
    args = parser.parse_args()
    print(json.dumps(build(args.source.resolve(), args.destination.resolve()), indent=2))
