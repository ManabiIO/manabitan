"""Fixed whole-import confirmation. No retries, dropped observations, or partial estimates."""
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


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()


def audit(root, output, dictionary, identity):
    summary = load(output / 'summary.json')
    raw = load(output / 'run-1.json')
    assert len(summary['runs']) == 1
    run = summary['runs'][0]
    benchmark = raw['benchmark']
    validation = run['validation']
    debug = run['importDebug']
    assert raw['status'] == 'success' and raw['skippedVerification'] is False
    assert benchmark['authoritativeTiming'] and benchmark['productionImportDefaults'] and benchmark['pinnedDictionaries']
    assert not any(benchmark[key] for key in ['traceEnabled', 'phaseProfiling', 'phaseScreenshots', 'processSampling'])
    assert benchmark['importFlags'] is None
    assert not summary['source']['dirty']
    assert summary['source']['gitSha'] == identity['commit']
    assert summary['source']['sha256']['builds/manabitan-chrome-dev.zip'] == identity['package']
    fixture = load(root / 'test/perf/dictionaries.lock.json')['dictionaries'][dictionary]
    assert (validation['title'], validation['revision'], validation['termRows']) == (fixture['expectedTitle'], fixture['revision'], fixture['termRows'])
    assert validation['contentReadable'] is True and validation['probeCount'] == 12
    assert debug['errorCount'] == 0 and debug['addSettingsErrorCount'] == 0 and debug['usesFallbackStorage'] is False
    milliseconds = run['totalImportMs']
    assert math.isfinite(milliseconds) and milliseconds > 0
    phases = [phase['details'] for phase in debug['importerPhaseTimings'] if phase['phase'].startswith('term-file-fast-path:')]
    with zipfile.ZipFile(root / 'builds/e2e-dictionary-cache' / fixture['cacheFile']) as archive:
        banks = [entry for entry in archive.infolist() if entry.filename.startswith('term_bank_') and entry.filename.endswith('.json')]
    assert sum(phase['batchedFileCount'] for phase in phases) == len(banks)
    assert sum(phase['rows'] for phase in phases) == fixture['termRows']
    assert sum(phase['parserSourceUncompressedBytes'] for phase in phases) == sum(entry.file_size for entry in banks)
    assert sum(phase['parserSourceCompressedBytes'] for phase in phases) == sum(entry.compress_size for entry in banks)
    keys = ['dedupPendingHitCount', 'dedupPersistedHitCount', 'dedupUniqueCount', 'dedupRecentSourceCacheBytes']
    costs = ['contentPackMs', 'dedupScanMs', 'contentMetadataMs', 'termRecordWriteMs', 'parserLookupIndexPrepareMs', 'parserParseBankMs', 'contentCompressMs']
    return {'ms': milliseconds, 'accounting': {key: sum(phase.get(key, 0) for phase in phases) for key in keys}, 'costs': {key: sum(phase.get(key, 0) for phase in phases) for key in costs}, 'validation': validation, 'source': summary['source']}


def stats(pairs):
    changes = [100 * (candidate / baseline - 1) for baseline, candidate in pairs]
    return {'pairs': pairs, 'changes': changes, 'median_change': statistics.median(changes), 'aggregate_change': 100 * (sum(b for a, b in pairs) / sum(a for a, b in pairs) - 1), 'faster': sum(b < a for a, b in pairs)}


