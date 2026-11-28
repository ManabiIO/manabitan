#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Frozen complete-import screen; unchanged product and timing harness per arm."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import random
import re
import shutil
import statistics
import subprocess
import sys
import time
import traceback
import zipfile

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
HELPERS = ROOT / 'dev/perf/import-memory-20261125-a7f7'
sys.path.insert(0, str(HELPERS))
from qualification_receipts import validate_import_summary, require_matching_receipts
from chromium_memory import run_with_sampling, summarize_import_window
from protocol import memory_overlay, memory_comparison, schedule as memory_schedule
from audit_memory import audit_cell

ORDERS = ('ABC', 'BCA', 'CAB', 'ACB', 'BAC', 'CBA',
          'CBA', 'BAC', 'ACB', 'CAB', 'BCA', 'ABC')
HARNESS = 'test/chromium/extension-two-dictionary-import.e2e.js'
PROVENANCE = (
    'package-lock.json', 'test/perf/dictionaries.lock.json',
    'dev/perf/benchmark-support.js', 'dev/perf/dictionary-fixtures.js',
    'dev/perf/import-benchmark.js', 'test/chromium/import-flags-ab-benchmark.js',
    HARNESS, 'test/e2e/import-timing.js',
    'ext/js/pages/settings/dictionary-import-controller.js', 'builds/manabitan-chrome.zip',
)


