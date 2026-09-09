"""Frozen source A/B with exact acceptance, two A/A controls, no retries."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import statistics
import subprocess
import zipfile


def load(path):
    return json.loads(Path(path).read_text())


def save(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + '\n')


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()


def audit(root, target, dictionary):
    summary = load(target / 'summary.json')
    raw = load(target / 'run-1.json')
    assert raw['status'] == 'success' and not raw['skippedVerification']
    b = raw['benchmark']
    assert b['pinnedDictionaries'] and b['productionImportDefaults'] and b['authoritativeTiming']
    assert not any(b[k] for k in ['traceEnabled', 'phaseProfiling', 'phaseScreenshots', 'processSampling'])
    assert b['importFlags'] is None
    assert not summary['source']['dirty']
    assert len(summary['runs']) == 1
    run = summary['runs'][0]
    ms = run['totalImportMs']
    assert math.isfinite(ms) and ms > 0
    expected = load(root / 'test/perf/dictionaries.lock.json')['dictionaries'][dictionary]
    v = run['validation']
    assert (v['title'], v['revision'], v['termRows']) == (expected['expectedTitle'], expected['revision'], expected['termRows'])
    assert v['contentReadable'] and v['probeCount'] == 12
    debug = run['importDebug']
    assert debug['errorCount'] == 0 and debug['addSettingsErrorCount'] == 0
    assert not debug['usesFallbackStorage']
    phases = [p['details'] for p in debug['importerPhaseTimings'] if p['phase'].startswith('term-file-fast-path:')]
    with zipfile.ZipFile(root / 'builds/e2e-dictionary-cache' / expected['cacheFile']) as z:
        banks = [i for i in z.infolist() if i.filename.startswith('term_bank_') and i.filename.endswith('.json')]
    assert sum(p['batchedFileCount'] for p in phases) == len(banks)
    assert sum(p['rows'] for p in phases) == expected['termRows']
    assert sum(p['parserSourceUncompressedBytes'] for p in phases) == sum(i.file_size for i in banks)
    assert sum(p['parserSourceCompressedBytes'] for p in phases) == sum(i.compress_size for i in banks)
    metrics = ['dedupPendingHitCount', 'dedupPersistedHitCount', 'dedupUniqueCount']
    return {'ms': ms, 'accounting': {k: sum(p[k] for p in phases) for k in metrics}, 'source': summary['source'], 'browserVersion': run['browserVersion'], 'validation': v}


def statistics_for(pairs):
    changes = [100 * (b / a - 1) for a, b in pairs]
    return {'pairs_ms': pairs, 'paired_changes_percent': changes, 'median_paired_change_percent': statistics.median(changes), 'aggregate_change_percent': 100 * (sum(b for a, b in pairs) / sum(a for a, b in pairs) - 1), 'faster_pairs': sum(b < a for a, b in pairs), 'worst_pair_percent': max(changes)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--dictionary', required=True)
    parser.add_argument('--reverse', action='store_true')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    roots = {'A': args.baseline.resolve(), 'B': args.candidate.resolve()}
    expected_shas = {'A': 'ff9cbf2e848a86d6bbfd281179a6d753349e52f4', 'B': '3ef73a422410d2f0ac0be00fb8e618a4c7949416'}
    identity = {}
    for arm, root in roots.items():
        assert git(root, 'rev-parse', 'HEAD') == expected_shas[arm]
        assert not git(root, 'status', '--porcelain')
        identity[arm] = {'commit': git(root, 'rev-parse', 'HEAD'), 'tree': git(root, 'rev-parse', 'HEAD^{tree}'), 'package_sha256': hashlib.sha256((root / 'builds/manabitan-chrome-dev.zip').read_bytes()).hexdigest()}
    with zipfile.ZipFile(roots['A'] / 'builds/manabitan-chrome-dev.zip') as a, zipfile.ZipFile(roots['B'] / 'builds/manabitan-chrome-dev.zip') as b:
        assert set(a.namelist()) == set(b.namelist())
        changed = sorted(n for n in a.namelist() if a.read(n) != b.read(n))
        assert changed == ['js/dictionary/term-record-preinterned-plan.js'], changed
    save(args.output / 'identity.json', identity)
    plan = []
    for pair in range(-1, 4):
        order = 'AB' if (pair + int(args.reverse)) % 2 == 0 else 'BA'
        plan.extend({'kind': 'warmup' if pair < 0 else 'AB', 'pair': pair, 'arm': arm} for arm in order)
        if pair in (0, 2):
            arm = 'A' if pair == 0 else 'B'
            plan.extend({'kind': 'AA', 'pair': pair, 'arm': arm} for _ in range(2))
    save(args.output / 'plan.json', plan)
    observations = []
    try:
        for index, item in enumerate(plan):
            target = args.output / f'{index:02d}-{item["kind"]}-{item["arm"]}'
            with (args.output / f'{index:02d}.log').open('w') as log:
                completed = subprocess.run(['node', 'dev/perf/import-benchmark.js', args.dictionary, '--runs', '1', '--no-build', '--output', str(target)], cwd=roots[item['arm']], stdout=log, stderr=subprocess.STDOUT, timeout=240, check=False)
            observation = dict(item, output=str(target), returncode=completed.returncode)
            observations.append(observation)
            save(args.output / 'observations.json', observations)
            assert completed.returncode == 0, observation
            observation.update(audit(roots[item['arm']], target, args.dictionary))
            save(args.output / 'observations.json', observations)
            print(index, item['kind'], item['arm'], observation['ms'], flush=True)
        pairs = []
        for index in range(4):
            values = {r['arm']: r for r in observations if r['kind'] == 'AB' and r['pair'] == index}
            assert values['A']['accounting'] == values['B']['accounting']
            pairs.append([values['A']['ms'], values['B']['ms']])
        for arm, root in roots.items():
            assert not git(root, 'status', '--porcelain')
            assert hashlib.sha256((root / 'builds/manabitan-chrome-dev.zip').read_bytes()).hexdigest() == identity[arm]['package_sha256']
        controls = {}
        for arm in 'AB':
            values = [r['ms'] for r in observations if r['kind'] == 'AA' and r['arm'] == arm]
            controls[arm] = statistics_for([values])
        save(args.output / 'RESULTS.json', {'status': 'complete', 'dictionary': args.dictionary, 'comparison': statistics_for(pairs), 'same_binary_controls': controls})
    except BaseException as error:
        save(args.output / 'FAILURE.json', {'status': 'incomplete', 'error': repr(error), 'observations': len(observations), 'effect_estimate': None})
        raise


if __name__ == '__main__':
    main()
