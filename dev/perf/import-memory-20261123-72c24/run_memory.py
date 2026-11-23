#!/usr/bin/env python3
"""Execute the separately frozen four-observation memory diagnostic per cell."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import statistics
import tempfile
import time
import zipfile

from chromium_memory import run_with_sampling

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
STUDY = ROOT / 'dev/perf/import-study-20261123'
spec = importlib.util.spec_from_file_location('timing_study', STUDY / 'run.py')
study = importlib.util.module_from_spec(spec)
spec.loader.exec_module(study)
command, save, digest = study.command, study.save, study.digest


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
    arms = 'ABBA' if replication == 1 else 'BAAB'
    counts = {'A': 0, 'B': 0}
    result = []
    for index, arm in enumerate(arms, 1):
        counts[arm] += 1
        result.append({'index': index, 'arm': arm, 'name': f'{arm}{counts[arm]}', 'pair': (index - 1) // 2 + 1})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dictionary', choices=('jmdict', 'jitendex', 'vndb'), required=True)
    parser.add_argument('--replication', type=int, choices=(1, 2), required=True)
    args = parser.parse_args()
    config = study.read_config()
    evidence = ROOT / 'builds/import-memory-20261123-72c24' / args.dictionary / str(args.replication)
    evidence.mkdir(parents=True, exist_ok=False)
    try:
        if command(['node', '--version']) != 'v22.22.0':
            raise ValueError('The diagnostic is pinned to Node 22.22.0')
        fixture = json.loads((ROOT / study.OVERLAY[0]).read_text())['dictionaries'][args.dictionary]
        overlay = memory_overlay((ROOT / 'test/chromium/extension-two-dictionary-import.e2e.js').read_text())
        source_files = [*study.OVERLAY, *study.TIMING_SOURCE,
                        'dev/perf/import-study-20261123/run.py', 'dev/perf/import-study-20261123/verify.mjs',
                        'dev/perf/import-study-20261123/config.json', 'dev/perf/import-study-20261123/README.md',
                        'dev/perf/import-memory-20261123-72c24/run_memory.py',
                        'dev/perf/import-memory-20261123-72c24/chromium_memory.py',
                        'dev/perf/import-memory-20261123-72c24/verify-memory.mjs',
                        'dev/perf/import-memory-20261123-72c24/audit_memory.py',
                        'dev/perf/import-memory-20261123-72c24/test_parallel_reads.py',
                        '.github/workflows/import-memory-20261123-72c24.yml']
        plan = {'schemaVersion': 1, 'dictionary': args.dictionary, 'replication': args.replication,
                'config': config, 'fixture': fixture, 'schedule': schedule(args.replication),
                'harnessSha': command(['git', 'rev-parse', 'HEAD']),
                'workflowRun': os.environ.get('GITHUB_RUN_ID'), 'workflowAttempt': os.environ.get('GITHUB_RUN_ATTEMPT'),
                'authoritativeTiming': False,
                'scope': 'Separate import-window PSS/private diagnostics; all internal benchmark timing labels are non-authoritative under this external observer',
                'sourceFiles': {name: digest(ROOT / name) for name in source_files},
                'memoryOverlaySha256': hashlib.sha256(overlay.encode()).hexdigest(),
                'promotionCriteria': {'maximumMedianPairedIncreasePercent': 5,
                                      'maximumIndividualPairedIncreasePercent': 10,
                                      'everyObservationQualified': True},
                'frozenCoverage': {'minimumFullyCoveredImportScans': 5,
                                   'maximumCoveredGapMs': 250, 'maximumBracketGapMs': 250,
                                   'betweenScanWaitMs': 25, 'maximumConcurrentSmapsReads': 4,
                                   'maximumConcurrentScans': 1,
                                   'joinAllReadsBeforeAfterInventory': True}}
        save(evidence / 'plan.json', plan)
        for name in source_files:
            target = evidence / 'source' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        (evidence / 'memory-harness.e2e.js').write_text(overlay)
        command(['node', '--input-type=module', '-e',
                 "import {ensurePinnedDictionaryCache} from './dev/perf/dictionary-fixtures.js'; await ensurePinnedDictionaryCache('builds/e2e-dictionary-cache',[process.argv[1]])", args.dictionary], log=evidence / 'fixtures.log')
        archive = ROOT / 'builds/e2e-dictionary-cache' / fixture['cacheFile']
        if archive.stat().st_size != fixture['sizeBytes'] or digest(archive) != fixture['sha256']:
            raise ValueError('Fixture bytes differ from lock')
        save(evidence / 'media-reference.json', study.media_reference(archive, fixture)['all'])
        stage = Path(tempfile.mkdtemp(prefix='import-memory-', dir=os.environ.get('RUNNER_TEMP')))
        roots, packages, identities = {}, {}, {}
        for arm, sha in (('A', config['baseline']), ('B', config['candidate'])):
            source = stage / arm
            command(['git', 'worktree', 'add', '--detach', str(source), sha], log=evidence / f'{arm}-checkout.log')
            for name in study.TIMING_SOURCE:
                if digest(source / name) != plan['sourceFiles'][name]:
                    raise ValueError('Timing/dependency source changed: ' + name)
            for name in study.OVERLAY:
                shutil.copyfile(ROOT / name, source / name)
            (source / 'test/chromium/extension-two-dictionary-import.e2e.js').write_text(overlay)
            (source / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
            (source / 'builds').mkdir(exist_ok=True)
            (source / 'builds/e2e-dictionary-cache').symlink_to(ROOT / 'builds/e2e-dictionary-cache', target_is_directory=True)
            for name, script in (('libs', 'build:libs'), ('license', 'license-report:html'), ('build', 'build')):
                invocation = ['npm', 'run', script]
                if name == 'build':
                    invocation += ['--', '--target', 'chrome']
                command(invocation, cwd=source, log=evidence / f'{arm}-{name}.log')
            package = source / 'builds/manabitan-chrome.zip'
            with zipfile.ZipFile(package) as archive_zip:
                packages[arm] = {entry.filename: hashlib.sha256(archive_zip.read(entry)).hexdigest()
                                 for entry in archive_zip.infolist() if not entry.is_dir()}
            save(evidence / f'{arm}-package-entries.json', packages[arm])
            identities[arm] = {'sha': sha, 'packageSha256': digest(package),
                               'statusWithHarnessOverlay': command(['git', 'status', '--porcelain'], cwd=source)}
            save(evidence / f'{arm}-identity.json', identities[arm])
            roots[arm] = source
        differences = sorted(name for name in packages['A'].keys() | packages['B'].keys()
                             if packages['A'].get(name) != packages['B'].get(name))
        save(evidence / 'package-differences.json', differences)
        if differences != config['expectedPackageDifferences']:
            raise ValueError('Unexpected packaged product differences: ' + repr(differences))
        observations = []
        for observation in plan['schedule']:
            output = evidence / observation['name']
            output.mkdir()
            command(['node', 'dev/perf/host-environment.js'], log=output / 'host-before.json')
            started = time.time()
            print(f"{args.dictionary} replication {args.replication}: {observation['name']}", flush=True)
            memory = run_with_sampling(
                ['node', 'dev/perf/import-benchmark.js', args.dictionary, '--runs', '1', '--no-build',
                 '--build-target', 'chrome', '--media-check', 'all', '--output', str(output)],
                roots[observation['arm']], output / 'run.log', output / 'memory.json', output / 'markers.jsonl')
            acquisition = {**observation, 'startedEpochSeconds': started, 'endedEpochSeconds': time.time(), 'retried': False}
            save(output / 'acquisition.json', acquisition)
            command(['node', 'dev/perf/host-environment.js'], log=output / 'host-after.json')
            observations.append({**observation, **memory})
            save(evidence / 'observations.json', observations)
        pairs = []
        qualified = all(row['qualifiedForWholeTreePss'] for row in observations)
        for index in (1, 2):
            arms = {row['arm']: row for row in observations if row['pair'] == index}
            pair = {'pair': index, 'qualified': all(row['qualifiedForWholeTreePss'] for row in arms.values())}
            for metric in ('maxSampledPssKiB', 'maxSampledPrivateKiB'):
                a, b = arms['A'][metric], arms['B'][metric]
                pair[metric] = {'baseline': a, 'candidate': b,
                                'changePercent': 100 * (b / a - 1) if pair['qualified'] and a > 0 else None}
            pairs.append(pair)
        metrics = {}
        for metric in ('maxSampledPssKiB', 'maxSampledPrivateKiB'):
            changes = [pair[metric]['changePercent'] for pair in pairs]
            metrics[metric] = {'medianPairedChangePercent': statistics.median(changes) if qualified else None,
                               'maximumPairedChangePercent': max(changes) if qualified else None}
        passes = qualified and all(value['medianPairedChangePercent'] <= 5 and value['maximumPairedChangePercent'] <= 10 for value in metrics.values())
        save(evidence / 'memory-comparison.json', {'schemaVersion': 1, 'dictionary': args.dictionary,
             'replication': args.replication, 'authoritativeTiming': False, 'observations': observations,
             'pairs': pairs, 'metrics': metrics, 'everyObservationQualified': qualified,
             'passesProspectiveMemoryScreen': passes})
        command(['python3', str(HERE / 'audit_memory.py'), str(evidence)], log=evidence / 'memory-audit.log')
        command(['node', str(HERE / 'verify-memory.mjs'), str(evidence)], log=evidence / 'verification.log')
        if not qualified:
            raise RuntimeError('Memory coverage failed; every fixed observation remains retained, null maxima are not replaced')
        if not passes:
            raise RuntimeError('Prospective memory screen failed; every observation and pair remains retained')
    except BaseException as error:
        save(evidence / 'failure.json', {'type': type(error).__name__, 'message': str(error),
                                        'recordedAtEpochSeconds': time.time(), 'retried': False})
        raise


if __name__ == '__main__':
    main()
