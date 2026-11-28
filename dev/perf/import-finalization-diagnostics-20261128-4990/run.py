#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Research-only JMdict finalization attribution; no speedup qualification."""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
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
from qualification_receipts import SOURCE_HASH_FIELDS, validate_import_summary, require_matching_receipts


def digest(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + '\n')


def plan(host):
    if host not in (1, 2):
        raise ValueError('Expected host 1 or 2')
    return [{'id': f'observation-{index:02d}-{arm}', 'ordinal': index, 'arm': arm,
             'purpose': 'ordinary baseline context' if arm == 'A' else 'instrumented operation attribution',
             'authoritativeComparativeTiming': False}
            for index, arm in enumerate('ADADAD' if host == 1 else 'DADADA', 1)]


def package_entries(path):
    with zipfile.ZipFile(path) as package:
        if len(set(package.namelist())) != len(package.namelist()):
            raise ValueError('Duplicate package members')
        return {entry.filename: hashlib.sha256(package.read(entry)).hexdigest()
                for entry in package.infolist() if not entry.is_dir()}


def extract_details(summary, arm):
    phases = summary['runs'][0]['importDebug']['importerPhaseTimings']
    finalization = [item for item in phases if item['phase'] == 'bulk-finalization']
    if len(finalization) != 1:
        raise ValueError('Expected exactly one complete finalization phase')
    details = finalization[0]['details']
    diagnostics = details.get('termRecordFinalizationDiagnostics')
    if arm == 'A':
        if diagnostics is not None:
            raise ValueError('Ordinary baseline contains diagnostic instrumentation')
    else:
        if type(diagnostics) is not list or len(diagnostics) != 1:
            raise ValueError('Expected exactly one JMdict descriptor/index diagnostic pair')
        row = diagnostics[0]
        if row.get('lookupWriterKind') != 'local-sync-access-handle':
            raise ValueError('JMdict did not use the expected ordinary local SAH writer')
        if row.get('lookupSyncFlushCount') != 1 or row.get('lookupSyncCloseCount') != 1:
            raise ValueError('Expected one final synchronous flush and close')
        for key, value in row.items():
            if key in ('fileName', 'lookupWriterKind'):
                if type(value) is not str or not value:
                    raise ValueError(f'Invalid diagnostic identity: {key}')
            elif type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                raise ValueError(f'Invalid diagnostic metric: {key}')
        inventory = summary['runs'][0]['validation']['storage']['files']
        descriptors = [entry for entry in inventory if entry['path'].endswith('/' + row['fileName'])]
        if len(descriptors) != 1 or descriptors[0]['bytes'] != row['descriptorBytes']:
            raise ValueError('Diagnostic descriptor differs from restart storage inventory')
        for key in ('descriptorFinishOffsetMs', 'lookupFinishOffsetMs'):
            if row[key] > row['joinElapsedMs'] + 1:
                raise ValueError('Operation extends beyond the measured close join')
        if row['lookupSyncFlushMs'] + row['lookupSyncCloseMs'] > row['lookupCloseMs'] + 1:
            raise ValueError('Synchronous close children exceed their parent interval')
    return {'totalImportMs': summary['runs'][0]['totalImportMs'],
            'finalizationElapsedMs': finalization[0]['elapsedMs'], 'details': details}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', required=True, type=int, choices=(1, 2))
    parser.add_argument('--evidence', required=True, type=Path)
    args = parser.parse_args()
    protocol = json.loads((HERE / 'protocol.json').read_text())
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    shutil.copytree(HERE, evidence / 'tooling', ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copyfile(HELPERS / 'qualification_receipts.py', evidence / 'qualification_receipts.py')
    shutil.copyfile(ROOT / '.github/workflows/import-finalization-diagnostics-4990.yml', evidence / 'workflow.yml')
    work = evidence.parent / (evidence.name + '-sources')
    work.mkdir(exist_ok=False)
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(('MANABITAN_E2E_', 'MANABITAN_CHROMIUM_', 'MANABITAN_AB_'))}
    env.update(MANABITAN_E2E_STRICT_RUNTIME='1', MANABITAN_CHROMIUM_ALLOW_HEADED_FALLBACK='0')
    commands, observations = [], []
    stage = 'prepare'

    def command(argv, cwd, log, timeout=1200):
        receipt = {'argv': argv, 'cwd': str(cwd), 'log': str(log.relative_to(evidence)), 'startedEpoch': time.time()}
        commands.append(receipt)
        write_json(evidence / 'commands.json', commands)
        try:
            with log.open('wb') as output:
                result = subprocess.run(argv, cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
            receipt['returnCode'] = result.returncode
            if result.returncode:
                raise RuntimeError(f'Command failed ({result.returncode}); see {log}')
        except Exception as error:
            receipt['error'] = str(error)
            raise
        finally:
            receipt['endedEpoch'] = time.time()
            write_json(evidence / 'commands.json', commands)

    def git(*arguments, cwd=ROOT):
        return subprocess.check_output(['git', *arguments], cwd=cwd, env=env, text=True).strip()

    try:
        if git('status', '--porcelain'):
            raise ValueError('Study checkout must be clean')
        study_sha = git('rev-parse', 'HEAD')
        if re.fullmatch('[0-9a-f]{40}', protocol['baseline']) is None:
            raise ValueError('Baseline requires full immutable commit identity')
        if subprocess.check_output(['node', '--version'], text=True).strip() != protocol['nodeVersion']:
            raise ValueError('Node differs from frozen protocol')
        runtime_paths = sorted(protocol['diagnosticSourceSha256'])
        for name, expected in protocol['diagnosticSourceSha256'].items():
            if digest(ROOT / name) != expected:
                raise ValueError(f'Diagnostic source differs from frozen hash: {name}')
        changed = git('diff', '--name-only', protocol['baseline'], study_sha, '--', 'ext').splitlines()
        if sorted(changed) != runtime_paths:
            raise ValueError(f'Unexpected runtime changes: {changed}')
        overlay = subprocess.check_output(['git', 'diff', '--binary', protocol['baseline'], study_sha, '--', *runtime_paths], cwd=ROOT)
        (evidence / 'runtime-instrumentation.patch').write_bytes(overlay)
        write_json(evidence / 'registered-plan.json', {
            **protocol, 'host': args.host, 'diagnosticCommit': study_sha,
            'diagnosticTree': git('rev-parse', 'HEAD^{tree}'), 'schedule': plan(args.host),
            'runtimePatchSha256': hashlib.sha256(overlay).hexdigest(),
            'authoritativeComparativeTiming': False,
            'failurePolicy': 'Stop on first acquisition, identity, semantic, or diagnostic failure. No retries or replacement observations.',
            'reportFlagCaveat': 'The unchanged standard harness reports authoritativeTiming according to its trace flags only. That flag does not detect this source instrumentation. Instrumented durations are diagnostic only; all study comparisons are nonauthoritative.',
        })
        fixture_path = ROOT / 'test/perf/dictionaries.lock.json'
        if digest(fixture_path) != protocol['fixtureLockSha256']:
            raise ValueError('Fixture lock differs from frozen protocol')
        fixture = json.loads(fixture_path.read_text())['dictionaries']['jmdict']
        browser = Path(subprocess.check_output(['node', '--input-type=module', '-e',
            "import {chromium} from 'playwright'; process.stdout.write(chromium.executablePath())"], cwd=ROOT, text=True))
        version_text = subprocess.check_output([str(browser), '--version'], text=True).strip()
        browser_version = re.search(r'\d+\.\d+\.\d+\.\d+', version_text).group(0)
        if browser_version != protocol['browserVersion']:
            raise ValueError('Chromium differs from frozen protocol')
        write_json(evidence / 'browser-identity.json', {'version': browser_version, 'sha256': digest(browser)})
        command(['node', 'dev/perf/prepare-dictionaries.js', 'jmdict', 'jmnedict', 'jitendex'], ROOT, evidence / 'fixtures.log')
        required_same = set(SOURCE_HASH_FIELDS[:-1]) | {'package.json', '.github/actions/setup/action.yml'}
        required_same.update(name for name in git('ls-tree', '-r', '--name-only', protocol['baseline'],
            'test/e2e', 'test/chromium', 'dev/perf').splitlines() if name.endswith(('.js', '.mjs', '.html')))
        sources, identities = {}, {}
        for arm, sha in (('A', protocol['baseline']), ('D', study_sha)):
            target = work / arm
            command(['git', 'worktree', 'add', '--detach', str(target), sha], ROOT, evidence / f'worktree-{arm}.log')
            for name in sorted(required_same):
                if (target / name).read_bytes() != (ROOT / name).read_bytes():
                    raise ValueError(f'Measurement input changed: {arm} {name}')
            shutil.copytree(ROOT / 'node_modules', target / 'node_modules', copy_function=os.link, symlinks=True)
            (target / 'builds').mkdir(exist_ok=True)
            (target / 'builds/e2e-dictionary-cache').symlink_to(ROOT / 'builds/e2e-dictionary-cache', target_is_directory=True)
            command(['npm', 'run', 'build:libs'], target, evidence / f'libs-{arm}.log')
            command(['npm', 'run', 'license-report:html'], target, evidence / f'license-{arm}.log')
            command(['node', 'dev/bin/build.js', '--target', 'chrome'], target, evidence / f'build-{arm}.log')
            manifest = json.loads((target / 'dev/data/dictionary-wasm/manifest.json').read_text())
            for item in manifest['targets']:
                if digest(target / 'ext/lib' / item['name']) != item['sha256']:
                    raise ValueError(f'Native manifest mismatch: {arm} {item["name"]}')
            package = target / 'builds/manabitan-chrome.zip'
            if git('status', '--porcelain', cwd=target):
                raise ValueError(f'Source {arm} changed during preparation')
            identities[arm] = {
                'sha': sha, 'tree': git('rev-parse', 'HEAD^{tree}', cwd=target),
                'packageSha256': digest(package), 'entries': package_entries(package),
                'sourceHashes': {name: digest(target / name) for name in SOURCE_HASH_FIELDS},
                'runtimeSourceHashes': {name: digest(target / name) for name in runtime_paths},
                'nativeManifest': manifest,
            }
            sources[arm] = target
            shutil.copyfile(package, evidence / f'package-{arm}.zip')
        if identities['A']['entries'].keys() != identities['D']['entries'].keys():
            raise ValueError('Release member sets differ')
        changes = sorted(name for name in identities['A']['entries'] if identities['A']['entries'][name] != identities['D']['entries'][name])
        if changes != sorted(protocol['expectedPackageChanges']):
            raise ValueError(f'Unexpected release package changes: {changes}')
        write_json(evidence / 'source-identities.json', {'arms': identities, 'changedPackageEntries': changes})
        reference = None
        stage = 'observations'
        for item in plan(args.host):
            arm = item['arm']
            output = evidence / item['id']
            output.mkdir()
            write_json(output / 'classification.json', {**item, 'sourceSha': identities[arm]['sha'],
                'authoritativeTiming': False, 'sourceInstrumented': arm == 'D',
                'interpretation': 'Operation attribution or ordinary context only; no performance-candidate comparison.'})
            if digest(sources[arm] / 'builds/manabitan-chrome.zip') != identities[arm]['packageSha256']:
                raise ValueError('Frozen package changed')
            command(['node', 'dev/perf/host-environment.js'], ROOT, output / 'host-before.json')
            command(['node', 'dev/perf/import-benchmark.js', 'jmdict', '--runs', '1', '--no-build',
                '--build-target', 'chrome', '--media-check', 'all', '--output', str(output)], sources[arm], output / 'run.log')
            summary = json.loads((output / 'summary.json').read_text())
            report = json.loads((output / 'run-1.json').read_text())
            identity = identities[arm]
            receipt = validate_import_summary(summary, report, dictionary='jmdict', fixture=fixture,
                source_sha=identity['sha'], package_sha256=identity['packageSha256'], browser_version=browser_version,
                source_hashes=identity['sourceHashes'], source_dirty=False, media_check='all')
            if reference is None:
                reference = receipt
            else:
                require_matching_receipts(reference, receipt)
            write_json(output / 'canonical-receipt.json', receipt)
            detail = extract_details(summary, arm)
            observations.append({**item, **detail})
            write_json(evidence / 'observations.json', observations)
            command(['node', 'dev/perf/host-environment.js'], ROOT, output / 'host-after.json')
        for arm, target in sources.items():
            if digest(target / 'builds/manabitan-chrome.zip') != identities[arm]['packageSha256'] or git('status', '--porcelain', cwd=target):
                raise ValueError(f'Frozen source or package changed: {arm}')
        arm_summaries = {}
        for arm in ('A', 'D'):
            rows = [row for row in observations if row['arm'] == arm]
            arm_summaries[arm] = {'observations': len(rows),
                'contextTotalImportMs': [row['totalImportMs'] for row in rows],
                'contextMedianTotalImportMs': statistics.median(row['totalImportMs'] for row in rows),
                'contextMedianRecordCloseRegionMs': statistics.median(row['details']['termRecordEndImportSessionCloseWritableMs'] for row in rows)}
            if arm == 'D':
                diagnostic_rows = [row['details']['termRecordFinalizationDiagnostics'][0] for row in rows]
                arm_summaries[arm]['diagnosticMedians'] = {
                    key: statistics.median(row[key] for row in diagnostic_rows)
                    for key in diagnostic_rows[0] if key.endswith('Ms') and key != 'regionStartedAtMs'}
        write_json(evidence / 'analysis.json', {
            'acquisitionComplete': True, 'host': args.host, 'authoritativeTiming': False,
            'comparison': None, 'arms': arm_summaries,
            'interpretation': 'Research-only operation attribution. No speedup estimate, confidence interval, qualification, or cross-host pooling. Descriptor and index intervals overlap; child intervals are nested. API waits include scheduling and I/O rather than CPU time.'})
    except Exception as error:
        write_json(evidence / 'failure.json', {'stage': stage, 'type': type(error).__name__, 'message': str(error),
            'completedObservations': len(observations), 'retried': False, 'traceback': traceback.format_exc()})
        raise


if __name__ == '__main__':
    main()
