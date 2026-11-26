#!/usr/bin/env python3
"""Preserve original hosted study text and audits without duplicate release ZIPs."""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import sys
import tarfile
import tempfile
import zipfile

sys.dont_write_bytecode = True


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def safe_relative(value):
    path = PurePosixPath(value)
    assert not path.is_absolute() and '..' not in path.parts and str(path) == value
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact-root', type=Path, required=True)
    parser.add_argument('--audit-root', type=Path)
    parser.add_argument('--index', type=Path, required=True)
    parser.add_argument('--provider-metadata', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--archive-name', required=True)
    parser.add_argument('--candidate', required=True)
    args = parser.parse_args()
    root = args.artifact_root.resolve()
    audit_root = (args.audit_root or args.artifact_root).resolve()
    output = args.output.resolve()
    assert output.is_dir()
    assert args.archive_name == Path(args.archive_name).name and args.archive_name.endswith('.text.tar.gz')
    index = json.loads(args.index.read_text())
    metadata = json.loads(args.provider_metadata.read_text())
    provider = [row for run in metadata['runs'] for row in run['artifacts']]
    by_id = {row['id']: row for row in provider}
    assert len(by_id) == len(provider) == len(index) == 9
    assert {row['id'] for row in index} == set(by_id)
    assert sum(row['kind'] == 'memory' for row in index) == 6
    assert sum(row['kind'] == 'timing' for row in index) == 3
    files = {}
    omissions = []
    records = []

    def add(name, path):
        safe_relative(name)
        assert name not in files and path.is_file() and not path.is_symlink(), name
        path.read_bytes().decode('utf-8')
        files[name] = path

    add('provenance/capture-index.json', args.index.resolve())
    add('provenance/github-artifacts.json', args.provider_metadata.resolve())
    add('provenance/pack_hosted_study.py', Path(__file__).resolve())
    for prefix, directory in [('independent-audit', audit_root)]:
        for path in sorted(directory.iterdir()):
            if path.is_file() and path.suffix != '.zip':
                add(f'{prefix}/{path.name}', path)
    if audit_root != root:
        for path in sorted(root.iterdir()):
            if path.is_file() and path.suffix != '.zip':
                add(f'original-download-records/{path.name}', path)

    source_identities = None
    for item in sorted(index, key=lambda row: (row['kind'], row['id'])):
        kind = item['kind']
        remote = by_id[item['id']]
        assert remote['name'] == item['name']
        assert str(remote['workflow_run']['id']) == str(item['run'])
        archive = root / safe_relative(item['archive'])
        directory = root / safe_relative(item['directory'])
        archive_sha = file_digest(archive)
        assert archive_sha == item['sha256']
        assert remote['digest'] == 'sha256:' + archive_sha
        assert archive.stat().st_size == item['bytes'] == remote['size_in_bytes']
        protocol_path = directory / ('plan.json' if kind == 'memory' else 'cohort/protocol.json')
        protocol = json.loads(protocol_path.read_text())
        assert protocol['sourceIdentities']['B']['commit'] == args.candidate
        assert protocol['sourceIdentities']['A']['commit'] == '7d1643e6147a10cb2165e9744cf0e63b59e46632'
        identities = {arm: protocol['sourceIdentities'][arm] for arm in ['A', 'B']}
        if source_identities is None:
            source_identities = identities
        else:
            assert identities == source_identities
        retained = 0
        omitted = 0
        supplemental = 0
        with zipfile.ZipFile(archive) as original:
            names = [entry.filename for entry in original.infolist() if not entry.is_dir()]
            assert len(names) == len(set(names))
            for name in sorted(names):
                relative = safe_relative(name)
                data = original.read(name)
                binary_reason = None
                if name in ['A-product.zip', 'B-product.zip']:
                    assert kind == 'memory'
                    binary_reason = 'Duplicate ordinary release ZIP payload omitted; exact package-entry manifest and source identity retained. Full receipt replay needs these matching bytes.'
                elif name.endswith('.pyc'):
                    binary_reason = 'Generated Python bytecode omitted; corresponding Python source retained.'
                    source_name = str(relative.parent.parent / (relative.name.split('.')[0] + '.py'))
                    assert source_name in names
                if binary_reason is not None:
                    omissions.append({'artifactId': item['id'], 'member': name,
                                      'bytes': len(data), 'sha256': digest(data), 'reason': binary_reason})
                    omitted += 1
                    continue
                data.decode('utf-8')
                path = directory / relative
                assert path.read_bytes() == data, (item['id'], name)
                add(f'artifacts/{kind}/{item["id"]}/{name}', path)
                retained += 1
        # Independent audits may be saved beside the extracted original files.
        # Preserve these additional textual receipts without relabeling them as
        # original uploaded artifact members.
        for path in sorted(directory.rglob('*')):
            if not path.is_file():
                continue
            name = path.relative_to(directory).as_posix()
            if name in names:
                continue
            if name.endswith('.pyc'):
                relative = safe_relative(name)
                source = directory / relative.parent.parent / (relative.name.split('.')[0] + '.py')
                assert source.is_file()
                omissions.append({'artifactId': item['id'], 'supplementalFile': name,
                                  'bytes': path.stat().st_size, 'sha256': file_digest(path),
                                  'reason': 'Generated during independent audit; corresponding Python source retained.'})
                continue
            add(f'artifacts/{kind}/{item["id"]}/{name}', path)
            supplemental += 1
        records.append({'artifactId': item['id'], 'name': item['name'], 'kind': kind,
                        'dictionary': protocol['dictionary'],
                        'replication': protocol.get('replication'),
                        'workflowRunId': remote['workflow_run']['id'],
                        'workflowRunUrl': f'https://github.com/ManabiIO/manabitan/actions/runs/{item["run"]}',
                        'originalArtifactZipBytes': archive.stat().st_size,
                        'originalArtifactZipSha256': archive_sha,
                        'originalArtifactZipOmitted': True,
                        'artifactApiUrl': remote['url'],
                        'artifactDownloadApiUrl': remote['archive_download_url'],
                        'artifactWebUrl': f'https://github.com/ManabiIO/manabitan/actions/runs/{item["run"]}/artifacts/{item["id"]}',
                        'expiresAt': remote['expires_at'],
                        'originalTextMembersRetained': retained, 'originalBinaryMembersOmitted': omitted,
                        'supplementalTextFilesRetained': supplemental})
    entries = [{'path': name, 'bytes': path.stat().st_size, 'sha256': file_digest(path)}
               for name, path in sorted(files.items())]
    helper_path = Path(__file__).resolve().parent.parent / 'media-memory/pack_text_evidence.py'
    spec = importlib.util.spec_from_file_location('retained_archive_writer', helper_path)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    archive = output / args.archive_name
    with archive.open('wb') as stream:
        helper.write_archive(stream, files)
    archive_sha = file_digest(archive)
    with tempfile.TemporaryFile() as second:
        helper.write_archive(second, files)
        second.seek(0)
        assert hashlib.file_digest(second, 'sha256').hexdigest() == archive_sha
    with tarfile.open(archive, 'r:gz') as packed:
        assert [member.name for member in packed.getmembers()] == [entry['path'] for entry in entries]
        for entry in entries:
            assert digest(packed.extractfile(entry['path']).read()) == entry['sha256']
    manifest = {'schemaVersion': 1,
                'scope': 'All three original six-block timing screens and all six original memory replications, with independent audits. Failed observations and qualification failures are retained without replacement or pooling.',
                'sourceIdentities': source_identities,
                'archive': {'path': archive.name, 'bytes': archive.stat().st_size, 'sha256': archive_sha},
                'artifacts': records, 'includedFiles': entries, 'includedFileCount': len(entries),
                'includedUncompressedBytes': sum(entry['bytes'] for entry in entries),
                'omittedBinaryFiles': omissions,
                'omissionPolicy': 'Original Actions ZIP containers, duplicate A/B release ZIP payloads in memory artifacts, and generated Python bytecode are omitted with exact hashes. Every original textual member and supplied independent audit file is retained verbatim. Product ZIP payloads were absent from original timing artifacts; their original entry manifests and package hashes are retained.',
                'verification': {'originalZipDigestsMatchGitHub': True, 'allOriginalTextMembersMatch': True,
                                 'duplicateBuildByteIdentical': True, 'everyMemberRoundTripMatches': True},
                'replay': 'Use ../tools/verify_text_archive.py and the captured unchanged auditors. Location-only timing adapter ../tools/audit_timing.py supports explicit independent audit envelopes. The complete receipt verifier additionally requires matching omitted product ZIP payloads.'}
    (output / 'archive-manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    (output / 'SHA256SUMS').write_text(f'{archive_sha}  {archive.name}\n')
    print(json.dumps({'archive': manifest['archive'], 'files': len(entries),
                      'uncompressedBytes': manifest['includedUncompressedBytes'],
                      'originalBinaryMembersOmitted': len(omissions)}))


if __name__ == '__main__':
    main()
