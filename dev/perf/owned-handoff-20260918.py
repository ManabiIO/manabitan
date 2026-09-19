#!/usr/bin/env python3
"""Research only: same-path builds, complete imports, retained controls and failures."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import time
import traceback
import zipfile

BASE = 'fb7241deb70950dc113089cd774c9489ede48f8a'
BUILD = 'dev/build-libs.js'
WORKER = 'ext/js/dictionary/term-bank-wasm-parser-worker.js'
TEST = 'test/term-bank-wasm-parser.test.js'
FILES = [BUILD, WORKER]
ROOT = Path(__file__).resolve().parents[2]


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def command(args, log=None, timeout=600, env=None):
    if log is None:
        subprocess.run(args, cwd=ROOT, env=env, check=True, timeout=timeout)
    else:
        with Path(log).open('w') as output:
            subprocess.run(args, cwd=ROOT, env=env, stdout=output,
                           stderr=subprocess.STDOUT, check=True, timeout=timeout)


def original(path):
    return subprocess.check_output(['git', 'show', f'{BASE}:{path}'], cwd=ROOT).decode()


def configure(variant):
    build, worker = original(BUILD), original(WORKER)
    if variant != 'baseline':
        split = build.index('async function buildDictionaryWasm(out)')
        prefix, target = build[:split], build[split:]
        old = "            '-Wl,--shared-memory',\n"
        assert target.count(old) == 1
        build = prefix + target.replace(old, '')
    if variant == 'private-owned':
        old = 'resultChunk = copyWasmBackedColumnChunk(chunk, true);'
        assert worker.count(old) == 1
        worker = worker.replace(old, 'resultChunk = copyWasmBackedColumnChunk(chunk);')
    assert variant in ('baseline', 'private-owned', 'private-shared')
    (ROOT / BUILD).write_text(build)
    (ROOT / WORKER).write_text(worker)


def adjust_tests():
    text = original(TEST)
    changes = {
        'expect(wasmBuffer).toBeInstanceOf(SharedArrayBuffer);':
            'expect(wasmBuffer instanceof ArrayBuffer).toBe(true);',
        'expect(cloned.contentBytesBuffer.buffer).toBeInstanceOf(SharedArrayBuffer);':
            'expect(cloned.contentBytesBuffer.buffer instanceof ArrayBuffer).toBe(true);',
        'expect(cloned.termRecordPreinternedPlan.stringsBuffer.buffer).toBeInstanceOf(SharedArrayBuffer);':
            'expect(cloned.termRecordPreinternedPlan.stringsBuffer.buffer instanceof ArrayBuffer).toBe(true);',
        'expect(cloned.scoreList[0]).toBe(123456);':
            'expect(cloned.scoreList[0]).toBe(originalScore);',
    }
    for old, new in changes.items():
        assert text.count(old) == 1
        text = text.replace(old, new)
    (ROOT / TEST).write_text(text)


def compare_archives(a, b):
    with zipfile.ZipFile(a) as left, zipfile.ZipFile(b) as right:
        assert set(left.namelist()) == set(right.namelist())
        different = [p for p in left.namelist() if left.read(p) != right.read(p)]
        allowed = {'lib/term-bank-parser.wasm', 'js/dictionary/term-bank-wasm-parser-worker.js'}
        assert set(different) <= allowed, different
        assert 'lib/term-bank-parser.wasm' in different
        return different


def summarize(observations, variant):
    measured = [x for x in observations if x['role'] == 'candidate' and x['candidate'] == variant]
    controls = [x for x in observations if x['role'] == 'control' and x['candidate'] == variant]
    def changes(rows):
        result = []
        for start in range(0, len(rows), 4):
            a, b, c, d = [x['ms'] for x in rows[start:start+4]]
            result += [100 * (b / a - 1), 100 * (c / d - 1)]
        return result
    paired = changes(measured)
    control_paired = changes(controls)
    a = [x['ms'] for x in measured if x['variant'] == 'baseline']
    b = [x['ms'] for x in measured if x['variant'] == variant]
    return {'pairedPercent': paired, 'medianPairedPercent': statistics.median(paired),
            'equalWorkPercent': 100 * (sum(b) / sum(a) - 1),
            'fasterPairs': sum(x < 0 for x in paired), 'pairs': len(paired),
            'blockTotalsPercent': [100 * ((measured[i+1]['ms'] + measured[i+2]['ms']) /
                                          (measured[i]['ms'] + measured[i+3]['ms']) - 1)
                                   for i in range(0, len(measured), 4)],
            'baselineMedianMs': statistics.median(a), 'candidateMedianMs': statistics.median(b),
            'controlPairedPercent': control_paired,
            'medianAbsoluteControlPercent': statistics.median(map(abs, control_paired))}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dictionary', required=True, choices=['jmdict', 'jmnedict', 'jitendex'])
    parser.add_argument('--out', required=True)
    parser.add_argument('--blocks', type=int, default=2)
    parser.add_argument('--variants', default='private-owned,private-shared')
    args = parser.parse_args()
    assert 1 <= args.blocks <= 12
    variants = args.variants.split(',')
    assert set(variants) <= {'private-owned', 'private-shared'} and len(set(variants)) == len(variants)
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=False)
    (out / 'driver.py').write_bytes(Path(__file__).read_bytes())
    identities = {'base': BASE, 'dictionary': args.dictionary, 'packages': {},
                  'node': subprocess.check_output(['node', '--version']).decode().strip(),
                  'compiler': subprocess.check_output([os.environ.get('MANABITAN_CLANG', 'clang'), '--version']).decode(),
                  'lockSha256': digest(ROOT / 'test/perf/dictionaries.lock.json')}
    for variant in ['baseline'] + variants:
        configure(variant)
        command(['node', 'dev/bin/build-libs.js'], out / f'{variant}-libraries.log')
        command(['node', 'dev/bin/build.js', 'chrome-dev'], out / f'{variant}-package.log')
        archive = out / f'{variant}.zip'
        shutil.copyfile(ROOT / 'builds/manabitan-chrome-dev.zip', archive)
        shutil.copyfile(ROOT / 'ext/lib/term-bank-parser.wasm', out / f'{variant}.wasm')
        patch = subprocess.check_output(['git', 'diff', BASE, '--', *FILES], cwd=ROOT)
        (out / f'{variant}.patch').write_bytes(patch)
        identities['packages'][variant] = {'sha256': digest(archive), 'bytes': archive.stat().st_size,
            'wasmSha256': digest(out / f'{variant}.wasm'), 'wasmBytes': (out / f'{variant}.wasm').stat().st_size,
            'sources': {p: digest(ROOT / p) for p in FILES}}
        if variant != 'baseline':
            identities['packages'][variant]['changedMembers'] = compare_archives(out / 'baseline.zip', archive)
    (out / 'identities.json').write_text(json.dumps(identities, indent=2))
    plan = []
    for candidate in variants:
        for variant in ['baseline', candidate]:
            plan.append({'role': 'warmup', 'candidate': candidate, 'variant': variant, 'block': -1})
        for block in range(args.blocks):
            roles = ['candidate', 'control'] if block % 2 == 0 else ['control', 'candidate']
            for role in roles:
                for variant in ['baseline', candidate, candidate, 'baseline']:
                    plan.append({'role': role, 'candidate': candidate,
                                 'variant': variant if role == 'candidate' else 'baseline', 'block': block})
    (out / 'plan.json').write_text(json.dumps(plan, indent=2))
    observations = []
    try:
        for index, spec in enumerate(plan):
            variant = spec['variant']
            configure(variant)
            archive = out / f'{variant}.zip'
            assert digest(archive) == identities['packages'][variant]['sha256']
            assert {p: digest(ROOT / p) for p in FILES} == identities['packages'][variant]['sources']
            shutil.copyfile(archive, ROOT / 'builds/manabitan-chrome-dev.zip')
            shutil.copyfile(out / f'{variant}.wasm', ROOT / 'ext/lib/term-bank-parser.wasm')
            directory = out / f'{index:03}-{spec["candidate"]}-{spec["role"]}-{variant}'
            directory.mkdir()
            start = time.monotonic()
            command(['node', 'dev/perf/import-benchmark.js', args.dictionary, '--runs', '1',
                     '--no-build', '--flags', '{}', '--output', str(directory)],
                    directory / 'driver.log', timeout=180)
            summary = json.loads((directory / 'summary.json').read_text())
            report = json.loads((directory / 'run-1.json').read_text())
            assert report['status'] == 'success' and report['skippedVerification'] is False
            assert len(summary['runs']) == 1 and summary['authoritativeTiming'] is True
            ms = summary['runs'][0]['totalImportMs']
            assert isinstance(ms, (int, float)) and 0 < ms < 180000
            row = {**spec, 'index': index, 'ms': ms, 'wallSeconds': time.monotonic()-start,
                   'packageSha256': digest(archive), 'reportSha256': digest(directory / 'run-1.json'),
                   'report': str(directory.relative_to(out) / 'run-1.json')}
            observations.append(row)
            (out / 'observations.json').write_text(json.dumps(observations, indent=2))
            print(json.dumps(row), flush=True)
        result = {'complete': True, 'dictionary': args.dictionary, 'observations': len(observations),
                  'variants': {v: summarize(observations, v) for v in variants}}
        (out / 'results.json').write_text(json.dumps(result, indent=2))
        print(json.dumps(result, indent=2), flush=True)
    except Exception:
        (out / 'failure.txt').write_text(traceback.format_exc())
        raise
    finally:
        configure('baseline')
        shutil.copyfile(out / 'baseline.wasm', ROOT / 'ext/lib/term-bank-parser.wasm')
        shutil.copyfile(out / 'baseline.zip', ROOT / 'builds/manabitan-chrome-dev.zip')


if __name__ == '__main__':
    main()
