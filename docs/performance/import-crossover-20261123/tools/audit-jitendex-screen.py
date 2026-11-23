#!/usr/bin/env python3
"""Independently audit the original six-block Jitendex screen packet."""
import argparse
import hashlib
import json
from pathlib import Path
import random
import statistics
import subprocess
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--repository', type=Path, required=True)
parser.add_argument('--packet', type=Path, required=True)
parser.add_argument('--archive', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
root = args.packet
sha = lambda data: hashlib.sha256(data).hexdigest()
read = lambda name: json.loads((root / name).read_text())
git_bytes = lambda ref, path: subprocess.check_output(['git', 'show', f'{ref}:{path}'], cwd=args.repository)
baseline = '3d65e403c644b9a5a6be3128d72f9d30050b70e0'
candidate = '78a2adcfba8d72d8cba070319b53d4b2b354a8f9'
tooling = '462c4e1e079f4bf7a0c858b004e14bb9356f11d5'
assert sha(args.archive.read_bytes()) == 'c5921388044bbe93a671e2072fce3fc4d36051985c65d5967bf5197ad7fbaa6e'
with zipfile.ZipFile(args.archive) as archive:
    assert archive.testzip() is None
    members = [entry for entry in archive.infolist() if not entry.is_dir()]
    for entry in members:
        assert (root / entry.filename).read_bytes() == archive.read(entry), entry.filename

protocol = read('protocol.json')
assert protocol['stage'] == 'screen'
assert protocol['dictionary'] == 'jitendex'
assert protocol['github']['GITHUB_RUN_ID'] == '45262916933'
assert protocol['toolingCommit'] == tooling
assert protocol['nodeVersion'] == 'v22.22.0'
assert protocol['harnessOverlay'] is None
assert protocol['orders'] == ['ABC', 'CBA', 'BAC', 'CAB', 'BCA', 'ACB']
assert protocol['plannedBlocks'] == 6
identities = protocol['sourceIdentities']
for arm, ref in [('A', baseline), ('B', candidate), ('C', baseline)]:
    assert identities[arm]['commit'] == ref
    tree = subprocess.check_output(['git', 'rev-parse', f'{ref}^{{tree}}'], cwd=args.repository, text=True).strip()
    assert identities[arm]['tree'] == tree
for filename, expected in protocol['unchangedHarnessSha256'].items():
    for ref in [baseline, candidate]:
        assert sha(git_bytes(ref, filename)) == expected, (ref, filename)
assert sha((root / 'runner.py').read_bytes()) == protocol['runnerSha256']
assert (root / 'runner.py').read_bytes() == git_bytes(tooling, 'dev/perf/import-runtime-next.py')
assert (root / 'workflow.yml').read_bytes() == git_bytes(tooling, '.github/workflows/import-runtime-next.yml')
for filename in ['source-status-A.txt', 'source-status-B.txt', 'tooling-status.txt']:
    assert not (root / filename).read_text().strip()

packages = {arm: read(f'package-{arm}.json') for arm in 'ABC'}
for field in ['entries', 'source', 'archiveSha256']:
    assert packages['A'][field] == packages['C'][field]
assert packages['A']['entries'].keys() == packages['B']['entries'].keys()
changed = sorted(name for name, value in packages['A']['entries'].items() if packages['B']['entries'][name] != value)
assert changed == read('package-differences.json') == ['js/dictionary/term-content-block-store.js', 'js/dictionary/zstd-term-content.js']
for arm, ref in [('A', baseline), ('B', candidate)]:
    assert packages[arm]['source'] == identities[arm]
    for filename in changed:
        assert packages[arm]['entries'][filename] == sha(git_bytes(ref, f'ext/{filename}'))

observations = read('observations.json')
assert len(observations) == 20
timed = [entry for entry in observations if entry['cohort'] == 'timed']
diagnostic = [entry for entry in observations if entry['cohort'] == 'exhaustive-diagnostic']
assert len(timed) == 18 and len(diagnostic) == 2
assert {entry['arm'] for entry in diagnostic} == {'A', 'B'}
groups = {}
for block, order in enumerate(protocol['orders'], start=1):
    entries = sorted([entry for entry in timed if entry['block'] == block], key=lambda entry: entry['position'])
    assert ''.join(entry['arm'] for entry in entries) == order
    assert [entry['position'] for entry in entries] == [1, 2, 3]
    groups[block] = {entry['arm']: entry['totalImportMs'] for entry in entries}
correctness = read('correctness.json')
assert correctness['status'] == 'passed'
receipts = correctness['identicalReceipts']
expected_output = None
expected_flags = None
for entry in observations:
    assert entry['status'] == 'success'
    assert entry['source'] == identities[entry['arm']]
    summary = read(f'{entry["name"]}/summary.json')
    report = read(f'{entry["name"]}/run-1.json')
    assert summary['gitSha'] == identities[entry['arm']]['commit']
    assert summary['source']['dirty'] is False
    assert summary['runs'][0]['totalImportMs'] == entry['totalImportMs']
    assert summary['runs'][0]['packageSha256'] == packages[entry['arm']]['archiveSha256']
    assert report['status'] == 'success' and not report['failureReason'] and not report['skippedVerification']
    assert report['packageSha256'] == packages[entry['arm']]['archiveSha256']
    assert report['browserVersion'] == '153.0.8010.12'
    for filename, value in summary['source']['sha256'].items():
        if filename.startswith('builds/'):
            continue
        assert sha(git_bytes(summary['gitSha'], filename)) == value
    benchmark = report['benchmark']
    assert benchmark['productionImportDefaults'] and benchmark['authoritativeTiming']
    for flag in ['phaseScreenshots', 'traceEnabled', 'phaseProfiling', 'processSampling']:
        assert benchmark[flag] is False
    if expected_flags is None:
        expected_flags = benchmark['importFlags']
    assert benchmark['importFlags'] == expected_flags
    validation = benchmark['validation']
    assert validation['termRows'] == 436555 and validation['contentReadable'] and validation['probeCount'] == 12
    assert len(validation['probeTerms']) == 12
    if expected_output is None:
        expected_output = validation['outputDigestSha256']
    assert validation['outputDigestSha256'] == expected_output
    assert validation['restart'] == {'title': 'Jitendex.org [2026-10-03]', 'revision': '2026.10.03.0', 'termRows': 436555, 'mediaFiles': 236, 'contentReadable': True, 'probeCount': 12}
    assert validation['storage']['bytes'] == entry['storageBytes'] == receipts['storageBytes'] == 67466332
    lookup = sorted([[item['pass'], item['term'], item['results'], item['sha256']] for item in validation['lookup']['observations']])
    assert lookup == receipts['lookup'] and len(lookup) == 72
    media = validation['media']
    mode = 'sample' if entry['cohort'] == 'timed' else 'all'
    assert media == receipts[f'media-{mode}']
    assert media['files'] == (64 if mode == 'sample' else 236)
    assert media['totalFiles'] == 236 and media['totalBytes'] == 4992155

comparisons = {}
for numerator, denominator in [('B', 'A'), ('B', 'C'), ('C', 'A')]:
    paired = [100 * (group[numerator] / group[denominator] - 1) for group in groups.values()]
    generator = random.Random(20261123)
    resampled = sorted(statistics.median(generator.choices(paired, k=len(paired))) for _ in range(10000))
    comparisons[f'{numerator}/{denominator}'] = {
        'pairedChangesPercent': paired, 'pairedMedianPercent': statistics.median(paired),
        'equalWorkPercent': 100 * (sum(group[numerator] for group in groups.values()) / sum(group[denominator] for group in groups.values()) - 1),
        'fasterPairs': sum(value < 0 for value in paired),
        'descriptiveBootstrap95Percent': [resampled[249], resampled[9749]],
        'bootstrapScope': '10000 block-paired median resamples, seed20261123; descriptive six-pair screen, no multiplicity correction',
    }
reported = read('analysis.json')
for independent, recorded in [('B/A', 'candidate'), ('B/C', 'candidateVsSecondBaseline'), ('C/A', 'identicalProductControl')]:
    for key in ['pairedChangesPercent', 'pairedMedianPercent', 'equalWorkPercent', 'fasterPairs']:
        assert comparisons[independent][key] == reported[recorded][key]
audit = {
    'result': 'passed', 'workflowRun': 45262916933, 'artifactId': 14861638196,
    'originalArchiveSha256': sha(args.archive.read_bytes()), 'verifiedExtractedFiles': len(members),
    'sourceIdentities': identities, 'verifiedHarnessHashesPerSource': len(protocol['unchangedHarnessSha256']),
    'packageEntriesPerArm': len(packages['A']['entries']), 'changedPackagedFiles': changed,
    'identicalControlPackage': True, 'successfulObservations': len(observations),
    'timedObservations': len(timed), 'separateExhaustiveDiagnostics': len(diagnostic),
    'sourceRowsPerImport': 436555, 'lookupReceiptsPerImport': 72, 'distinctTermProbes': 12,
    'sampledMediaPerTimedImport': 64, 'exhaustiveMediaPerDiagnostic': 236,
    'logicalStorageBytesAllObservations': receipts['storageBytes'], 'screenshotsCollected': False,
    'processMemorySampled': False, 'blocks': groups, 'comparisons': comparisons,
    'assessment': 'No whole-import gain established. B/A aggregate improvement is matched by unchanged C/A drift; B/C equal-work is +0.141%. Keep all six blocks, including block1, and use a separate fixed qualification without pooling.',
    'inferenceLimits': ['Fresh browser whole-import timing, one shared hosted environment', 'Six exploratory paired blocks; intervals descriptive', '12 fixed term probes, not exhaustive term equivalence', 'Exhaustive media diagnostics excluded from timing comparison', 'No process-memory or screenshot evidence', 'No omitted observations or post-hoc trimming'],
}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(audit, indent=2) + '\n')
print(json.dumps({key: audit[key] for key in ['result', 'verifiedExtractedFiles', 'verifiedHarnessHashesPerSource', 'packageEntriesPerArm', 'successfulObservations', 'comparisons', 'assessment']}, indent=2))
