"""Materialize exactly the frozen inventory; never modify original evidence."""
from pathlib import Path
import datetime
import gzip
import hashlib
import io
import json
import tarfile

root = Path(__file__).resolve().parent
sha = lambda data: hashlib.sha256(data).hexdigest()
inventory_path = root / 'inventory.json'
inventory_bytes = inventory_path.read_bytes()
assert sha(inventory_bytes) == '31d20caac16acbcd0c435c36b709362a5c92ab6837bee5a2899754bbe6709de8'
inventory = json.loads(inventory_bytes)
archive_dir = root / 'archives'
archive_dir.mkdir(exist_ok=False)
retained = {}
for study in inventory['studies']:
    for row in study['files']:
        source = Path(row['sourcePath'])
        data = source.read_bytes()
        assert len(data) == row['bytes'] and sha(data) == row['sha256'], source
        retained[row['sourcePath']] = data

archives = []
for study in inventory['studies']:
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode='wb', compresslevel=6, mtime=0, filename='') as compressed:
        with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as archive:
            for row in study['files']:
                data = retained[row['sourcePath']]
                info = tarfile.TarInfo(row['archivePath'])
                info.size = len(data)
                info.mode = 0o444
                archive.addfile(info, io.BytesIO(data))
    data = buffer.getvalue()
    assert len(data) == study['estimatedTarGzipBytes']
    assert sha(data) == study['estimatedTarGzipSha256']
    path = archive_dir / f"{study['name']}.tar.gz"
    with path.open('xb') as target:
        target.write(data)
    assert sha(path.read_bytes()) == study['estimatedTarGzipSha256']
    with tarfile.open(path, 'r:gz') as archive:
        members = archive.getmembers()
        assert len(members) == study['fileCount']
        assert [item.name for item in members] == [row['archivePath'] for row in study['files']]
        for item, row in zip(members, study['files']):
            assert item.isfile() and item.size == row['bytes']
            assert sha(archive.extractfile(item).read()) == row['sha256']
    archives.append({'path': study['suggestedArchivePath'], 'localPath': str(path), 'bytes': len(data), 'sha256': sha(data), 'gitBlobSha1': hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest(), 'files': study['fileCount'], 'uncompressedBytes': study['uncompressedBytes'], 'disposition': study['disposition']})

assert inventory_path.read_bytes() == inventory_bytes
original_artifacts = []
for check in inventory['identityChecks']:
    if check['kind'] != 'original-artifact-zip-and-extracted-bytes':
        continue
    artifact = check['artifact']
    original_artifacts.append({'artifactId': artifact['id'], 'name': artifact['name'], 'runId': artifact['workflow_run']['id'], 'runAttempt': 1, 'headSha': artifact['workflow_run']['head_sha'], 'zipBytes': check['zipBytes'], 'zipSha256': check['zipSha256'], 'verifiedMembers': len(check['members'])})
receipt = {'complete': True, 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'baselineCommit': inventory['baselineCommit'], 'scope': 'Saved completed component-study observations, failures, identities and correctness evidence. Complete-import qualification remains pending; no new measurement or performance claim.', 'inventorySha256': sha(inventory_bytes), 'materializerSha256': sha(Path(__file__).read_bytes()), 'sourceEntriesVerified': inventory['totalFiles'], 'totalArchiveBytes': sum(row['bytes'] for row in archives), 'checks': ['Every source size and SHA256 checked before inclusion', 'Each generated archive size and SHA256 equals the frozen in-memory estimate', 'Each saved archive reread and every regular member byte hash checked', 'Original inventory bytes unchanged', 'No original source receipt modified; no original ZIP, fixture, column capture, generated binary or SDK duplicated'], 'originalArtifacts': original_artifacts, 'archives': archives, 'pendingRuns': {'metadataWholeImport': 46107460816, 'guardedCodecWholeImport': 46109596112, 'inflaterComponentReplication': 46106878218}}
receipt_path = root / 'publication-receipt.json'
with receipt_path.open('x') as target:
    json.dump(receipt, target, indent=2)
    target.write('\n')

