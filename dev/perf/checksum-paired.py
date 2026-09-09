"""Checksum candidate: exact trees, fixed paired imports, no retries."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import random
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


def stats(pairs):
    changes = [100 * (b / a - 1) for a, b in pairs]
    rng = random.Random(8171)
    boot = sorted(statistics.median(rng.choices(changes, k=len(changes))) for _ in range(20000))
    return {'pairs_ms': pairs, 'paired_changes_percent': changes,
            'median_paired_change_percent': statistics.median(changes),
            'aggregate_change_percent': 100 * (sum(b for a, b in pairs) / sum(a for a, b in pairs) - 1),
            'faster_pairs': sum(b < a for a, b in pairs), 'worst_pair_percent': max(changes),
            'bootstrap_95_percent': [boot[500], boot[19499]]}


def audit(root, target, dictionary):
    summary = load(target / 'summary.json')
    raw = load(target / 'run-1.json')
    assert raw['status'] == 'success' and raw['skippedVerification'] is False
    config = raw['benchmark']
    assert config['dictionary'] == dictionary
    assert config['pinnedDictionaries'] and config['productionImportDefaults'] and config['authoritativeTiming']
    assert not any(config[k] for k in ('traceEnabled', 'phaseProfiling', 'phaseScreenshots', 'processSampling'))
    assert config['importFlags'] is None and summary['source']['dirty'] is False
    assert len(summary['runs']) == 1
    run = summary['runs'][0]
    ms = run['totalImportMs']
    assert math.isfinite(ms) and ms > 0
    fixture = load(root / 'test/perf/dictionaries.lock.json')['dictionaries'][dictionary]
    validation = run['validation']
    assert (validation['title'], validation['revision'], validation['termRows'], validation['contentReadable'], validation['probeCount']) == (fixture['expectedTitle'], fixture['revision'], fixture['termRows'], True, 12)
    debug = run['importDebug']
    assert debug['errorCount'] == debug['addSettingsErrorCount'] == 0
    assert debug['usesFallbackStorage'] is False
    phases = [p['details'] for p in debug['importerPhaseTimings'] if p['phase'].startswith('term-file-fast-path:')]
    with zipfile.ZipFile(root / 'builds/e2e-dictionary-cache' / fixture['cacheFile']) as archive:
        banks = [i for i in archive.infolist() if i.filename.startswith('term_bank_') and i.filename.endswith('.json')]
    assert sum(p['batchedFileCount'] for p in phases) == len(banks)
    assert sum(p['rows'] for p in phases) == fixture['termRows']
    accounting = {k: sum(p[k] for p in phases) for k in ('dedupPendingHitCount', 'dedupPersistedHitCount', 'dedupUniqueCount')}
    metrics = {k: sum(p[k] for p in phases) if all(k in p for p in phases) else None for k in ('contentPackMs', 'contentCompressMs', 'dedupScanMs', 'contentMetadataMs', 'termRecordWriteMs', 'parserLookupIndexPrepareMs', 'parserSourceTransferredBytes', 'parserSourceUncompressedBytes', 'parserSourceCompressedBytes')}
    return {'ms': ms, 'accounting': accounting, 'metrics': metrics, 'source': summary['source'],
            'browserVersion': run['browserVersion'], 'validation': validation,
            'sourceBudgets': sorted(set(p['sourceBatchMaxBytes'] for p in phases))}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--dictionary', required=True)
    parser.add_argument('--pairs', type=int, default=6)
    parser.add_argument('--reverse', action='store_true')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    roots = {'A': args.baseline.resolve(), 'B': args.candidate.resolve()}
    trees = {'A': 'b217181dee356a8a8f9836cffe5c5b382c27da69', 'B': 'bff51446158ec2255c4ffd0f24e38fea6db57d6a'}
    identity = {}
    for arm, root in roots.items():
        assert git(root, 'rev-parse', 'HEAD^{tree}') == trees[arm]
        assert not git(root, 'status', '--porcelain')
        identity[arm] = {'commit': git(root, 'rev-parse', 'HEAD'), 'tree': trees[arm], 'package_sha256': digest(root / 'builds/manabitan-chrome-dev.zip')}
    assert identity['A']['commit'] == 'da8f7436d34e510441d30692c8d698806b70e13f'
    for path in ('package-lock.json', 'test/perf/dictionaries.lock.json', 'dev/perf/benchmark-support.js', 'dev/perf/import-benchmark.js', 'test/chromium/extension-two-dictionary-import.e2e.js'):
        assert digest(roots['A'] / path) == digest(roots['B'] / path)
    with zipfile.ZipFile(roots['A'] / 'builds/manabitan-chrome-dev.zip') as a, zipfile.ZipFile(roots['B'] / 'builds/manabitan-chrome-dev.zip') as b:
        assert a.namelist() == b.namelist()
        changed = sorted(n for n in a.namelist() if a.read(n) != b.read(n))
        assert changed == ['js/dictionary/term-key-hash.js', 'js/dictionary/term-record-opfs-store.js'], changed
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
        for index, item in enumerate(plan):
            root = roots[item['arm']]
            assert not git(root, 'status', '--porcelain')
            assert git(root, 'rev-parse', 'HEAD') == identity[item['arm']]['commit']
            assert digest(root / 'builds/manabitan-chrome-dev.zip') == identity[item['arm']]['package_sha256']
            target = args.output / f'{index:02d}-{item["kind"]}-{item["arm"]}'
            with (args.output / f'{index:02d}.log').open('w') as log:
                result = subprocess.run(['node', 'dev/perf/import-benchmark.js', args.dictionary, '--runs', '1', '--no-build', '--output', str(target)], cwd=root, stdout=log, stderr=subprocess.STDOUT, timeout=210)
            row = dict(item, output=str(target), returncode=result.returncode)
            observations.append(row)
            save(args.output / 'observations.json', observations)
            assert result.returncode == 0, row
            row.update(audit(root, target, args.dictionary))
            save(args.output / 'observations.json', observations)
            print(index, item['kind'], item['arm'], row['ms'], flush=True)
        pairs = []
        for pair in range(args.pairs):
            values = {r['arm']: r for r in observations if r['kind'] == 'AB' and r['pair'] == pair}
            assert values['A']['accounting'] == values['B']['accounting']
            assert values['A']['sourceBudgets'] == values['B']['sourceBudgets']
            pairs.append([values['A']['ms'], values['B']['ms']])
        controls = {arm: [r['ms'] for r in observations if r['kind'] == 'AA' and r['arm'] == arm] for arm in 'AB'}
        for arm, root in roots.items():
            assert not git(root, 'status', '--porcelain')
            assert git(root, 'rev-parse', 'HEAD') == identity[arm]['commit']
            assert digest(root / 'builds/manabitan-chrome-dev.zip') == identity[arm]['package_sha256']
        save(args.output / 'RESULTS.json', {'status': 'complete', 'dictionary': args.dictionary, 'comparison': stats(pairs), 'same_binary_controls': controls})
    except BaseException as error:
        save(args.output / 'FAILURE.json', {'status': 'incomplete', 'error': repr(error), 'observations': len(observations), 'effect_estimate': None})
        raise


if __name__ == '__main__':
    main()
