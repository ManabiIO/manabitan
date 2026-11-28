#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Research-only terminal record/content overlap attribution; no speedup qualification."""

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


def extract_details(summary, arm, fixture):
    phases = summary['runs'][0]['importDebug']['importerPhaseTimings']
    finalization = [item for item in phases if item['phase'] == 'bulk-finalization']
    if len(finalization) != 1:
        raise ValueError('Expected exactly one complete finalization phase')
    details = finalization[0]['details']
    diagnostics = details.get('termRecordTerminalOverlapDiagnostics')
    if arm == 'A':
        if diagnostics is not None:
            raise ValueError('Ordinary baseline contains diagnostic instrumentation')
    else:
        if type(diagnostics) is not dict:
            raise ValueError('Missing bounded terminal-overlap diagnostic object')

        def number(value, label, signed=False):
            if type(value) not in (int, float) or not math.isfinite(value) or (not signed and value < 0):
                raise ValueError(f'Invalid numeric diagnostic: {label}')
            return value

        def integer(value, label, minimum=0):
            if type(value) is not int or not minimum <= value <= 2 ** 53 - 1:
                raise ValueError(f'Invalid integral diagnostic: {label}')
            return value

        def boolean(value, label):
            if type(value) is not bool:
                raise ValueError(f'Invalid boolean diagnostic: {label}')
            return value

        def call(record):
            if type(record) is not dict:
                raise ValueError('Invalid artifact call diagnostic')
            integer(record['ordinal'], 'call ordinal', 1)
            count = integer(record['rowCount'], 'call row count')
            begin = integer(record['artifactRowStart'], 'call row start')
            end = integer(record['artifactRowEnd'], 'call row end')
            if end - begin != count or end > diagnostics['artifactRowCount']:
                raise ValueError('Artifact call row identity mismatch')
            if record['dictionary'] != fixture['expectedTitle']:
                raise ValueError('Artifact call dictionary mismatch')
            boolean(record['activeBulkImport'], 'active bulk import')
            position = record['source']
            if position is not None:
                if type(position) is not dict:
                    raise ValueError('Invalid source position diagnostic')
                for key in ('sourceFileIndex', 'sourceFileBatchCount', 'sourceFileCount', 'chunkIndex', 'chunkCount'):
                    integer(position[key], key)
            return record

        count = integer(diagnostics['artifactCallCount'], 'artifact call count')
        rows = integer(diagnostics['artifactRowCount'], 'artifact row count')
        if rows > fixture['termRows']:
            raise ValueError('Artifact rows exceed verified dictionary row count')
        last_call = diagnostics['lastArtifactCall']
        if count == 0:
            if last_call is not None or rows != 0:
                raise ValueError('Empty artifact-call identity mismatch')
        else:
            call(last_call)
            if last_call['ordinal'] != count or last_call['artifactRowEnd'] != rows:
                raise ValueError('Final artifact-call identity mismatch')
        final_id = diagnostics['finalNextRecordId']
        if final_id is not None:
            integer(final_id, 'final record id')
        eligible = diagnostics['lastEligible']
        if eligible is None:
            expected_final_call = expected_terminal = expected_record = expected_final_append = False
            signed_wait = available_wait = None
        else:
            call(eligible['call'])
            if eligible['recordStatus'] != 'fulfilled' or eligible['contentStatus'] != 'fulfilled':
                raise ValueError('Successful import retained an unsettled/failed eligible join')
            times = {key: number(eligible[key], key) for key in (
                'metadataPublishedAtMs', 'recordAppendCompletedAtMs', 'contentCompletedAtMs', 'joinFinishedAtMs')}
            if min(times['recordAppendCompletedAtMs'], times['contentCompletedAtMs']) < times['metadataPublishedAtMs']:
                raise ValueError('Completion precedes operation publication')
            if times['joinFinishedAtMs'] < max(times['recordAppendCompletedAtMs'], times['contentCompletedAtMs']):
                raise ValueError('Join precedes a completed operation')
            before = eligible['nextRecordIdAtAppendStart']
            after = eligible['nextRecordIdAfterAppend']
            for label, value in (('record id before append', before), ('record id after append', after)):
                if value is not None:
                    integer(value, label)
            if before is not None and after is not None and after - before != eligible['call']['rowCount']:
                raise ValueError('Record append identity differs from observed call rows')
            position = eligible['call']['source']
            expected_final_call = eligible['call']['ordinal'] == count
            expected_terminal = position is not None and (
                position['sourceFileBatchCount'] > 0 and position['sourceFileCount'] > 0 and
                position['sourceFileIndex'] + position['sourceFileBatchCount'] == position['sourceFileCount'] and
                position['chunkIndex'] > 0 and position['chunkIndex'] == position['chunkCount'])
            expected_record = final_id is not None and after == final_id
            expected_final_append = eligible['call']['activeBulkImport'] and expected_final_call and expected_terminal and expected_record
            signed_wait = times['contentCompletedAtMs'] - times['recordAppendCompletedAtMs']
            available_wait = max(0, signed_wait)
        for key, expected in (
            ('lastEligibleWasFinalArtifactCall', expected_final_call),
            ('lastEligibleWasTerminalSourceChunk', expected_terminal),
            ('lastEligibleMatchesFinalRecordId', expected_record),
            ('lastEligibleWasFinalAppend', expected_final_append),
        ):
            if boolean(diagnostics[key], key) != expected:
                raise ValueError(f'Derived diagnostic identity mismatch: {key}')
        for key, expected in (
            ('contentCompletionMinusRecordAppendMs', signed_wait), ('availableContentWaitMs', available_wait),
        ):
            actual = diagnostics[key]
            if expected is None:
                if actual is not None:
                    raise ValueError(f'Absent observation has nonnull wait: {key}')
            elif not math.isclose(number(actual, key, signed=True), expected, rel_tol=1e-12, abs_tol=1e-8):
                raise ValueError(f'Derived diagnostic wait mismatch: {key}')
    return {'totalImportMs': summary['runs'][0]['totalImportMs'],
            'finalizationElapsedMs': finalization[0]['elapsedMs'], 'details': details}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', required=True, type=int, choices=(1, 2))
    parser.add_argument('--dictionary', required=True, choices=('jmdict', 'jitendex'))
    parser.add_argument('--evidence', required=True, type=Path)
    args = parser.parse_args()
    protocol = json.loads((HERE / 'protocol.json').read_text())
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    shutil.copytree(HERE, evidence / 'tooling', ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copyfile(HELPERS / 'qualification_receipts.py', evidence / 'qualification_receipts.py')
    shutil.copyfile(ROOT / '.github/workflows/import-terminal-overlap-diagnostics-4990.yml', evidence / 'workflow.yml')
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
            **protocol, 'host': args.host, 'dictionary': args.dictionary, 'diagnosticCommit': study_sha,
            'diagnosticTree': git('rev-parse', 'HEAD^{tree}'), 'schedule': plan(args.host),
            'runtimePatchSha256': hashlib.sha256(overlay).hexdigest(),
            'authoritativeComparativeTiming': False,
            'failurePolicy': 'Stop on first acquisition, identity, semantic, or diagnostic failure. No retries or replacement observations.',
            'reportFlagCaveat': 'The unchanged standard harness reports authoritativeTiming according to its trace flags only. That flag does not detect this source instrumentation. Instrumented durations are diagnostic only; all study comparisons are nonauthoritative.',
        })
        fixture_path = ROOT / 'test/perf/dictionaries.lock.json'
        if digest(fixture_path) != protocol['fixtureLockSha256']:
            raise ValueError('Fixture lock differs from frozen protocol')
        fixture = json.loads(fixture_path.read_text())['dictionaries'][args.dictionary]
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
            command(['node', 'dev/perf/import-benchmark.js', args.dictionary, '--runs', '1', '--no-build',
                '--build-target', 'chrome', '--media-check', 'all', '--output', str(output)], sources[arm], output / 'run.log')
            summary = json.loads((output / 'summary.json').read_text())
            report = json.loads((output / 'run-1.json').read_text())
            identity = identities[arm]
            receipt = validate_import_summary(summary, report, dictionary=args.dictionary, fixture=fixture,
                source_sha=identity['sha'], package_sha256=identity['packageSha256'], browser_version=browser_version,
                source_hashes=identity['sourceHashes'], source_dirty=False, media_check='all')
            if reference is None:
                reference = receipt
            else:
                require_matching_receipts(reference, receipt)
            write_json(output / 'canonical-receipt.json', receipt)
            detail = extract_details(summary, arm, fixture)
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
                diagnostics = [row['details']['termRecordTerminalOverlapDiagnostics'] for row in rows]
                eligible = [row for row in diagnostics if row['lastEligibleWasFinalAppend']]
                arm_summaries[arm]['terminalFinalAppendObservations'] = len(eligible)
                arm_summaries[arm]['signedContentCompletionMinusRecordAppendMs'] = [
                    row['contentCompletionMinusRecordAppendMs'] for row in diagnostics]
                arm_summaries[arm]['availableContentWaitMs'] = [row['availableContentWaitMs'] for row in diagnostics]
                arm_summaries[arm]['medianEligibleContentWaitUpperBoundMs'] = (
                    statistics.median(row['availableContentWaitMs'] for row in eligible) if eligible else None)
        write_json(evidence / 'analysis.json', {
            'acquisitionComplete': True, 'host': args.host, 'dictionary': args.dictionary, 'authoritativeTiming': False,
            'comparison': None, 'arms': arm_summaries,
            'interpretation': 'Research-only last-append attribution. No speedup estimate, confidence interval, qualification, or cross-host pooling. Positive record-to-content callback wait is an upper bound on overlap opportunity, not evidence that a compression worker is still executing. The same-worker clock includes callback delivery and storage work. A nonterminal or absent eligible observation is a valid negative finding.'})
    except Exception as error:
        write_json(evidence / 'failure.json', {'stage': stage, 'type': type(error).__name__, 'message': str(error),
            'completedObservations': len(observations), 'retried': False, 'traceback': traceback.format_exc()})
        raise


if __name__ == '__main__':
    main()
