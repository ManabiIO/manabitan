import argparse
import hashlib
import json
import math
import statistics
import subprocess
import zipfile
from pathlib import Path


def load(path):
    return json.loads(Path(path).read_text())


def save(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + '\n')


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def audit(root, target, dictionary):
    summary = load(target / 'summary.json')
    raw = load(target / 'run-1.json')
    run = summary['runs'][0]
    assert summary['schemaVersion'] == 3 and summary['dictionary'] == dictionary
    assert summary['authoritativeTiming'] and not summary['traceEnabled']
    assert raw['status'] == 'success' and raw['skippedVerification'] is False
    benchmark = raw['benchmark']
    assert benchmark['pinnedDictionaries'] and benchmark['productionImportDefaults'] and benchmark['authoritativeTiming']
    assert benchmark['importFlags'] is None
    assert not any(benchmark[key] for key in ['traceEnabled', 'phaseProfiling', 'phaseScreenshots', 'processSampling'])
    assert not summary['source']['dirty'] and summary['source']['gitSha'] == git(root, 'rev-parse', 'HEAD')
    assert len(summary['runs']) == 1 and math.isfinite(run['totalImportMs']) and run['totalImportMs'] > 0
    fixture = load(root / 'test/perf/dictionaries.lock.json')['dictionaries'][dictionary]
    validation = run['validation']
    assert (validation['title'], validation['revision'], validation['termRows']) == (fixture['expectedTitle'], fixture['revision'], fixture['termRows'])
    assert validation['contentReadable'] and validation['probeCount'] == 12
    debug = run['importDebug']
    assert debug['errorCount'] == 0 and debug['addSettingsErrorCount'] == 0 and not debug['usesFallbackStorage']
    phases = [phase['details'] for phase in debug['importerPhaseTimings'] if phase['phase'].startswith('term-file-fast-path:')]
    with zipfile.ZipFile(root / 'builds/e2e-dictionary-cache' / fixture['cacheFile']) as archive:
        banks = [item for item in archive.infolist() if item.filename.startswith('term_bank_') and item.filename.endswith('.json')]
    assert sum(phase['rows'] for phase in phases) == fixture['termRows']
    assert sum(phase['batchedFileCount'] for phase in phases) == len(banks)
    assert sum(phase['parserSourceUncompressedBytes'] for phase in phases) == sum(item.file_size for item in banks)
    assert sum(phase['parserSourceCompressedBytes'] for phase in phases) == sum(item.compress_size for item in banks)
    metrics = ['dedupPendingHitCount', 'dedupPersistedHitCount', 'dedupUniqueCount']
    profile = ['contentPackMs', 'contentCompressMs', 'dedupScanMs', 'contentMetadataMs', 'parserLookupIndexCompactMs', 'termRecordWriteMs', 'contentAppendMs']
    return {'ms': run['totalImportMs'], 'accounting': {key: sum(phase[key] for phase in phases) for key in metrics}, 'profile': {key: sum(phase[key] for phase in phases) for key in profile}, 'source': summary['source'], 'browser': summary['browserVersion']}


