#!/usr/bin/env python3
"""Compare unpacked bytes from four already-built Chrome packages."""

from pathlib import Path
import hashlib
import json
import subprocess
import sys
import tempfile
import zipfile

arguments = sys.argv[1:]
remove_generated = '--remove-generated-zips' in arguments
arguments = [value for value in arguments if value != '--remove-generated-zips']
root = Path(arguments[0]).resolve() if arguments else Path(__file__).resolve().parents[2]
stage = root / 'evidence-staging/package'
names = ['manabitan-base', 'jmdict', 'jitendex', 'vndb']
base_commit = '7d1643e6147a10cb2165e9744cf0e63b59e46632'
snapshots = Path(tempfile.mkdtemp(prefix='manabitan-package-audit-')) if remove_generated else None


def digest_stream(stream):
    digest = hashlib.sha256()
    for block in iter(lambda: stream.read(65536), b''):
        digest.update(block)
    return digest.hexdigest()


def digest_file(path):
    with path.open('rb') as stream:
        return digest_stream(stream)


packages = {}
for name in names:
    receipt = json.loads((stage / f'{name}-build.json').read_text())
    if receipt['exitCode'] != 0 or receipt['status'] != 'success':
        raise RuntimeError(f'No successful build receipt for {name}')
    repo = root / name
    archive = repo / 'builds/manabitan-chrome.zip'
    entries = {}
    with zipfile.ZipFile(archive) as package:
        for info in package.infolist():
            if info.filename in entries:
                raise RuntimeError(f'Duplicate package entry: {info.filename}')
            with package.open(info) as stream:
                digest = digest_stream(stream)
            entries[info.filename] = {
                'sha256': digest,
                'bytes': info.file_size,
                'compressedBytes': info.compress_size,
                'directory': info.is_dir(),
            }
        version = json.loads(package.read('manifest.json'))['version']
    archive_sha256 = digest_file(archive)
    archive_bytes = archive.stat().st_size
    if snapshots is not None:
        snapshot = {'archiveSha256': archive_sha256, 'packageBytes': archive_bytes, 'entries': entries}
        (snapshots / f'{name}.json').write_text(json.dumps(snapshot, separators=(',', ':')) + '\n')
        archive.unlink()
    manifest_path = stage / f'{name}-entries.json'
    manifest_path.write_text(json.dumps(entries, sort_keys=True, separators=(',', ':')) + '\n')
    packages[name] = {
        'head': receipt['head'],
        'command': receipt['command'],
        'exitCode': receipt['exitCode'],
        'trackedStatusBefore': receipt['trackedStatusBefore'],
        'trackedStatusAfter': receipt['trackedStatusAfter'],
        'archive': str(archive),
        'archiveSha256': archive_sha256,
        'packageBytes': archive_bytes,
        'generatedArchiveRemovedAfterHashing': remove_generated,
        'entryCount': len(entries),
        'fileCount': sum(not value['directory'] for value in entries.values()),
        'uncompressedBytes': sum(value['bytes'] for value in entries.values()),
        'manifestVersion': version,
        'entriesManifest': manifest_path.name,
        'entriesManifestSha256': digest_file(manifest_path),
        'packageLockSha256': digest_file(repo / 'package-lock.json'),
        'wasm': {key: value for key, value in entries.items() if key.endswith('.wasm')},
        'entries': entries,
    }

baseline = packages['manabitan-base']
comparisons = {}
for name in names[1:]:
    candidate = packages[name]
    before = baseline['entries']
    after = candidate['entries']
    added = sorted(after.keys() - before.keys())
    removed = sorted(before.keys() - after.keys())
    changed = sorted(key for key in before.keys() & after.keys() if before[key]['sha256'] != after[key]['sha256'])
    changed_js = [key for key in changed if key.endswith(('.js', '.mjs'))]
    js_before = sum(before[key]['bytes'] for key in changed_js)
    js_after = sum(after[key]['bytes'] for key in changed_js)
    expected = subprocess.check_output(
        ['git', '-C', str(root / name), 'diff', '--name-only', base_commit, candidate['head'], '--', 'ext'], text=True,
    ).splitlines()
    expected = sorted(path.removeprefix('ext/') for path in expected)
    actual = set(added + removed + changed)
    comparisons[name] = {
        'packageByteDelta': candidate['packageBytes'] - baseline['packageBytes'],
        'uncompressedByteDelta': candidate['uncompressedBytes'] - baseline['uncompressedBytes'],
        'addedEntries': added,
        'removedEntries': removed,
        'changedEntries': {key: {'baseline': before[key], 'candidate': after[key]} for key in changed},
        'unchangedEntryCount': len(before.keys() & after.keys()) - len(changed),
        'expectedRuntimeChanges': expected,
        'unexpectedChangedEntries': sorted(actual - set(expected)),
        'expectedButUnchangedEntries': sorted(set(expected) - actual),
        'changedJavaScriptUncompressedBytes': {'baseline': js_before, 'candidate': js_after, 'delta': js_after - js_before},
        'wasmNamesIdentical': candidate['wasm'].keys() == baseline['wasm'].keys(),
        'allWasmHashesMatch': {key: value['sha256'] for key, value in candidate['wasm'].items()} == {key: value['sha256'] for key, value in baseline['wasm'].items()},
    }

for package in packages.values():
    del package['entries']
report = {
    'scope': 'Four sequential npm Chrome package builds and complete decompressed-entry SHA256 comparison; no import or timing measurement.',
    'baselineCommit': base_commit,
    'node': subprocess.check_output(['node', '--version'], text=True).strip(),
    'npm': subprocess.check_output(['npm', '--version'], text=True).strip(),
    'packages': packages,
    'comparisons': comparisons,
    'recoverySnapshotDirectory': str(snapshots) if snapshots is not None else None,
    'notes': [
        'npm run build invokes buildLibs internally; no separate duplicate library build was run.',
        'Packages use the requested chrome target and default manifest version 0.0.0.0.',
        'ZIP container hashes may differ due to entry metadata; content parity is determined by complete per-entry decompressed SHA256 hashes.',
        'Archive reads verify ZIP CRCs. No source was edited by this audit; tracked status before and after each build is retained.',
        *(['This comparison preserved complete hash/size snapshots in /tmp, then removed only the four newly built ZIPs after hashing.'] if remove_generated else []),
    ],
}
(stage / 'package-audit.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({name: {'packageBytes': item['packageBytes'], 'files': item['fileCount'], 'wasmCount': len(item['wasm'])} for name, item in packages.items()}))
print(json.dumps(comparisons))
