#!/usr/bin/env python3
"""Preserve final native-v2 evidence after all four audited cells and analysis finish."""

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


PACKER_SHA256 = 'a71f64e2bd74e5e69737878f619159dd7d6a3059059ab3180d41e4de94c453a6'
TOOLING_COMMIT = '72b8ab5471fc68e369a54d884efbbea933699d7c'
TOOLING_TREE = 'e50ac7c7f7cf892a0e8dc666f5176f97e8800455'
MANIFEST_SHA256 = '66062489217d31a117ee7892c4f51190ccb51b837886f2c1cdaef857e6b2afa7'
RUN_ID = 44729808376
CELLS = ('chromium-forward', 'chromium-reverse', 'firefox-forward', 'firefox-reverse')
COMPARISONS = {'C/A', 'D/B', 'B/A', 'D/A'}
FIXED_INPUTS = {
    'manabitan-canonical-config/builds/perf/20261120-canonical-config/native-evidence-receipt.json': '4078175886a361a1cc09043d26e8372ea910b302959c18bcb7651e95aa803852',
    'manabitan-canonical-config/builds/perf/20261120-canonical-config-packaging-erratum/packaging-erratum.json': 'b83dfa7e2fad86f8b9413f8a2a20426025998f720e0f11b3dcf871628c931eff',
    'manabitan-canonical-config/builds/perf/20261120-canonical-config-packaging-erratum/v2-sealed-review.json': '2761f2a37dcc3170414b188bd61c14f665adf0a6422536e348c90986a7ede1dc',
    'manabitan-canonical-config/builds/perf/20261120-compression-audit/compression-audit-receipt.json': '4cc154c39c18683d32dfb66e25d1e48457ab7eca60a7326b688cafd2b7b04c5b',
    'manabitan-canonical-config/builds/perf/20261120-compression-source-snapshot/source-snapshot-receipt.json': 'fc595bcbd80e3e44aaffaacde04a085efdf364b7e4702d29ffd676b128af51f5',
    'manabitan-canonical-config/builds/perf/20261120-compression-source-snapshot/posthoc-reproduction.json': '216fef44694c930a14c96db5be45bb2fcf4f487a25b0069fbfb4ecaeb9bfb3f9',
    'manabitan-native-config-study/builds/perf/20261120-native-study-v2-tooling/freeze.json': 'ec58935f2825fb0148e200ed3f8ced3c709262a86788aed54de2046763d5b278',
    'manabitan-native-config-study/builds/perf/20261120-native-study-v2-tooling/measured-source-ci.json': '0cf02e240a07e86a6ac327509388f54f81714527d1aaee06ef854e5ca8f268e2',
    'manabitan-native-config-study/builds/perf/20261120-native-config-study/failed-v1-evidence.tar.xz.json': 'de5f2c5bba5307aff2989e2a7118fd5dfeb54152ad3dce42df53758350a78bfb',
}
EXCLUSIONS = [
    'browser-provenance/*/evidence/*',
    'browser-provenance/*/original-*.zip',
    '*/__pycache__/*',
    '*.pyc',
]
QUERY = re.compile(r'(?i)[?&](?:sig|signature|x-amz-signature|x-amz-credential|x-goog-signature|token|access_token|auth|jwt)=([^\s"\'<>]+)')
AUTH = re.compile(r'(?i)(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic)\s+(?!\*\*\*)[A-Za-z0-9_+/.=-]{12,}')
PAT = re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b')
SECRET_FIELD = re.compile(r'(?i)"(download_url|downloadUrl|access_token|refresh_token|private_key)"\s*:\s*"(?!\*\*\*)([^"]+)"')


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def read_json(path):
    return json.loads(path.read_text())


def save_new(path, value):
    with path.open('x') as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n')