def make_plan(dictionaries, pairs, reverse):
    assert pairs >= 4
    plan = []
    for pair in range(-1, pairs):
        for index in range(len(dictionaries)):
            dictionary = dictionaries[(index + pair + 1) % len(dictionaries)]
            order = 'AB' if (pair + index + int(reverse)) % 2 == 0 else 'BA'
            plan.extend({'dictionary': dictionary, 'kind': 'warmup' if pair < 0 else 'AB', 'pair': pair, 'arm': arm} for arm in order)
        if pair in (1, pairs - 2):
            arm = 'A' if pair == 1 else 'B'
            for dictionary in dictionaries:
                plan.extend({'dictionary': dictionary, 'kind': 'AA', 'pair': pair, 'arm': arm} for _ in range(2))
    assert len(plan) == len(dictionaries) * (2 + 2 * pairs + 4)
    return plan


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--pairs', type=int, default=6)
    parser.add_argument('--dictionary', default='jmnedict,jmdict,jitendex')
    parser.add_argument('--reverse', action='store_true')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    roots = {'A': args.baseline.resolve(), 'B': args.candidate.resolve()}
    identities = {}
    for arm, root in roots.items():
        assert not git(root, 'status', '--porcelain')
        identities[arm] = {'commit': git(root, 'rev-parse', 'HEAD'), 'tree': git(root, 'rev-parse', 'HEAD^{tree}'), 'package': sha(root / 'builds/manabitan-chrome-dev.zip')}
    assert identities['A']['tree'] == 'e4a19b48831a9fd91e2ab91eea562573d1195828'
    assert identities['B']['tree'] == '23c968f9fc18b3c533d0e7565b3ca9d66bed77aa'
    with zipfile.ZipFile(roots['A'] / 'builds/manabitan-chrome-dev.zip') as baseline, zipfile.ZipFile(roots['B'] / 'builds/manabitan-chrome-dev.zip') as candidate:
        assert set(baseline.namelist()) == set(candidate.namelist())
        changes = sorted(name for name in baseline.namelist() if baseline.read(name) != candidate.read(name))
        assert changes == ['js/dictionary/term-bank-wasm-parser.js'], changes
    for path in ['package-lock.json', 'test/perf/dictionaries.lock.json', 'dev/perf/import-benchmark.js', 'test/chromium/extension-two-dictionary-import.e2e.js']:
        assert sha(roots['A'] / path) == sha(roots['B'] / path)
    save(args.output / 'identity.json', identities)
    dictionaries = args.dictionary.split(',')
    plan = make_plan(dictionaries, args.pairs, args.reverse)
    save(args.output / 'plan.json', plan)
    observations = []
    try:
        for index, item in enumerate(plan):
            root = roots[item['arm']]
            output = args.output / f'{index:03}-{item["dictionary"]}-{item["kind"]}-{item["arm"]}'
            with (args.output / f'{index:03}.log').open('w') as log:
                result = subprocess.run(['node', 'dev/perf/import-benchmark.js', item['dictionary'], '--runs', '1', '--no-build', '--output', str(output)], cwd=root, stdout=log, stderr=subprocess.STDOUT, timeout=240, check=False)
            observation = {**item, 'output': str(output), 'returncode': result.returncode}
            observations.append(observation)
            save(args.output / 'observations.json', observations)
            assert result.returncode == 0, observation
            observation.update(audit(root, output, item['dictionary'], identities[item['arm']]))
            save(args.output / 'observations.json', observations)
            print(index, item['dictionary'], item['kind'], item['arm'], observation['ms'], flush=True)
        results = {}
        for dictionary in dictionaries:
            pairs = []
            for pair in range(args.pairs):
                values = {o['arm']: o for o in observations if o['dictionary'] == dictionary and o['kind'] == 'AB' and o['pair'] == pair}
                assert values['A']['accounting'] == values['B']['accounting']
                pairs.append([values['A']['ms'], values['B']['ms']])
            results[dictionary] = stats(pairs)
            results[dictionary]['same_binary'] = {arm: stats([[o['ms'] for o in observations if o['dictionary'] == dictionary and o['kind'] == 'AA' and o['arm'] == arm]]) for arm in 'AB'}
        for arm, root in roots.items():
            assert not git(root, 'status', '--porcelain')
            assert sha(root / 'builds/manabitan-chrome-dev.zip') == identities[arm]['package']
        save(args.output / 'RESULTS.json', results)
        print(json.dumps(results, indent=2), flush=True)
    except BaseException as error:
        save(args.output / 'FAILURE.json', {'error': repr(error), 'effect_estimate': None, 'complete': False})
        raise


if __name__ == '__main__':
    main()
