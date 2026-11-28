#!/usr/bin/env python3
"""Assemble already-audited frozen observations; acquire no new measurements."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile

PRESERVED = 'e54f8f55e6a493a13f2e7ab2cd8c06317d513800'
ROOT = 'builds/perf/20261128-4d9f-hosted-evidence/'
BASE = 'f28c2801fcfd9416f220b46b9cbafeee901c1cb2'
CANDIDATE = '68b29e5a959470e76ff67a93ec8b300cc53f1254'
EXPECTED = [
    ('jmdict', 'AB', 15260125586), ('jmdict', 'BA', 15260020903),
    ('jitendex', 'AB', 15260335462), ('jitendex', 'BA', 15259662382),
    ('vndb', 'AB', 15260312654), ('vndb', 'BA', 15260224001),
]


def sha(value):
    return hashlib.sha256(value).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', type=Path, required=True)
    parser.add_argument('--first-four-audit', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    inputs = []

    def git_bytes(path):
        value = subprocess.check_output(['git', 'show', f'{PRESERVED}:{ROOT}{path}'], cwd=args.repository)
        inputs.append({'publicCommit': PRESERVED, 'path': ROOT + path, 'bytes': len(value), 'sha256': sha(value)})
        return value

    def git_json(path):
        return json.loads(git_bytes(path))

    def artifact(artifact_id, selected):
        prefix = f'artifacts/{artifact_id}/'
        receipt = git_json(prefix + 'archive-receipt.json')
        members = git_json(prefix + 'artifact-members.json')
        member_map = {item['name']: item for item in members}
        assert len(member_map) == len(members)
        raw = git_bytes(prefix + 'verified-evidence.tar.xz')
        assert len(raw) == receipt['archiveBytes'] and sha(raw) == receipt['archiveSha256']
        result = {}
        with tarfile.open(fileobj=io.BytesIO(raw), mode='r:xz') as archive:
            for name in selected:
                data = archive.extractfile(name).read()
                expected = member_map[name]
                assert len(data) == expected['bytes'] and sha(data) == expected['sha256']
                result[name] = json.loads(data)
        return receipt, result

    manifest = git_json('pinned-artifact-manifest.json')
    assert sha(git_bytes('audit-hosted-imports-4d9f.py')) == '83f6c2eabcd31232dade45596c5df833fe87879e095267cda250aa44780347ee'
    current_manifest = next(run for run in manifest['runs'] if run['id'] == 46135718522)
    manifest_by_id = {item['id']: item for item in current_manifest['artifacts']}
    first_four_raw = args.first_four_audit.read_bytes()
    inputs.append({'originalLocalAudit': str(args.first_four_audit), 'bytes': len(first_four_raw), 'sha256': sha(first_four_raw)})
    first_four = json.loads(first_four_raw)
    assert len(first_four) == 4
    by_id = {item['artifact']['id']: item for item in first_four}
    for artifact_id in (15260312654, 15260224001):
        audited = git_json(f'artifacts/{artifact_id}/independent-audit.json')
        assert len(audited) == 1
        by_id[artifact_id] = audited[0]
    assert set(by_id) == {item[2] for item in EXPECTED}
    cells = []
    for dictionary, order, artifact_id in EXPECTED:
        row = by_id[artifact_id]
        expected = manifest_by_id[artifact_id]
        assert row['status'] == 'audit-passed'
        assert row['artifact']['digest'] == 'sha256:' + expected['sha256']
        assert row['artifact']['size_in_bytes'] == expected['size']
        assert row['observations'] == 36 and row['semanticChecks'] == 42
        assert row['candidateVsBaseline']['count'] == 12 and row['identicalCodeControl']['count'] == 4
        receipt, selected = artifact(artifact_id, ['source-identities.json', 'registered-plan.json', 'memory/memory-comparison.json'])
        identity = selected['source-identities.json']
        assert identity['arms']['A']['sha'] == BASE and identity['arms']['B']['sha'] == CANDIDATE
        assert row['changedPackageEntries'] == identity['changedPackageEntries']
        plan = selected['registered-plan.json']
        assert plan['initialOrder'] == order and len(plan['schedule']) == 36
        comparison = selected['memory/memory-comparison.json']
        assert row['memory']['passesProspectiveMemoryScreen'] == comparison['passesProspectiveMemoryScreen']
        assert row['memory']['metrics'] == comparison['metrics']
        failures = [{key: observation[key] for key in ('name', 'arm', 'pair', 'benchmarkExitCode', 'qualificationFailures', 'maximumCoveredSampleGapMs', 'preImportBracketGapMs', 'postImportBracketGapMs', 'fullyContainedImportSampleCount', 'samplesWithUnavailableSmaps', 'samplesWithUnreadableAddressSpaces')} for observation in comparison['observations'] if not observation['qualifiedForWholeTreePss']]
        cells.append({**row, 'dictionary': dictionary, 'initialOrder': order,
                      'source': {arm: {key: value for key, value in identity['arms'][arm].items() if key != 'entries'} for arm in ('A', 'B')},
                      'publicArchive': receipt, 'memoryCoverageFailures': failures,
                      'auditExecution': 'original local audit, retained unchanged' if dictionary != 'vndb' else 'hosted frozen audit in preservation run46139005895'})
    old_failures = []
    for dictionary, order, artifact_id in [('jmdict', 'BA', 15258559921), ('vndb', 'AB', 15259387382)]:
        receipt, selected = artifact(artifact_id, ['memory/memory-comparison.json'])
        comparison = selected['memory/memory-comparison.json']
        assert comparison['passesProspectiveMemoryScreen'] is False
        old_failures.append({'dictionary': dictionary, 'order': order, 'artifact': receipt['artifact'],
                             'baseline': 'dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16',
                             'candidate': '6a05b649de2bf220b21f5365902c76d78d1cde29',
                             'failures': [{key: observation[key] for key in ('name', 'arm', 'qualificationFailures', 'maximumCoveredSampleGapMs')} for observation in comparison['observations'] if not observation['qualifiedForWholeTreePss']],
                             'passesProspectiveMemoryScreen': False})
    result = {'schemaVersion': 1, 'qualificationBoundary': 'Completed frozen f28-versus68b browser cohort; not later a300 qualification.',
              'workflowRunId': 46135718522, 'preservationRunId': 46139005895, 'preservedCommit': PRESERVED,
              'baseline': BASE, 'candidate': CANDIDATE,
              'localCandidateTreeEquivalent': '81e203e084c009e79057a36d0e2106ef669ab168',
              'browserVersion': '153.0.8010.12',
              'auditHelperSha256': '83f6c2eabcd31232dade45596c5df833fe87879e095267cda250aa44780347ee',
              'cellCount': len(cells), 'semanticChecks': sum(row['semanticChecks'] for row in cells),
              'scheduledObservations': sum(row['observations'] for row in cells),
              'rawMemoryScanCount': sum(row['memory']['rawScanCount'] for row in cells),
              'passedMemoryCells': sum(row['memory']['passesProspectiveMemoryScreen'] for row in cells),
              'allMemoryCellsQualified': all(row['memory']['passesProspectiveMemoryScreen'] for row in cells),
              'repeatedElapsedGainEstablished': False, 'repeatedProcessPeakMemoryGainEstablished': False,
              'memoryFailureInterpretation': 'Temporal sampling coverage failed in VNDB BA; no paired PSS/private deltas are eligible for that cell. No underlying scheduling cause is inferred.',
              'retainedOldCohortFailures': old_failures, 'cells': cells,
              'limitations': ['Sampled PSS/private observations are not exact process peaks.', 'No raw observation was excluded or replaced.', 'The preserved product ZIP inventories and archive hashes bind packages; verified duplicate product ZIP bytes alone were excluded from archival.', 'Later merged source requires its own qualification.']}
    assert result['semanticChecks'] == 252 and result['passedMemoryCells'] == 5
    assert result['rawMemoryScanCount'] == 1972
    for name, data in [('browser-audit-all-six.json', result), ('input-receipts.json', inputs), ('retained-old-memory-failures.json', old_failures), ('vndb-ba-memory-coverage.json', cells[-1]['memoryCoverageFailures'])]:
        (args.output / name).write_text(json.dumps(data, indent=2) + '\n')
    print(json.dumps({'semanticChecks': result['semanticChecks'], 'passedMemoryCells': result['passedMemoryCells'], 'rawMemoryScanCount': result['rawMemoryScanCount'], 'vndbBaFailures': cells[-1]['memoryCoverageFailures'], 'retainedOldFailures': old_failures, 'output': str(args.output)}))


if __name__ == '__main__':
    main()