def input_plan(root):
    repo = root / 'manabitan-native-config-study'
    output = repo / 'builds/perf/20261120-native-config-study-v2'
    native = root / 'manabitan-canonical-config/builds/perf'
    prior = repo / 'builds/perf/20261120-native-config-study'
    directories = [
        ('browser-provenance', root / 'round5-browser'),
        ('native-component-validation', native / '20261120-canonical-config'),
        ('packaging-erratum-and-reviews', native / '20261120-canonical-config-packaging-erratum'),
        ('study-tooling-v2', repo / 'builds/perf/20261120-native-study-v2-tooling'),
        ('compression-audit', native / '20261120-compression-audit'),
        ('compression-source-snapshot', native / '20261120-compression-source-snapshot'),
        ('extras', output / 'packing-extras'),
    ]
    files = [
        ('packing/pack-evidence.py', Path(__file__).resolve()),
        ('packing/import-study-evidence.py', repo / 'dev/perf/import-study-evidence.py'),
        ('packing/packing-plan.md', output / 'packing-plan.md'),
        ('analysis/all-browser-analysis.json', output / 'all-browser-analysis.json'),
        ('analysis/analysis.log', output / 'analysis.log'),
        ('analysis/report-assembly-attempts.json', output / 'report-assembly-attempts.json'),
        ('local-toolchain/llvm21-packages.json', root / 'toolchains/llvm21-packages.json'),
        ('local-toolchain/llvm21-Packages.txt', root / 'toolchains/llvm21-Packages.txt'),
        ('local-toolchain/llvm21-env.sh', root / 'toolchains/llvm21-env.sh'),
        ('local-toolchain/actionlint.json', repo / 'builds/perf/20261120-native-study-tooling/actionlint.json'),
        ('setup/npm-ci.log', root / 'npm-ci.log'),
        ('setup/build-libs.log', root / 'build-libs.log'),
        ('prior-v1/failed-v1-evidence.tar.xz.json', prior / 'failed-v1-evidence.tar.xz.json'),
        ('prior-v1/failed-v1-artifact-coverage.json', prior / 'failed-v1-artifact-coverage.json'),
        ('prior-v1/failed-v1-packing-receipt.json', prior / 'failed-v1-packing-receipt.json'),
    ]
    return repo, output, directories, files


def selected_files(directories, files):
    names = set()
    for prefix, directory in directories:
        check(directory.is_dir() and not directory.is_symlink(), 'Missing ordinary source directory: ' + str(directory))
        for item in sorted(directory.rglob('*')):
            name = prefix + '/' + item.relative_to(directory).as_posix()
            if any(fnmatch.fnmatchcase(name, pattern) for pattern in EXCLUSIONS):
                continue
            check(not item.is_symlink(), 'Unexpected evidence symlink: ' + str(item))
            if item.is_file():
                check(name not in names, 'Duplicate selected path: ' + name)
                names.add(name)
                yield name, item
    for name, item in files:
        check(item.is_file() and not item.is_symlink(), 'Missing ordinary source file: ' + str(item))
        check(name not in names, 'Duplicate selected path: ' + name)
        names.add(name)
        yield name, item


def snapshot_inputs(zip_inputs, directories, files):
    result = {}
    for name, path in list(selected_files(directories, files)) + [('original-zip/' + name, path) for name, path in zip_inputs]:
        check(name not in result, 'Duplicate snapshot name: ' + name)
        result[name] = {'path': str(path), 'bytes': path.stat().st_size, 'sha256': digest(path)}
    return result


def verify_frozen_supplements(root):
    for relative, expected in FIXED_INPUTS.items():
        check(digest(root / relative) == expected, 'Frozen receipt changed: ' + relative)
    prior = root / 'manabitan-native-config-study/builds/perf/20261120-native-config-study/failed-v1-evidence.tar.xz'
    prior_receipt = read_json(prior.with_name(prior.name + '.json'))
    check(prior.stat().st_size == prior_receipt['archiveBytes'] and digest(prior) == prior_receipt['archiveSha256'], 'Separately preserved failed-v1 archive changed')
    native = root / 'manabitan-canonical-config/builds/perf/20261120-canonical-config'
    original = read_json(native / 'native-evidence-receipt.json')
    for entry in original['files']:
        path = native / entry['path']
        check(path.stat().st_size == entry['bytes'] and digest(path) == entry['sha256'], 'Frozen native evidence changed: ' + entry['path'])
    compression = native.parent / '20261120-compression-audit'
    for relative, expected in read_json(compression / 'compression-audit-receipt.json')['files'].items():
        path = compression / relative
        check(path.stat().st_size == expected['bytes'] and digest(path) == expected['sha256'], 'Frozen compression audit changed: ' + relative)
    source_snapshot = native.parent / '20261120-compression-source-snapshot'
    for relative, expected in read_json(source_snapshot / 'source-snapshot-receipt.json')['files'].items():
        path = source_snapshot / relative
        check(path.stat().st_size == expected['bytes'] and digest(path) == expected['sha256'], 'Frozen compression source snapshot changed: ' + relative)


