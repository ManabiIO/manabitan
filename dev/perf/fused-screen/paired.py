"""Fixed whole-import pairs and same-binary controls; no retries or discarded runs."""
import argparse
import hashlib
import json
import math
import os
import signal
import statistics
import subprocess
import zipfile
from pathlib import Path


def load(p):
    return json.loads(Path(p).read_text())


def save(p, value):
    Path(p).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()


def digest(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def statistics_for(pairs):
    changes = [100 * (b / a - 1) for a, b in pairs]
    return {'pairs_ms': pairs, 'paired_changes_percent': changes, 'median_paired_change_percent': statistics.median(changes), 'aggregate_change_percent': 100 * (sum(b for a, b in pairs) / sum(a for a, b in pairs) - 1), 'faster_pairs': sum(b < a for a, b in pairs), 'worst_pair_percent': max(changes)}


def audit(root, target, dictionary, identity):
    s = load(target / 'summary.json')
    raw = load(target / 'run-1.json')
    assert s['schemaVersion'] == 3 and s['authoritativeTiming'] and not s['traceEnabled']
    assert raw['status'] == 'success' and raw['skippedVerification'] is False
    b = raw['benchmark']
    assert b['pinnedDictionaries'] and b['productionImportDefaults'] and b['authoritativeTiming'] and b['importFlags'] is None
    assert not any(b[k] for k in ['traceEnabled', 'phaseProfiling', 'phaseScreenshots', 'processSampling'])
    assert not s['source']['dirty'] and s['source']['gitSha'] == identity['commit']
    assert s['source']['sha256']['builds/manabitan-chrome-dev.zip'] == identity['package_sha256']
    assert len(s['runs']) == 1
    run = s['runs'][0]
    ms = run['totalImportMs']
    assert math.isfinite(ms) and ms > 0
    expected = load(root / 'test/perf/dictionaries.lock.json')['dictionaries'][dictionary]
    v = run['validation']
    assert (v['title'], v['revision'], v['termRows']) == (expected['expectedTitle'], expected['revision'], expected['termRows'])
    assert v['contentReadable'] and v['probeCount'] == 12
    debug = run['importDebug']
    assert debug['errorCount'] == 0 and debug['addSettingsErrorCount'] == 0 and not debug['usesFallbackStorage']
    phases = [p['details'] for p in debug['importerPhaseTimings'] if p['phase'].startswith('term-file-fast-path:')]
    with zipfile.ZipFile(root / 'builds/e2e-dictionary-cache' / expected['cacheFile']) as z:
        banks = [i for i in z.infolist() if i.filename.startswith('term_bank_') and i.filename.endswith('.json')]
    assert sum(p['batchedFileCount'] for p in phases) == len(banks)
    assert sum(p['rows'] for p in phases) == expected['termRows']
    assert sum(p['parserSourceUncompressedBytes'] for p in phases) == sum(i.file_size for i in banks)
    assert sum(p['parserSourceCompressedBytes'] for p in phases) == sum(i.compress_size for i in banks)
    metrics = ['dedupPendingHitCount', 'dedupPersistedHitCount', 'dedupUniqueCount']
    timings = ['dedupScanMs', 'dedupCapacityMs', 'dedupCanonicalScanMs', 'dedupExactCompareMs', 'contentStoreMs', 'contentMetadataMs', 'parserParallelWorkerWallMs', 'dedupRecentSourceCacheMs']
    return {'ms': ms, 'accounting': {k: sum(p[k] for p in phases) for k in metrics}, 'components_ms': {k: sum(p.get(k, 0) for p in phases) for k in timings}, 'validation': v, 'source': s['source']}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--baseline', type=Path, required=True)
    p.add_argument('--candidate', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--dictionary', required=True)
    p.add_argument('--pairs', type=int, default=6)
    p.add_argument('--reverse', action='store_true')
    args = p.parse_args()
    assert args.pairs >= 2
    args.output.mkdir(parents=True, exist_ok=False)
    roots = {'A': args.baseline.resolve(), 'B': args.candidate.resolve()}
    identity = {}
    for arm, root in roots.items():
        assert not git(root, 'status', '--porcelain')
        identity[arm] = {'commit': git(root, 'rev-parse', 'HEAD'), 'tree': git(root, 'rev-parse', 'HEAD^{tree}'), 'package_sha256': digest(root / 'builds/manabitan-chrome-dev.zip')}
    assert identity['A']['tree'] == 'dc3098b9acc761caf193952537d568652196dc76'
    assert identity['B']['tree'] == '493b5c5d206a391cebd1b2aaa8fe45ef6203dbc3'
    with zipfile.ZipFile(roots['A'] / 'builds/manabitan-chrome-dev.zip') as az, zipfile.ZipFile(roots['B'] / 'builds/manabitan-chrome-dev.zip') as bz:
        assert set(az.namelist()) == set(bz.namelist())
        changed = sorted(n for n in az.namelist() if az.read(n) != bz.read(n))
        assert changed == ['js/dictionary/dictionary-database.js'], changed
    save(args.output / 'identity.json', identity)
    plan = []
    for pair in range(-1, args.pairs):
        order = 'AB' if (pair + int(args.reverse)) % 2 == 0 else 'BA'
        plan.extend({'kind': 'warmup' if pair < 0 else 'AB', 'pair': pair, 'arm': arm} for arm in order)
        if pair in (0, args.pairs - 1):
            arm = 'A' if pair == 0 else 'B'
            plan.extend({'kind': 'AA', 'pair': pair, 'arm': arm} for _ in range(2))
    save(args.output / 'plan.json', plan)
    observations = []
    try:
        for i, item in enumerate(plan):
            target = args.output / f'{i:03d}-{item["kind"]}-{item["arm"]}'
            with (args.output / f'{i:03d}.log').open('w') as log:
                child = subprocess.Popen(['node', 'dev/perf/import-benchmark.js', args.dictionary, '--runs', '1', '--no-build', '--output', str(target)], cwd=roots[item['arm']], stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                try:
                    code = child.wait(timeout=240)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGTERM)
                    child.wait(timeout=20)
                    raise
            row = dict(item, output=target.name, returncode=code)
            observations.append(row)
            save(args.output / 'observations.json', observations)
            assert code == 0, row
            row.update(audit(roots[item['arm']], target, args.dictionary, identity[item['arm']]))
            save(args.output / 'observations.json', observations)
            print(i, item, round(row['ms'], 2), flush=True)
        pairs = []
        for n in range(args.pairs):
            rows = {r['arm']: r for r in observations if r['kind'] == 'AB' and r['pair'] == n}
            assert rows['A']['accounting'] == rows['B']['accounting']
            pairs.append([rows['A']['ms'], rows['B']['ms']])
        for arm, root in roots.items():
            assert not git(root, 'status', '--porcelain')
            assert digest(root / 'builds/manabitan-chrome-dev.zip') == identity[arm]['package_sha256']
        controls = {arm: statistics_for([[r['ms'] for r in observations if r['kind'] == 'AA' and r['arm'] == arm]]) for arm in 'AB'}
        result = {'status': 'complete', 'dictionary': args.dictionary, 'comparison': statistics_for(pairs), 'same_binary_controls': controls}
        save(args.output / 'RESULTS.json', result)
        print(json.dumps(result, indent=2), flush=True)
    except BaseException as error:
        save(args.output / 'FAILURE.json', {'status': 'incomplete', 'error': repr(error), 'observations': len(observations), 'effect_estimate': None})
        raise


if __name__ == '__main__':
    main()
