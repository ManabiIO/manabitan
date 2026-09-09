#!/usr/bin/env python3
"""Fixed, read-only #24 vs isolated i64 inflater comparison. No retries."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import time
import zipfile

from paired import COMMON, PACKAGE, digest, effects, git, save, schedule, validate

HEADER = 'ext/js/dictionary/wasm/vendor/miniz/miniz.h'
WASM = 'ext/lib/term-bank-parser.wasm'
HEADER_BLOBS = {'baseline': '6b71bda7605c11f0cb6da7f150d7d0fce6a5a6d2',
                'candidate': '22d72694d7361cc2642e845a7136eb38e6afeb63'}
BASE = 'ff9cbf2e848a86d6bbfd281179a6d753349e52f4'
CANDIDATE = 'dc226aaf88a0f8d2d4b2bcc37778352be0104622'


def check_common(source: dict) -> None:
    """Retain every identity; permit ONLY the intentionally different WASM."""
    a, b = (source[arm]['common'] for arm in ('baseline', 'candidate'))
    if set(a) != set(COMMON) or set(b) != set(COMMON):
        raise ValueError('Missing common build identity')
    changed = {p for p in COMMON if a[p] != b[p]}
    if changed != {WASM}:
        raise ValueError(f'Unexpected common build differences: {sorted(changed)}')



def check_wasm_identity(root: Path, expected: dict) -> None:
    """Hash the actual build and shipped member; schema 3 only reports ZIP SHA."""
    if digest(root / WASM) != expected['common'][WASM]:
        raise ValueError('Per-run WASM build changed')
    if digest(root / PACKAGE) != expected['package_sha256']:
        raise ValueError('Per-run extension package changed')
    with zipfile.ZipFile(root / PACKAGE) as archive:
        member = WASM.removeprefix('ext/')
        if archive.namelist().count(member) != 1:
            raise ValueError('Missing or ambiguous packaged WASM')
        if hashlib.sha256(archive.read(member)).hexdigest() != expected['common'][WASM]:
            raise ValueError('Shipped WASM differs from identified build')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--dictionary', choices=['jmdict', 'jmnedict', 'jitendex'], required=True)
    parser.add_argument('--pairs', type=int, default=6)
    parser.add_argument('--reverse', action='store_true')
    args = parser.parse_args()
    roots = {'baseline': args.baseline.resolve(), 'candidate': args.candidate.resolve()}
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    plan = schedule(args.pairs, args.reverse)
    result = dict(status='preflight', plan=plan, runs=[], source={},
                  driver_sha256=digest(Path(__file__)), helper_sha256=digest(Path(__file__).with_name('paired.py')),
                  platform=platform.platform(), started_at=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                  comparison='isolated-i64-bitbuffer', failure_policy='No retries; incomplete plans have no effect estimate')
    save(output / 'plan.json', result)
    try:
        expected_refs = dict(baseline=BASE, candidate=CANDIDATE)
        source = result['source']
        fixture = json.loads((roots['baseline'] / 'test/perf/dictionaries.lock.json').read_text())['dictionaries'][args.dictionary]
        result['fixture'] = fixture
        for arm, root in roots.items():
            if git(root, 'rev-parse', 'HEAD') != expected_refs[arm] or git(root, 'status', '--porcelain'):
                raise ValueError(f'{arm}: not the pinned clean checkout')
            if git(root, 'hash-object', HEADER) != HEADER_BLOBS[arm]:
                raise ValueError(f'{arm}: wrong inflater header')
            archive = root / 'builds/e2e-dictionary-cache' / fixture['cacheFile']
            if archive.stat().st_size != fixture['sizeBytes'] or digest(archive) != fixture['sha256']:
                raise ValueError(f'{arm}: fixture mismatch')
            with zipfile.ZipFile(archive) as z:
                bank_count = sum(bool(re.fullmatch(r'term_bank_\d+\.json', n)) for n in z.namelist())
            source[arm] = dict(commit=git(root, 'rev-parse', 'HEAD'), tree=git(root, 'rev-parse', 'HEAD^{tree}'),
                               package_sha256=digest(root / PACKAGE), bank_count=bank_count,
                               common={p: digest(root / p) for p in COMMON},
                               header_sha256=digest(root / HEADER))
        # Test tools/docs may differ; the actual shipped source has one change.
        changed = git(roots['candidate'], 'diff', '--name-only', BASE, CANDIDATE, '--', 'ext').splitlines()
        if changed != [HEADER]:
            raise ValueError(f'Unexpected production changes: {changed}')
        check_common(source)
        for arm, root in roots.items():
            check_wasm_identity(root, source[arm])
        result['status'] = 'running'
        save(output / 'plan.json', result)
        for index, item in enumerate(plan):
            root = roots[item['arm']]
            name = f"{index:02d}-{item['kind']}-{item['pair']:02d}-{item['arm']}-{item['position']}"
            folder = output / name
            command = ['node', 'dev/perf/import-benchmark.js', args.dictionary,
                       '--runs', '1', '--no-build', '--output', str(folder)]
            print('START', name, flush=True)
            before = os.getloadavg()
            with (output / (name + '.log')).open('w') as log:
                # Kill the entire automation tree on timeout, not only its parent.
                child = subprocess.Popen(command, cwd=root, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                try:
                    code = child.wait(timeout=150)
                except BaseException:
                    import signal
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
                    raise
                if code != 0:
                    raise RuntimeError(f'{name}: benchmark exited {code}; retain its raw failure report')
            summary_path, report_path = folder / 'summary.json', folder / 'run-1.json'
            summary, report = json.loads(summary_path.read_text()), json.loads(report_path.read_text())
            measured = validate(summary, report, args.dictionary, fixture, 'low', source[item['arm']])
            check_wasm_identity(root, source[item['arm']])
            result['runs'].append(dict(**item, **measured, summary=str(summary_path.relative_to(output)),
                                      report_sha256=digest(report_path), summary_sha256=digest(summary_path),
                                      load_before=before, command=command))
            save(output / 'results.json', result)
            print('DONE', name, measured['elapsed_ms'], flush=True)
        for arm, root in roots.items():
            if git(root, 'status', '--porcelain') or digest(root / PACKAGE) != source[arm]['package_sha256']:
                raise ValueError('Source or package changed during verification')
            if {p: digest(root / p) for p in COMMON} != source[arm]['common']:
                raise ValueError('Build identities changed during verification')
        result['effect'] = effects(plan, result['runs'])
        result['status'] = 'complete'
    except BaseException as error:
        result.update(status='failed', error=str(error))
        raise
    finally:
        save(output / 'results.json', result)


if __name__ == '__main__':
    main()
