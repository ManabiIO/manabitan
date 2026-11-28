#!/usr/bin/env python3
"""Verify preserved evidence only. Does not run product tests or builds."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parent
manifest_bytes = (root / 'manifest.json').read_bytes()
manifest = json.loads(manifest_bytes)
sha = lambda b: hashlib.sha256(b).hexdigest()
logs = {}
log_bytes = compressed_bytes = log_lines = source_comparisons = 0
expected = {'manifest.json', 'verification.json'}
for entry in manifest['files']:
    relative = entry['path']
    path = root / relative
    assert path.resolve().is_relative_to(root), relative
    assert not path.is_symlink(), relative
    expected.add(relative)
    data = path.read_bytes()
    assert len(data) == entry['bytes'] and sha(data) == entry['sha256'], relative
    if entry['encoding'] == 'gzip':
        assert data[:4] == b'\x1f\x8b\x08\x00', relative
        assert data[4:8] == b'\x00\x00\x00\x00', relative
        assert data[8] == 2 and data[9] == 255, relative
        raw = gzip.decompress(data)
        assert len(raw) == entry['uncompressedBytes'], relative
        assert sha(raw) == entry['uncompressedSha256'], relative
        assert len(raw.splitlines()) == entry['uncompressedLineCount'], relative
        logs[entry['sourceRelativePath']] = raw.decode('utf-8')
        log_bytes += len(raw)
        compressed_bytes += len(data)
        log_lines += len(raw.splitlines())
    else:
        assert entry['encoding'] == 'identity', relative
        raw = data
    if args.source is not None and 'sourceRelativePath' in entry:
        original = args.source / entry['sourceRelativePath']
        assert raw == original.read_bytes(), relative
        source_comparisons += 1
actual = {p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()}
assert actual <= expected and expected - actual <= {'verification.json'}
load = lambda name: json.loads((root / 'receipts' / name).read_text())
summary = load('validation-summary.json')
full = load('full-unit-attempt-1.json')
repair1 = load('native-compiler-repair-attempt-1.json')
repair2 = load('native-compiler-repair-attempt-2.json')
build1 = load('all-target-dry-build-attempt-1.json')
build2 = load('all-target-dry-build-attempt-2.json')
assert full['exitCode'] == repair1['exitCode'] == build1['exitCode'] == 1
assert repair2['exitCode'] == build2['exitCode'] == 0
assert load('eslint-attempt-1.json')['exitCode'] == 1
assert load('eslint-attempt-2.json')['exitCode'] == 0
for kind in ['main', 'test']:
    assert load(f'types-{kind}-attempt-1.json')['exitCode'] == 0
source_hashes = json.loads((root / 'source-hashes.json').read_text())
for item in [full, repair1, repair2, build1, build2]:
    assert item['sourceBefore'] == item['sourceAfter'] == summary['sourceHashes']
    assert item['sourceUnchanged'] is True
    assert item['node'] == 'v24.22.3'
assert source_hashes['executedSourceSha256'] == summary['sourceHashes']
for name, digest in summary['receipts'].items():
    assert sha((root / 'receipts' / name).read_bytes()) == digest, name
for filename in ['full-unit-attempt-1', 'native-compiler-repair-attempt-1',
                 'native-compiler-repair-attempt-2', 'all-target-dry-build-attempt-1',
                 'all-target-dry-build-attempt-2']:
    assert sha(logs[filename + '.log'].encode()) == load(filename + '.json')['logSha256']
assert re.search(r'Test Files\s+2 failed \| 667 passed \(669\)', logs['full-unit-attempt-1.log'])
assert re.search(r'Tests\s+15138 passed \| 68 skipped \(15206\)', logs['full-unit-attempt-1.log'])
assert re.search(r'Tests\s+21 skipped \(21\)', logs['native-compiler-repair-attempt-1.log'])
assert re.search(r'Test Files\s+2 passed \(2\)', logs['native-compiler-repair-attempt-2.log'])
assert re.search(r'Tests\s+21 passed \(21\)', logs['native-compiler-repair-attempt-2.log'])
assert '7 problems (7 errors, 0 warnings)' in logs['eslint-attempt-1.log']
targets = re.findall(r'^Building ([a-z-]+)\.\.\.$', logs['all-target-dry-build-attempt-2.log'], re.M)
assert targets == ['chrome', 'chrome-dev', 'chrome-playwright', 'firefox',
                   'firefox-dev', 'firefox-android', 'edge']
style = load('test-style-equivalence.json')
assert style['complete'] is True and style['equalAst'] is True
assert sha((root / 'test-style/test-before-style.js').read_bytes()) == style['beforeSha256']
assert sha((root / 'test-style/test-after-style.js').read_bytes()) == style['afterSha256']
assert style['afterSha256'] == summary['sourceHashes']['test/term-bank-media-projection.test.js']
coverage = summary['unit']['combinedUniqueCoverage']
assert coverage['passedTests'] == 15138 + 21 == 15159
assert coverage['inheritedSkippedTests'] == 68 - 21 == 47
assert coverage['filesExecutedSuccessfullyAcrossAttempts'] == 667 + 2 == 669
report = {
    'status': 'passed',
    'scope': 'Evidence byte/hash/count verification only; no tests or builds rerun',
    'manifestSha256': sha(manifest_bytes),
    'payloadFiles': len(manifest['files']),
    'completeGzipLogs': len(logs),
    'compressedLogBytes': compressed_bytes,
    'uncompressedLogBytes': log_bytes,
    'uncompressedLogLines': log_lines,
    'originalSourceComparisons': source_comparisons,
    'unitOriginalExitCode': 1,
    'targetedRepairExitCode': 0,
    'combinedUniquePassingTests': 15159,
    'inheritedSkippedTests': 47,
    'suitesCoveredAcrossAttempts': 669,
    'dryBuildTargets': targets,
    'styleReceiptAndFileHashesVerified': True,
    'astComparisonRerun': False,
    'singleCleanFullSuitePassClaimed': False,
}
(root / 'verification.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