def digest(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def plan(replication):
    if replication not in (1, 2):
        raise ValueError('Expected replication 1 or 2')
    orders = ORDERS if replication == 1 else tuple(order[::-1] for order in ORDERS)
    warmup = 'ABC' if replication == 1 else 'CBA'
    result = [{'id': 'warmup-' + arm, 'kind': 'warmup', 'block': 0, 'arm': arm} for arm in warmup]
    for block, order in enumerate(orders, 1):
        result.extend({'id': f'block-{block:02d}-{arm}', 'kind': 'timing', 'block': block, 'arm': arm} for arm in order)
    return result


def paired_summary(observations, numerator, denominator):
    blocks = {}
    for item in observations:
        if item['kind'] == 'timing':
            blocks.setdefault(item['block'], {})[item['arm']] = item['totalImportMs']
    if sorted(blocks) != list(range(1, len(ORDERS) + 1)) or any(set(row) != {'A', 'B', 'C'} for row in blocks.values()):
        raise ValueError('All twelve complete three-arm blocks are required')
    rows = [blocks[index] for index in range(1, len(ORDERS) + 1)]
    ratios = [row[numerator] / row[denominator] for row in rows]
    if any(not 0 < ratio < float('inf') for ratio in ratios):
        raise ValueError('Invalid positive finite paired duration')
    rng = random.Random(20261127)
    resampled = sorted(statistics.median(rng.choices(ratios, k=len(ratios))) for _ in range(10000))
    return {
        'pairs': len(ORDERS), 'pairedChangePercent': [(ratio - 1) * 100 for ratio in ratios],
        'medianPairedChangePercent': (statistics.median(ratios) - 1) * 100,
        'equalWorkChangePercent': (sum(row[numerator] for row in rows) / sum(row[denominator] for row in rows) - 1) * 100,
        'descriptiveBootstrap95Percent': [(resampled[index] - 1) * 100 for index in (249, 9749)],
        'fasterPairs': sum(ratio < 1 for ratio in ratios),
    }


def package_entries(path):
    with zipfile.ZipFile(path) as package:
        names = package.namelist()
        if len(set(names)) != len(names):
            raise ValueError('Duplicate release package members')
        return {entry.filename: hashlib.sha256(package.read(entry)).hexdigest()
                for entry in package.infolist() if not entry.is_dir()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dictionary', required=True, choices=('jmdict', 'jitendex', 'vndb'))
    parser.add_argument('--replication', required=True, type=int, choices=(1, 2))
    parser.add_argument('--evidence', required=True, type=Path)
    args = parser.parse_args()
    protocol = json.loads((HERE / 'protocol.json').read_text())
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    shutil.copytree(HERE, evidence / 'tooling', ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copytree(HELPERS, evidence / 'receipt-memory-helpers', ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copyfile(ROOT / '.github/workflows/import-composite-study-4990.yml', evidence / 'workflow.yml')
    work = evidence.parent / (evidence.name + '-sources')
    work.mkdir(exist_ok=False)
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(('MANABITAN_E2E_', 'MANABITAN_CHROMIUM_', 'MANABITAN_AB_'))}
    env.update(MANABITAN_E2E_STRICT_RUNTIME='1', MANABITAN_CHROMIUM_ALLOW_HEADED_FALLBACK='0')
    for key in list(os.environ):
        if key.startswith(('MANABITAN_E2E_', 'MANABITAN_CHROMIUM_', 'MANABITAN_AB_')):
            del os.environ[key]
    os.environ.update(env)
    commands = []
    observations = []
    stage = 'prepare'

    def command(argv, cwd, log, timeout=1800):
        receipt = {'argv': argv, 'cwd': str(cwd), 'log': str(log.relative_to(evidence)), 'startedEpoch': time.time()}
        commands.append(receipt)
        write_json(evidence / 'commands.json', commands)
        try:
            with log.open('wb') as output:
                completed = subprocess.run(argv, cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
            receipt['returnCode'] = completed.returncode
            if completed.returncode:
                raise RuntimeError(f'Command failed ({completed.returncode}); see {log}')
        except Exception as error:
            receipt['error'] = str(error)
            raise
        finally:
            receipt['endedEpoch'] = time.time()
            write_json(evidence / 'commands.json', commands)

    def git(*arguments, cwd=ROOT):
        return subprocess.check_output(['git', *arguments], cwd=cwd, env=env, text=True).strip()

    try:
        for key in ('baseline', 'candidate'):
            if re.fullmatch('[0-9a-f]{40}', protocol[key]) is None:
                raise ValueError('Protocol requires frozen full commit identities')
        if subprocess.check_output(['node', '--version'], text=True).strip() != protocol['nodeVersion']:
            raise ValueError('Node version differs from frozen protocol')
        write_json(evidence / 'tooling-identity.json', {'sha': git('rev-parse', 'HEAD'), 'tree': git('rev-parse', 'HEAD^{tree}'),
                   'driverSha256': digest(Path(__file__)), 'protocolSha256': digest(HERE / 'protocol.json')})
        fixture_path = ROOT / 'test/perf/dictionaries.lock.json'
        if digest(fixture_path) != protocol['fixtureLockSha256']:
            raise ValueError('Fixture lock differs from frozen protocol')
        fixture = json.loads(fixture_path.read_text())['dictionaries'][args.dictionary]
        schedule = plan(args.replication)
        write_json(evidence / 'registered-plan.json', {
            **protocol, 'dictionary': args.dictionary, 'replication': args.replication,
            'schedule': schedule, 'memorySchedule': memory_schedule(args.replication),
            'timingHarnessOverlay': False,
            'failurePolicy': 'Stop timing on first failed acquisition or receipt; retain failures and unattempted plan entries. Memory attempts all four slots.',
        })
        required_same = set(PROVENANCE[:-1]) | {'package.json', '.github/actions/setup/action.yml', 'dev/perf/import-media-validation.js'}
        required_same.update(path for path in git('ls-tree', '-r', '--name-only', protocol['baseline'],
                                                  'test/e2e', 'test/chromium', 'dev/perf').splitlines()
                             if path.endswith(('.js', '.mjs', '.html')))
        browser = Path(subprocess.check_output(['node', '--input-type=module', '-e',
                       "import {chromium} from 'playwright'; process.stdout.write(chromium.executablePath())"], cwd=ROOT, text=True))
        version_text = subprocess.check_output([str(browser), '--version'], text=True).strip()
        browser_version = re.search(r'\d+\.\d+\.\d+\.\d+', version_text).group(0)
        if browser_version != protocol['browserVersion']:
            raise ValueError('Chromium version differs from frozen protocol')
        write_json(evidence / 'browser-identity.json', {'path': str(browser), 'version': browser_version, 'sha256': digest(browser)})
        fixture_ids = ['jmdict', 'jmnedict', 'jitendex'] + (['vndb'] if args.dictionary == 'vndb' else [])
        command(['node', 'dev/perf/prepare-dictionaries.js', *fixture_ids], ROOT, evidence / 'fixtures.log')
        sources, identities = {}, {}
        for arm, key in (('A', 'baseline'), ('B', 'candidate')):
            target = work / arm
            command(['git', 'worktree', 'add', '--detach', str(target), protocol[key]], ROOT, evidence / f'worktree-{arm}.log')
            for relative in sorted(required_same):
                if (target / relative).read_bytes() != (ROOT / relative).read_bytes():
                    raise ValueError(f'Changed measurement input: {arm} {relative}')
            shutil.copytree(ROOT / 'node_modules', target / 'node_modules', copy_function=os.link, symlinks=True)
            (target / 'builds').mkdir(exist_ok=True)
            (target / 'builds/e2e-dictionary-cache').symlink_to(ROOT / 'builds/e2e-dictionary-cache', target_is_directory=True)
            command(['npm', 'run', 'build:libs'], target, evidence / f'libs-{arm}.log')
            command(['npm', 'run', 'license-report:html'], target, evidence / f'license-{arm}.log')
            command(['node', 'dev/bin/build.js', '--target', 'chrome'], target, evidence / f'build-{arm}.log')
            manifest = json.loads((target / 'dev/data/dictionary-wasm/manifest.json').read_text())
            for item in manifest['targets']:
                if digest(target / 'ext/lib' / item['name']) != item['sha256']:
                    raise ValueError(f'Source-bound native artifact mismatch: {arm} {item["name"]}')
            if digest(target / 'ext/lib/term-bank-parser.wasm') != protocol['parserWasmSha256'][arm]:
                raise ValueError(f'Native parser differs from frozen candidate: {arm}')
            package = target / 'builds/manabitan-chrome.zip'
            if git('status', '--porcelain', cwd=target):
                raise ValueError(f'Arm {arm} changed during preparation')
            identities[arm] = {'sha': git('rev-parse', 'HEAD', cwd=target), 'tree': git('rev-parse', 'HEAD^{tree}', cwd=target),
                               'packageSha256': digest(package), 'entries': package_entries(package),
                               'sourceHashes': {name: digest(target / name) for name in PROVENANCE},
                               'nativeManifest': manifest}
            sources[arm] = target
            shutil.copyfile(package, evidence / f'package-{arm}.zip')
        if identities['B']['tree'] != protocol['candidateTree']:
            raise ValueError('Candidate tree differs from the locally reviewed tree')
        if identities['A']['entries'].keys() != identities['B']['entries'].keys():
            raise ValueError('Different package member sets')
        changes = sorted(name for name in identities['A']['entries'] if identities['A']['entries'][name] != identities['B']['entries'][name])
        if changes != sorted(protocol['expectedPackageChanges']):
            raise ValueError(f'Unexpected release package changes: {changes}')
        write_json(evidence / 'source-identities.json', {'arms': identities, 'changedPackageEntries': changes,
                    'controlC': 'Same immutable baseline source and package as A, with independent fresh browser profiles'})
        stage = 'native-output-parity'
        command(['node', '--expose-gc', '--max-old-space-size=1024', 'test/perf/native-lookup-initialization-20261126/replay.mjs',
                 '--baseline-root', str(sources['A']), '--candidate-root', str(sources['B']),
                 '--cache-dir', str(ROOT / 'builds/e2e-dictionary-cache'), '--parser-workers', '3',
                 '--pairs', '1', '--out', str(evidence / 'native-output-parity.json'), args.dictionary],
                sources['B'], evidence / 'native-output-parity.log')
        reference = None

        def validate(output, arm, media='sample', overlay=None):
            summary = json.loads((output / 'summary.json').read_text())
            report = json.loads((output / 'run-1.json').read_text())
            identity = identities[arm]
            hashes = dict(identity['sourceHashes'])
            if overlay is not None:
                hashes[HARNESS] = hashlib.sha256(overlay.encode()).hexdigest()
            receipt = validate_import_summary(summary, report, dictionary=args.dictionary, fixture=fixture,
                       source_sha=identity['sha'], package_sha256=identity['packageSha256'], browser_version=browser_version,
                       source_hashes=hashes, source_dirty=overlay is not None, media_check=media,
                       vndb_sah_allocation_units=protocol['vndbSahAllocationUnits'])
            if reference is not None:
                require_matching_receipts(reference, receipt, compare_media=media == 'sample')
            write_json(output / 'canonical-receipt.json', receipt)
            return summary, receipt

        def import_command(output, media='sample', trace=False):
            result = ['node', 'dev/perf/import-benchmark.js', args.dictionary, '--runs', '1', '--no-build',
                      '--build-target', 'chrome', '--media-check', media, '--output', str(output)]
            return result + (['--trace'] if trace else [])

        stage = 'timing'
        for item in schedule:
            arm = 'B' if item['arm'] == 'B' else 'A'
            output = evidence / item['id']
            output.mkdir()
            if digest(sources[arm] / 'builds/manabitan-chrome.zip') != identities[arm]['packageSha256']:
                raise ValueError('Product package changed during the frozen cohort')
            command(['node', 'dev/perf/host-environment.js'], ROOT, output / 'host-before.json')
            command(import_command(output), sources[arm], output / 'run.log')
            summary, receipt = validate(output, arm)
            if reference is None:
                reference = receipt
            observations.append({**item, 'totalImportMs': summary['runs'][0]['totalImportMs']})
            write_json(evidence / 'observations.json', observations)
            command(['node', 'dev/perf/host-environment.js'], ROOT, output / 'host-after.json')
        analysis = {'dictionary': args.dictionary, 'replication': args.replication,
                    'B/A': paired_summary(observations, 'B', 'A'), 'B/C': paired_summary(observations, 'B', 'C'),
                    'C/A': paired_summary(observations, 'C', 'A'),
                    'interpretation': 'Per-host descriptive results; no host pooling, control subtraction, removed tails or automatic promotion.'}
        write_json(evidence / 'analysis.json', analysis)

        stage = 'exhaustive-media'
        full_reference = None
        for arm in ('AB' if args.replication == 1 else 'BA'):
            output = evidence / f'exhaustive-media-{arm}'
            output.mkdir()
            command(import_command(output, 'all'), sources[arm], output / 'run.log')
            _, receipt = validate(output, arm, 'all')
            if full_reference is None:
                full_reference = receipt
            else:
                require_matching_receipts(full_reference, receipt)

        stage = 'memory'
        memory_root = evidence / 'memory'
        memory_root.mkdir()
        original = (sources['A'] / HARNESS).read_text()
        instrumented = memory_overlay(original)
        (memory_root / 'harness-original.js').write_text(original)
        (memory_root / 'harness-instrumented.js').write_text(instrumented)
        write_json(memory_root / 'plan.json', {'dictionary': args.dictionary, 'replication': args.replication,
                   'schedule': memory_schedule(args.replication), 'overlaySha256': hashlib.sha256(instrumented.encode()).hexdigest()})
        memory_observations, memory_errors = [], []
        try:
            for target in sources.values():
                if (target / HARNESS).read_text() != original:
                    raise ValueError('Memory harness sources differ')
                (target / HARNESS).write_text(instrumented)
            for item in memory_schedule(args.replication):
                output = memory_root / item['name']
                output.mkdir()
                try:
                    sampled = run_with_sampling(import_command(output), sources[item['arm']], output / 'run.log',
                                                output / 'memory.json', output / 'markers.jsonl')
                except Exception as error:
                    memory_errors.append({'name': item['name'], 'samplingError': str(error)})
                    path = output / 'memory.json'
                    if path.exists():
                        path.rename(output / 'memory-incomplete.json')
                    marker = output / 'markers.jsonl'
                    if not marker.exists():
                        marker.write_text('')
                    try:
                        markers = [json.loads(line) for line in marker.read_text().splitlines() if line]
                    except ValueError:
                        markers = []
                    raw = summarize_import_window([], markers, -1)
                    write_json(path, raw)
                    sampled = {key: value for key, value in raw.items() if key != 'samples'}
                memory_observations.append({**item, **sampled})
                write_json(memory_root / 'observations.json', memory_observations)
                try:
                    validate(output, item['arm'], overlay=instrumented)
                except Exception as error:
                    memory_errors.append({'name': item['name'], 'semanticError': str(error)})
                write_json(memory_root / 'semantic-failures.json', memory_errors)
        finally:
            for target in sources.values():
                (target / HARNESS).write_text(original)
        memory_result = memory_comparison(memory_observations, args.dictionary, args.replication, memory_schedule)
        write_json(memory_root / 'memory-comparison.json', memory_result)
        try:
            write_json(memory_root / 'memory-audit.json', audit_cell(memory_root))
        except Exception as error:
            memory_errors.append({'auditError': str(error)})
            write_json(memory_root / 'semantic-failures.json', memory_errors)

        stage = 'profile'
        for arm in ('A', 'B'):
            output = evidence / f'trace-{arm}'
            output.mkdir()
            command(import_command(output, trace=True), sources[arm], output / 'run.log')
        for arm, target in sources.items():
            if digest(target / 'builds/manabitan-chrome.zip') != identities[arm]['packageSha256'] or git('status', '--porcelain', cwd=target):
                raise ValueError('Source or product package changed after diagnostics')
        analysis['memoryPassed'] = memory_result['passesProspectiveMemoryScreen'] and not memory_errors
        analysis['memoryErrors'] = memory_errors
        analysis['acquisitionComplete'] = True
        write_json(evidence / 'analysis.json', analysis)
        if not analysis['memoryPassed']:
            raise RuntimeError('All timing retained; separate memory qualification did not pass')
    except Exception as error:
        write_json(evidence / 'failure.json', {'stage': stage, 'type': type(error).__name__, 'message': str(error),
                   'completedObservations': len(observations), 'traceback': traceback.format_exc(), 'retried': False})
        raise


if __name__ == '__main__':
    main()
