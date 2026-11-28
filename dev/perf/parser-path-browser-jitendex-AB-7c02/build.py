"""Preserve a completed artifact without executing its code or changing its bytes."""
from pathlib import Path
from collections import defaultdict
import datetime
import hashlib
import json
import re
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CONFIG = json.loads((HERE / 'cohort.json').read_bytes())
SOURCE = Path(CONFIG['extractionPath'])
HOSTED = ROOT / 'path-hosted'
ORIGINAL = Path(CONFIG['originalZip']['path'])
EXPECTED_ORIGINAL = CONFIG['originalZip']['sha256']
OMIT = {'result/package-A.zip', 'result/package-B.zip'}
EXTRAS = {
    'metadata/artifact.json': HOSTED / f"artifact-{CONFIG['artifactId']}-metadata.json",
    'metadata/original-preservation.json': HOSTED / f"artifact-{CONFIG['artifactId']}-preservation.json",
    f"metadata/job-{CONFIG['jobId']}.log": HOSTED / f"job-{CONFIG['jobId']}.log",
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, indent=2, sort_keys=True) + '\n').encode()


def file_sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def category(name):
    if name in OMIT:
        return 'omitted-package-payloads'
    if name.startswith('result/memory/'):
        return 'complete-memory-tree'
    if name.startswith(('result/pair-', 'result/control-', 'result/warmup-')):
        return 'complete-ordinary-observations'
    if name.startswith('result/exhaustive-media-'):
        return 'complete-exhaustive-media-observations'
    return 'root-identity-schedule-statistics-and-logs'


def zip_info(name):
    item = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    item.compress_type = zipfile.ZIP_DEFLATED
    item.create_system = 3
    item.external_attr = 0o100644 << 16
    return item


