#!/usr/bin/env python3
"""Create the immutable, content-addressed saved-evidence bundle; no native execution."""
from pathlib import Path
import datetime
import gzip
import hashlib
import io
import json
import re
import zipfile

SOURCE = Path('/workspace/scratch/7c02210aa375/import-experiments-7c02/zstd-sequence64')
OUTPUT = Path(__file__).resolve().parent


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def git_blob(raw):
    return hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()


selected, omitted, aliases = {}, {}, {}
directories = ['capacity-census-prototype', 'capacity-census-result', 'design-b-prototype',
    'design-b-result', 'design-b-timing-prototype', 'design-b-codegen', 'design-b-study',
    'production-workload-audit', 'repack-1m-prototype', 'production-corpus-prototype']
excluded = {
    'capacity-census-result/inputs/zstd-baseline-census.c': 'Full generated amalgamation; hash retained in build manifest',
    'design-b-result/inputs/zstd-A.c': 'Full generated baseline amalgamation; hash retained in build manifest',
    'design-b-result/inputs/zstd-B.c': 'Full generated candidate amalgamation; hash retained in build manifest',
    'design-b-result/inputs/jmdict.zdict': 'Pinned repository dictionary payload; all source/size/hash identities retained',
    'design-b-codegen/P.wat.gz': 'Full-module disassembly; exact identity and changed function/loop WAT retained',
    'design-b-codegen/B1.wat.gz': 'Full-module disassembly; exact identity and changed function/loop WAT retained',
}
for directory in directories:
    for path in sorted((SOURCE / directory).rglob('*')):
        name = path.relative_to(SOURCE).as_posix()
        if path.is_symlink():
            aliases[name] = str(path.readlink())
        if not path.is_file():
            continue
        if name in excluded:
            omitted[name] = (path, excluded[name])
        else:
            selected[name] = path
top_files = ['capacity-dispatch-contract.md', 'design-b-code-and-suite-assessment.json',
    'design-b-prebuild-cleanup.json', 'capacity-census-acquisition.log', 'capacity-census-freeze.json',
    'capacity-census-invocation.json', 'design-b-acquisition.log', 'design-b-invocation.json',
    'design-b-execution-preparation-note.json', 'design-b-execution-freeze.json',
    'design-b-component-screen.json', 'design-b-component-screen.log', 'design-b-component-termination.json',
    'design-b-integration-plan-v1.md', 'design-b-integration-plan.md']
for name in top_files:
    selected[name] = SOURCE / name
# Retain exact per-group/corpus receipts, while omitting payloads and entry-length data.
for path in sorted((SOURCE / 'canonical-jmdict-1m').iterdir()):
    if not path.is_file():
        continue
    name = path.relative_to(SOURCE).as_posix()
    if path.suffix in ['.json', '.log']:
        selected[name] = path
    else:
        omitted[name] = (path, 'Canonical payload or per-entry data; exact reconstruction and identities retained')
for path in sorted((SOURCE / 'design-b-result/corpus-jmdict').iterdir()):
    if path.is_file() and path.suffix in ['.json', '.log']:
        selected['design-b-result/corpus-jmdict/' + path.name] = path
for label in ['A', 'B', 'C']:
    for path in sorted((SOURCE / 'design-b-result/arms' / label).iterdir()):
        if path.is_file():
            selected['design-b-result/arms/' + label + '/' + path.name] = path
for name in ['full-sdk-download.json', 'full-sdk-extraction.json', 'full-sdk-file-hashes.json',
             'sdk-python-cache-diagnostic.json', 'acquisition-receipt.json']:
    selected['toolchain-metadata/' + name] = SOURCE / 'toolchain-metadata' / name
for name in ['verify.py', 'README.md', 'RESULT.md', 'build-archive.py', 'investigation-ledger-snapshot.json']:
    selected[name] = OUTPUT / name
assert sha(selected['investigation-ledger-snapshot.json'].read_bytes()) == 'a97cdcc29a6ab0b724b79f08d1c8c5dab96196166b9c61a3c194dd1fe878dafd'

