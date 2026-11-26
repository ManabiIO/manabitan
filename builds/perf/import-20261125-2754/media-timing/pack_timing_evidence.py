#!/usr/bin/env python3
"""Retain all three frozen media timing cohorts and their original audit."""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import zipfile

sys.dont_write_bytecode = True


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('artifact_root', type=Path)
    args = parser.parse_args()
    output = Path(__file__).resolve().parent
    helper_path = output.parent / 'media-memory/pack_text_evidence.py'
    spec = importlib.util.spec_from_file_location('memory_archive_writer', helper_path)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    metadata_path = output / 'github-artifacts.json'
    metadata = json.loads(metadata_path.read_text())['artifacts']
    by_name = {row['name']: row for row in metadata}
    assert len(metadata) == 3
    files = {
        'provenance/github-artifacts.json': metadata_path,
        'independent-audit/audit_cohort.py': args.artifact_root / 'audit_cohort.py',
    }
    records = []
    omitted = []
    audits = {}
    for dictionary in ['jmdict', 'jitendex', 'vndb']:
        root = args.artifact_root / dictionary
        original_zip = args.artifact_root / f'{dictionary}.zip'
        remote = by_name[f'current-media-screen-{dictionary}-2754']
        zip_digest = digest(original_zip.read_bytes())
        assert remote['digest'] == 'sha256:' + zip_digest
        assert remote['size_in_bytes'] == original_zip.stat().st_size
        assert remote['workflow_run']['id'] == 45642169759
        audit_path = root / 'independent-timing-audit.json'
        audit = json.loads(audit_path.read_text())
        assert audit['status'] == 'passed' and audit['observationsReopened'] == 23
        assert audit['timedObservations'] == 18
        assert audit['sourceIdentities']['B']['commit'] == '7a8b25a44a3fe165107ed816377cc72bb0fac67d'
        assert audit['sourceIdentities']['A']['commit'] == '7d1643e6147a10cb2165e9744cf0e63b59e46632'
        audits[dictionary] = audit
        files[f'artifacts/{dictionary}/independent-timing-audit.json'] = audit_path
        retained_count = 0
        with zipfile.ZipFile(original_zip) as original:
            names = [entry.filename for entry in original.infolist() if not entry.is_dir()]
            assert len(names) == len(set(names))
            for name in sorted(names):
                data = original.read(name)
                path = root / name
                if name.endswith('.pyc'):
                    omitted.append({'artifactId': remote['id'], 'dictionary': dictionary,
                                    'member': name, 'bytes': len(data), 'sha256': digest(data),
                                    'reason': 'Generated Python bytecode omitted; exact corresponding Python source retained.'})
                    continue
                data.decode('utf-8')
                assert path.read_bytes() == data, (dictionary, name)
                files[f'artifacts/{dictionary}/{name}'] = path
                retained_count += 1
        records.append({
            'artifactId': remote['id'], 'name': remote['name'], 'dictionary': dictionary,
            'originalArtifactZipBytes': original_zip.stat().st_size,
            'originalArtifactZipSha256': zip_digest,
            'originalArtifactZipOmitted': True,
            'artifactApiUrl': remote['url'], 'artifactDownloadApiUrl': remote['archive_download_url'],
            'artifactWebUrl': f"https://github.com/ManabiIO/manabitan/actions/runs/45642169759/artifacts/{remote['id']}",
            'expiresAt': remote['expires_at'], 'originalTextMembersRetained': retained_count,
        })
    entries = [{'path': name, 'bytes': path.stat().st_size, 'sha256': digest(path.read_bytes())}
               for name, path in sorted(files.items())]
    archive_path = output / 'media-timing-45642169759.text.tar.gz'
    with archive_path.open('wb') as stream:
        helper.write_archive(stream, files)
    archive_digest = digest(archive_path.read_bytes())
    with tempfile.TemporaryFile(dir='/tmp') as second:
        helper.write_archive(second, files)
        second.seek(0)
        assert hashlib.file_digest(second, 'sha256').hexdigest() == archive_digest
    with tarfile.open(archive_path, 'r:gz') as archive:
        assert [row.name for row in archive.getmembers()] == [row['path'] for row in entries]
        for entry in entries:
            assert digest(archive.extractfile(entry['path']).read()) == entry['sha256']
    manifest = {
        'schemaVersion': 1, 'workflowRunId': 45642169759,
        'workflowRunUrl': 'https://github.com/ManabiIO/manabitan/actions/runs/45642169759',
        'scope': 'Complete original six-block media candidate screens, three excluded warmups and two exhaustive diagnostics per corpus; no independent performance qualification and no pooling with other stages.',
        'sourceIdentities': audits['vndb']['sourceIdentities'],
        'archive': {'path': archive_path.name, 'bytes': archive_path.stat().st_size, 'sha256': archive_digest},
        'artifacts': records, 'includedFiles': entries, 'includedFileCount': len(entries),
        'includedUncompressedBytes': sum(row['bytes'] for row in entries),
        'omittedBinaryFiles': omitted,
        'omissionPolicy': 'Only original Actions ZIP containers and generated Python bytecode are omitted. Every original textual member, including all observations, warmups, diagnostics, logs, protocols, manifests, and any failure, is retained verbatim. Release-package ZIP payloads were not included in the original timing artifacts; complete package-entry manifests and exact ZIP hashes are retained as originally supplied.',
        'verification': {'originalZipDigestsMatchGitHub': True, 'allOriginalTextMembersMatch': True,
                         'duplicateBuildByteIdentical': True, 'everyMemberRoundTripMatches': True,
                         'all69RawReportsIndependentlyRevalidated': True},
        'auditSourceSha256': digest((args.artifact_root / 'audit_cohort.py').read_bytes()),
        'portableReplay': '../tools/audit_timing.py binds explicit repository/Node paths and the hash-verified captured storage policy while running the original unchanged auditor.',
    }
    (output / 'archive-manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    (output / 'independent-audit-summary.json').write_text(json.dumps(audits, indent=2, sort_keys=True) + '\n')
    (output / 'SHA256SUMS').write_text(f'{archive_digest}  {archive_path.name}\n')
    print(json.dumps({'archive': manifest['archive'], 'files': len(entries),
                      'uncompressedBytes': manifest['includedUncompressedBytes'],
                      'originalBytecodeFilesOmitted': len(omitted)}))


if __name__ == '__main__':
    main()