readme = ['# Saved import investigation evidence — 9d6', '', 'These archives preserve completed component studies, including every retained observation, source-identical control, negative result, failure record, correctness proof and source identity. They do not establish a complete-import speedup. Full-import qualification remains pending at packaging time.', '', f"Baseline: `{inventory['baselineCommit']}`. The six archives contain **{inventory['totalFiles']:,} files** and occupy **{receipt['totalArchiveBytes']:,} bytes** in total. `inventory.json` binds every member to its original source path, size and SHA256; `publication-receipt.json` records the verified package and original artifact identities.", '', '| Archive | Bytes | SHA256 |', '| --- | ---: | --- |']
for row in archives:
    readme.append(f"| `{Path(row['path']).name}` | {row['bytes']:,} | `{row['sha256']}` |")
readme += ['', '## Interpretation', '', '- **Metadata:** earlier scan fusion was rejected for a roughly 0.6 ms warmed saving and disproportionate complexity. The narrow helper shows cold component gains on two hosts, while warmed AB regresses and BA is mixed. Local cohorts and all original failures remain included.', '- **Codec v1:** scalar counters were rejected for inconsistent cold gains and larger modules. Later source review also identified the missing reversed-limit guard; their old timings cannot qualify a production change.', '- **Codec v2:** original count16 is invalid (768 direct-test traps and one wrong result). Its exploratory timings cannot qualify the corrected binary. CStream64 is rejected with 72 tight-destination status regressions. The guarded replacement passes correctness, but its performance requires separate qualification.', '- **Direct record lengths:** all 108 fresh-child receipts are retained. No stable gain survives both controls for JMdict or VNDB; Jitendex warm savings are only about 0.24 ms. Runtime restored.', '- **Inflater:** all 36 local children, cold losses, noisy controls, byte/CRC parity, reach and test-harness correction evidence are retained. No local gain is established.', '', 'Full-import runs pending at packaging: metadata **46107460816**, guarded codec **46109596112**. Inflater component replication **46106878218** is also pending. Later results should be added separately and must not replace these completed cohorts.', '', '## Original hosted artifacts', '', '| Artifact ID | Run / attempt | Head commit | ZIP bytes | Original ZIP SHA256 |', '| ---: | --- | --- | ---: | --- |']
for row in original_artifacts:
    readme.append(f"| {row['artifactId']} | {row['runId']} / {row['runAttempt']} | `{row['headSha']}` | {row['zipBytes']:,} | `{row['zipSha256']}` |")
readme += ['', 'All seven original ZIP identities and every extracted member were verified before packaging. Their complete member hash lists are in the unchanged inventory. The compact archives exclude original downloaded ZIPs, fixtures, compressed source/record columns, generated WASM/module duplicates, SDKs and checkout/dependency trees. They preserve observations and provenance without claiming to recreate those original ZIPs from the intentionally omitted binary files.', '', 'Archive entries use deterministic PAX tar metadata with gzip level 6 and mtime zero. Every input was rehashed before inclusion; every saved archive matches the frozen estimated byte count and digest; every saved member was reread and verified. Original receipts and the inventory were not modified.', '']
readme_path = root / 'PUBLICATION.md'
with readme_path.open('x') as target:
    target.write('\n'.join(readme))

files = []
for row in archives:
    files.append({key: row[key] for key in ['path', 'localPath', 'bytes', 'sha256', 'gitBlobSha1']} | {'encoding': 'base64'})
for file, remote in [(inventory_path, 'inventory.json'), (receipt_path, 'publication-receipt.json'), (readme_path, 'README.md')]:
    data = file.read_bytes()
    files.append({'path': 'dev/perf/import-investigation-9d6/evidence/' + remote, 'localPath': str(file), 'bytes': len(data), 'sha256': sha(data), 'gitBlobSha1': hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest(), 'encoding': 'utf-8'})
manifest = {'status': 'Verified local files ready for authorized publication by root; no external publication performed by this agent.', 'files': files, 'originalArtifacts': original_artifacts}
manifest_path = root / 'publication-manifest.json'
with manifest_path.open('x') as target:
    json.dump(manifest, target, indent=2)
    target.write('\n')
print(json.dumps({'complete': True, 'manifest': str(manifest_path), 'manifestSha256': sha(manifest_path.read_bytes()), 'files': len(files), 'archiveBytes': receipt['totalArchiveBytes'], 'inventorySha256': sha(inventory_path.read_bytes()), 'archives': [{key: row[key] for key in ['path', 'bytes', 'sha256']} for row in archives]}, indent=2))
