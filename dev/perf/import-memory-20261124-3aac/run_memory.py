#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Run a fixed, separately instrumented import-window memory qualification."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import time

from chromium_memory import run_with_sampling, summarize_import_window
from protocol import (DEPENDENCY_PATHS, HARNESS, ROOT, WORKFLOW, command, digest,
                      harness_hashes, link_or_copy, memory_comparison,
                      package_entries, read_summary, require_dependency_source, require_package_differences,
                      save, source_identity)

HERE = Path(__file__).resolve().parent


def memory_overlay(source):
    """Add two test-only file markers to both arms; no runtime file is changed."""
    anchor = "import {existsSync, readFileSync} from 'node:fs';"
    if source.count(anchor) != 1:
        raise ValueError('Missing unique filesystem import anchor')
    source = source.replace(anchor, "import {appendFileSync, existsSync, readFileSync} from 'node:fs';")
    helper = """
const importMemoryMarkerPath = process.env.MANABITAN_IMPORT_MEMORY_MARKERS ?? '';
function recordImportMemoryMarker(event) {
    if (importMemoryMarkerPath.length > 0) {
        appendFileSync(importMemoryMarkerPath, JSON.stringify({event, monotonicNs: process.hrtime.bigint().toString(), epochMs: Date.now()}) + '\\n');
    }
}

"""
    anchor = '/**\n * Exercise real browser confirmation dialogs'
    if source.count(anchor) != 1:
        raise ValueError('Missing unique marker helper anchor')
    source = source.replace(anchor, helper + anchor)
    anchor = "        const initialImportTriggerStart = safePerformance.now();"
    if source.count(anchor) != 1:
        raise ValueError('Missing unique import start anchor')
    source = source.replace(anchor, "        recordImportMemoryMarker('start');\n" + anchor)
    anchor = "            const importTotalEnd = safePerformance.now();"
    if source.count(anchor) != 1:
        raise ValueError('Missing unique import end anchor')
    source = source.replace(anchor, "            recordImportMemoryMarker('end');\n" + anchor)
    return source


