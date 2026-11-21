#!/usr/bin/env python3
"""Exact PR770 evidence packing recipe; original evidence is read-only."""

import argparse
import collections
import datetime
import fnmatch
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import urllib.parse
import zipfile


PACKER_SHA = 'a71f64e2bd74e5e69737878f619159dd7d6a3059059ab3180d41e4de94c453a6'
ZIP_INPUTS = [
    ('chromium-forward', 14622422675, 724),
    ('chromium-reverse', 14622128790, 724),
    ('firefox-forward', 14624055431, 620),
    ('firefox-reverse', 14622739067, 620),
]
EXCLUSIONS = [
    'browser-provenance/prior-schema-example/*',
    'browser-provenance/*/evidence/*',
    'browser-provenance/*/original-*.zip',
    '*/__pycache__/*', '*.pyc',
    'checksum/real-fixture/store.bin',
]
QUERY = re.compile(r'(?i)[?&](?:sig|signature|x-amz-signature|x-amz-credential|x-goog-signature|token|access_token|auth|jwt)=([^\s\"\'<>]+)')
AUTH = re.compile(r'(?i)(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic)\s+(?!\*\*\*)[A-Za-z0-9_+/.=-]{12,}')
PAT = re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b')
SECRET_FIELD = re.compile(r'(?i)\"(download_url|downloadUrl|access_token|refresh_token|private_key)\"\s*:\s*\"(?!\*\*\*)([^\"]+)\"')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def save_new(path, value):
    with path.open('x') as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n')


def selected_files(directories, files):
    for prefix, directory in directories:
        for item in sorted(directory.rglob('*')):
            name = prefix + '/' + item.relative_to(directory).as_posix()
            if any(fnmatch.fnmatchcase(name, pattern) for pattern in EXCLUSIONS):
                continue
            assert not item.is_symlink(), f'Unexpected symlink: {item}'
            if item.is_file():
                yield name, item
    yield from files