def main():
    assert not (HERE / 'index.json').exists(), 'Refuse to replace an existing bundle'
    preserved_bytes = EXTRAS['metadata/original-preservation.json'].read_bytes()
    assert sha(preserved_bytes) == CONFIG['preservationSha256']
    preserved = json.loads(preserved_bytes)
    metadata_bytes = EXTRAS['metadata/artifact.json'].read_bytes()
    assert sha(metadata_bytes) == CONFIG['metadataSha256']
    metadata = json.loads(metadata_bytes)
    assert preserved['artifactId'] == metadata['id'] == CONFIG['artifactId']
    assert preserved['runId'] == metadata['workflow_run']['id'] == 46113567719
    assert preserved['jobId'] == CONFIG['jobId']
    assert preserved['crcPassed'] is True
    assert ORIGINAL.stat().st_size == preserved['zipBytes'] == metadata['size_in_bytes'] == CONFIG['originalZip']['size']
    assert file_sha(ORIGINAL) == preserved['zipSha256'] == EXPECTED_ORIGINAL
    assert metadata['digest'] == 'sha256:' + EXPECTED_ORIGINAL
    expected = {x['name']: x for x in preserved['members']}
    assert len(expected) == len(preserved['members']) == 317
    files = {str(p.relative_to(SOURCE)): p for p in SOURCE.rglob('*') if p.is_file()}
    assert set(files) == set(expected)
    assert all(not p.is_symlink() for p in files.values())
    source_identities = json.loads(files['result/source-identities.json'].read_bytes())
    omitted = []
    for name in sorted(OMIT):
        arm = name[-5]
        path = files[name]
        assert file_sha(path) == expected[name]['sha256'] == source_identities['arms'][arm]['packageSha256']
        with zipfile.ZipFile(path) as package:
            entries = {entry.filename: sha(package.read(entry)) for entry in package.infolist() if not entry.is_dir()}
            assert len(entries) == len([entry for entry in package.infolist() if not entry.is_dir()])
            assert entries == source_identities['arms'][arm]['entries']
        omitted.append({**expected[name], 'reason': 'Rebuildable runtime package payload; exact archive hash and complete 554-entry hash map retained', 'identityManifest': 'artifact/result/source-identities.json', 'identityArm': arm, 'entryCount': len(entries)})
    frozen = []
    counts = defaultdict(lambda: {'files': 0, 'bytes': 0})
    for name, path in sorted(files.items()):
        size = path.stat().st_size
        assert size == expected[name]['bytes']
        assert file_sha(path) == expected[name]['sha256']
        kind = category(name)
        counts[kind]['files'] += 1
        counts[kind]['bytes'] += size
        if name not in OMIT:
            frozen.append({'path': 'artifact/' + name, 'size': size, 'sha256': expected[name]['sha256'], 'category': kind})
    for name, path in sorted(EXTRAS.items()):
        data = path.read_bytes()
        frozen.append({'path': name, 'size': len(data), 'sha256': sha(data), 'category': 'original-artifact-metadata-and-job-log'})
    assert sum(x['bytes'] for x in counts.values()) == CONFIG['extractedBytes']
    assert sum(x['files'] for x in counts.values()) == 317
    # Scan retained text only; report names, never matching credential text.
    patterns = [
        re.compile(rb'\bgh[pousr]_[A-Za-z0-9]{20,}'),
        re.compile(rb'\bgithub_pat_[A-Za-z0-9_]{20,}'),
        re.compile(rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'),
        re.compile(rb'https?://[^\s\"<>]*(?:[?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|X-Goog-Signature|sig|access_token|token)=)', re.I),
    ]
    matches = []
    for entry in frozen:
        name = entry['path']
        path = files[name[len('artifact/'):]] if name.startswith('artifact/') else EXTRAS[name]
        data = path.read_bytes()
        if any(pattern.search(data) for pattern in patterns):
            matches.append(name)
    privacy = {'scope': 'All retained source artifact and metadata/log bytes; obvious token and signed-download-URL patterns only', 'scannedFiles': len(frozen), 'matchingPaths': matches}
    (HERE / 'privacy-scan.json').write_bytes(encoded(privacy))
    assert not matches, 'Possible credentials found in: ' + ', '.join(matches)
    manifest = {
        'schemaVersion': 1,
        'scope': 'Lossless saved-artifact preservation; no result arithmetic, native execution or new observation',
        'artifactId': CONFIG['artifactId'], 'runId': 46113567719, 'jobId': CONFIG['jobId'],
        'dictionary': CONFIG['dictionary'], 'initialOrder': CONFIG['initialOrder'],
        'originalArtifact': {'size': CONFIG['originalZip']['size'], 'sha256': EXPECTED_ORIGINAL, 'extractedFiles': 317, 'extractedBytes': CONFIG['extractedBytes']},
        'categories': dict(sorted(counts.items())),
        'files': frozen, 'omitted': omitted,
        'fixturePayloadsPresentInOriginalExtraction': False,
        'preservedEveryNonPackageArtifactMember': True,
        'originalInputsUnmodified': True,
    }
    manifest_bytes = encoded(manifest)
    archive = HERE / 'cohort-evidence.zip'
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr(zip_info('manifest.json'), manifest_bytes, compresslevel=9)
        for entry in frozen:
            name = entry['path']
            path = files[name[len('artifact/'):]] if name.startswith('artifact/') else EXTRAS[name]
            data = path.read_bytes()
            assert len(data) == entry['size'] and sha(data) == entry['sha256'], 'Input changed: ' + name
            z.writestr(zip_info(name), data, compresslevel=9)
    # Repeat every original member identity, including omitted packages, after packing.
    assert {str(p.relative_to(SOURCE)) for p in SOURCE.rglob('*') if p.is_file()} == set(expected)
    for name, path in files.items():
        assert path.stat().st_size == expected[name]['bytes'] and file_sha(path) == expected[name]['sha256']
    parts = []
    with archive.open('rb') as stream:
        for index, data in enumerate(iter(lambda: stream.read(256 * 1024), b''), 1):
            name = f'cohort-evidence.part-{index:03d}'
            with (HERE / name).open('xb') as target:
                target.write(data)
            git_hash = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
            parts.append({'path': name, 'size': len(data), 'sha256': sha(data), 'gitBlobSha1': git_hash})
    result = {
        'schemaVersion': 1, 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'format': 'Deterministic ZIP split into ordered parts no larger than 256 KiB',
        'archive': {'size': archive.stat().st_size, 'sha256': file_sha(archive), 'manifestSha256': sha(manifest_bytes)},
        'artifactId': CONFIG['artifactId'], 'parts': parts,
        'retainedArtifactFiles': 315, 'retainedArtifactBytes': CONFIG['retainedArtifactBytes'],
        'extraMetadataFiles': len(EXTRAS), 'extraMetadataBytes': sum(p.stat().st_size for p in EXTRAS.values()),
        'omittedPayloadFiles': 2, 'omittedPayloadBytes': CONFIG['omittedPackageBytes'],
        'categories': manifest['categories'],
        'privacyScanSha256': sha((HERE / 'privacy-scan.json').read_bytes()),
        'verifierSha256': sha((HERE / 'verify.py').read_bytes()),
        'builderSha256': sha(Path(__file__).read_bytes()),
        'configurationSha256': sha((HERE / 'cohort.json').read_bytes()),
        'originalsNotDeletedOrModified': True,
    }
    (HERE / 'index.json').write_bytes(encoded(result))
    print(json.dumps({'status': 'packed', 'archive': result['archive'], 'parts': len(parts), 'indexSha256': sha((HERE / 'index.json').read_bytes())}))


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        (HERE / 'packing-failure.json').write_bytes(encoded({'type': type(error).__name__, 'message': str(error)}))
        raise