def schedule(replication):
    if replication not in (1, 2):
        raise ValueError('Replication must be 1 or 2')
    arms = 'ABBA' if replication == 1 else 'BAAB'
    counts = {'A': 0, 'B': 0}
    result = []
    for index, arm in enumerate(arms, 1):
        counts[arm] += 1
        result.append({'index': index, 'arm': arm, 'name': f'{arm}{counts[arm]}', 'pair': (index - 1) // 2 + 1})
    return result


def run(args, evidence):
    if command(['node', '--version']) != 'v22.22.0':
        raise ValueError('Memory qualification is pinned to Node 22.22.0')
    identities = {'A': source_identity(args.baseline), 'B': source_identity(args.candidate)}
    if args.baseline == args.candidate:
        raise ValueError('Candidate must differ from baseline')
    command(['git', 'merge-base', '--is-ancestor', args.baseline, args.candidate])
    expected = json.loads(args.expected_differences)
    if (not isinstance(expected, list) or not expected or
            any(not isinstance(name, str) for name in expected) or expected != sorted(set(expected))):
        raise ValueError('Freeze a nonempty sorted unique packaged difference list')
    fixture_lock = json.loads((ROOT / 'test/perf/dictionaries.lock.json').read_text())
    fixture = fixture_lock['dictionaries'][args.dictionary]
    source_files = [str(path.relative_to(ROOT)) for path in sorted(HERE.iterdir()) if path.is_file()] + [WORKFLOW, *DEPENDENCY_PATHS]
    plan = {
        'schemaVersion': 1, 'dictionary': args.dictionary, 'replication': args.replication,
        'sourceIdentities': identities, 'fixture': fixture, 'schedule': schedule(args.replication),
        'toolingCommit': command(['git', 'rev-parse', 'HEAD']),
        'sourceFiles': {name: digest(ROOT / name) for name in source_files},
        'workflowRun': os.environ.get('GITHUB_RUN_ID'), 'workflowAttempt': os.environ.get('GITHUB_RUN_ATTEMPT'),
        'authoritativeTiming': False,
        'scope': 'External import-window PSS/private diagnostics. Raw native-harness timing labels are non-authoritative under this observer.',
        'expectedPackageDifferences': expected, 'mediaCheck': 'sample',
        'exhaustiveMediaQualification': 'Separate existing whole-import timing study diagnostics; this memory study does not replace them.',
        'dependencyPreparation': 'Real node_modules directories from the normal npm ci setup; exact tooling/arm manifest and setup hashes required before hardlink/copy, internal symlinks preserved.',
        'dependencySourceSha256': {name: digest(ROOT / name) for name in DEPENDENCY_PATHS},
        'promotionCriteria': {'maximumMedianPairedIncreasePercent': 5, 'maximumIndividualPairedIncreasePercent': 10,
                              'everyObservationQualified': True, 'bothIndependentReplicationsRequired': True},
        'frozenCoverage': {'minimumFullyCoveredImportScans': 5, 'maximumCoveredGapMs': 250,
                           'maximumBracketGapMs': 250, 'betweenScanWaitMs': 25},
        'observerProvenance': 'Unchanged chromium_memory.py and audit_memory.py from f2f08c8ee74cdea548c5c1b494ec15bf10360b46; marker overlay retained.',
    }
    save(evidence / 'plan.json', plan)
    for name in source_files:
        target = evidence / 'source' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
    stage = Path(tempfile.mkdtemp(prefix='import-memory-3aac-', dir=os.environ.get('RUNNER_TEMP')))
    roots, packages, arm_identities = {}, {}, {}
    cache = ROOT / 'builds/e2e-dictionary-cache'
    cache.mkdir(parents=True, exist_ok=True)
    for arm in ('A', 'B'):
        source = stage / arm
        command(['git', 'worktree', 'add', '--detach', str(source), identities[arm]['commit']], log=evidence / f'{arm}-checkout.log')
        hashes = harness_hashes(source)
        if arm == 'A':
            plan['harnessSha256'] = hashes
            overlay = memory_overlay((source / HARNESS).read_text())
            plan['memoryOverlaySha256'] = hashlib.sha256(overlay.encode()).hexdigest()
            plan['markerOverlayPath'] = HARNESS
            (evidence / 'memory-harness.e2e.js').write_text(overlay)
            (evidence / 'original-harness.e2e.js').write_bytes((source / HARNESS).read_bytes())
            save(evidence / 'plan.json', plan)
        if hashes != plan['harnessSha256']:
            raise ValueError(f'Native harness, fixture locks or dependencies differ between arms: {arm}')
        if digest(source / 'test/perf/dictionaries.lock.json') != digest(ROOT / 'test/perf/dictionaries.lock.json'):
            raise ValueError('Tooling fixture lock differs from frozen sources')
        if require_dependency_source(source, ROOT) != plan['dependencySourceSha256']:
            raise ValueError('Tooling dependencies changed after the protocol was frozen')
        shutil.copytree((ROOT / 'node_modules').resolve(), source / 'node_modules', symlinks=True, copy_function=link_or_copy)
        (source / 'builds').mkdir(exist_ok=True)
        (source / 'builds/e2e-dictionary-cache').symlink_to(cache, target_is_directory=True)
        command(['npm', 'run', 'build:libs'], source, evidence / f'{arm}-libs.log')
        command(['npm', 'run', 'build', '--', '--target', 'chrome'], source, evidence / f'{arm}-build.log')
        if command(['git', 'status', '--porcelain'], source) or harness_hashes(source) != hashes:
            raise ValueError(f'Build changed frozen source/harness in {arm}')
        package = source / 'builds/manabitan-chrome.zip'
        packages[arm] = package_entries(package)
        save(evidence / f'{arm}-package-entries.json', packages[arm])
        shutil.copyfile(package, evidence / f'{arm}-product.zip')
        (source / HARNESS).write_text(overlay)
        status = command(['git', 'status', '--porcelain'], source)
        if status != f'M {HARNESS}' or command(['git', 'diff', '--name-only'], source) != HARNESS:
            raise ValueError(f'Unexpected source changes outside marker overlay in {arm}: {status!r}')
        arm_identities[arm] = {**identities[arm], 'packageSha256': digest(package), 'buildCleanBeforeOverlay': True,
                               'statusWithHarnessOverlay': status, 'harnessOverlaySha256': digest(source / HARNESS)}
        save(evidence / f'{arm}-identity.json', arm_identities[arm])
        roots[arm] = source
    differences = require_package_differences(packages, expected)
    save(evidence / 'package-differences.json', differences)
    command(['git', 'diff', '--stat', args.baseline, args.candidate], log=evidence / 'source-differences.txt')
    cache_ids = ['jmdict', 'jmnedict', 'jitendex'] + (['vndb'] if args.dictionary == 'vndb' else [])
    command(['node', 'dev/perf/prepare-dictionaries.js', *cache_ids], roots['A'], evidence / 'fixtures.log')
    checked = {}
    for name in cache_ids:
        item = fixture_lock['dictionaries'][name]
        archive = cache / item['cacheFile']
        if archive.stat().st_size != item['sizeBytes'] or digest(archive) != item['sha256']:
            raise ValueError(f'Fixture bytes differ from lock: {name}')
        checked[name] = item
    save(evidence / 'setup-fixtures.json', checked)
    observations, correctness = [], []
    expected_receipt = None
    for observation in plan['schedule']:
        output = evidence / observation['name']
        output.mkdir()
        arm = observation['arm']
        source = roots[arm]
        started = time.time()
        print(f"{args.dictionary} replication {args.replication}: {observation['name']}", flush=True)
        acquisition = {**observation, 'source': identities[arm], 'packageSha256': arm_identities[arm]['packageSha256'],
                       'startedEpochSeconds': started, 'retried': False, 'authoritativeTiming': False}
        save(output / 'acquisition.json', acquisition)
        try:
            command(['node', 'dev/perf/host-environment.js'], source, output / 'host-before.json')
            memory = run_with_sampling(
                ['node', 'dev/perf/import-benchmark.js', args.dictionary, '--runs', '1', '--no-build',
                 '--build-target', 'chrome', '--media-check', 'sample', '--output', str(output)],
                source, output / 'run.log', output / 'memory.json', output / 'markers.jsonl')
        except Exception as error:
            save(output / 'sampling-failure.json', {'type': type(error).__name__, 'message': str(error), 'retried': False})
            # Retain partial bytes without inventing readable zero memory or
            # substituting a fifth observation for a failed acquisition.
            path = output / 'memory.json'
            if path.exists():
                path.rename(output / 'memory-incomplete.json')
            marker_path = output / 'markers.jsonl'
            if not marker_path.exists():
                marker_path.write_text('')
            try:
                markers = [json.loads(line) for line in marker_path.read_text().splitlines() if line]
            except json.JSONDecodeError:
                markers = []
            raw = summarize_import_window([], markers, -1)
            save(path, raw)
            memory = {key: value for key, value in raw.items() if key != 'samples'}
        acquisition['endedEpochSeconds'] = time.time()
        save(output / 'acquisition.json', acquisition)
        observations.append({**observation, **memory})
        save(evidence / 'observations.json', observations)
        check = {'name': observation['name'], 'status': 'failed', 'authoritativeTiming': False}
        try:
            receipt = read_summary(output, plan, arm, arm_identities[arm])
            if expected_receipt is not None and receipt != expected_receipt:
                raise ValueError('Lookup/media/storage/browser receipts differ across arms or observations')
            expected_receipt = receipt
            if memory['benchmarkExitCode'] != 0:
                raise ValueError('Native benchmark command failed')
            check.update(status='passed', receipt=receipt)
        except Exception as error:
            check['error'] = str(error)
        save(output / 'correctness.json', check)
        correctness.append(check)
        save(evidence / 'correctness.json', correctness)
        try:
            command(['node', 'dev/perf/host-environment.js'], source, output / 'host-after.json')
        except Exception as error:
            save(output / 'host-after-failure.json', {'error': str(error)})
    comparison = memory_comparison(observations, args.dictionary, args.replication, schedule)
    save(evidence / 'memory-comparison.json', comparison)
    for arm, source in roots.items():
        hashes = harness_hashes(source)
        hashes[HARNESS] = plan['harnessSha256'][HARNESS]
        if (hashes != plan['harnessSha256'] or digest(source / HARNESS) != plan['memoryOverlaySha256'] or
                command(['git', 'status', '--porcelain'], source) != f'M {HARNESS}' or
                digest(source / 'builds/manabitan-chrome.zip') != arm_identities[arm]['packageSha256']):
            raise ValueError(f'Frozen source/package/marker overlay changed during observations: {arm}')
    command(['python3', str(HERE / 'audit_memory.py'), str(evidence)], log=evidence / 'memory-audit.log')
    command(['python3', str(HERE / 'verify_receipts.py'), str(evidence)], log=evidence / 'receipt-audit.log')
    passed = comparison['passesProspectiveMemoryScreen'] and all(row['status'] == 'passed' for row in correctness)
    save(evidence / 'qualification.json', {'status': 'passed' if passed else 'failed', 'authoritativeTiming': False,
        'memoryScreenPassed': comparison['passesProspectiveMemoryScreen'],
        'correctnessPassed': all(row['status'] == 'passed' for row in correctness),
        'bothIndependentReplicationsRequired': True, 'retriedObservations': 0})
    if not passed:
        raise RuntimeError('Memory coverage/gates or correctness failed; every scheduled observation is retained without replacement')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', required=True)
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--dictionary', choices=('jmdict', 'jitendex', 'vndb'), required=True)
    parser.add_argument('--replication', type=int, choices=(1, 2), required=True)
    parser.add_argument('--expected-differences', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    evidence = args.output.resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    try:
        run(args, evidence)
    except BaseException as error:
        save(evidence / 'failure.json', {'type': type(error).__name__, 'message': str(error),
                                        'recordedAtEpochSeconds': time.time(), 'retried': False})
        raise


if __name__ == '__main__':
    main()
