#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Refresh a deterministic, append-only evidence snapshot; never run benchmarks.

Each input directory receives its own archive and manifest. Changed inputs get
a new content-derived version, so an earlier failed or incomplete snapshot is
never replaced. The sole CI-content omission is a built product ZIP whose full
archive hash and every package-entry hash are checked against retained receipts.
"""

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile
import tempfile
import zipfile


HERE = Path(__file__).resolve().parent
REPOSITORY = 'ManabiIO/manabitan'
RUNS = {
    'screen': 45465463257,
    'prefix-qualification': 45468314006,
    'prefix-memory': 45468614083,
    'corrected-vndb-screen': 45469432793,
    'activation-failures': 45468163108,
    'activation-corrected': 45470204352,
    'baseline-profile': 45458569610,
}
MEDIA_MEMORY_COMMIT = 'df1e9f4ac1e4c4e2e02b96de90bfe63d3ff359dc'
READABLE = {
    'analysis.json', 'state.json', 'correctness.json', 'protocol.json',
    'plan.json', 'qualification.json', 'memory-comparison.json',
    'memory-audit.json', 'receipt-audit.json', 'observations.json',
    'storage-allocation-summary.json', 'fixture.json', 'setup-fixtures.json',
    'package-differences.json', 'summary.json', 'diagnosis.md',
}
LOCAL_RECEIPTS = {
    'six-screen-independent-review.json', 'prefix-qualification-artifact-provenance.json',
    'package-guards.json', 'private-prefix-handoff.md', 'memory-tooling-tests.log',
    'jmdict-cache-receipt.json', 'jmdict-cache-focused-setup-failure.log',
    'jmdict-cache-focused.log', 'jmdict-cache-lint.log', 'jmdict-cache-lint-final.log',
    'jmdict-cache-types-main.log', 'jmdict-cache-types-test.log',
    'content-overlap-package-build.log', 'current-baseline-build.log',
    'jmdict-sidecar-package-build.log', 'media-critical-package-build.log',
    'actual-activation-cache.patch', 'actual-activation-prefix.patch',
    'activation-prefix-jmdict.log',
}


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + '\n').encode()


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    data = encoded(value)
    if not path.exists() or path.read_bytes() != data:
        path.write_bytes(data)


def read_json(path):
    return json.loads(path.read_text())


def source_files(root, select=None, shallow=False):
    result = []
    candidates = root.iterdir() if shallow else root.rglob('*')
    for path in sorted(candidates):
        relative = path.relative_to(root)
        if any(part in {'__pycache__', '.git', 'node_modules'} for part in relative.parts):
            continue
        if select is not None and not select(relative):
            continue
        if path.is_symlink():
            raise ValueError(f'Unexpected source symlink: {path}')
        if path.is_file():
            result.append((relative.as_posix(), path))
    return result


def artifact_provenance(output):
    result = {}
    for path in sorted((output / 'provenance').glob('github-artifacts-*.json')):
        record = read_json(path)
        receipt_sha = digest(path)
        frozen = output / 'provenance' / 'metadata' / f'{receipt_sha}.json'
        frozen.parent.mkdir(parents=True, exist_ok=True)
        if frozen.exists() and frozen.read_bytes() != path.read_bytes():
            raise ValueError('GitHub metadata content hash collision')
        frozen.write_bytes(path.read_bytes())
        for artifact in record['artifacts']:
            previous = result.get(artifact['name'])
            if previous is not None and previous['artifact']['id'] != artifact['id']:
                raise ValueError(f'Conflicting artifact provenance: {artifact["name"]}')
            result[artifact['name']] = {
                'repository': record['repository'], 'runId': record['runId'],
                'runUrl': record['runUrl'],
                'artifactUrl': f'{record["runUrl"]}/artifacts/{artifact["id"]}',
                'artifact': artifact,
                'metadataReceipt': frozen.relative_to(output).as_posix(),
                'metadataReceiptSha256': receipt_sha,
            }
    return result


def classify(name):
    match = re.fullmatch(r'import-(prefix|media|cache)-screen-(jmdict|jitendex|vndb)-(forward|reverse)-(\d+)-(\d+)', name)
    if match:
        candidate, dictionary, direction, run, attempt = match.groups()
        if int(run) == RUNS['screen']:
            stage = 'screen'
        elif int(run) == RUNS['corrected-vndb-screen'] and dictionary == 'vndb' and candidate in {'prefix', 'media'}:
            stage = 'corrected-vndb-screen'
        else:
            return None
        return {'stage': stage, 'candidate': candidate, 'dictionary': dictionary,
                'direction': direction, 'runId': int(run), 'attempt': int(attempt)}
    match = re.fullmatch(r'import-prefix-qualification-(jmdict|jitendex)-(forward|reverse)-(\d+)-(\d+)', name)
    if match and int(match[3]) == RUNS['prefix-qualification']:
        return {'stage': 'prefix-qualification', 'candidate': 'prefix', 'dictionary': match[1],
                'direction': match[2], 'runId': int(match[3]), 'attempt': int(match[4])}
    match = re.fullmatch(r'import-memory-3aac-(prefix|media)-(jmdict|jitendex|vndb)-rep([12])-(\d+)-(\d+)', name)
    if match:
        candidate, dictionary, replication, run, attempt = match.groups()
        if candidate == 'prefix' and (int(run) != RUNS['prefix-memory'] or dictionary != 'jitendex'):
            return None
        if candidate == 'media' and dictionary not in {'jitendex', 'vndb'}:
            return None
        return {'stage': f'{candidate}-memory', 'candidate': candidate, 'dictionary': dictionary,
                'replication': int(replication), 'runId': int(run), 'attempt': int(attempt)}
    match = re.fullmatch(r'import-critical-path-3aac-(jmdict|jitendex|vndb)-(\d+)-(\d+)', name)
    if match and int(match[2]) == RUNS['baseline-profile']:
        return {'stage': 'baseline-profile', 'dictionary': match[1],
                'runId': int(match[2]), 'attempt': int(match[3])}
    return None


def checked_product_omission(root, relative, path, provenance):
    match = re.fullmatch(r'([ABC])-product\.zip', relative)
    if match is None:
        return None
    if provenance is None:
        raise ValueError(f'Product ZIP cannot be omitted without original CI provenance: {path}')
    arm = match[1]
    identity_path = root / f'{arm}-identity.json'
    entries_path = root / f'{arm}-package-entries.json'
    identity, expected = read_json(identity_path), read_json(entries_path)
    planned_source = read_json(root / 'plan.json')['sourceIdentities'][arm]
    if any(identity[key] != planned_source[key] for key in ('commit', 'tree')):
        raise ValueError(f'Product ZIP source differs from the frozen plan: {path}')
    sha256 = digest(path)
    if identity['packageSha256'] != sha256:
        raise ValueError(f'Product ZIP archive hash mismatch: {path}')
    actual = {}
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            if info.filename in actual:
                raise ValueError(f'Duplicate product ZIP member: {info.filename}')
            actual[info.filename] = hashlib.sha256(archive.read(info)).hexdigest()
    if actual != expected:
        raise ValueError(f'Product ZIP entry map mismatch: {path}')
    return {
        'path': relative, 'bytes': path.stat().st_size, 'sha256': sha256,
        'reason': 'Built product ZIP bytes excluded from git evidence; full SHA and every entry verified before omission.',
        'identityReceipt': identity_path.relative_to(root).as_posix(),
        'identityReceiptSha256': digest(identity_path),
        'entryMapReceipt': entries_path.relative_to(root).as_posix(),
        'entryMapReceiptSha256': digest(entries_path), 'verifiedEntries': len(actual),
        'sourceCommit': identity['commit'], 'sourceTree': identity['tree'],
        'sourceUrl': f'https://github.com/{REPOSITORY}/tree/{identity["commit"]}',
        'buildCommands': ['npm ci', 'npm run build:libs', 'npm run build -- --target chrome'],
        'buildRecipe': 'Exact dependency manifests, setup action, tooling runner, workflow and build logs retained in this artifact.',
        'originalArtifactUrl': None if provenance is None else provenance['artifactUrl'],
        'originalArtifactArchiveSha256': None if provenance is None else provenance['artifact']['digest'],
        'reconstructionLimit': 'Frozen source/assets reproduce package contents; a rebuilt ZIP need not reproduce original archive timestamps or compression metadata.',
    }


def add_bytes(archive, name, data):
    info = tarfile.TarInfo(name)
    info.size, info.mtime, info.mode = len(data), 0, 0o644
    info.uid = info.gid = 0
    info.uname = info.gname = ''
    archive.addfile(info, io.BytesIO(data))


def write_archive(path, manifest, files):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.pending-', delete=False) as raw:
        temporary = Path(raw.name)
        try:
            with gzip.GzipFile(filename='', mode='wb', compresslevel=9, mtime=0, fileobj=raw) as compressed:
                with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as archive:
                    add_bytes(archive, 'EVIDENCE-MANIFEST.json', encoded(manifest))
                    for record in manifest['retainedFiles']:
                        data = files[record['path']].read_bytes()
                        if len(data) != record['bytes'] or hashlib.sha256(data).hexdigest() != record['sha256']:
                            raise ValueError(f'Source changed during packaging: {record["path"]}')
                        add_bytes(archive, record['path'], data)
            raw.flush()
            temporary.replace(path)
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise


def package_directory(root, descriptor, output, provenance=None, select=None):
    files = dict(source_files(root, select, shallow=descriptor['sourceRoot'] == '.'))
    if not files:
        raise ValueError(f'Empty evidence directory: {root}')
    inventory = [{'path': name, 'bytes': path.stat().st_size, 'sha256': digest(path)}
                 for name, path in files.items()]
    fingerprint = hashlib.sha256(encoded(inventory)).hexdigest()
    stem = f'{descriptor["name"]}--{fingerprint[:16]}'
    archive_relative = f'archives/{descriptor["stage"]}/{stem}.tar.gz'
    manifest_relative = f'manifests/{descriptor["stage"]}/{stem}.json'
    manifest_path, archive_path = output / manifest_relative, output / archive_relative
    if manifest_path.exists() or archive_path.exists():
        if not manifest_path.exists() or not archive_path.exists():
            raise ValueError(f'Incomplete prior snapshot: {stem}')
        manifest = read_json(manifest_path)
        if manifest['sourceInventory'] != inventory:
            raise ValueError(f'Snapshot identity collision: {stem}')
    else:
        omitted = [value for name, path in files.items()
                   if (value := checked_product_omission(root, name, path, provenance)) is not None]
        omitted_names = {value['path'] for value in omitted}
        retained = [row for row in inventory if row['path'] not in omitted_names]
        state = None
        for relative in ('cohort/state.json', 'qualification.json'):
            if relative in files:
                state = read_json(files[relative])
                break
        manifest = {
            'schemaVersion': 1, **descriptor, 'sourceInventorySha256': fingerprint,
            'sourceInventory': inventory, 'sourceFileCount': len(inventory),
            'sourceBytes': sum(row['bytes'] for row in inventory),
            'retainedFiles': retained, 'retainedBytes': sum(row['bytes'] for row in retained),
            'omittedBuiltProducts': omitted, 'originalGithubArtifact': provenance,
            'recordedStudyState': state,
            'packagingDoesNotQualifyOrReclassifyStudies': True,
            'packagerSha256': digest(Path(__file__)),
        }
        write_archive(archive_path, manifest, files)
        save(manifest_path, manifest)
    readable = []
    for relative, path in files.items():
        is_top_receipt = len(Path(relative).parts) <= 2 and path.name in READABLE
        is_local_receipt = descriptor['stage'] == 'supporting' and path.suffix in {'.json', '.md'}
        if is_top_receipt or is_local_receipt:
            destination = output / 'readable' / descriptor['stage'] / stem / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            data = path.read_bytes()
            if destination.exists() and destination.read_bytes() != data:
                raise ValueError(f'Changed readable receipt: {destination}')
            destination.write_bytes(data)
            readable.append({'path': destination.relative_to(output).as_posix(),
                             'sha256': hashlib.sha256(data).hexdigest()})
    return {**descriptor, 'sourceInventorySha256': fingerprint,
            'archive': archive_relative, 'archiveSha256': digest(archive_path),
            'archiveBytes': archive_path.stat().st_size,
            'manifest': manifest_relative, 'manifestSha256': digest(manifest_path),
            'sourceFileCount': manifest['sourceFileCount'], 'retainedBytes': manifest['retainedBytes'],
            'omittedProductBytes': sum(row['bytes'] for row in manifest['omittedBuiltProducts']),
            'recordedStudyState': manifest['recordedStudyState'], 'readable': readable}


def expected_names(media_run):
    result = []
    for dictionary in ('jmdict', 'jitendex', 'vndb'):
        result.append(f'import-critical-path-3aac-{dictionary}-{RUNS["baseline-profile"]}-1')
    for stage in ('activation-failures', 'activation-corrected'):
        for candidate, dictionary in (('prefix', 'jmdict'), ('prefix', 'jitendex'),
                                      ('prefix', 'vndb'), ('cache', 'jmdict')):
            result.append(f'import-activation-3aac-{candidate}-{dictionary}-{RUNS[stage]}-1')
    for candidate in ('prefix', 'media', 'cache'):
        for dictionary in ('jmdict', 'jitendex', 'vndb'):
            result.append(f'import-{candidate}-screen-{dictionary}-forward-{RUNS["screen"]}-1')
    for dictionary in ('jmdict', 'jitendex'):
        for direction in ('forward', 'reverse'):
            result.append(f'import-prefix-qualification-{dictionary}-{direction}-{RUNS["prefix-qualification"]}-1')
    for replication in (1, 2):
        result.append(f'import-memory-3aac-prefix-jitendex-rep{replication}-{RUNS["prefix-memory"]}-1')
    for candidate in ('prefix', 'media'):
        result.append(f'import-{candidate}-screen-vndb-forward-{RUNS["corrected-vndb-screen"]}-1')
    for dictionary in ('jitendex', 'vndb'):
        for replication in (1, 2):
            result.append(f'import-memory-3aac-media-{dictionary}-rep{replication}-{media_run or "RUN_PENDING"}-1')
    return result


def refresh(round2, output, media_run):
    packager = Path(__file__)
    packager_copy = output / 'provenance' / 'packagers' / f'{digest(packager)}.py'
    packager_copy.parent.mkdir(parents=True, exist_ok=True)
    packager_copy.write_bytes(packager.read_bytes())
    provenance = artifact_provenance(output)
    old = read_json(output / 'index.json') if (output / 'index.json').exists() else {'snapshots': []}
    snapshots = {row['archive']: row for row in old['snapshots']}
    seen = []
    missing_provenance = []
    discovered_media_runs = set()
    for root in sorted((round2 / 'artifacts').iterdir()):
        descriptor = classify(root.name) if root.is_dir() else None
        if descriptor is None:
            continue
        original = provenance.get(root.name)
        if original is None:
            missing_provenance.append(root.name)
        elif descriptor['stage'] == 'media-memory' and original['artifact']['workflow_run']['head_sha'] != MEDIA_MEMORY_COMMIT:
            raise ValueError(f'Media memory artifact has unexpected tooling revision: {root.name}')
        if descriptor['stage'] == 'media-memory':
            discovered_media_runs.add(descriptor['runId'])
        descriptor.update(name=root.name, sourceRoot=f'artifacts/{root.name}')
        row = package_directory(root, descriptor, output, original)
        snapshots[row['archive']] = row
        seen.append(root.name)
    if len(discovered_media_runs) > 1 or (media_run and discovered_media_runs - {media_run}):
        raise ValueError('Multiple media memory runs require an explicitly reviewed protocol update')
    media_run = media_run or next(iter(discovered_media_runs), None)
    for stage in ('activation-failures', 'activation-corrected'):
        activation = round2 / f'{stage}-{RUNS[stage]}'
        if not activation.exists():
            continue
        for root in sorted(activation.glob('artifact-*')):
            if not root.is_dir():
                continue
            artifact_id = int(root.name.removeprefix('artifact-'))
            original = next((row for row in provenance.values() if row['artifact']['id'] == artifact_id), None)
            name = root.name if original is None else original['artifact']['name']
            descriptor = {'stage': stage, 'name': name,
                          'runId': RUNS[stage], 'sourceRoot': f'{activation.name}/{root.name}'}
            if original is None:
                missing_provenance.append(name)
            zip_path = root.with_suffix('.zip')
            if original is not None and zip_path.exists():
                expected = original['artifact']['digest'].removeprefix('sha256:')
                if digest(zip_path) != expected:
                    raise ValueError(f'Original activation artifact ZIP differs: {zip_path}')
                descriptor['originalArchiveLocallyVerifiedSha256'] = expected
            row = package_directory(root, descriptor, output, original)
            snapshots[row['archive']] = row
            seen.append(name)
    supporting = [
        ('vndb-audit', None), ('storage-protocol', None), ('jmdict-audit', None),
        (f'activation-failures-{RUNS["activation-failures"]}',
         lambda p: not p.parts[0].startswith('artifact-') or len(p.parts) == 1),
        (f'activation-corrected-{RUNS["activation-corrected"]}',
         lambda p: not p.parts[0].startswith('artifact-') or len(p.parts) == 1),
        ('.', lambda p: len(p.parts) == 1 and
         (p.name in LOCAL_RECEIPTS or p.name.endswith(('-publication.json', '-publication-plan.json',
                                                     '-independent-review.json', '-independent-review.py')))),
    ]
    missing_supporting = []
    for relative, select in supporting:
        root = round2 / relative
        if not root.exists():
            missing_supporting.append(relative)
            continue
        name = 'session-receipts' if relative == '.' else relative
        descriptor = {'stage': 'supporting', 'name': name, 'sourceRoot': relative,
                      'timingClaim': 'none; supporting source/oracle/failure/provenance evidence'}
        row = package_directory(root, descriptor, output, select=select)
        snapshots[row['archive']] = row
    all_names = {row['name'] for row in snapshots.values()}
    expected = expected_names(media_run)
    result = {'schemaVersion': 1, 'repository': REPOSITORY,
              'scope': 'Separate fixed timing cohorts, memory replications, failed activation diagnostics and supporting source evidence; no pooling.',
              'packagerSha256': digest(Path(__file__)),
              'archiveFormat': 'Sorted regular-file tar, uid/gid=0, mode=0644, mtime=0; gzip mtime=0 and empty filename.',
              'productZipExclusion': 'Every built product ZIP omitted only after its full archive SHA and all entry hashes match retained receipts; raw reports/scans/markers/logs retained.',
              'expectedArtifactNames': expected,
              'missingExpectedArtifactNames': [name for name in expected if name not in all_names],
              'missingGithubProvenance': sorted(missing_provenance),
              'missingSupportingDirectories': missing_supporting,
              'snapshots': sorted(snapshots.values(), key=lambda row: (row['stage'], row['name'], row['archive'])),
              'priorSnapshotsRetained': True, 'failedCohortsReclassified': False,
              'allArchiveBytes': sum(row['archiveBytes'] for row in snapshots.values())}
    save(output / 'index.json', result)
    lines = ['# Import evidence snapshot — 2026-11-24', '',
             'Every cell is preserved separately. The status below is copied from the original study; packaging does not qualify a study, pool cohorts, remove tails, or replace failed observations.', '',
             'Built product ZIP bytes are the sole CI-content exclusion. Their full archive SHA-256 and every package-entry hash were checked before omission, and their identity receipts, original CI links, source revisions and build recipes remain retained. Full native JSON, protocols, raw memory scans, markers, logs and failures remain in the archives. Rebuilt ZIP container bytes may differ even when package contents match.', '',
             'Run `python3 package-evidence.py --verify` to audit archive/member hashes and readable receipts. Extract an archive with `tar -xzf <archive> -C <empty-directory>`. Omitted product ZIPs needed by the original memory receipt verifier can be recovered from the linked original CI artifact while available; their expected hashes are in each manifest.', '',
             'Refresh from the acquisition workspace with `python3 package-evidence.py --round2 /absolute/path/to/round2`. Add `--media-memory-run RUN_ID` before those artifacts arrive if needed. The script runs no tests, browser acquisitions or benchmarks. Input-content changes create a new version; prior snapshots are never removed.', '',
             f'Total compressed archive bytes: **{result["allArchiveBytes"]:,}**.', '',
             '| Stage | Cell | Original status | Compressed bytes |', '|---|---|---|---:|']
    for row in result['snapshots']:
        state = row['recordedStudyState']
        status = 'retained supporting/diagnostic data' if state is None else str(state.get('status', state.get('qualified', state)))
        lines.append(f'| {row["stage"]} | [{row["name"]}]({row["manifest"]}) | {status} | [{row["archiveBytes"]:,}]({row["archive"]}) |')
    lines.extend(['', '## Missing or forthcoming evidence', ''])
    missing = result['missingExpectedArtifactNames'] + result['missingGithubProvenance'] + result['missingSupportingDirectories']
    lines.extend([f'- `{name}`' for name in missing] if missing else ['No expected acquisition artifacts or metadata receipts are missing.'])
    lines.extend(['', 'Readable cell analyses and receipts are under `readable/`; original GitHub metadata is under `provenance/`. `index.json` and each manifest list every retained source-file hash, explicit product ZIP omission, archive hash and source location. All native semantic and persisted-byte coverage limits from the original protocols remain in force.', ''])
    (output / 'README.md').write_text('\n'.join(lines))
    return result


def verify(output):
    index = read_json(output / 'index.json')
    if index['packagerSha256'] != digest(Path(__file__)):
        raise ValueError('Packaging script differs from the recorded refresh')
    checked_files = checked_bytes = 0
    for row in index['snapshots']:
        manifest_path, archive_path = output / row['manifest'], output / row['archive']
        if digest(manifest_path) != row['manifestSha256'] or digest(archive_path) != row['archiveSha256']:
            raise ValueError(f'Snapshot hash mismatch: {row["name"]}')
        manifest = read_json(manifest_path)
        frozen_packager = output / 'provenance' / 'packagers' / f'{manifest["packagerSha256"]}.py'
        if not frozen_packager.exists() or digest(frozen_packager) != manifest['packagerSha256']:
            raise ValueError('Snapshot packaging source is missing or changed')
        original = manifest['originalGithubArtifact']
        if original is not None:
            metadata_path = output / 'provenance' / 'metadata' / f'{original["metadataReceiptSha256"]}.json'
            if not metadata_path.exists() or digest(metadata_path) != original['metadataReceiptSha256']:
                raise ValueError('Frozen original GitHub metadata is missing or changed')
            metadata = read_json(metadata_path)
            if metadata['runId'] != original['runId'] or original['artifact'] not in metadata['artifacts']:
                raise ValueError('Original artifact does not match its frozen GitHub metadata')
        fingerprint = hashlib.sha256(encoded(manifest['sourceInventory'])).hexdigest()
        if fingerprint != manifest['sourceInventorySha256'] or fingerprint != row['sourceInventorySha256']:
            raise ValueError('Source inventory fingerprint mismatch')
        expected = {item['path']: item for item in manifest['retainedFiles']}
        if len(expected) != len(manifest['retainedFiles']):
            raise ValueError('Duplicate retained manifest paths')
        omitted = {item['path']: item for item in manifest['omittedBuiltProducts']}
        if omitted and original is None:
            raise ValueError('Omitted products require original GitHub provenance')
        inventory = {item['path']: item for item in manifest['sourceInventory']}
        if set(inventory) != set(expected) | set(omitted) or set(expected) & set(omitted):
            raise ValueError('Source inventory is not exactly partitioned by retained/omitted files')
        for name, item in expected.items():
            if item != inventory[name]:
                raise ValueError('Retained file differs from source inventory')
        for name, item in omitted.items():
            if inventory[name] != {key: item[key] for key in ('path', 'bytes', 'sha256')}:
                raise ValueError('Omitted product differs from source inventory')
        with tarfile.open(archive_path, 'r:gz') as archive:
            members = archive.getmembers()
            names = [member.name for member in members]
            if len(names) != len(set(names)) or set(names) != set(expected) | {'EVIDENCE-MANIFEST.json'}:
                raise ValueError(f'Archive member inventory mismatch: {row["name"]}')
            if archive.extractfile('EVIDENCE-MANIFEST.json').read() != manifest_path.read_bytes():
                raise ValueError('Embedded manifest differs from readable manifest')
            for member in members:
                if not member.isfile() or member.mtime != 0 or member.uid != 0 or member.gid != 0:
                    raise ValueError('Unexpected archive member type or nondeterministic metadata')
                if member.name == 'EVIDENCE-MANIFEST.json':
                    continue
                data = archive.extractfile(member).read()
                expected_row = expected[member.name]
                if len(data) != expected_row['bytes'] or hashlib.sha256(data).hexdigest() != expected_row['sha256']:
                    raise ValueError(f'Archive member hash mismatch: {member.name}')
                checked_files += 1
                checked_bytes += len(data)
            for item in omitted.values():
                identity_data = archive.extractfile(item['identityReceipt']).read()
                entries_data = archive.extractfile(item['entryMapReceipt']).read()
                identity, entries = json.loads(identity_data), json.loads(entries_data)
                arm = item['path'].split('-', 1)[0]
                source = json.loads(archive.extractfile('plan.json').read())['sourceIdentities'][arm]
                if (hashlib.sha256(identity_data).hexdigest() != item['identityReceiptSha256'] or
                        hashlib.sha256(entries_data).hexdigest() != item['entryMapReceiptSha256'] or
                        identity['packageSha256'] != item['sha256'] or
                        identity['commit'] != item['sourceCommit'] or identity['tree'] != item['sourceTree'] or
                        source['commit'] != identity['commit'] or source['tree'] != identity['tree'] or
                        len(entries) != item['verifiedEntries'] or
                        item['originalArtifactUrl'] != original['artifactUrl'] or
                        item['originalArtifactArchiveSha256'] != original['artifact']['digest']):
                    raise ValueError('Omitted product provenance/receipt mismatch')
        for readable in row['readable']:
            if digest(output / readable['path']) != readable['sha256']:
                raise ValueError(f'Readable receipt mismatch: {readable["path"]}')
    return {'status': 'passed', 'archives': len(index['snapshots']),
            'retainedFilesVerified': checked_files, 'retainedBytesVerified': checked_bytes,
            'compressedArchiveBytes': index['allArchiveBytes'],
            'missingExpectedArtifacts': index['missingExpectedArtifactNames'],
            'failedCohortsReclassified': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--round2', type=Path)
    parser.add_argument('--output', type=Path, default=HERE)
    parser.add_argument('--media-memory-run', type=int)
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    if args.verify:
        result = verify(args.output)
    else:
        if args.round2 is None:
            parser.error('--round2 is required for refresh')
        refresh(args.round2.resolve(), args.output.resolve(), args.media_memory_run)
        result = verify(args.output.resolve())
        save(args.output / 'verification.json', result)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
