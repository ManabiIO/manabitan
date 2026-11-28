#!/usr/bin/env python3
"""Hosted-only, three-slot JMdict dependency diagnostic. No performance comparison."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import shutil
import subprocess
import sys
import traceback
import zipfile

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'builds/perf/group-stages-9bb32'
SPEC = ROOT / 'dev/perf/import-group-stages-9bb32.json'
BASE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + '\n')


def git(*args, cwd=ROOT):
    return subprocess.check_output(['git', *args], cwd=cwd, text=True).strip()


def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def command(argv, log, cwd=ROOT, timeout=1200, required=True):
    with log.open('wb') as stream:
        process = subprocess.Popen(argv, cwd=cwd, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=10)
            stream.write(b'\nDIAGNOSTIC DRIVER: prescribed command timeout; no retry.\n')
            code = 124
    if required:
        require(code == 0, f'Command failed ({code}); retained {log.name}')
    return code


def package(path):
    with zipfile.ZipFile(path) as archive:
        names = [i.filename for i in archive.infolist()]
        require(len(names) == len(set(names)), 'Duplicate ZIP members')
        require(all(not n.startswith('/') and '..' not in Path(n).parts for n in names), 'Unsafe ZIP member path')
        return {i.filename: hashlib.sha256(archive.read(i)).hexdigest() for i in archive.infolist() if not i.is_dir()}


def inventory():
    rows = []
    for path in sorted(OUT.rglob('*')):
        if path.is_file() and path.name != 'retention-manifest.json':
            rows.append({'path': path.relative_to(OUT).as_posix(), 'sizeBytes': path.stat().st_size, 'sha256': digest(path)})
    write(OUT / 'retention-manifest.json', {'schemaVersion': 1, 'scope': 'All diagnostic outputs, including failures; no exclusions.', 'files': rows})


def main():
    # Refuse local execution before creating worktrees, packages or outputs.
    require(os.environ.get('GITHUB_ACTIONS') == 'true', 'Acquisition is hosted-only')
    require(os.environ.get('GITHUB_REPOSITORY', '').lower() == 'manabiio/manabitan', 'Unexpected repository')
    head = os.environ.get('GITHUB_SHA', '')
    require(re.fullmatch(r'[0-9a-f]{40}', head) is not None and git('rev-parse', 'HEAD') == head, 'Checkout must equal immutable workflow SHA')
    OUT.mkdir(parents=True, exist_ok=False)
    status = {'schemaVersion': 1, 'purpose': 'Coordinator dependency diagnostic, not a gain qualification', 'sourceCommit': head, 'baselineCommit': BASE, 'plannedSlots': [1, 2, 3], 'slots': [], 'complete': False, 'conclusive': False}
    write(OUT / 'status.json', status)
    try:
        require(os.environ.get('GITHUB_RUN_ATTEMPT') == '1', 'The three-slot acquisition cannot be rerun')
        spec = json.loads(SPEC.read_text())
        require(spec['baselineCommit'] == BASE and spec['slots'] == [1, 2, 3], 'Unexpected diagnostic protocol')
        require(spec['flags'] is None and spec['expectedWorkers'] == 3, 'No policy overrides permitted')
        require(not git('status', '--porcelain'), 'Initial source checkout is dirty')
        node = subprocess.check_output(['node', '--version'], cwd=ROOT, text=True).strip()
        require(node == 'v22.22.0', 'Unexpected Node version')
        write(OUT / 'source-identity.json', {'commit': head, 'tree': git('rev-parse', 'HEAD^{tree}'), 'baseline': BASE, 'specSha256': digest(SPEC), 'node': node, 'workflowRunId': os.environ.get('GITHUB_RUN_ID'), 'workflowRunAttempt': os.environ.get('GITHUB_RUN_ATTEMPT'), 'runnerOS': os.environ.get('RUNNER_OS'), 'workflowRef': os.environ.get('GITHUB_WORKFLOW_REF')})
        shutil.copyfile(SPEC, OUT / 'prospective-spec.json')
        for name, expected in {**spec['overlaySourceSha256'], **spec['unchangedHarnessSha256'], **spec['diagnosticToolSha256'], **spec['nativeAssetSha256']}.items():
            require(digest(ROOT / name) == expected, f'Source hash mismatch: {name}')
        changed = set(git('diff', '--name-only', BASE, head, '--', 'ext').splitlines())
        require(changed == set(spec['overlaySourceSha256']), 'Unregistered runtime source changes')
        same = set(spec['unchangedHarnessSha256']) | {'package.json', '.github/actions/setup/action.yml', 'dev/perf/import-memory-20261125-a7f7/qualification_receipts.py'}
        same.update(p for p in git('ls-tree', '-r', '--name-only', BASE, 'test/e2e', 'test/chromium', 'dev/perf').splitlines() if p.endswith(('.js', '.mjs', '.html')))
        for name in sorted(same):
            expected = subprocess.check_output(['git', 'show', f'{BASE}:{name}'], cwd=ROOT)
            require((ROOT / name).read_bytes() == expected, f'Changed frozen harness dependency: {name}')
        write(OUT / 'harness-identity.json', {name: digest(ROOT / name) for name in sorted(same)})
        # A build-only baseline worktree verifies the exact package delta. It is
        # never imported. All three acquisitions use only the diagnostic package.
        baseline = ROOT / 'builds/group-stages-baseline-9bb32'
        command(['git', 'worktree', 'add', '--detach', str(baseline), BASE], OUT / 'baseline-worktree.log')
        shutil.copytree(ROOT / 'node_modules', baseline / 'node_modules', copy_function=os.link, symlinks=True)
        for label, source in [('baseline', baseline), ('diagnostic', ROOT)]:
            command(['npm', 'run', 'build:libs'], OUT / f'{label}-libs.log', source)
            command(['npm', 'run', 'license-report:html'], OUT / f'{label}-license.log', source)
            command(['npm', 'run', 'build', '--', '--target', 'chrome'], OUT / f'{label}-build.log', source)
            require(not git('status', '--porcelain', cwd=source), f'Build changed tracked source: {label}')
            shutil.copyfile(source / 'builds/manabitan-chrome.zip', OUT / f'package-{label}.zip')
        packages = {label: package(OUT / f'package-{label}.zip') for label in ('baseline', 'diagnostic')}
        a, b = packages['baseline'], packages['diagnostic']
        added, removed = sorted(b.keys() - a.keys()), sorted(a.keys() - b.keys())
        modified = sorted(n for n in a.keys() & b.keys() if a[n] != b[n])
        require(added == spec['expectedPackageDelta']['added'] and removed == [] and modified == spec['expectedPackageDelta']['modified'], 'Package delta differs from four changed JS plus one collector')
        for name, expected in spec['nativeAssetSha256'].items():
            member = name.removeprefix('ext/')
            require(a.get(member) == expected == b.get(member), f'Native package changed: {member}')
        for name, expected in spec['overlaySourceSha256'].items():
            require(b.get(name.removeprefix('ext/')) == expected, f'Packaged observer differs from reviewed source: {name}')
        package_audit = {'passed': True, 'sourceCommit': head, 'baselineCommit': BASE, 'added': added, 'removed': removed, 'modified': modified, 'packages': {label: {'sha256': digest(OUT / f'package-{label}.zip'), 'members': entries} for label, entries in packages.items()}}
        write(OUT / 'package-audit.json', package_audit)
        browser = Path(subprocess.check_output(['node', '--input-type=module', '-e', "import {chromium} from 'playwright'; process.stdout.write(chromium.executablePath())"], cwd=ROOT, text=True))
        browser_text = subprocess.check_output([str(browser), '--version'], text=True).strip()
        match = re.search(r'\d+\.\d+\.\d+\.\d+', browser_text)
        require(match is not None, 'Missing installed Chromium version')
        browser_version = match.group(0)
        browser_identity = {'path': str(browser), 'sha256': digest(browser), 'versionOutput': browser_text, 'version': browser_version}
        write(OUT / 'browser-identity.json', browser_identity)
        command(['node', 'dev/perf/prepare-dictionaries.js', 'jmdict'], OUT / 'fixtures.log')
        fixture = ROOT / 'builds/e2e-dictionary-cache' / spec['fixture']['cacheFile']
        require(fixture.stat().st_size == spec['fixture']['sizeBytes'] and digest(fixture) == spec['fixture']['sha256'], 'Locked JMdict fixture mismatch')
        registered = {**spec, 'status': 'registered before hosted acquisition; immutable source/package/browser bindings', 'overlaySourceCommit': head, 'overlayTree': git('rev-parse', 'HEAD^{tree}'), 'packageAuditPassed': True, 'packageAuditSha256': digest(OUT / 'package-audit.json'), 'expectedPackageSha256': package_audit['packages']['diagnostic']['sha256'], 'expectedBrowserVersion': browser_version, 'browserIdentitySha256': digest(OUT / 'browser-identity.json')}
        write(OUT / 'registered-plan.json', registered)
        sys.path.insert(0, str(ROOT / 'dev/perf/import-memory-20261125-a7f7'))
        from qualification_receipts import validate_import_summary
        extractor_path = ROOT / 'dev/perf/import-group-stages-extract-9bb32.py'
        module_spec = importlib.util.spec_from_file_location('group_stage_extractor', extractor_path)
        extractor = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(extractor)
        for index in (1, 2, 3):
            slot = OUT / f'slot-{index}'
            slot.mkdir()
            receipt = {'slot': index, 'attempted': False, 'benchmarkExitCode': None, 'semanticReceiptPassed': False, 'diagnosticConclusive': False}
            status['slots'].append(receipt)
            write(OUT / 'status.json', status)
            stage = 'preflight'
            stop_after_slot = False
            try:
                require(not git('status', '--porcelain'), 'Source changed before planned slot')
                require(digest(ROOT / 'builds/manabitan-chrome.zip') == registered['expectedPackageSha256'], 'Package changed before planned slot')
                require(digest(browser) == browser_identity['sha256'], 'Browser changed before planned slot')
                argv = ['node', 'dev/perf/import-benchmark.js', 'jmdict', '--runs', '1', '--build-target', 'chrome', '--no-build', '--media-check', 'all', '--output', str(slot)]
                write(slot / 'invocation.json', {'argv': argv, 'cwd': str(ROOT), 'sourceCommit': head, 'slot': index, 'freshProfileMechanism': 'unchanged E2E entrypoint mkdtemp per new child process', 'relativeSpeedClaim': False})
                # Commit the launch request before spawning. If the driver or
                # job is killed, this slot cannot be relabeled unattempted.
                receipt['attempted'] = True
                receipt['launchState'] = 'launch-requested; actual child progress requires retained log/report'
                stage = 'acquisition'
                write(slot / 'slot-status.json', receipt)
                write(OUT / 'status.json', status)
                code = command(argv, slot / 'benchmark.log', required=False)
                receipt['benchmarkExitCode'] = code
                receipt['launchState'] = 'child-exited'
                require(code == 0, f'Planned slot {index} failed; no replacement')
                stage = 'receipt-validation'
                summary, report = (json.loads((slot / name).read_text()) for name in ('summary.json', 'run-1.json'))
                canonical = validate_import_summary(summary, report, dictionary='jmdict', fixture=spec['fixture'], source_sha=head, package_sha256=registered['expectedPackageSha256'], browser_version=browser_version, import_flags=None, source_hashes=spec['unchangedHarnessSha256'], source_dirty=False, media_check='all')
                write(slot / 'canonical-persisted-receipt.json', canonical)
                receipt['semanticReceiptPassed'] = True
                stage = 'review'
                diagnostic = extractor.audit(report, summary, registered)
                diagnostic['inputIdentities'] = {name: {'sha256': digest(slot / name), 'sizeBytes': (slot / name).stat().st_size} for name in ('summary.json', 'run-1.json')}
                diagnostic['registeredPlanSha256'] = digest(OUT / 'registered-plan.json')
                diagnostic['extractorSha256'] = digest(extractor_path)
                write(slot / 'coordinator-stage-audit.json', diagnostic)
                receipt['diagnosticConclusive'] = diagnostic['eligibleForDependencyAnalysis']
            except Exception as error:
                receipt['failure'] = f'{type(error).__name__}: {error}'
                receipt['failureStage'] = stage
                stop_after_slot = stage != 'review'
                (slot / 'failure.txt').write_text(traceback.format_exc())
            finally:
                if receipt['benchmarkExitCode'] == 0:
                    try:
                        require(not git('status', '--porcelain') and digest(ROOT / 'builds/manabitan-chrome.zip') == registered['expectedPackageSha256'], 'Source/package changed during planned slot')
                        require(digest(browser) == browser_identity['sha256'], 'Browser changed during planned slot')
                    except Exception as error:
                        receipt['postflightFailure'] = f'{type(error).__name__}: {error}'
                        (slot / 'postflight-failure.txt').write_text(traceback.format_exc())
                        stop_after_slot = True
            write(slot / 'slot-status.json', receipt)
            write(OUT / 'status.json', status)
            if stop_after_slot:
                # The unchanged benchmark can normalize a nested E2E signal to
                # exit 1. Every nonzero acquisition exit or identity failure
                # stops the plan. Only completed-but-inconclusive diagnostic reviews may
                # continue the remaining predeclared slots.
                break
        status['complete'] = len(status['slots']) == 3 and all(s['attempted'] for s in status['slots'])
        status['conclusive'] = status['complete'] and all(s['benchmarkExitCode'] == 0 and s['semanticReceiptPassed'] and s['diagnosticConclusive'] and 'failure' not in s and 'postflightFailure' not in s for s in status['slots'])
    except Exception as error:
        status['failure'] = f'{type(error).__name__}: {error}'
        (OUT / 'failure.txt').write_text(traceback.format_exc())
    finally:
        status['unattemptedSlots'] = [i for i in (1, 2, 3) if not any(s['slot'] == i and s['attempted'] for s in status['slots'])]
        write(OUT / 'status.json', status)
        inventory()
    return 0 if status['conclusive'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