def stats(pairs):
    changes = [100 * (b / a - 1) for a, b in pairs]
    return {'pairs_ms': pairs, 'paired_changes_percent': changes, 'median_paired_change_percent': statistics.median(changes), 'aggregate_change_percent': 100 * (sum(b for a, b in pairs) / sum(a for a, b in pairs) - 1), 'faster_pairs': sum(b < a for a, b in pairs), 'baseline_median_ms': statistics.median(a for a, b in pairs), 'candidate_median_ms': statistics.median(b for a, b in pairs)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--a', type=Path, required=True)
    parser.add_argument('--b', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--dictionaries', nargs='+', default=['jmnedict'])
    parser.add_argument('--pairs', type=int, default=6)
    parser.add_argument('--controls', action='store_true')
    args = parser.parse_args()
    assert args.pairs >= 2
    args.out.mkdir(parents=True, exist_ok=False)
    roots = {'A': args.a.resolve(), 'B': args.b.resolve()}
    identity = {}
    for arm, root in roots.items():
        assert not git(root, 'status', '--porcelain')
        identity[arm] = {'commit': git(root, 'rev-parse', 'HEAD'), 'tree': git(root, 'rev-parse', 'HEAD^{tree}'), 'package': digest(root / 'builds/manabitan-chrome-dev.zip')}
    assert identity['A']['commit'] == '03478be25506176610b2133be658ee697d9bb3f1'
    assert identity['B']['tree'] == 'e604fea040cffee4e557d0c3797632b17328036f'
    with zipfile.ZipFile(roots['A'] / 'builds/manabitan-chrome-dev.zip') as a, zipfile.ZipFile(roots['B'] / 'builds/manabitan-chrome-dev.zip') as b:
        assert a.namelist() == b.namelist()
        changed = [name for name in a.namelist() if a.read(name) != b.read(name)]
        assert changed == ['js/dictionary/term-content-block-store.js'], changed
    save(args.out / 'identity.json', {'identity': identity, 'changed': changed})
    plan = []
    for pair in range(-1, args.pairs):
        dictionaries = args.dictionaries[pair % len(args.dictionaries):] + args.dictionaries[:pair % len(args.dictionaries)]
        for dictionary in dictionaries:
            order = 'AB' if pair % 2 == 0 else 'BA'
            plan.extend({'kind': 'warmup' if pair < 0 else 'AB', 'pair': pair, 'd': dictionary, 'arm': arm} for arm in order)
            if args.controls and pair in (0, args.pairs - 1):
                arm = 'A' if pair == 0 else 'B'
                plan.extend({'kind': 'AA', 'pair': pair, 'd': dictionary, 'arm': arm} for _ in range(2))
    save(args.out / 'plan.json', plan)
    observations = []
    try:
        for index, item in enumerate(plan):
            root = roots[item['arm']]
            target = args.out / f'{index:03d}-{item["kind"]}-{item["d"]}-{item["arm"]}'
            with (args.out / f'{index:03d}.log').open('w') as log:
                process = subprocess.run(['node', 'dev/perf/import-benchmark.js', item['d'], '--runs', '1', '--no-build', '--output', str(target)], cwd=root, stdout=log, stderr=subprocess.STDOUT, timeout=240)
            observation = dict(item, output=str(target), returncode=process.returncode)
            observations.append(observation)
            save(args.out / 'observations.json', observations)
            assert process.returncode == 0, observation
            observation.update(audit(root, target, item['d']))
            save(args.out / 'observations.json', observations)
            assert digest(root / 'builds/manabitan-chrome-dev.zip') == identity[item['arm']]['package']
            print(index, item, round(observation['ms'], 1), flush=True)
        results = {}
        controls = {}
        for dictionary in args.dictionaries:
            pairs = []
            for pair in range(args.pairs):
                rows = {row['arm']: row for row in observations if row['kind'] == 'AB' and row['pair'] == pair and row['d'] == dictionary}
                assert rows['A']['accounting'] == rows['B']['accounting']
                pairs.append([rows['A']['ms'], rows['B']['ms']])
            results[dictionary] = stats(pairs)
            controls[dictionary] = {arm: stats([[row['ms'] for row in observations if row['kind'] == 'AA' and row['d'] == dictionary and row['arm'] == arm]]) for arm in 'AB'} if args.controls else {}
        for root in roots.values():
            assert not git(root, 'status', '--porcelain')
        save(args.out / 'RESULTS.json', {'status': 'complete', 'results': results, 'same_binary_controls': controls})
        print(json.dumps(results, indent=2), flush=True)
    except BaseException as error:
        save(args.out / 'FAILURE.json', {'status': 'incomplete', 'error': repr(error), 'observations': len(observations), 'effect_estimate': None})
        raise


if __name__ == '__main__':
    main()
