#!/usr/bin/env python3
"""Frozen four-observation memory cells for source PR #905.

Copyright (C) 2026 Manabitan authors
SPDX-License-Identifier: GPL-3.0-or-later
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import statistics
import subprocess
import sys
import time

from chromium_memory import run_with_sampling
from overlay_helpers import memory_overlay, overlay_sources, schedule, OVERLAY_PATHS
import packaging_helpers as study


HERE = Path(__file__).resolve().parent
ROOT = study.ROOT
PROTOCOL_PATH = HERE / 'protocol.json'
OUTPUT = ROOT / 'builds/memory-qualification'
SUMMARY_OUTPUT = ROOT / 'builds/memory-qualification-summary/summary.json'
WORKFLOW_PATH = ROOT / '.github/workflows/import-memory-ef009.yml'
PROMOTION_CRITERIA = {
    'maximumMedianPairedIncreasePercent': 5,
    'maximumIndividualPairedIncreasePercent': 10,
    'everyObservationQualified': True,
}
FROZEN_COVERAGE = {
    'minimumFullyCoveredImportScans': 5,
    'maximumCoveredGapMs': 250,
    'maximumBracketGapMs': 250,
    'betweenScanWaitMs': 25,
}
RUN_CONTEXT = {}
OUTPUT_CREATED = False
command, save, digest = study.command, study.write_json, study.sha256


def validate_protocol(config):
    for name, commit in [('base', config['base']), ('candidate', config['candidate']['commit'])]:
        if not isinstance(commit, str) or re.fullmatch(r'[0-9a-f]{40}', commit) is None:
            raise RuntimeError(f'Unfrozen source commit for {name}')
    if config['promotionCriteria'] != PROMOTION_CRITERIA or config['frozenCoverage'] != FROZEN_COVERAGE:
        raise RuntimeError('The reviewed observer coverage and memory limits must remain unchanged')
    if config['orders'] != {'1': 'ABBA', '2': 'BAAB'} or config['observationsPerHost'] != 4:
        raise RuntimeError('The four-observation adjacent-pair schedule must remain unchanged')
    if config['dictionaries'] != ['jmdict', 'jitendex', 'vndb'] or config['independentHostsPerDictionary'] != 2:
        raise RuntimeError('All three dictionaries require two independent hosted cells each')


def build_comparison(observations, expected_schedule, validation_failures):
    if len(observations) != 4 or [
        {key: row[key] for key in ('index', 'arm', 'name', 'pair')} for row in observations
    ] != expected_schedule:
        raise RuntimeError('Missing, duplicated, or reordered observations cannot qualify')
    qualified = all(row['qualifiedForWholeTreePss'] for row in observations)
    pairs = []
    for index in (1, 2):
        cohort = {row['arm']: row for row in observations if row['pair'] == index}
        pair = {'pair': index, 'qualified': all(row['qualifiedForWholeTreePss'] for row in cohort.values())}
        for metric in ('maxSampledPssKiB', 'maxSampledPrivateKiB'):
            a, b = cohort['A'][metric], cohort['B'][metric]
            pair[metric] = {
                'baseline': a, 'candidate': b,
                'changePercent': 100 * (b / a - 1) if pair['qualified'] and a > 0 else None,
            }
        pairs.append(pair)
    metrics = {}
    for metric in ('maxSampledPssKiB', 'maxSampledPrivateKiB'):
        changes = [pair[metric]['changePercent'] for pair in pairs]
        metrics[metric] = {
            'medianPairedChangePercent': statistics.median(changes) if qualified else None,
            'maximumPairedChangePercent': max(changes) if qualified else None,
        }
    passes = qualified and all(
        row['medianPairedChangePercent'] <= 5 and row['maximumPairedChangePercent'] <= 10
        for row in metrics.values()
    )
    return {
        'schemaVersion': 1, 'authoritativeTiming': False,
        'observations': observations, 'pairs': pairs, 'metrics': metrics,
        'everyObservationQualified': qualified, 'passesProspectiveMemoryScreen': passes,
        'validationFailures': validation_failures,
    }


def export_compact_summary(error=None):
    def read_json(name):
        path = OUTPUT / name
        return json.loads(path.read_text()) if path.exists() else None

    observations = read_json('observations.json') or []
    comparison = read_json('memory-comparison.json')
    audit = read_json('memory-audit.json')
    proofs = []
    for observation in observations:
        path = OUTPUT / observation['name'] / 'semantic-receipt.json'
        if not path.exists():
            continue
        receipt = json.loads(path.read_text())
        public_results = json.dumps(receipt['publicResults'], sort_keys=True, ensure_ascii=False).encode()
        proofs.append({
            'name': observation['name'], 'semanticReceiptSha256': digest(path),
            'publicResultSha256': hashlib.sha256(public_results).hexdigest(),
            'publicLookupObservationCount': 72, 'distinctProbeCount': len(receipt['publicResults']),
            'termRows': receipt['termRows'], 'contentReadable': receipt['contentReadable'],
            'restartContentReadable': receipt['restart']['contentReadable'], 'media': receipt['media'],
        })
    complete = len(observations) == 4 and len(proofs) == 4 and comparison is not None and audit is not None
    passes = bool(complete and error is None and not comparison['validationFailures'] and
                  comparison['passesProspectiveMemoryScreen'] and audit['passesProspectiveMemoryScreen'])
    fields = (
        'index', 'arm', 'name', 'pair', 'qualifiedForWholeTreePss', 'qualificationFailures',
        'maxSampledPssKiB', 'maxSampledPrivateKiB', 'benchmarkExitCode',
        'allObservedSampleCount', 'stableFullyReadImportSampleCount',
        'maximumCoveredSampleGapMs', 'preImportBracketGapMs', 'postImportBracketGapMs',
    )
    summary = {
        'schemaVersion': 1, 'authoritativeTiming': False, **RUN_CONTEXT,
        'status': 'passed' if passes else ('failed' if complete else 'incomplete'),
        'error': error, 'acquisitionComplete': complete, 'passesProspectiveMemoryScreen': passes,
        'plan': read_json('plan.json'), 'fixture': read_json('fixture.json'),
        'packageDelta': read_json('package-delta.json'),
        'packages': {arm: read_json(f'package-memory-{arm}-receipt.json') for arm in 'AB'},
        'overlayReceipts': read_json('overlay-receipts.json'),
        'observations': [{key: row[key] for key in fields} for row in observations],
        'semanticProofs': proofs,
        'pairs': comparison['pairs'] if comparison else None,
        'metrics': comparison['metrics'] if comparison else None,
        'validationFailures': read_json('validation-failures.json') or [],
        'independentAudit': audit,
        'limitation': 'One cell of the frozen six-cell study. Sampled maxima are not exact peaks; instrumented latency is non-authoritative. All six cells must pass on independent hosts.',
    }
    save(SUMMARY_OUTPUT, summary)
    print('IMPORT_MEMORY_SUMMARY ' + json.dumps(summary, ensure_ascii=False), flush=True)
    return summary


def main():
    global OUTPUT_CREATED
    parser = argparse.ArgumentParser()
    parser.add_argument('dictionary', choices=['jmdict', 'jitendex', 'vndb'])
    parser.add_argument('replication', type=int, choices=[1, 2])
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args()
    config = json.loads(PROTOCOL_PATH.read_text())
    validate_protocol(config)
    candidate = config['candidate']
    RUN_CONTEXT.update({'candidate': candidate['name'], 'dictionary': args.dictionary,
                        'replication': args.replication, 'prepareOnly': args.prepare_only})
    if command(['node', '--version']).stdout.strip() != config['nodeVersion']:
        raise RuntimeError('Memory qualification requires Node 22.22.0')
    OUTPUT.mkdir(parents=True, exist_ok=False)
    OUTPUT_CREATED = True
    shutil.copytree(HERE, OUTPUT / 'observer-source', ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copyfile(PROTOCOL_PATH, OUTPUT / 'protocol.json')
    shutil.copyfile(HERE / 'packaging_helpers.py', OUTPUT / 'executed-packager.py')
    shutil.copyfile(WORKFLOW_PATH, OUTPUT / 'executed-workflow.yml')
    command(['git', 'diff', '--exit-code', config['base'], candidate['commit'], '--',
             'package.json', 'package-lock.json', 'dev/perf', 'test/chromium', 'test/e2e', 'test/perf',
             'ext/js/pages/settings/dictionary-import-controller.js'])
    (OUTPUT / 'candidate.patch').write_bytes(subprocess.check_output(
        ['git', 'diff', '--binary', config['base'], candidate['commit']], cwd=ROOT))
    originals = {name: (ROOT / name).read_text() for name in OVERLAY_PATHS}
    overlays = overlay_sources(originals)
    original_hashes = {name: hashlib.sha256(source.encode()).hexdigest() for name, source in originals.items()}
    overlay_hashes = {name: hashlib.sha256(source.encode()).hexdigest() for name, source in overlays.items()}
    for name in OVERLAY_PATHS:
        for directory, contents in [('original-harness', originals[name]), ('memory-harness', overlays[name])]:
            destination = OUTPUT / directory / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(contents)
    plan = {
        'schemaVersion': 2, **RUN_CONTEXT, 'schedule': schedule(args.replication), 'config': config,
        'workflowCommit': command(['git', 'rev-parse', 'HEAD']).stdout.strip(),
        'workflowRun': os.environ.get('GITHUB_RUN_ID'), 'workflowAttempt': os.environ.get('GITHUB_RUN_ATTEMPT'),
        'hostIdentity': {'hostname': socket.gethostname(),
                         'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                         'runnerName': os.environ.get('RUNNER_NAME'),
                         'runnerEnvironment': os.environ.get('RUNNER_ENVIRONMENT')},
        'authoritativeTiming': False,
        'scope': 'Separate import-window PSS/private diagnosis. Browser report, benchmark summary, and outer receipts explicitly mark instrumented timing as non-authoritative.',
        'originalHarnessSha256': original_hashes, 'memoryOverlaySha256': overlay_hashes,
        'protocolSha256': digest(PROTOCOL_PATH), 'provenanceSha256': digest(HERE / 'provenance.json'),
        'observerSha256': {path.name: digest(path) for path in sorted(HERE.glob('*.py'))},
        'promotionCriteria': config['promotionCriteria'], 'frozenCoverage': config['frozenCoverage'],
        'limitations': config['criterion']['limitations'],
    }
    save(OUTPUT / 'plan.json', plan)
    command(['node', 'dev/perf/prepare-dictionaries.js', args.dictionary], log=OUTPUT / 'fixture-prepare.log')
    cache = (ROOT / 'builds/e2e-dictionary-cache').resolve()
    fixture = json.loads((ROOT / 'test/perf/dictionaries.lock.json').read_text())['dictionaries'][args.dictionary]
    fixture_path = cache / fixture['cacheFile']
    if digest(fixture_path) != fixture['sha256'] or fixture_path.stat().st_size != fixture['sizeBytes']:
        raise RuntimeError('Pinned source archive mismatch')
    save(OUTPUT / 'fixture.json', fixture)
    arms, receipts, members, overlay_receipts = {}, {}, {}, {}
    for arm, commit in [('A', config['base']), ('B', candidate['commit'])]:
        location, receipt, hashes = study.prepare_arm('memory-' + arm, commit, OUTPUT, cache)
        if arm == 'B' and receipt['sourceTree'] != candidate['tree']:
            raise RuntimeError('Candidate source tree mismatch')
        arms[arm], receipts[arm], members[arm] = location, receipt, hashes
        for name in OVERLAY_PATHS:
            if digest(location / name) != original_hashes[name]:
                raise RuntimeError(f'Original memory harness differs between arms: {name}')
            (location / name).write_text(overlays[name])
        applied_hashes = {name: digest(location / name) for name in OVERLAY_PATHS}
        if applied_hashes != overlay_hashes:
            raise RuntimeError('Applied memory overlay hash mismatch')
        overlay_receipts[arm] = {'sourceCommit': receipt['sourceCommit'],
                                 'originalSha256': original_hashes, 'appliedSha256': applied_hashes}
    if receipts['A']['harnessSha256'] != receipts['B']['harnessSha256']:
        raise RuntimeError('Harness or fixture changes between arms')
    save(OUTPUT / 'overlay-receipts.json', overlay_receipts)
    changes = sorted(name for name in members['A'].keys() | members['B'].keys()
                     if members['A'].get(name) != members['B'].get(name))
    save(OUTPUT / 'package-delta.json', changes)
    if changes != sorted(candidate['packagedDelta']):
        raise RuntimeError('Unreviewed package differences in memory screen')
    if args.prepare_only:
        return
    observations, validation_failures = [], []
    semantic = None
    for item in plan['schedule']:
        destination = OUTPUT / item['name']
        destination.mkdir()
        arm_root, receipt = arms[item['arm']], receipts[item['arm']]
        try:
            command(['node', 'dev/perf/host-environment.js'], cwd=arm_root, log=destination / 'host-before.json')
            memory = run_with_sampling(
                ['node', 'dev/perf/import-benchmark.js', args.dictionary, '--runs', '1', '--no-build',
                 '--build-target', 'chrome', '--media-check', 'all', '--output', str(destination)],
                arm_root, destination / 'run.log', destination / 'memory.json', destination / 'markers.jsonl')
        except BaseException as error:
            save(destination / 'acquisition-failure.json', {
                **item, 'status': 'incomplete', 'type': type(error).__name__, 'error': str(error),
                'sampleMaxima': None, 'retried': False,
            })
            raise
        observations.append({**item, **memory})
        save(OUTPUT / 'observations.json', observations)
        try:
            report = json.loads((destination / 'run-1.json').read_text())
            summary = json.loads((destination / 'summary.json').read_text())
            if len(summary['runs']) != 1:
                raise RuntimeError('Expected one complete import in each memory observation')
            if report['status'] != 'success' or report['skippedVerification']:
                raise RuntimeError('Memory observation failed import validation')
            if report['benchmark']['authoritativeTiming'] is not False or summary['authoritativeTiming'] is not False:
                raise RuntimeError('Instrumented browser or benchmark timing was mislabeled authoritative')
            if report['packageSha256'] != receipt['packageSha256'] or report['browserVersion'] != config['browserVersion']:
                raise RuntimeError('Executed release or browser mismatch')
            if summary['gitSha'] != receipt['sourceCommit'] or any(
                summary['source']['sha256'][name] != overlay_hashes[name] for name in OVERLAY_PATHS
            ):
                raise RuntimeError('Source lineage or applied overlay mismatch')
            current = study.semantic_receipt(report)
            media = current['media']
            if (media['mode'] != 'all' or media['files'] != fixture['mediaFiles'] or
                    media['files'] != media['totalFiles'] or media['bytes'] != fixture['mediaBytes'] or
                    media['bytes'] != media['totalBytes']):
                raise RuntimeError('Memory observation did not verify every persisted media payload')
            if semantic is not None and current != semantic:
                raise RuntimeError('Public lookup, restart, or complete media readback differs across observations')
            semantic = current
            if memory['windowDurationMs'] is None or memory['windowDurationMs'] < summary['runs'][0]['totalImportMs']:
                raise RuntimeError('Marked memory window does not cover browser import interval')
            save(destination / 'semantic-receipt.json', current)
        except Exception as error:
            validation_failures.append({'name': item['name'], 'error': str(error)})
            save(OUTPUT / 'validation-failures.json', validation_failures)
        command(['node', 'dev/perf/host-environment.js'], cwd=arm_root, log=destination / 'host-after.json', check=False)
        print(json.dumps({'name': item['name'], 'qualified': memory['qualifiedForWholeTreePss'],
                          'pssKiB': memory['maxSampledPssKiB'], 'privateKiB': memory['maxSampledPrivateKiB'],
                          'authoritativeTiming': False}), flush=True)
    comparison = build_comparison(observations, plan['schedule'], validation_failures)
    save(OUTPUT / 'memory-comparison.json', comparison)
    command(['python3', str(HERE / 'audit_memory.py'), str(OUTPUT)], log=OUTPUT / 'independent-audit.log')
    if not comparison['passesProspectiveMemoryScreen'] or validation_failures:
        raise RuntimeError('Memory coverage, prospective memory gate, or semantic validation failed; no observations replaced')


if __name__ == '__main__':
    failure = None
    try:
        main()
    except BaseException as error:
        failure = str(error)
        if OUTPUT_CREATED:
            save(OUTPUT / 'failure-status.json', {
                'status': 'failed-or-incomplete', 'type': type(error).__name__, 'error': failure,
                'recordedAtEpochSeconds': time.time(), 'qualified': False, 'retried': False,
            })
        raise
    finally:
        if OUTPUT_CREATED:
            try:
                export_compact_summary(failure)
            except Exception as error:
                print(f'Could not export compact memory summary: {error}', file=sys.stderr, flush=True)