# Scan retained textual payloads, including any gzip text, before creating an archive.
# Matched values are never printed or stored; only logical paths are reported.
credential_patterns = [
    re.compile(rb'\bgh[pousr]_[A-Za-z0-9]{20,}\b'),
    re.compile(rb'\bgithub_pat_[A-Za-z0-9_]{20,}\b'),
    re.compile(rb'\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b'),
    re.compile(rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'),
    re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    re.compile(rb'Authorization[\s\"\x27:=]+Bearer[ \t]+[A-Za-z0-9_.+/=-]{16,}', re.I),
    re.compile(rb'[?&](?:amp;)?(?:sig|signature|X-Amz-Signature|X-Amz-Credential|X-Goog-Signature|access_token|token)=[A-Za-z0-9%+/=_-]{8,}', re.I),
]
scan_files, matched_paths = {}, []
for name, path in sorted(selected.items()):
    raw = path.read_bytes()
    if raw.startswith(b'\0asm'):
        kind, text = 'wasm-binary-identity-only', None
    elif raw.startswith(b'\x1f\x8b'):
        kind, text = 'decompressed-gzip-text', gzip.decompress(raw)
    else:
        kind, text = 'text', raw
    if text is not None and any(pattern.search(text) for pattern in credential_patterns):
        matched_paths.append(name)
    scan_files[name] = {'bytes': len(raw), 'sha256': sha(raw), 'kind': kind}
scan = {'status': 'passed' if not matched_paths else 'requires-review', 'matchedPaths': matched_paths,
    'scope': 'Obvious token/private-key/Bearer/signed-query patterns in all retained text/log payloads; gzip text decompressed. Not a general secret-detection guarantee.',
    'patternCount': len(credential_patterns), 'files': scan_files}
with (OUTPUT / 'privacy-scan.json').open('x') as stream:
    stream.write(json.dumps(scan, indent=2) + '\n')
if matched_paths:
    print(json.dumps({'credentialPatternMatchedPaths': matched_paths}))
    raise SystemExit('Archive not created: retained text requires review')
selected['privacy-scan.json'] = OUTPUT / 'privacy-scan.json'

files, blobs = {}, {}
for name, path in sorted(selected.items()):
    raw = path.read_bytes()
    digest = sha(raw)
    files[name] = {'bytes': len(raw), 'sha256': digest}
    blobs.setdefault(digest, raw)
omitted_files = {}
for name, (path, reason) in sorted(omitted.items()):
    raw = path.read_bytes()
    omitted_files[name] = {'bytes': len(raw), 'sha256': sha(raw), 'reason': reason}
policy = {
    'canonicalPayloads': 'Full canonical content/dictionary and per-entry data omitted; immutable block/group/record identities and reconstruction sources retained.',
    'sdkAndPackages': 'SDK/package binaries and generated cache bytes omitted; full SDK file inventory, official acquisition identities and cache diagnostics retained.',
    'largeDerivedFiles': 'Full generated amalgamations and full-module WAT omitted; their exact hashes and compiled WASM plus changed function/loop WAT retained.',
    'priorStudy': 'Earlier checked64 setup failures and its completed negative timing cohort remain in their separate published record; this archive preserves the new study and its explicitly reused baseline receipts.'}
manifest = {'schemaVersion': 1, 'study': 'Separate Design B/capacity-census saved evidence; performance unqualified',
    'fileCount': len(files), 'files': files, 'omittedFiles': omitted_files, 'omissionPolicy': policy,
    'historicalSymlinks': aliases, 'restoration': 'Selected aliases restore as regular files; omitted payloads are not restored',
    'ledgerSnapshot': {'sha256': files['investigation-ledger-snapshot.json']['sha256'],
        'suppliedAtUtc': '2026-11-28T07:19:07Z', 'browserQueueLastObservedAtUtc': '2026-11-28T07:13:09Z'}}
manifest_raw = (json.dumps(manifest, indent=2, sort_keys=True) + '\n').encode()
archive_buffer = io.BytesIO()
with zipfile.ZipFile(archive_buffer, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for name, raw in [('manifest.json', manifest_raw)] + [('blobs/' + key, value) for key, value in sorted(blobs.items())]:
        entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
        entry.compress_type = zipfile.ZIP_DEFLATED
        entry.external_attr = 0o100644 << 16
        archive.writestr(entry, raw, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
archive_raw = archive_buffer.getvalue()
# Re-read every selected original after packing; archive only a stable snapshot.
for name, path in selected.items():
    raw = path.read_bytes()
    assert len(raw) == files[name]['bytes'] and sha(raw) == files[name]['sha256'], name
for name, (path, _) in omitted.items():
    assert sha(path.read_bytes()) == omitted_files[name]['sha256'], name
parts = []
for number, offset in enumerate(range(0, len(archive_raw), 256 * 1024), 1):
    raw = archive_raw[offset:offset + 256 * 1024]
    name = f'sequence64-design-b.part-{number:03d}'
    with (OUTPUT / name).open('xb') as stream:
        stream.write(raw)
    parts.append({'name': name, 'bytes': len(raw), 'sha256': sha(raw), 'gitBlobSha1': git_blob(raw)})
index = {'schemaVersion': 1, 'archiveName': 'sequence64-design-b.zip', 'archiveBytes': len(archive_raw),
    'archiveSha256': sha(archive_raw), 'manifestSha256': sha(manifest_raw),
    'fileCount': len(files), 'uniqueBlobCount': len(blobs), 'rawBytes': sum(x['bytes'] for x in files.values()),
    'uniqueRawBytes': sum(len(x) for x in blobs.values()), 'files': files, 'parts': parts,
    'omittedFiles': omitted_files, 'omissions': policy,
    'createdAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'ledgerSnapshot': manifest['ledgerSnapshot'],
    'sourceResultSha256': files['design-b-component-screen.json']['sha256'],
    'sourceFreezeSha256': files['design-b-execution-freeze.json']['sha256'],
    'qualifiedArtifactManifestSha256': files['design-b-result/manifest.json']['sha256']}
with (OUTPUT / 'index.json').open('x') as stream:
    stream.write(json.dumps(index, indent=2) + '\n')
print(json.dumps({key: index[key] for key in ['archiveBytes', 'archiveSha256', 'manifestSha256', 'fileCount', 'uniqueBlobCount', 'rawBytes', 'uniqueRawBytes']} | {'parts': len(parts), 'omittedFiles': len(omitted_files)}, indent=2))