def readiness(root, output):
    analysis = read_json(output / 'all-browser-analysis.json')
    check(len(analysis['cells']) == 4, 'Root analysis must contain all four completed cells')
    analysis_cells = {cell['browser'] + '-' + cell['replication']: cell for cell in analysis['cells']}
    check(set(analysis_cells) == set(CELLS), 'Root analysis cell set differs')
    check((output / 'analysis.log').is_file() and (output / 'report-assembly-attempts.json').is_file(), 'Root analysis log and assembly-attempt receipt are required')
    read_json(output / 'report-assembly-attempts.json')
    check((root / 'round5-browser/chromium-summary.json').is_file() and (root / 'round5-browser/firefox-audits-receipt.json').is_file(), 'Both browser auditors must finish their summary receipts')
    zip_inputs = []
    records = []
    for cell in CELLS:
        directory = root / 'round5-browser' / cell
        download = read_json(directory / 'download.json')
        audit = read_json(directory / 'independent-audit-001.json')
        artifact = download['artifact']
        check(artifact['workflow_run']['id'] == RUN_ID and artifact['workflow_run']['head_sha'] == TOOLING_COMMIT, 'Wrong artifact source: ' + cell)
        check(artifact['name'] == 'jmdict-native-config-study-v2-' + cell, 'Wrong artifact name: ' + cell)
        archive_path = directory / ('original-' + str(artifact['id']) + '.zip')
        check(Path(download['originalZip']).resolve() == archive_path.resolve(), 'Unexpected original ZIP path: ' + cell)
        actual_hash = digest(archive_path)
        check(actual_hash == download['sha256'] and artifact['digest'] == 'sha256:' + actual_hash, 'Original ZIP identity differs: ' + cell)
        check(archive_path.stat().st_size == download['bytes'] == artifact['size_in_bytes'], 'Original ZIP length differs: ' + cell)
        check(download['zipCrc'] == 'passed', 'Acquisition CRC did not pass: ' + cell)
        check(audit['manifestSha256'] == MANIFEST_SHA256 and audit['toolingCommit'] == TOOLING_COMMIT and audit['toolingTree'] == TOOLING_TREE, 'Wrong independently audited source: ' + cell)
        if cell.startswith('chromium-'):
            check(audit['complete'] is True and not audit['failures'], 'Chromium audit is incomplete or failed: ' + cell)
            check(audit['attemptedObservations'] == 104 and audit['measuredObservations'] == 96 and audit['warmups'] == 8, 'Chromium audit counts differ: ' + cell)
            check(audit['archive']['sha256'] == actual_hash, 'Chromium audited another archive: ' + cell)
            expected_files = audit['archive']['filePayloads']
            auditor_hash = audit['auditorSha256']
        else:
            check(download['ok'] is True and audit['ok'] is True and not audit['commandFailures'], 'Firefox audit is incomplete or failed: ' + cell)
            check(audit['observations'] == 104 and audit['measured'] == 96 and audit['warmups'] == 8, 'Firefox audit counts differ: ' + cell)
            check(audit['archiveSha256'] == actual_hash, 'Firefox audited another archive: ' + cell)
            extraction = read_json(directory / 'analysis-extraction-receipt.json')
            check(extraction['ok'] and extraction['archiveSha256'] == actual_hash, 'Firefox analysis copy is not independently verified: ' + cell)
            expected_files = audit['payloadFiles']
            auditor_hash = audit['auditScriptSha256']
        check(digest(directory / 'independent-audit-001.py') == auditor_hash, 'Archived auditor differs: ' + cell)
        check(any(directory.glob('job-*.log')), 'Full job log is missing: ' + cell)
        with zipfile.ZipFile(archive_path) as original:
            names = original.namelist()
            check(len(names) == len(set(names)), 'Duplicate original ZIP member: ' + cell)
            members = [entry for entry in original.infolist() if not entry.is_dir()]
            check(len(members) == download['filePayloads'] == expected_files, 'Original payload count differs: ' + cell)
            cohort_names = [name for name in names if name == 'cohort.json' or name.endswith('/cohort.json')]
            check(len(cohort_names) == 1, 'Expected one original cohort: ' + cell)
            cohort_bytes = original.read(cohort_names[0])
            cohort = json.loads(cohort_bytes)
            check(cohort['complete'] and not cohort['failures'] and len(cohort['observations']) == len(cohort['planned']) == 104, 'Original cohort is not fully complete: ' + cell)
            check(cohort['manifestSha256'] == MANIFEST_SHA256 and set(cohort['statistics']) == COMPARISONS, 'Original cohort protocol differs: ' + cell)
            analyzed = analysis_cells[cell]
            check(analyzed['complete'] and not analyzed['failures'] and analyzed['attemptedObservations'] == analyzed['plannedObservations'] == 104, 'Analysis is incomplete: ' + cell)
            check(analyzed['manifestSha256'] == MANIFEST_SHA256 and analyzed['diagnosticCommit'] == TOOLING_COMMIT, 'Analysis source differs: ' + cell)
            check(analyzed['cohortSha256'] == hashlib.sha256(cohort_bytes).hexdigest() and set(analyzed['comparisons']) == COMPARISONS, 'Analysis is not bound to this original cohort: ' + cell)
        zip_inputs.append((cell, archive_path))
        records.append({'cell': cell, 'artifactId': artifact['id'], 'archiveSha256': actual_hash, 'archiveBytes': archive_path.stat().st_size, 'originalFilePayloads': expected_files, 'downloadReceiptSha256': digest(directory / 'download.json'), 'auditReceiptSha256': digest(directory / 'independent-audit-001.json'), 'cohortSha256': analyzed['cohortSha256']})
    verify_frozen_supplements(root)
    return zip_inputs, records


