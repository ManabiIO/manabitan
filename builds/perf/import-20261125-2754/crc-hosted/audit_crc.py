#!/usr/bin/env python3
"""Read-only reconciliation of the frozen CRC timing and memory studies."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import traceback

ROOT = Path('/tmp/manabitan-2754-crc-audit')
WORKSPACE = Path('/workspace/scratch/2754d3e3fa09')
BASELINE = {'commit': '7d1643e6147a10cb2165e9744cf0e63b59e46632',
            'tree': '99d23f16e973c7ae9feba77ca3643d1c27dfb93d'}
CANDIDATE = {'commit': 'c2cf7647c67b02474301ed48e54a53205be0f027',
             'tree': '074e622aec0c6537c7f0d8ac92725dd62c28b73b'}
SOURCES = {'A': BASELINE, 'B': CANDIDATE}
DIFFERENCES = ['js/dictionary/term-bank-wasm-parser.js',
               'js/dictionary/wasm/term-bank-parser.c', 'lib/term-bank-parser.wasm']
RUNS = {'timing': '45644628634', 'memory': '45644635208'}


def read(path):
    return json.loads(Path(path).read_text())


def sha(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def save(name, value):
    destination = ROOT / name
    destination.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')
    return str(destination)


def artifact_identity(item):
    result = {key: item[key] for key in ('id', 'name', 'kind', 'run', 'directory', 'archive')}
    result['archiveSha256'] = sha(item['archive'])
    if item.get('serviceDigest'):
        assert item['serviceDigest'] == 'sha256:' + result['archiveSha256']
    assert str(item['run']) == RUNS[item['kind']]
    return result


def timing(items):
    spec = importlib.util.spec_from_file_location('frozen_timing_auditor', '/tmp/manabitan-2754-timing/audit_cohort.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    rows = []
    for item in items:
        row = artifact_identity(item)
        location = Path(item['directory']) / 'cohort'
        try:
            protocol = read(location / 'protocol.json')
            row['dictionary'] = protocol['dictionary']
            assert protocol['sourceIdentities'] == {**SOURCES, 'C': BASELINE}
            assert protocol['expectedPackageDifferences'] == DIFFERENCES
            assert str(protocol['github']['GITHUB_RUN_ID']) == RUNS['timing']
            assert str(protocol['github']['GITHUB_RUN_ATTEMPT']) == '1'
            assert protocol['stage'] == 'screen' and protocol['plannedBlocks'] == 6
            assert protocol['orders'] == ['ABC', 'CBA', 'BAC', 'CAB', 'BCA', 'ACB']
            assert protocol['runnerSha256'] == sha(WORKSPACE / 'studies/dev/perf/import-runtime-20261124-3aac.py')
            row['audit'] = module.audit(location, CANDIDATE['commit'])
            assert row['audit']['observationsReopened'] == 23
            assert row['audit']['timedObservations'] == 18
            row['status'] = 'passed'
            save(f"timing-{row['dictionary']}-audit.json", row)
        except Exception as error:
            row['status'] = 'failed'
            row['error'] = repr(error)
            row['traceback'] = traceback.format_exc()
            for name in ('state.json', 'failure.json', 'observations.json', 'analysis.json'):
                path = location / name
                if path.exists():
                    row[name.removesuffix('.json')] = read(path)
        rows.append(row)
    return {'schemaVersion': 1, 'workflowRun': RUNS['timing'], 'sourceIdentities': {**SOURCES, 'C': BASELINE},
            'scope': 'Independent reopening and reconciliation only; no acquisitions, retries, exclusions, or pooling',
            'auditorSha256': sha('/tmp/manabitan-2754-timing/audit_cohort.py'),
            'artifacts': rows, 'expectedArtifacts': 3, 'receivedArtifacts': len(rows),
            'complete': {row.get('dictionary') for row in rows} == {'jmdict', 'jitendex', 'vndb'},
            'allAuditsPassed': len(rows) == 3 and all(row['status'] == 'passed' for row in rows)}


def memory(items):
    tooling = WORKSPACE / 'memory'
    directory = 'dev/perf/import-memory-20261124-3aac'
    sys.path.insert(0, str(tooling / directory))
    from audit_memory import audit_cell
    from verify_receipts import verify
    from protocol import receipt_comparison_key, WORKFLOW
    frozen = {}
    for name in ('chromium_memory.py', 'audit_memory.py'):
        original = subprocess.check_output(['git', 'show',
            f'f2f08c8ee74cdea548c5c1b494ec15bf10360b46:dev/perf/import-memory-20261123-72c24/{name}'], cwd=tooling)
        current = (tooling / directory / name).read_bytes()
        assert original == current
        frozen[name] = {'unchanged': True, 'sha256': hashlib.sha256(current).hexdigest()}
    rows, receipts = [], {}
    for item in items:
        row = artifact_identity(item)
        location = Path(item['directory'])
        try:
            plan = read(location / 'plan.json')
            row.update(dictionary=plan['dictionary'], replication=plan['replication'])
            assert plan['sourceIdentities'] == SOURCES
            assert plan['expectedPackageDifferences'] == DIFFERENCES
            assert str(plan['workflowRun']) == RUNS['memory']
            assert str(plan['workflowAttempt']) == '1'
            assert len(plan['schedule']) == 4
            for name, expected in plan['sourceFiles'].items():
                source = ROOT / 'workflow-memory.yml' if name == WORKFLOW else tooling / name
                assert sha(source) == expected, name
            row['rawScanAudit'] = audit_cell(location)
            assert row['rawScanAudit'] == read(location / 'memory-audit.json')
            row['receiptAudit'] = verify(location)
            assert row['receiptAudit'] == read(location / 'receipt-audit.json')
            row['auditReconciliation'] = 'passed'
            comparison = read(location / 'memory-comparison.json')
            row['pairs'], row['metrics'] = comparison['pairs'], comparison['metrics']
            qualification = read(location / 'qualification.json')
            row['qualification'] = qualification
            assert qualification['correctnessPassed'] == row['receiptAudit']['allCorrectnessPassed']
            assert qualification['memoryScreenPassed'] == row['rawScanAudit']['passesProspectiveMemoryScreen']
            assert qualification['retriedObservations'] == 0
            assert qualification['status'] == ('passed' if qualification['correctnessPassed'] and qualification['memoryScreenPassed'] else 'failed')
            row['observations'] = []
            keys = ['qualifiedForWholeTreePss', 'qualificationFailures', 'benchmarkExitCode',
                'allObservedSampleCount', 'fullyContainedImportSampleCount', 'stableFullyReadImportSampleCount',
                'maximumCoveredSampleGapMs', 'preImportBracketGapMs', 'postImportBracketGapMs',
                'maxSampledPssKiB', 'maxSampledPrivateKiB', 'samplesWithUnavailableSmaps',
                'samplesWithUnreadableAddressSpaces', 'confirmedExitedZombieIdentityCount', 'observedProcessCountRange']
            for observation in plan['schedule']:
                memory_report = read(location / observation['name'] / 'memory.json')
                correctness = read(location / observation['name'] / 'correctness.json')
                result = {**observation, **{key: memory_report[key] for key in keys}, 'correctness': correctness['status']}
                if correctness['status'] == 'passed':
                    receipt = correctness['receipt']
                    receipts.setdefault(plan['dictionary'], []).append(receipt_comparison_key(receipt))
                    result['rawStorageBytes'] = receipt['storage']['rawStorageBytes']
                    result['activeSahFileBytes'] = receipt['storage']['sahPool']['activeFileBytes']
                    result['nonSahBytes'] = receipt['storage']['nonSahBytes']
                else:
                    result['correctnessFailure'] = correctness
                row['observations'].append(result)
            failure = location / 'failure.json'
            row['retainedFailure'] = read(failure) if failure.exists() else None
        except Exception as error:
            row['auditReconciliation'] = 'failed'
            row['error'] = repr(error)
            row['traceback'] = traceback.format_exc()
            for name in ('failure.json', 'observations.json', 'qualification.json', 'memory-comparison.json'):
                path = location / name
                if path.exists():
                    row[name.removesuffix('.json')] = read(path)
        rows.append(row)
        if 'dictionary' in row:
            save(f"memory-{row['dictionary']}-rep{row['replication']}-audit.json", row)
    equality = {dictionary: {'observations': len(values), 'allEqual': all(value == values[0] for value in values),
                              'browserVersion': values[0]['browserVersion']}
                for dictionary, values in receipts.items()}
    cells = {(row.get('dictionary'), row.get('replication')) for row in rows}
    complete = len(rows) == 6 and cells == {(dictionary, replication) for dictionary in ('jmdict', 'jitendex', 'vndb') for replication in (1, 2)}
    cross_replication_passed = complete and set(equality) == {'jmdict', 'jitendex', 'vndb'} and all(
        row['observations'] == 8 and row['allEqual'] for row in equality.values())
    return {'schemaVersion': 1, 'workflowRun': RUNS['memory'], 'sourceIdentities': SOURCES,
            'scope': 'Independent raw-scan and receipt reconciliation; memory timings are non-authoritative; no new acquisition',
            'frozenObserver': frozen, 'artifacts': rows, 'expectedArtifacts': 6, 'receivedArtifacts': len(rows),
            'complete': complete, 'crossReplicationReceiptEquality': equality,
            'allAuditReconciliationsPassed': complete and all(row['auditReconciliation'] == 'passed' for row in rows),
            'allCorrectnessPassed': cross_replication_passed and all(row.get('receiptAudit', {}).get('allCorrectnessPassed', False) for row in rows),
            'crossReplicationReceiptsPassed': cross_replication_passed,
            'promotionMemoryPass': complete and all(row.get('rawScanAudit', {}).get('passesProspectiveMemoryScreen', False) for row in rows),
            'totalRawScans': sum(row.get('rawScanAudit', {}).get('rawScanCount', 0) for row in rows)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('kind', choices=['timing', 'memory'])
    args = parser.parse_args()
    index = read(ROOT / 'artifacts.json')
    selected = [item for item in index if item['kind'] == args.kind]
    report = timing(selected) if args.kind == 'timing' else memory(selected)
    destination = save(f'independent-{args.kind}-audit.json', report)
    print(json.dumps({'report': destination, 'complete': report['complete'], 'receivedArtifacts': report['receivedArtifacts'],
                      'failures': [row for row in report['artifacts'] if row.get('status', row.get('auditReconciliation')) == 'failed']}))
