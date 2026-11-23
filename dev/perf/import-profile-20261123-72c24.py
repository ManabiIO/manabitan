#!/usr/bin/env python3
"""Frozen diagnostic acquisition; not a comparative latency qualification."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import zipfile

BASELINE = '467067650653c37c1f7d6b05d6737d070e1259cd'
ROOT = Path(__file__).resolve().parents[2]


def save(path, data):
    path.write_text(json.dumps(data, indent=2) + '\n')


def command(args, log=None, timeout=1800):
    if log is None:
        return subprocess.check_output(args, cwd=ROOT, text=True, timeout=timeout).strip()
    with log.open('x') as output:
        result = subprocess.run(args, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'Exit {result.returncode}: {args}; original log retained at {log}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dictionary', choices=('jmdict', 'jitendex', 'vndb'), required=True)
    args = parser.parse_args()
    evidence = ROOT / 'builds/import-profile-20261123-72c24' / args.dictionary
    evidence.mkdir(parents=True, exist_ok=False)
    try:
        if command(['node', '--version']) != 'v22.22.0':
            raise ValueError('Diagnostic source is pinned to Node 22.22.0')
        sha = command(['git', 'rev-parse', 'HEAD'])
        changed = command(['git', 'diff', '--name-only', BASELINE, sha]).splitlines()
        allowed = {'.github/workflows/import-profile-20261123-72c24.yml',
                   'dev/perf/import-profile-20261123-72c24.py'}
        if set(changed) != allowed:
            raise ValueError(f'Diagnostic revision has unexpected changes: {changed}')
        lock = json.loads((ROOT / 'test/perf/dictionaries.lock.json').read_text())
        fixture = lock['dictionaries'][args.dictionary]
        save(evidence / 'plan.json', {
            'schemaVersion': 1, 'baseline': BASELINE, 'harnessSha': sha,
            'workflowRun': os.environ.get('GITHUB_RUN_ID'),
            'workflowAttempt': os.environ.get('GITHUB_RUN_ATTEMPT'),
            'dictionary': args.dictionary, 'fixture': fixture,
            'schedule': ['ordinary', 'trace'],
            'scope': 'One ordinary diagnostic import, followed by one independent traced import. No comparison, warmup exclusion, latency qualification, retries, or memory claim.',
            'runtimeChanged': False,
            'measurementFiles': {
                name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                for name in ['package-lock.json', 'test/perf/dictionaries.lock.json',
                             'dev/perf/dictionary-fixtures.js', 'dev/perf/benchmark-support.js',
                             'dev/perf/import-benchmark.js',
                             'test/chromium/extension-two-dictionary-import.e2e.js',
                             'dev/perf/import-profile-20261123-72c24.py']
            },
        })
        command(['node', '--input-type=module', '-e',
                 "import {ensurePinnedDictionaryCache} from './dev/perf/dictionary-fixtures.js'; await ensurePinnedDictionaryCache('builds/e2e-dictionary-cache',[process.argv[1]])", args.dictionary],
                log=evidence / 'fixtures.log')
        archive = ROOT / 'builds/e2e-dictionary-cache' / fixture['cacheFile']
        if archive.stat().st_size != fixture['sizeBytes'] or hashlib.sha256(archive.read_bytes()).hexdigest() != fixture['sha256']:
            raise ValueError('Fixture size/digest mismatch')
        command(['npm', 'run', 'build', '--', '--target', 'chrome'], log=evidence / 'build.log')
        package = ROOT / 'builds/manabitan-chrome.zip'
        with zipfile.ZipFile(package) as archive_zip:
            members = {entry.filename: hashlib.sha256(archive_zip.read(entry)).hexdigest()
                       for entry in archive_zip.infolist() if not entry.is_dir()}
        save(evidence / 'package-entries.json', members)
        save(evidence / 'identity.json', {
            'sha': sha, 'baseline': BASELINE,
            'packageSha256': hashlib.sha256(package.read_bytes()).hexdigest(),
            'workingStatus': command(['git', 'status', '--porcelain']),
        })
        for observation in ('ordinary', 'trace'):
            output = evidence / observation
            output.mkdir()
            command(['node', 'dev/perf/host-environment.js'], log=output / 'host-before.json')
            started = time.time()
            try:
                print(f'{args.dictionary}: {observation}', flush=True)
                invocation = ['node', 'dev/perf/import-benchmark.js', args.dictionary,
                              '--runs', '1', '--no-build', '--build-target', 'chrome',
                              '--media-check', 'all', '--output', str(output)]
                if observation == 'trace':
                    invocation.append('--trace')
                command(invocation, log=output / 'run.log')
            finally:
                save(output / 'acquisition.json', {'kind': observation, 'startedEpochSeconds': started,
                                                   'endedEpochSeconds': time.time(), 'retried': False})
                command(['node', 'dev/perf/host-environment.js'], log=output / 'host-after.json')
    except BaseException as error:
        save(evidence / 'failure.json', {'type': type(error).__name__, 'message': str(error),
                                        'recordedAtEpochSeconds': time.time(), 'retried': False})
        raise


if __name__ == '__main__':
    main()