def scan_credentials(zip_inputs, directories, files):
    findings = []
    classifications = collections.Counter()
    counts = collections.Counter()

    def inspect(name, data):
        counts['payloads'] += 1
        try:
            content = data.decode()
        except UnicodeDecodeError:
            counts['binaryPayloads'] += 1
            return
        counts['textPayloads'] += 1
        for kind, pattern in [('signed-query', QUERY), ('authorization-header', AUTH), ('github-token', PAT), ('secret-json-value', SECRET_FIELD)]:
            for match in pattern.finditer(content):
                line = content.count('\n', 0, match.start()) + 1
                if kind == 'signed-query' and name.endswith('/tooling/test/e2e/request-builder-rule-matching.js') and match.group(1) in ('CaseSensitive', 'casesensitive'):
                    check('https://example.com/' in content.splitlines()[line - 1], 'Unexpected URL test literal')
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
    return {'scope': 'Credential-pattern check of every selected original payload and supplement before generating this receipt. Matched values are never echoed; no evidence is redacted or silently omitted.', 'counts': dict(counts), 'reviewedNonSecretMatches': dict(classifications), 'confirmedPrivateCredentialFindings': findings, 'redactionsApplied': [], 'allOriginalEvidencePreservedUnchanged': True}


def coverage(archive_path, zip_inputs, original_records):
    with tarfile.open(archive_path, 'r:xz') as packed:
        index = json.load(packed.extractfile('evidence-index.json'))
    cells = []
    for (prefix, path), record in zip(zip_inputs, original_records):
        source_names = set()
        matched = 0
        with zipfile.ZipFile(path) as original:
            for entry in original.infolist():
                if entry.is_dir():
                    continue
                name = prefix + '/' + entry.filename
                check(name not in source_names, 'Duplicate original file name: ' + name)
                source_names.add(name)
                data = original.read(entry)
                retained = index['files'][name]
                check(retained['bytes'] == len(data) and retained['sha256'] == hashlib.sha256(data).hexdigest(), 'Original payload differs in packed index: ' + name)
                check(retained['source'] == {'zip': prefix, 'entry': entry.filename, 'crc32': entry.CRC}, 'Original source mapping differs: ' + name)
                matched += 1
        represented = {name for name, item in index['files'].items() if item['source'].get('zip') == prefix}
        check(represented == source_names and matched == record['originalFilePayloads'], 'Missing or extra original payloads: ' + prefix)
        cells.append({**record, 'matchingPackedPayloads': matched, 'missing': [], 'extra': [], 'changed': []})
    total = sum(cell['originalFilePayloads'] for cell in cells)
    return {'schemaVersion': 1, 'archive': archive_path.name, 'archiveSha256': digest(archive_path), 'allPackedPayloadHashesVerified': True, 'originalZipPayloads': total, 'matchedOriginalZipPayloads': sum(cell['matchingPackedPayloads'] for cell in cells), 'cells': cells, 'limitations': 'Every original regular-file payload is preserved. Original ZIP container metadata is represented by exact SHA256 and byte count; it is not reconstructed. Failed-v1 evidence is preserved in its separate archive.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, default=Path('/workspace/scratch/f34c9c9fae89'))
    parser.add_argument('--execute', action='store_true', help='Pack only after all four audits, browser summaries and root analysis are complete')
    args = parser.parse_args()
    root = args.workspace.resolve()
    repo, output, directories, files = input_plan(root)
    if not args.execute:
        print(json.dumps({'mode': 'plan only; no files written or archives read', 'requiredCells': list(CELLS), 'zipSources': 'Original filenames and counts are resolved from each completed audited download receipt', 'directories': [(name, str(path)) for name, path in directories], 'files': [(name, str(path)) for name, path in files], 'exclusions': EXCLUSIONS, 'output': str(output / 'native-evidence.tar.xz')}, indent=2))
        return
    packer = repo / 'dev/perf/import-study-evidence.py'
    check(digest(packer) == PACKER_SHA256, 'Evidence utility changed')
    archive_path = output / 'native-evidence.tar.xz'
    for name in ['native-evidence.tar.xz', 'native-evidence.tar.xz.json', 'artifact-coverage.json', 'packing-receipt.json', 'packing.log', 'verification.log', 'packing-failure.json']:
        check(not (output / name).exists(), 'Refusing to overwrite earlier packing evidence: ' + name)
    zip_inputs, original_records = readiness(root, output)
    scan = scan_credentials(zip_inputs, directories, files)
    save_new(output / 'packing-extras/credential-scan.json', scan)
    check(not scan['confirmedPrivateCredentialFindings'], 'Credential candidates require explicit review; no archive produced')
    before = snapshot_inputs(zip_inputs, directories, files)
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    command = [sys.executable, str(packer), 'pack', '--output', str(archive_path)]
    for option, values in [('--zip', zip_inputs), ('--directory', directories), ('--file', files)]:
        for name, path in values:
            command.extend([option, name + '=' + str(path)])
    for pattern in EXCLUSIONS:
        command.extend(['--exclude', pattern])
    phase = 'packing'
    try:
        result = subprocess.run(command, capture_output=True, text=True)
        with (output / 'packing.log').open('x') as stream:
            stream.write(result.stdout + result.stderr)
        result.check_returncode()
        phase = 'archive verification'
        verify_command = [sys.executable, str(packer), 'verify', str(archive_path)]
        verified = subprocess.run(verify_command, capture_output=True, text=True)
        with (output / 'verification.log').open('x') as stream:
            stream.write(verified.stdout + verified.stderr)
        verified.check_returncode()
        phase = 'original payload coverage'
        coverage_receipt = coverage(archive_path, zip_inputs, original_records)
        phase = 'input identity verification'
        after = snapshot_inputs(zip_inputs, directories, files)
        check(before == after, 'Evidence input set or bytes changed during packing')
        verify_frozen_supplements(root)
        save_new(output / 'artifact-coverage.json', coverage_receipt)
        archive_receipt = read_json(archive_path.with_name(archive_path.name + '.json'))
        receipt = {'schemaVersion': 1, 'startedAt': started, 'completedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'measuredToolingCommit': TOOLING_COMMIT, 'measuredToolingTree': TOOLING_TREE, 'manifestSha256': MANIFEST_SHA256, 'workflowRunId': RUN_ID, 'recipeSha256': digest(Path(__file__).resolve()), 'packerSha256': PACKER_SHA256, 'packCommand': command, 'packExitCode': result.returncode, 'verifyCommand': verify_command, 'verifyExitCode': verified.returncode, 'inputIdentitiesBefore': before, 'allInputIdentitiesUnchangedAfter': True, 'archiveReceipt': archive_receipt, 'coverageSha256': digest(output / 'artifact-coverage.json'), 'credentialScanSha256': digest(output / 'packing-extras/credential-scan.json'), 'scopeAndExclusionsSha256': digest(output / 'packing-extras/scope-and-exclusions.json'), 'analysisSha256': digest(output / 'all-browser-analysis.json'), 'reportAssemblyAttemptsSha256': digest(output / 'report-assembly-attempts.json'), 'failedV1ArchiveUnmodified': True}
        save_new(output / 'packing-receipt.json', receipt)
    except Exception as error:
        save_new(output / 'packing-failure.json', {'startedAt': started, 'failedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'phase': phase, 'errorType': type(error).__name__, 'error': str(error), 'recipeSha256': digest(Path(__file__).resolve()), 'inputIdentitiesBefore': before, 'partialArchivePreserved': archive_path.exists() or archive_path.with_name(archive_path.name + '.tmp').exists(), 'noRetryOrOverwritePerformed': True})
        raise
    print(json.dumps({'ok': True, 'archive': archive_receipt, 'originalZipPayloads': coverage_receipt['originalZipPayloads'], 'coverageSha256': receipt['coverageSha256'], 'recipeSha256': receipt['recipeSha256'], 'packingReceiptSha256': digest(output / 'packing-receipt.json')}, indent=2))


if __name__ == '__main__':
    main()
