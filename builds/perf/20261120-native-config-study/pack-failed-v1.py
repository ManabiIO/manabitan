#!/usr/bin/env python3
"""Exact native-study v1 failure packing recipe; original evidence is read-only."""

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
    ('chromium-forward', 14624378243, 104),
    ('chromium-reverse', 14624951264, 104),
    ('firefox-forward', 14624787018, 104),
    ('firefox-reverse', 14624263633, 104),
]
EXCLUSIONS = [
    'browser-provenance/prior-schema-example/*',
    'browser-provenance/*/evidence/*',
    'browser-provenance/*/original-*.zip',
    '*/__pycache__/*', '*.pyc',
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
    output = root / 'manabitan-native-config-study/builds/perf/20261120-native-config-study'
    extras = output / 'failed-v1-packing-extras'
    extras.mkdir(exist_ok=False)
    archive_path = output / 'failed-v1-evidence.tar.xz'
    packer = root / 'manabitan-validation-study/dev/perf/import-study-evidence.py'
    assert digest(packer) == PACKER_SHA
    assert not archive_path.exists()
    zip_inputs = [(cell, root / f'round4-browser/{cell}/original-{artifact}.zip') for cell, artifact, _ in ZIP_INPUTS]
    directories = [('browser-provenance', root / 'round4-browser'), ('extras', extras)]
    files = [('packing/pack-failed-v1.py', Path(__file__).resolve()), ('packing/import-study-evidence.py', packer)]
    audits = {}
    for cell, _, _ in ZIP_INPUTS:
        candidates = list((root / 'round4-browser' / cell).glob('*audit*.json'))
        assert len(candidates) == 1
        audit = json.loads(candidates[0].read_text())
        assert audit['auditPassed'] and audit['studyComplete'] is False and audit['attemptedObservations'] == 0
        assert audit['harnessInputsVerified'] == 51 and audit['sharedInputsVerified'] == 34 and audit['completedSetupCommands'] == 15
        audits[cell] = {'path': str(candidates[0]), 'sha256': digest(candidates[0]), 'attemptedObservations': 0}
    save_new(extras / 'scope-and-exclusions.json', {
        'scope': 'Native study v1, run44727365554, failed during preparation before any browser import or warmup. This archive is separate from every subsequent versioned attempt.',
        'sourceToolingCommit': '5e2dea241ac11ef7b75c407c2ee1c878e1fd4091',
        'sourceToolingTree': '0918840aa460073311dc15fed9e693e82c4c9546',
        'candidateCommit': '19b13a550d9b7f2a53f37d74aa36b2ee9c3e7472',
        'failure': 'The frozen packagePaths list omitted the normally packaged C source; the preparation guard rejected the C+WASM delta. All15 setup commands succeeded in each cell; no imports began.',
        'audits': audits,
        'exclusions': {
            'originalZipContainers': 'All416 original file payloads are included byte-for-byte; outer ZIP hashes and sizes are retained. Original ZIP files remain untouched outside this tarball.',
            'extractedDuplicates': 'Exclude */evidence copies; original ZIP payloads are the authoritative source.',
            'cachesAndPriorExamples': 'Exclude interpreter caches and non-study prior-schema examples.',
            'largeRuntimeArchive': 'Never downloaded locally. The successful hosted reuse/install checks, exact verified runtime.json bytes, source artifact metadata and scope-limited receipts are included.',
            'laterAttempts': 'Versioned v2 source, jobs and observations are not part of this failed v1 evidence set.'
        },
        'runtimeScope': 'The hosted reuse job checked the exact prior runtime receipt hash and immutable source artifact metadata. All Firefox install steps succeeded. Preparation stopped before runtime/source-artifact copies were placed in result archives; no executed browser import path or persistence proof is claimed.',
    })
    scan = scan_credentials(zip_inputs, directories, files)
    save_new(extras / 'credential-scan.json', scan)
    assert not scan['confirmedPrivateCredentialFindings']
    input_paths = sorted({p for _, p in selected_files(directories, files)} | {p for _, p in zip_inputs})
    before = {str(p): {'bytes': p.stat().st_size, 'sha256': digest(p)} for p in input_paths}
    command = [sys.executable, str(packer), 'pack', '--output', str(archive_path)]
    for option, values in [('--zip', zip_inputs), ('--directory', directories), ('--file', files)]:
        for name, path in values:
            command.extend([option, name + '=' + str(path)])
    for pattern in EXCLUSIONS:
        command.extend(['--exclude', pattern])
    started = datetime.datetime.now(datetime.UTC).isoformat()
    packed = subprocess.run(command, capture_output=True, text=True)
    (output / 'failed-v1-packing.log').write_text(packed.stdout + packed.stderr)
    packed.check_returncode()
    verify_command = [sys.executable, str(packer), 'verify', str(archive_path)]
    verified = subprocess.run(verify_command, capture_output=True, text=True)
    (output / 'failed-v1-verification.log').write_text(verified.stdout + verified.stderr)
    verified.check_returncode()
    after = {str(p): {'bytes': p.stat().st_size, 'sha256': digest(p)} for p in input_paths}
    assert before == after
    with tarfile.open(archive_path, 'r:xz') as archive:
        index = json.load(archive.extractfile('evidence-index.json'))
    coverage = []
    for (prefix, path), (_, artifact_id, expected_count) in zip(zip_inputs, ZIP_INPUTS):
        names = set()
        with zipfile.ZipFile(path) as original:
            for entry in original.infolist():
                if entry.is_dir():
                    continue
                name = prefix + '/' + entry.filename
                assert name not in names
                names.add(name)
                data = original.read(entry)
                expected = index['files'][name]
                assert expected['bytes'] == len(data) and expected['sha256'] == hashlib.sha256(data).hexdigest()
                assert expected['source'] == {'zip': prefix, 'entry': entry.filename, 'crc32': entry.CRC}
        represented = {name for name, item in index['files'].items() if item['source'].get('zip') == prefix}
        assert represented == names and len(names) == expected_count
        coverage.append({'cell': prefix, 'artifactId': artifact_id, 'originalZipBytes': path.stat().st_size, 'originalZipSha256': digest(path), 'expectedFilePayloads': expected_count, 'matchingPackedPayloads': len(names), 'missing': [], 'extra': [], 'changed': []})
    assert sum(item['matchingPackedPayloads'] for item in coverage) == 416
    archive_receipt = json.loads(archive_path.with_name(archive_path.name + '.json').read_text())
    coverage_path = output / 'failed-v1-artifact-coverage.json'
    save_new(coverage_path, {'archive': archive_path.name, 'archiveSha256': archive_receipt['archiveSha256'], 'allPackedPayloadHashesVerified': True, 'originalZipPayloads': 416, 'matchingPackedOriginalZipPayloads': 416, 'attemptedImports': 0, 'cells': coverage})
    receipt_path = output / 'failed-v1-packing-receipt.json'
    save_new(receipt_path, {'startedAt': started, 'completedAt': datetime.datetime.now(datetime.UTC).isoformat(), 'recipeSha256': digest(Path(__file__)), 'packerSha256': PACKER_SHA, 'packCommand': command, 'packExitCode': packed.returncode, 'verifyCommand': verify_command, 'verifyExitCode': verified.returncode, 'inputIdentitiesBefore': before, 'allInputIdentitiesUnchangedAfter': True, 'archiveReceipt': archive_receipt, 'coverageSha256': digest(coverage_path), 'credentialScanSha256': digest(extras / 'credential-scan.json')})
    print(json.dumps({'ok': True, 'archive': archive_receipt, 'coverageSha256': digest(coverage_path), 'recipeSha256': digest(Path(__file__)), 'packingReceiptSha256': digest(receipt_path)}, indent=2))


if __name__ == '__main__':
    main()
