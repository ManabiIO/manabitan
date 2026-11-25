#!/usr/bin/env python3
"""Run one frozen browser observation; never edit product or harness sources."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
import traceback

ROOT = Path(__file__).resolve().parent
IDENTITY_PATH = ROOT / 'identity.json'


def utc():
    return datetime.now(timezone.utc).isoformat()


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def git(where, *args):
    env = {**os.environ, 'GIT_OPTIONAL_LOCKS': '0'}
    return subprocess.check_output(['git', '-C', str(where), *args], env=env, text=True).strip()


def source_guard(identity, arm):
    source = identity['source'][arm]
    where = Path(source['path'])
    require(git(where, 'rev-parse', 'HEAD') == source['head'], 'Source HEAD changed')
    require(git(where, 'rev-parse', 'HEAD^{tree}') == source['tree'], 'Source tree changed')
    require(git(where, 'status', '--porcelain') == '', 'Source checkout is dirty')
    for name, expected in source['allTrackedFileHashes'].items():
        require(sha(where / name) == expected, f'Tracked file changed: {name}')
    package = identity['packages'][arm]
    require(sha(package['path']) == package['sha256'], 'Frozen package changed')
    for kind in ('node', 'chromium'):
        executable = identity['runtime'][kind]
        require(sha(executable['path']) == executable['sha256'], f'{kind} executable changed')
    return {'head': source['head'], 'tree': source['tree'],
            'aggregateTrackedSha256': source['aggregateTrackedSha256'],
            'packageSha256': package['sha256'], 'verifiedAt': utc()}


def host_snapshot():
    snapshot = {'utc': utc(), 'loadAverage': os.getloadavg(),
                'tmpDisk': dict(zip(('total', 'used', 'free'), shutil.disk_usage(ROOT)))}
    for name in ('/proc/pressure/cpu', '/proc/pressure/memory', '/proc/pressure/io',
                 '/sys/fs/cgroup/cpu.stat', '/sys/fs/cgroup/memory.current',
                 '/sys/fs/cgroup/memory.max'):
        try:
            snapshot[name] = Path(name).read_text().strip()
        except OSError:
            snapshot[name] = None
    return snapshot


def validate(output, identity, source_arm, dictionary):
    summary = json.loads((output / 'summary.json').read_text())
    report = json.loads((output / 'run-1.json').read_text())
    source = identity['source'][source_arm]
    package = identity['packages'][source_arm]
    require(summary['schemaVersion'] == 3, 'Unexpected summary schema')
    require(summary['dictionary'] == dictionary, 'Wrong dictionary')
    require(summary['buildTarget'] == 'chrome', 'Wrong package target')
    require(summary['source']['gitSha'] == source['head'], 'Reported source HEAD mismatch')
    require(summary['source']['dirty'] is False, 'Reported source checkout is dirty')
    for name, actual in summary['source']['sha256'].items():
        if name in source['allTrackedFileHashes']:
            require(actual == source['allTrackedFileHashes'][name], f'Reported source hash mismatch: {name}')
    require(summary['source']['sha256']['builds/manabitan-chrome.zip'] == package['sha256'], 'Reported package source hash mismatch')
    require(report['packageSha256'] == package['sha256'], 'Executed package hash mismatch')
    require(summary['browserVersion'] == identity['runtime']['chromium']['version'], 'Browser version mismatch')
    require(report['browserVersion'] == summary['browserVersion'], 'Raw browser version mismatch')
    require(summary['authoritativeTiming'] is True and summary['traceEnabled'] is False, 'Trace/instrumentation enabled')
    require(summary['importFlags'] is None and summary['mediaCheck'] == 'all', 'Nonproduction flags or incomplete media mode')
    require(report['status'] == 'success' and report['skippedVerification'] is False, 'Report failed or skipped verification')
    require(len(summary['runs']) == 1, 'Unexpected run count')
    run = summary['runs'][0]
    require(run['packageSha256'] == package['sha256'], 'Run package hash mismatch')
    require(isinstance(run['totalImportMs'], (float, int)) and math.isfinite(run['totalImportMs']) and run['totalImportMs'] > 0, 'Invalid import duration')
    require(run['importDebug']['usesFallbackStorage'] is False, 'Fallback storage used')
    rd = report['runtimeDiagnostics']
    for name in ('hasStorageGetDirectory', 'hasCreateSyncAccessHandle', 'hasOpfsSahpoolVfs'):
        require(rd.get(name) is True, f'Missing OPFS capability: {name}')
    require(rd.get('opfsSahpoolInstallResult') == 'installed', 'OPFS SAH pool VFS was not installed')
    require(rd.get('openStorageMode') == 'opfs-sahpool', 'Wrong live storage mode')
    storage = rd['openStorageDiagnostics']
    require(storage.get('mode') == 'opfs-sahpool', 'Wrong backend storage mode')
    require(storage.get('forceFallback') is False, 'Backend fallback forced')
    require(storage.get('hasOpfsSahpoolVfs') is True, 'Backend lacks OPFS SAH pool VFS')
    require(storage.get('opfsSahpoolVfsPtr') not in (None, 0, '0', '0x0', ''), 'No backend OPFS SAH pool VFS pointer')
    require(storage.get('opfsSahpoolInstallResult') == 'installed', 'Backend VFS install did not succeed')
    validation = run['validation']
    # The unchanged wrapper already validates all fixture counts, restart,
    # probes, lookup receipts, errors, flags, media bytes, and clock boundaries.
    # Preserve a timing-free digest for later cross-arm output comparisons.
    witness = {key: validation.get(key) for key in ('title', 'revision', 'termRows',
               'contentReadable', 'probeCount', 'probeTerms', 'outputDigestSha256', 'media', 'restart')}
    witness['lookups'] = [{key: row[key] for key in ('pass', 'term', 'results',
                          'originalTextLength', 'hasExactHeadwordMatch', 'sha256')}
                         for row in validation['lookup']['observations']]
    return {'totalImportMs': run['totalImportMs'],
            'automationObservedImportMs': run['automationObservedImportMs'],
            'workerImportMs': run['workerImportMs'],
            'runtimeDiagnostics': rd, 'validation': validation,
            'outputWitnessSha256': hashlib.sha256(json.dumps(witness, sort_keys=True, ensure_ascii=False,
                                      separators=(',', ':')).encode()).hexdigest(),
            'outputWitness': witness,
            'summarySha256': sha(output / 'summary.json'),
            'rawReportSha256': sha(output / 'run-1.json')}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--id', required=True)
    parser.add_argument('--arm', required=True, choices=('A', 'B', 'C'))
    parser.add_argument('--dictionary', required=True, choices=('jmdict', 'jitendex', 'vndb'))
    parser.add_argument('--purpose', required=True, choices=('functional-smoke', 'warmup', 'measured'))
    args = parser.parse_args()
    require(re.fullmatch(r'[a-z0-9_-]+', args.id) is not None, 'Invalid observation ID')
    require((ROOT / 'cpu-slot-released.json').is_file(), 'Root has not released the browser CPU slot')
    identity = json.loads(IDENTITY_PATH.read_text())
    source_arm = 'B' if args.arm == 'B' else 'A'
    where = Path(identity['source'][source_arm]['path'])
    output = ROOT / 'results' / args.id
    tmp = ROOT / 'tmp' / args.id
    require(not output.exists() and not tmp.exists(), 'Observation ID already exists; results cannot be overwritten')
    output.mkdir()
    tmp.mkdir()
    node = identity['runtime']['node']['path']
    env = {key: value for key, value in os.environ.items()
           if not re.match(r'^MANABITAN_(?:E2E_|CHROMIUM_)', key)
           and key not in ('NODE_OPTIONS', 'NODE_V8_COVERAGE', 'PWDEBUG', 'DEBUG')}
    env.update({'PLAYWRIGHT_BROWSERS_PATH': identity['runtime']['playwrightBrowsersPath'],
                'PATH': str(Path(node).parent) + ':' + env.get('PATH', ''),
                'TMPDIR': str(tmp), 'GIT_OPTIONAL_LOCKS': '0'})
    command = [node, 'dev/perf/import-benchmark.js', args.dictionary, '--runs', '1',
               '--no-build', '--build-target', 'chrome', '--media-check', 'all', '--output', str(output)]
    receipt = {'schemaVersion': 1, 'id': args.id, 'arm': args.arm, 'sourceArm': source_arm,
               'dictionary': args.dictionary, 'purpose': args.purpose,
               'includedInTimingCohort': args.purpose == 'measured',
               'identitySha256': sha(IDENTITY_PATH), 'startedAt': utc(), 'command': command,
               'cwd': str(where), 'tmpdir': str(tmp),
               'runtimeEnvironment': {key: env[key] for key in ('PLAYWRIGHT_BROWSERS_PATH', 'PATH', 'TMPDIR', 'GIT_OPTIONAL_LOCKS')},
               'status': 'preflight', 'sampling': 'none; snapshots outside the harness only'}
    process = None
    started = None
    exit_code = 1
    try:
        receipt['beforeIdentity'] = source_guard(identity, source_arm)
        receipt['beforeHost'] = host_snapshot()
        receipt['status'] = 'running'
        write_json(output / 'observation.json', receipt)
        print(json.dumps({'id': args.id, 'purpose': args.purpose, 'status': 'running', 'log': str(output / 'harness.log')}), flush=True)
        started = time.monotonic()
        with (output / 'harness.log').open('wb') as log:
            process = subprocess.Popen(command, cwd=where, env=env, stdout=log,
                                       stderr=subprocess.STDOUT, start_new_session=True)
            receipt['harnessPid'] = process.pid
            write_json(output / 'observation.json', receipt)
            receipt['harnessExitCode'] = process.wait(timeout=2100 if args.dictionary == 'vndb' else 900)
        receipt['harnessWallMs'] = (time.monotonic() - started) * 1000
        receipt['afterHost'] = host_snapshot()
        require(receipt['harnessExitCode'] == 0, f'Harness exited {receipt["harnessExitCode"]}')
        receipt['result'] = validate(output, identity, source_arm, args.dictionary)
        receipt['afterIdentity'] = source_guard(identity, source_arm)
        receipt['status'] = 'passed'
        exit_code = 0
    except BaseException as error:
        if started is not None:
            receipt.setdefault('harnessWallMs', (time.monotonic() - started) * 1000)
        receipt['status'] = 'failed'
        receipt['error'] = repr(error)
        receipt['traceback'] = traceback.format_exc()
        receipt['afterHost'] = host_snapshot()
    finally:
        if process is not None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            if process.poll() is None:
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=10)
        receipt['cleanup'] = {'remainingTempEntries': sorted(p.name for p in tmp.iterdir())}
        shutil.rmtree(tmp)
        receipt['cleanup']['tempDirectoryRemoved'] = not tmp.exists()
        receipt['endedAt'] = utc()
        write_json(output / 'observation.json', receipt)
        print(json.dumps({'id': args.id, 'status': receipt['status'],
                          'totalImportMs': receipt.get('result', {}).get('totalImportMs'),
                          'harnessWallMs': receipt.get('harnessWallMs'),
                          'error': receipt.get('error'), 'receipt': str(output / 'observation.json')}), flush=True)
    return exit_code


if __name__ == '__main__':
    sys.exit(main())
