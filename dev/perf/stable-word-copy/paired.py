"""Fixed adjacent A/B imports; exact acceptance; no retries or outlier deletion."""
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


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def statistics_for(pairs):
    changes = [100 * (b / a - 1) for a, b in pairs]
    return {'pairs_ms': pairs, 'paired_changes_percent': changes,
            'median_paired_change_percent': statistics.median(changes),
            'aggregate_change_percent': 100 * (sum(b for a, b in pairs) / sum(a for a, b in pairs) - 1),
            'faster_pairs': sum(b < a for a, b in pairs), 'worst_pair_percent': max(changes)}


def audit(root, target, dictionary, identity):
    summary = load(target / 'summary.json')
    raw = load(target / 'run-1.json')
    assert raw['status'] == 'success' and raw['skippedVerification'] is False
    benchmark = raw['benchmark']
    assert benchmark['dictionary'] == dictionary
    assert benchmark['pinnedDictionaries'] and benchmark['productionImportDefaults'] and benchmark['authoritativeTiming']
    assert not any(benchmark[k] for k in ['traceEnabled', 'phaseProfiling', 'phaseScreenshots', 'processSampling'])
    assert benchmark['importFlags'] is None
    assert summary['source']['dirty'] is False and summary['source']['gitSha'] == identity['commit']
    assert len(summary['runs']) == 1
    assert digest(root / 'builds/manabitan-chrome-dev.zip') == identity['package_sha256']
    run = summary['runs'][0]
    ms = run['totalImportMs']
    assert isinstance(ms, (int, float)) and math.isfinite(ms) and ms > 0
    expected = load(root / 'test/perf/dictionaries.lock.json')['dictionaries'][dictionary]
    validation = run['validation']
    assert (validation['title'], validation['revision'], validation['termRows']) == (expected['expectedTitle'], expected['revision'], expected['termRows'])
    assert validation['contentReadable'] is True and validation['probeCount'] >= 12
    debug = run['importDebug']
    assert debug['errorCount'] == 0 and debug['addSettingsErrorCount'] == 0 and debug['usesFallbackStorage'] is False
    phases = [p for p in debug['importerPhaseTimings'] if p['phase'].startswith('term-file-fast-path:')]
    details = [p['details'] for p in phases]
    with zipfile.ZipFile(root / 'builds/e2e-dictionary-cache' / expected['cacheFile']) as archive:
        banks = [i for i in archive.infolist() if i.filename.startswith('term_bank_') and i.filename.endswith('.json')]
    assert sum(p['batchedFileCount'] for p in details) == len(banks)
    assert sum(p['rows'] for p in details) == expected['termRows']
    compressed = sum(p['parserSourceCompressedBytes'] for p in details)
    uncompressed = sum(p['parserSourceUncompressedBytes'] for p in details)
    transferred = sum(p['parserSourceTransferredBytes'] for p in details)
    if compressed:
        assert compressed == sum(i.compress_size for i in banks)
        assert uncompressed == sum(i.file_size for i in banks)
    else:
        assert transferred == sum(i.file_size for i in banks)
    metrics = {k: sum(p.get(k, 0) for p in details) for k in details[0] if k.endswith(('Ms', 'Count', 'Bytes'))}
    return {'ms': ms, 'validation': validation, 'source': summary['source'],
            'browser_version': run['browserVersion'], 'bank_phases': [p['phase'] for p in phases], 'metrics': metrics}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--dictionary', choices=['jmdict', 'jmnedict', 'jitendex'], required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--pairs', type=int, default=6)
    parser.add_argument('--reverse', action='store_true')
    args = parser.parse_args()
    assert args.pairs >= 2
    args.output.mkdir(parents=True, exist_ok=False)
    roots = {'A': args.baseline.resolve(), 'B': args.candidate.resolve()}
    trees = {'A': '1dadf454221027e6789733815c01cb6877f24218', 'B': '8385544b3e978ea4c3140d78a27c1e31118392f4'}
    identity = {}
    for arm, root in roots.items():
        assert git(root, 'rev-parse', 'HEAD^{tree}') == trees[arm]
        assert not git(root, 'status', '--porcelain')
        identity[arm] = {'commit': git(root, 'rev-parse', 'HEAD'), 'tree': trees[arm],
                         'package_sha256': digest(root / 'builds/manabitan-chrome-dev.zip')}
    same_files = ['package-lock.json', 'test/perf/dictionaries.lock.json', 'dev/perf/import-benchmark.js',
                  'dev/perf/benchmark-support.js', 'test/chromium/extension-two-dictionary-import.e2e.js']
    for file in same_files:
        assert digest(roots['A'] / file) == digest(roots['B'] / file), file
    with zipfile.ZipFile(roots['A'] / 'builds/manabitan-chrome-dev.zip') as a, zipfile.ZipFile(roots['B'] / 'builds/manabitan-chrome-dev.zip') as b:
        assert set(b.namelist()) - set(a.namelist()) == {'js/core/copy-stable-bytes.js'}
        assert set(a.namelist()) - set(b.namelist()) == set()
        changed = sorted(n for n in a.namelist() if a.read(n) != b.read(n))
        assert changed == ['js/dictionary/dictionary-database.js'], changed
    save(args.output / 'identity.json', identity)
    save(args.output / 'harness_sha256.json', {file: digest(roots['A'] / file) for file in same_files})
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
        for index, item in enumerate(plan):
            target = args.output / f'{index:02d}-{item["kind"]}-{item["arm"]}'
            with (args.output / f'{index:02d}.log').open('w') as log:
                completed = subprocess.run(['node', 'dev/perf/import-benchmark.js', args.dictionary, '--runs', '1', '--no-build', '--output', str(target)], cwd=roots[item['arm']], stdout=log, stderr=subprocess.STDOUT, timeout=300, check=False)
            observation = dict(item, output=str(target), returncode=completed.returncode)
            observations.append(observation)
            save(args.output / 'observations.json', observations)
            assert completed.returncode == 0, observation
            observation.update(audit(roots[item['arm']], target, args.dictionary, identity[item['arm']]))
            save(args.output / 'observations.json', observations)
            print(index, item['kind'], item['arm'], observation['ms'], flush=True)
        pairs = []
        exact_metrics = ['dedupPendingHitCount', 'dedupPersistedHitCount', 'dedupUniqueCount', 'dedupRecentSourceCacheBytes']
        for index in range(args.pairs):
            values = {r['arm']: r for r in observations if r['kind'] == 'AB' and r['pair'] == index}
            assert values['A']['bank_phases'] == values['B']['bank_phases']
            assert values['A']['browser_version'] == values['B']['browser_version']
            for metric in exact_metrics:
                assert values['A']['metrics'][metric] == values['B']['metrics'][metric], metric
            pairs.append([values['A']['ms'], values['B']['ms']])
        for arm, root in roots.items():
            assert not git(root, 'status', '--porcelain')
            assert git(root, 'rev-parse', 'HEAD') == identity[arm]['commit']
            assert digest(root / 'builds/manabitan-chrome-dev.zip') == identity[arm]['package_sha256']
        controls = {}
        for arm in 'AB':
            values = [r['ms'] for r in observations if r['kind'] == 'AA' and r['arm'] == arm]
            controls[arm] = statistics_for([values])
        save(args.output / 'RESULTS.json', {'status': 'complete', 'dictionary': args.dictionary,
             'comparison': statistics_for(pairs), 'same_binary_controls': controls})
    except BaseException as error:
        save(args.output / 'FAILURE.json', {'status': 'incomplete', 'error': repr(error), 'observations': len(observations), 'effect_estimate': None})
        raise


if __name__ == '__main__':
    main()
