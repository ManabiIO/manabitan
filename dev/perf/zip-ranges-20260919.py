#!/usr/bin/env python3
"""Research-only full-import A/B. Original archive members are never rewritten."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import time
import zipfile

ROOT = Path(__file__).resolve().parents[2]
BASE = 'fb7241deb70950dc113089cd774c9489ede48f8a'
SOURCE = 'ext/js/dictionary/term-bank-source-pipeline.js'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(args, log, timeout=300):
    with Path(log).open('w') as output:
        subprocess.run(args, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT,
                       timeout=timeout, check=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dictionary', required=True, choices=['jmdict', 'jmnedict', 'jitendex'])
    parser.add_argument('--out', required=True)
    parser.add_argument('--blocks', type=int, default=6)
    args = parser.parse_args()
    assert 2 <= args.blocks <= 6
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=False)
    shutil.copyfile(__file__, out / 'driver.py')
    subprocess.run(['git', 'fetch', '--depth=1', 'origin', BASE], cwd=ROOT, check=True)
    baseline = subprocess.check_output(['git', 'show', f'{BASE}:{SOURCE}'], cwd=ROOT)
    (ROOT / SOURCE).write_bytes(baseline)
    subprocess.run(['git', 'apply', 'dev/perf/zip-ranges-20260919.patch'], cwd=ROOT, check=True)
    candidate = (ROOT / SOURCE).read_bytes()
    assert candidate != baseline
    identities = {'parent': BASE, 'node': subprocess.check_output(['node', '--version']).decode().strip(),
                  'source': {}, 'packages': {}, 'wasm': sha(ROOT / 'ext/lib/term-bank-parser.wasm')}
    for arm, source in [('baseline', baseline), ('candidate', candidate)]:
        (ROOT / SOURCE).write_bytes(source)
        (out / f'{arm}.js').write_bytes(source)
        run(['node', 'dev/bin/build.js', 'chrome-dev'], out / f'{arm}-build.log')
        shutil.copyfile(ROOT / 'builds/manabitan-chrome-dev.zip', out / f'{arm}.zip')
        identities['source'][arm] = sha(out / f'{arm}.js')
        identities['packages'][arm] = {'sha256': sha(out / f'{arm}.zip'), 'bytes': (out / f'{arm}.zip').stat().st_size}
    with zipfile.ZipFile(out / 'baseline.zip') as a, zipfile.ZipFile(out / 'candidate.zip') as b:
        assert set(a.namelist()) == set(b.namelist())
        changed = [n for n in a.namelist() if a.read(n) != b.read(n)]
        assert changed == ['js/dictionary/term-bank-source-pipeline.js'], changed
        identities['changedMembers'] = changed
    (out / 'identities.json').write_text(json.dumps(identities, indent=2))
    lock_path = ROOT / 'test/perf/dictionaries.lock.json'
    original_lock = lock_path.read_bytes()
    lock = json.loads(original_lock)
    fixture = lock['dictionaries'][args.dictionary]
    original = ROOT / 'builds/e2e-dictionary-cache' / fixture['cacheFile']
    assert sha(original) == fixture['sha256'] and original.stat().st_size == fixture['sizeBytes']
    derived = original.with_name('range-control-' + original.name)
    shutil.copyfile(original, derived)
    padding = out / 'unused-padding.bin'
    with padding.open('wb') as f:
        f.truncate(129 * 1024 * 1024)
    with zipfile.ZipFile(derived, 'a') as archive:
        info = zipfile.ZipInfo('benchmark-unused.bin', date_time=(2026, 9, 19, 0, 0, 0))
        info.compress_type = zipfile.ZIP_STORED
        with archive.open(info, 'w') as target, padding.open('rb') as source:
            shutil.copyfileobj(source, target, 1024 * 1024)
    padding.unlink()
    with zipfile.ZipFile(original) as a, zipfile.ZipFile(derived) as b:
        assert set(b.namelist()) - set(a.namelist()) == {'benchmark-unused.bin'}
        for name in a.namelist():
            assert a.read(name) == b.read(name), name
    fixture.update(cacheFile=derived.name, sha256=sha(derived), sizeBytes=derived.stat().st_size)
    derived_lock = json.dumps(lock, indent=4).encode() + b'\n'
    (out / 'derived-lock.json').write_bytes(derived_lock)
    (out / 'original-lock.json').write_bytes(original_lock)
    try:
        for layout, blocks in [('large', args.blocks), ('original', 2)]:
            lock_path.write_bytes(derived_lock if layout == 'large' else original_lock)
            cell = out / layout
            cell.mkdir()
            plan = [{'role': 'warmup', 'arm': arm, 'block': -1} for arm in ['baseline', 'candidate']]
            for block in range(blocks):
                for role in (['candidate', 'control'] if block % 2 == 0 else ['control', 'candidate']):
                    for arm in ['baseline', 'candidate', 'candidate', 'baseline']:
                        plan.append({'role': role, 'arm': arm if role == 'candidate' else 'baseline', 'block': block})
            (cell / 'plan.json').write_text(json.dumps(plan, indent=2))
            observations = []
            for index, spec in enumerate(plan):
                arm = spec['arm']
                (ROOT / SOURCE).write_bytes(baseline if arm == 'baseline' else candidate)
                shutil.copyfile(out / f'{arm}.zip', ROOT / 'builds/manabitan-chrome-dev.zip')
                assert sha(ROOT / SOURCE) == identities['source'][arm]
                assert sha(ROOT / 'builds/manabitan-chrome-dev.zip') == identities['packages'][arm]['sha256']
                dest = cell / f'{index:03}-{spec["role"]}-{arm}'
                run(['node', 'dev/perf/import-benchmark.js', args.dictionary, '--runs', '1', '--no-build',
                     '--flags', '{}', '--output', str(dest)], cell / f'{index:03}.log')
                summary = json.loads((dest / 'summary.json').read_text())
                report = json.loads((dest / 'run-1.json').read_text())
                assert report['status'] == 'success' and report['skippedVerification'] is False
                assert summary['authoritativeTiming'] is True and len(summary['runs']) == 1
                value = summary['runs'][0]['totalImportMs']
                assert 0 < value < 180000
                row = {**spec, 'index': index, 'ms': value, 'report': str((dest / 'run-1.json').relative_to(out)),
                       'reportSha256': sha(dest / 'run-1.json'), 'packageSha256': identities['packages'][arm]['sha256']}
                observations.append(row)
                (cell / 'observations.json').write_text(json.dumps(observations, indent=2))
                print(json.dumps(row), flush=True)
            def changes(role):
                values = [v['ms'] for v in observations if v['role'] == role]
                pairs, totals = [], []
                for i in range(0, len(values), 4):
                    a, b, c, d = values[i:i+4]
                    pairs.extend([100 * (b / a - 1), 100 * (c / d - 1)])
                    totals.append(100 * ((b+c) / (a+d) - 1))
                return pairs, totals
            pairs, totals = changes('candidate')
            controls, _ = changes('control')
            measured = [v for v in observations if v['role'] == 'candidate']
            arm_times = {a: [v['ms'] for v in measured if v['arm'] == a] for a in ['baseline', 'candidate']}
            result = {'complete': True, 'dictionary': args.dictionary, 'layout': layout,
                      'pairedPercent': pairs, 'medianPairedPercent': statistics.median(pairs),
                      'fasterPairs': sum(v < 0 for v in pairs), 'blockTotalsPercent': totals,
                      'equalWorkPercent': 100 * (sum(arm_times['candidate']) / sum(arm_times['baseline']) - 1),
                      'armMediansMs': {a: statistics.median(v) for a, v in arm_times.items()},
                      'controlPairs': controls, 'medianAbsControlPercent': statistics.median(map(abs, controls)),
                      'observationCount': len(observations)}
            (cell / 'result.json').write_text(json.dumps(result, indent=2))
            print(json.dumps(result), flush=True)
    finally:
        lock_path.write_bytes(original_lock)
        (ROOT / SOURCE).write_bytes(candidate)
        shutil.copyfile(out / 'candidate.zip', ROOT / 'builds/manabitan-chrome-dev.zip')


if __name__ == '__main__':
    main()
