#!/usr/bin/env python3
"""Frozen revival registration, source gate, and separate participation audit.

The acquisition driver, its statistics, browser harness and memory observer are
unchanged. This wrapper never retries or replaces an observation.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


BASELINE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
DRIVER = 'dev/perf/import-qualification-bda85f3c7e15.py'
FIXED_CELLS = [(dictionary, order, pairs) for dictionary, pairs in
               [('vndb', 12), ('jmdict', 6), ('jitendex', 6)] for order in ['AB', 'BA']]
MAX_SAFE_INTEGER = 2**53 - 1


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def validate_plan(plan, require_ready=True):
    if plan['baseline'] != BASELINE or plan['flagsByArm'] != dict.fromkeys('ABC'):
        raise ValueError('Unregistered baseline or import flags')
    actual = [(x['dictionary'], x['initialOrder'], x['candidatePairs']) for x in plan['matrix']]
    if actual != FIXED_CELLS or plan['totalHosts'] != 6 or plan['totalPlannedImports'] != 188:
        raise ValueError('The prospectively fixed six-cell matrix changed')
    for cell in plan['matrix']:
        pairs = cell['candidatePairs']
        expected = {'controlPairs': pairs // 3, 'warmupImports': 4,
                    'candidateImports': pairs * 2, 'controlImports': pairs // 3 * 2,
                    'exhaustiveMediaImports': 2, 'memoryImports': 4,
                    'totalImports': 10 + pairs * 2 + pairs // 3 * 2}
        if any(cell[key] != value for key, value in expected.items()):
            raise ValueError('Registered import counts changed')
    memory = plan['memory']
    for key, value in {'minimumFullyCoveredScans': 5, 'maximumCoveredGapMs': 250,
                       'maximumBracketGapMs': 250, 'betweenScanWaitMs': 25,
                       'maximumMedianPairedIncreasePercent': 5,
                       'maximumIndividualPairedIncreasePercent': 10,
                       'everyObservationMustQualify': True, 'rawAuditRequired': True,
                       'retryOrReplacement': False}.items():
        if memory[key] != value:
            raise ValueError('Existing memory protocol changed')
    if plan['vndbSahAllocationUnits'] != [37, 37]:
        raise ValueError('Unregistered current-source VNDB allocation bound')
    if plan['timing']['minimumLatencyImprovementPercent'] is not None:
        raise ValueError('No minimum latency threshold is registered')
    if any(plan['timing'][key] is not True for key in
           ['noOutlierDrops', 'noHostPooling', 'noControlSubtraction', 'noAdaptivePairIncrease']) or plan['timing']['memoryTimingAuthoritative'] is not False:
        raise ValueError('The frozen timing interpretation changed')
    if not require_ready:
        return
    candidate = plan['candidate']
    if plan['status'] != 'READY_FOR_PROSPECTIVE_ACQUISITION' or plan['participation']['status'] != 'CONFIRMED_SOURCE_BOUND':
        raise ValueError('PENDING source/package/counter registration; acquisition is blocked')
    for key in ['sha', 'tree']:
        if not re.fullmatch('[a-f0-9]{40}', candidate[key]):
            raise ValueError('Candidate commit and tree must be exact complete hashes')
    for key in ['expectedPackageEntries', 'expectedAddedPackageEntries', 'lintPaths', 'focusedTests']:
        values = candidate[key]
        if not isinstance(values, list) or len(values) != len(set(values)):
            raise ValueError(f'Unregistered or duplicate candidate paths: {key}')
        if key != 'expectedAddedPackageEntries' and not values:
            raise ValueError(f'Empty candidate gate: {key}')
        for value in values:
            if not isinstance(value, str) or not re.fullmatch('[A-Za-z0-9_./-]+', value) or '..' in Path(value).parts or value.startswith('/'):
                raise ValueError('Unsafe registered source path')
    if not set(candidate['expectedAddedPackageEntries']) <= set(candidate['expectedPackageEntries']):
        raise ValueError('Added package entries must be in the exact total delta')
    if any(not value.startswith('js/dictionary/') or not value.endswith('.js') for value in candidate['expectedPackageEntries']):
        raise ValueError('Revival runtime changes must remain registered dictionary JavaScript')
    receipt = plan['participation']
    if receipt['phase'] != 'bulk-finalization' or receipt['positiveOnly'] != {'dictionary': 'vndb', 'arm': 'B'}:
        raise ValueError('Unregistered participation scope')
    for key in ['countField', 'bytesField']:
        if not re.fullmatch('[A-Za-z][A-Za-z0-9]*', receipt[key]) or receipt[key] == 'PENDING':
            raise ValueError('Pending participation metric name')
    if receipt['countField'] == receipt['bytesField']:
        raise ValueError('Count and byte fields must be distinct')


def verify_locked_tooling(plan, repo):
    for relative, expected in plan['lockedToolingSha256'].items():
        if digest(repo / relative) != expected:
            raise ValueError(f'Frozen common driver/helper/protocol changed: {relative}')


def select_cell(plan, dictionary, order):
    matches = [x for x in plan['matrix'] if x['dictionary'] == dictionary and x['initialOrder'] == order]
    if len(matches) != 1:
        raise ValueError('Unregistered qualification cell')
    return matches[0]


def driver_command(plan, cell, repo, output):
    candidate = plan['candidate']
    command = [sys.executable, str(repo / DRIVER), '--baseline', plan['baseline'],
               '--candidate', candidate['sha'], '--dictionary', cell['dictionary'],
               '--initial-order', cell['initialOrder'], '--pairs', str(cell['candidatePairs'])]
    for name in candidate['expectedPackageEntries']:
        command.extend(['--expected-package-entry', name])
    for name in candidate['expectedAddedPackageEntries']:
        command.extend(['--expected-added-package-entry', name])
    if cell['dictionary'] == 'vndb':
        command.extend(['--vndb-sah-allocation-units', *map(str, plan['vndbSahAllocationUnits'])])
    command.extend(['--evidence', str(output)])
    return command


def expected_observations(cell):
    """Inventory only; the unchanged common driver owns the acquisition order."""
    rows = []
    first = cell['initialOrder']
    for pair, order in enumerate([first, first[::-1]], 1):
        rows.extend({'id': f'warmup-{pair}-{arm}', 'kind': 'warmup', 'pair': pair, 'arm': arm} for arm in order)
    for pair in range(1, cell['candidatePairs'] + 1):
        order = first if pair % 2 else first[::-1]
        rows.extend({'id': f'pair-{pair:02d}-{arm}', 'kind': 'candidate', 'pair': pair, 'arm': arm} for arm in order)
        if pair % 3 == 0:
            control = pair // 3
            order = 'AC' if (control + (first == 'BA')) % 2 else 'CA'
            rows.extend({'id': f'control-{control:02d}-{arm}', 'kind': 'control', 'pair': control, 'arm': arm} for arm in order)
    rows.extend({'id': f'exhaustive-media-{arm}', 'kind': 'exhaustive-media', 'arm': arm} for arm in first)
    names = ['A1', 'B1', 'B2', 'A2'] if first == 'AB' else ['B1', 'A1', 'A2', 'B2']
    rows.extend({'id': f'memory/{name}', 'kind': 'memory', 'arm': name[0]} for name in names)
    if len(rows) != cell['totalImports']:
        raise ValueError('Participation inventory disagrees with frozen count')
    return rows


def counter_receipt(summary, dictionary, arm, contract):
    runs = summary.get('runs', [])
    if len(runs) != 1:
        raise ValueError('Expected exactly one run in each summary')
    phases = runs[0]['importDebug'].get('importerPhaseTimings', [])
    selected = [p for p in phases if isinstance(p, dict) and p.get('phase') == contract['phase']]
    if len(selected) != 1 or not isinstance(selected[0].get('details'), dict):
        raise ValueError('Missing or duplicate bulk-finalization receipt')
    details = selected[0]['details']
    values = {key: details.get(contract[key], 0) for key in ['countField', 'bytesField']}
    if any(type(value) is not int or not 0 <= value <= MAX_SAFE_INTEGER for value in values.values()):
        raise ValueError('Invalid envelope counter; expected nonnegative safe integers')
    count, byte_count = values['countField'], values['bytesField']
    if (count == 0) != (byte_count == 0):
        raise ValueError('Contradictory envelope count and byte receipts')
    positive = dictionary == 'vndb' and arm == 'B'
    if positive and (count <= 0 or byte_count <= 0):
        raise ValueError('VNDB candidate did not execute acknowledged owned-envelope writes')
    if not positive and (count != 0 or byte_count != 0):
        raise ValueError('An inactive arm/dictionary reported owned-envelope writes')
    return {'requiresPositive': positive, 'phase': contract['phase'],
            'countField': contract['countField'], 'bytesField': contract['bytesField'],
            'count': count, 'bytes': byte_count}


def audit_participation(plan, cell, acquisition):
    planned = expected_observations(cell)
    result = {'status': 'failed', 'expectedObservations': len(planned), 'observations': [],
              'scope': 'Separate receipt audit; original driver analysis remains unchanged; memory timing is not authoritative.'}
    try:
        identities = json.loads((acquisition / 'source-identities.json').read_text())['arms']
        actual_plan = json.loads((acquisition / 'registered-plan.json').read_text())
        ordinary = [x for x in planned if x['kind'] in ['warmup', 'candidate', 'control']]
        if actual_plan['schedule'] != ordinary or actual_plan['flagsByArm'] != dict.fromkeys('ABC'):
            raise ValueError('Driver schedule or arm flags differ from the frozen plan')
        if actual_plan['baseline'] != plan['baseline'] or actual_plan['candidate'] != plan['candidate']['sha'] or actual_plan['dictionary'] != cell['dictionary'] or actual_plan['pairs'] != cell['candidatePairs']:
            raise ValueError('Driver registration differs from the frozen revival cell')
    except Exception as error:
        identities = {}
        result['registrationError'] = str(error)
    for row in planned:
        receipt = {**row, 'status': 'failed'}
        directory = acquisition / row['id']
        try:
            arm = 'B' if row['arm'] == 'B' else 'A'
            expected_source = plan['candidate']['sha'] if arm == 'B' else plan['baseline']
            identity = identities[arm]
            summary = json.loads((directory / 'summary.json').read_text())
            if identity['sha'] != expected_source or summary['gitSha'] != expected_source or summary['importFlags'] is not None:
                raise ValueError('Summary source or flags do not match the registered arm')
            if summary['runs'][0]['packageSha256'] != identity['packageSha256']:
                raise ValueError('Summary package does not match the validated source identity')
            receipt['boundFilesSha256'] = {name: digest(directory / name) for name in
                                          ['summary.json', 'run-1.json', 'canonical-receipt.json']}
            receipt['rawCounterReceipts'] = [
                {field: phase.get('details', {}).get(field) for field in
                 [plan['participation']['countField'], plan['participation']['bytesField']]}
                for phase in summary['runs'][0]['importDebug'].get('importerPhaseTimings', [])
                if isinstance(phase, dict) and phase.get('phase') == plan['participation']['phase'] and
                isinstance(phase.get('details'), dict)
            ]
            receipt.update(counter_receipt(summary, cell['dictionary'], row['arm'], plan['participation']))
            receipt.update({'status': 'passed', 'source': expected_source, 'packageSha256': identity['packageSha256'], 'flags': None})
        except Exception as error:
            receipt['error'] = str(error)
        result['observations'].append(receipt)
    result['passedObservations'] = sum(x['status'] == 'passed' for x in result['observations'])
    if 'registrationError' not in result and result['passedObservations'] == len(planned):
        result['status'] = 'passed'
    return result


def capture(command, cwd, log):
    with log.open('wb') as output:
        return subprocess.run(command, cwd=cwd, stdout=output, stderr=subprocess.STDOUT).returncode


def validate_source(plan, repo, output, work):
    output.mkdir(parents=True, exist_ok=True)
    receipt = {'status': 'failed', 'commands': [], 'candidate': plan['candidate'], 'acquisitionLaunched': False}
    def run(command, cwd, name):
        code = capture(command, cwd, output / f'{name}.log')
        receipt['commands'].append({'name': name, 'command': command, 'exitCode': code})
        if code:
            raise RuntimeError(f'Source gate failed: {name} ({code})')
    try:
        run(['git', 'fetch', '--no-tags', '--depth=1', 'origin', plan['baseline'], plan['candidate']['sha']], repo, 'fetch')
        run(['git', 'worktree', 'add', '--detach', str(work), plan['candidate']['sha']], repo, 'checkout')
        observed = {key: subprocess.check_output(['git', 'rev-parse', value], cwd=work, text=True).strip()
                    for key, value in [('sha', 'HEAD'), ('tree', 'HEAD^{tree}')]}
        if observed != {key: plan['candidate'][key] for key in ['sha', 'tree']}:
            raise ValueError('Candidate checkout identity differs from the frozen source')
        receipt['observedSource'] = observed
        if (work / 'package-lock.json').read_bytes() != (repo / 'package-lock.json').read_bytes():
            raise ValueError('Dependency lock differs')
        (work / 'node_modules').symlink_to(repo / 'node_modules', target_is_directory=True)
        commands = [(['npm', 'run', 'build:libs'], 'build-libs'),
                    (['npm', 'run', 'license-report:html'], 'license'),
                    (['npx', 'eslint', *plan['candidate']['lintPaths']], 'scoped-lint'),
                    (['npm', 'run', 'test:ts:main'], 'main-types'),
                    (['npm', 'run', 'test:ts:test'], 'test-types'),
                    (['npx', 'vitest', 'run', *plan['candidate']['focusedTests'], '--maxWorkers=2'], 'focused-unit'),
                    (['npm', 'run', 'test:unit', '--', '--maxWorkers=2'], 'full-unit'),
                    (['npm', 'run', 'test:build'], 'all-target-dry-build')]
        for command, name in commands:
            run(command, work, name)
        if subprocess.check_output(['git', 'status', '--porcelain'], cwd=work, text=True):
            raise ValueError('Source gate left unexpected tracked or untracked changes')
        receipt['status'] = 'passed'
    except Exception as error:
        receipt['error'] = str(error)
    write_json(output / 'source-validation.json', receipt)
    return 0 if receipt['status'] == 'passed' else 1


def run_cell(plan, cell, repo, output, plan_path):
    output.mkdir(parents=True, exist_ok=False)
    acquisition = output / 'acquisition'
    command = driver_command(plan, cell, repo, acquisition)
    (output / 'frozen-revival-plan.json').write_bytes(plan_path.read_bytes())
    write_json(output / 'command.json', {'cell': cell, 'command': command, 'workflowHead': os.environ.get('GITHUB_SHA'),
                                      'planSha256': digest(plan_path), 'wrapperSha256': digest(__file__)})
    driver_exit = None
    driver_error = None
    try:
        driver_exit = capture(command, repo, output / 'driver.log')
    except Exception as error:
        driver_error = str(error)
    participation = audit_participation(plan, cell, acquisition)
    write_json(output / 'participation-audit.json', participation)
    analysis_path = acquisition / 'analysis.json'
    analysis = None
    analysis_error = None
    try:
        if analysis_path.exists():
            analysis = json.loads(analysis_path.read_text())
    except Exception as error:
        analysis_error = str(error)
    passed = driver_exit == 0 and isinstance(analysis, dict) and analysis.get('memoryPassed') is True and participation['status'] == 'passed'
    verdict = {'status': 'correctness-memory-participation-passed' if passed else 'not-qualified',
               'authoritativeCohortVerdict': True, 'driverExitCode': driver_exit,
               'driverLaunchError': driver_error, 'driverAnalysisReadError': analysis_error,
               'driverAnalysisSha256': digest(analysis_path) if analysis_path.exists() else None,
               'driverAnalysisPreservedUnchanged': True, 'participationStatus': participation['status'],
               'expectedObservations': cell['totalImports'], 'noRetryOrReplacement': True,
               'latencyConclusion': 'No automatic latency gate or promotion. Review each host and its controls under the prospective plan; this verdict cannot establish a speedup.'}
    write_json(output / 'cohort-verdict.json', verdict)
    return 0 if passed else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['check', 'validate-source', 'run'])
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--repo-root', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--worktree', type=Path)
    parser.add_argument('--dictionary', choices=['jmdict', 'jitendex', 'vndb'])
    parser.add_argument('--initial-order', choices=['AB', 'BA'])
    args = parser.parse_args()
    plan = json.loads(args.plan.read_text())
    validate_plan(plan)
    repo = args.repo_root.resolve()
    verify_locked_tooling(plan, repo)
    if args.action == 'check':
        print(json.dumps({'status': 'source-and-protocol-registered', 'planSha256': digest(args.plan), 'candidate': plan['candidate']['sha'], 'totalImports': 188, 'acquisitionLaunched': False}))
        return 0
    if args.output is None:
        parser.error('--output is required')
    if args.action == 'validate-source':
        if args.worktree is None:
            parser.error('--worktree is required')
        return validate_source(plan, repo, args.output.resolve(), args.worktree.resolve())
    cell = select_cell(plan, args.dictionary, args.initial_order)
    return run_cell(plan, cell, repo, args.output.resolve(), args.plan.resolve())


if __name__ == '__main__':
    sys.exit(main())