def scan_credentials(zip_inputs, directories, files):
    findings = []
    classifications = collections.Counter()
    counts = collections.Counter()

    def inspect(name, data):
        counts['payloads'] += 1
        try:
            text = data.decode()
        except UnicodeDecodeError:
            counts['binaryPayloads'] += 1
            return
        counts['textPayloads'] += 1
        for kind, pattern in [('signed-query', QUERY), ('authorization-header', AUTH), ('github-token', PAT), ('secret-json-value', SECRET_FIELD)]:
            for match in pattern.finditer(text):
                line = text.count('\n', 0, match.start()) + 1
                if kind == 'signed-query' and name.endswith('/tooling/test/e2e/request-builder-rule-matching.js') and match.group(1) in ('CaseSensitive', 'casesensitive'):
                    assert 'https://example.com/' in text.splitlines()[line - 1]
                    classifications['frozen URL-matching test literals on example.com'] += 1
                    continue
                if kind == 'secret-json-value' and match.group(1) in ('download_url', 'downloadUrl'):
                    value = match.group(2)
                    parsed = urllib.parse.urlsplit(value)
                    if parsed.scheme == 'https' and parsed.netloc == 'github.com' and not parsed.query and hashlib.sha256(value.encode()).hexdigest() == '4e9f086d0f7e32ad18664ce11808debc5e772ade3cc3afbfbe83f20cf2c03350':
                        classifications['pinned public dictionary release URL without credentials or query'] += 1
                        continue
                findings.append({'path': name, 'kind': kind, 'line': line})

    for prefix, path in zip_inputs:
        with zipfile.ZipFile(path) as archive:
            for entry in archive.infolist():
                if not entry.is_dir():
                    inspect(prefix + '/' + entry.filename, archive.read(entry))
    for name, path in selected_files(directories, files):
        inspect(name, path.read_bytes())
    return {'scope': 'Credential-pattern review of all selected original ZIP payloads and supplemental files available before this generated receipt. Signed query parameters, transfer/token JSON fields, authorization values and GitHub token shapes are checked. Matched values are never echoed.', 'counts': dict(counts), 'reviewedNonSecretMatches': dict(classifications), 'confirmedPrivateCredentialFindings': findings, 'redactionsApplied': [], 'allOriginalEvidencePreservedUnchanged': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, default=Path('/workspace/scratch/f34c9c9fae89'))
    args = parser.parse_args()
    root = args.workspace.resolve()
    repo = root / 'manabitan-validation-study'
    output = repo / 'builds/perf/20261120-validation-study'
    extras = output / 'packing-extras'
    archive_path = output / 'validation-evidence.tar.xz'
    packer = repo / 'dev/perf/import-study-evidence.py'
    assert digest(packer) == PACKER_SHA, 'Evidence utility must remain unchanged from cf7efa'
    assert not archive_path.exists() and not (output / 'artifact-coverage.json').exists()
    zip_inputs = [(cell, root / f'round3-browser/{cell}/original-{artifact}.zip') for cell, artifact, _ in ZIP_INPUTS]
    directories = [
        ('browser-provenance', root / 'round3-browser'),
        ('validation', root / 'manabitan-validation/builds/perf/20261120-validation'),
        ('checksum', root / 'manabitan-hash-pair/builds/perf/20261120-hash-pair'),
        ('checksum-reproduction', root / 'manabitan-hash-pair/builds/perf/20261120-hash-reproduction'),
        ('canonical-diagnostic', root / 'manabitan-canonical-diagnostic/builds/perf/20261120-canonical-diagnostic'),
        ('study-tooling', repo / 'builds/perf/20261120-study-tooling'),
        ('extras', extras),
    ]
    files = [
        ('packing/pack-evidence.py', Path(__file__).resolve()),
        ('analysis/all-browser-analysis.json', output / 'all-browser-analysis.json'),
        ('analysis/analysis.log', output / 'analysis.log'),
        ('analysis/report-assembly-attempts.json', output / 'report-assembly-attempts.json'),
        ('local-toolchain/llvm21-packages.json', root / 'toolchains/llvm21-packages.json'),
        ('local-toolchain/llvm21-Packages.txt', root / 'toolchains/llvm21-Packages.txt'),
        ('local-toolchain/llvm21-env.sh', root / 'toolchains/llvm21-env.sh'),
        ('setup/npm-ci.log', root / 'npm-ci.log'),
        ('setup/build-libs.log', root / 'build-libs.log'),
    ]
    credential_scan = scan_credentials(zip_inputs, directories, files)
    save_new(extras / 'credential-scan.json', credential_scan)
    assert not credential_scan['confirmedPrivateCredentialFindings'], 'Private credential candidates require explicit review before packing'
    input_paths = sorted({path for _, path in selected_files(directories, files)} | {path for _, path in zip_inputs})
    before = {str(path): {'bytes': path.stat().st_size, 'sha256': digest(path)} for path in input_paths}
    command = [sys.executable, str(packer), 'pack', '--output', str(archive_path)]
    for option, values in [('--zip', zip_inputs), ('--directory', directories), ('--file', files)]:
        for name, path in values:
            command.extend([option, name + '=' + str(path)])
    for pattern in EXCLUSIONS:
        command.extend(['--exclude', pattern])
    started = datetime.datetime.now(datetime.UTC).isoformat()
    result = subprocess.run(command, capture_output=True, text=True)
    (output / 'packing.log').write_text(result.stdout + result.stderr)
    result.check_returncode()
    verify_command = [sys.executable, str(packer), 'verify', str(archive_path)]
    verified = subprocess.run(verify_command, capture_output=True, text=True)
    (output / 'verification.log').write_text(verified.stdout + verified.stderr)
    verified.check_returncode()
    after = {str(path): {'bytes': path.stat().st_size, 'sha256': digest(path)} for path in input_paths}
    assert after == before, 'An evidence input changed during packing or verification'
    with tarfile.open(archive_path, 'r:xz') as packed:
        index = json.load(packed.extractfile('evidence-index.json'))
    coverage = []
    for (prefix, path), (_, artifact_id, expected_count) in zip(zip_inputs, ZIP_INPUTS):
        matched = 0
        source_names = set()
        with zipfile.ZipFile(path) as original:
            for entry in original.infolist():
                if entry.is_dir():
                    continue
                name = prefix + '/' + entry.filename
                assert name not in source_names
                source_names.add(name)
                data = original.read(entry)
                expected = index['files'][name]
                assert expected['bytes'] == len(data) and expected['sha256'] == hashlib.sha256(data).hexdigest()
                assert expected['source'] == {'zip': prefix, 'entry': entry.filename, 'crc32': entry.CRC}
                matched += 1
        represented = {name for name, item in index['files'].items() if item['source'].get('zip') == prefix}
        assert represented == source_names and matched == expected_count
        coverage.append({'cell': prefix, 'artifactId': artifact_id, 'originalZipSha256': digest(path), 'originalZipBytes': path.stat().st_size, 'originalFilePayloads': expected_count, 'matchingPackedPayloads': matched, 'missing': [], 'extra': [], 'changed': []})
    assert sum(item['matchingPackedPayloads'] for item in coverage) == 2688
    archive_receipt = json.loads(archive_path.with_name(archive_path.name + '.json').read_text())
    coverage_receipt = {'schemaVersion': 1, 'archive': archive_path.name, 'archiveSha256': archive_receipt['archiveSha256'], 'allPackedPayloadHashesVerified': True, 'originalZipPayloads': 2688, 'matchedOriginalZipPayloads': 2688, 'cells': coverage, 'limitations': 'Complete original file payloads are preserved; original ZIP container metadata is represented by its hash and size and is not reconstructed.'}
    save_new(output / 'artifact-coverage.json', coverage_receipt)
    receipt = {'startedAt': started, 'completedAt': datetime.datetime.now(datetime.UTC).isoformat(), 'recipeSha256': digest(Path(__file__)), 'packerSha256': PACKER_SHA, 'packCommand': command, 'packExitCode': result.returncode, 'verifyCommand': verify_command, 'verifyExitCode': verified.returncode, 'inputIdentitiesBefore': before, 'allInputIdentitiesUnchangedAfter': True, 'archiveReceipt': archive_receipt, 'coverageSha256': digest(output / 'artifact-coverage.json'), 'credentialScanSha256': digest(extras / 'credential-scan.json'), 'exclusionRationaleSha256': digest(extras / 'exclusions-and-regeneration.json')}
    save_new(output / 'packing-receipt.json', receipt)
    print(json.dumps({'ok': True, 'archive': archive_receipt, 'coverageSha256': receipt['coverageSha256'], 'recipeSha256': receipt['recipeSha256'], 'packingReceiptSha256': digest(output / 'packing-receipt.json')}, indent=2))


if __name__ == '__main__':
    main()
