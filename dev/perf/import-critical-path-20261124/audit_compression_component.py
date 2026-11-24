#!/usr/bin/env python3
"""Audit the fixed compression component cohort without rerunning timing."""
import hashlib
import json
import math
from pathlib import Path
import statistics

ROOT = Path(__file__).resolve().parent
COHORT = ROOT / 'compression-level-study/cohort-1'
SOURCE = ROOT.parent / 'compression-level-study'
HARNESS = SOURCE / 'dev/perf/compression-level-study-20261124'
ORDERS = ['ABCD', 'BDAC', 'CADB', 'DCBA', 'DCBA', 'CADB', 'BDAC', 'ABCD']
ARMS = {'A': -1, 'B': -2, 'C': -3, 'D': -1}

def read(path):
    return json.loads(path.read_text())

def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def equal(actual, expected, context):
    if isinstance(actual, float) or isinstance(expected, float):
        assert math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-8), (context, actual, expected)
    else:
        assert actual == expected, (context, actual, expected)

plan = read(COHORT / 'plan.json')
analysis = read(COHORT / 'analysis.json')
commands = read(COHORT / 'commands.json')
plan_sha = sha(COHORT / 'plan.json')
assert plan['sourceBase'] == 'bbccabd520972cc351a65d9f545bd5369b6e9747'
assert plan['orders'] == ORDERS and plan['arms'] == ARMS
assert plan['corpora'] == ['jmdict', 'jitendex']
assert plan['excludedWarmupPasses'] == 2 and plan['measuredPassesPerFreshChild'] == 1
assert plan['plannedMeasuredObservations'] == 64 and plan['plannedWarmupPasses'] == 128
assert plan['environment']['node'] == 'v22.22.0'
for name, key in [('run-one.mjs', 'runnerSha256'), ('run.mjs', 'driverSha256'), ('capture.mjs', 'captureHarnessSha256')]:
    equal(sha(HARNESS / name), plan[key], name)
for name, expected in plan['productSha256'].items():
    equal(sha(SOURCE / name), expected, name)
equal(analysis['planSha256'], plan_sha, 'analysis plan')
expected_order = [(corpus, block, arm) for corpus in plan['corpora']
                  for block, order in enumerate(ORDERS) for arm in order]
assert [(c['corpus'], c['block'], c['arm']) for c in commands] == expected_order
assert len(list((COHORT / 'observations').iterdir())) == 64
inventory = read(ROOT / 'baseline-content-inventory.json')
result = {'status': 'passed', 'planSha256': plan_sha, 'observations': 64,
          'warmupPasses': 128, 'scope': 'Independent source/receipt/byte-hash/arithmetic audit; no timing rerun',
          'corpora': {}, 'limitations': [
              'Node compression component only; source gather, IPC, dedup and storage are outside timing.',
              'Explicit forced GC is outside timing; automatic GC during wrapper calls is not proven absent.',
              'Baseline byte equality is against captured production-function frames; browser OPFS inventories agree, but complete browser frame bytes were not captured.',
              'No whole-import improvement follows from a component speed estimate.',
          ]}
for corpus in plan['corpora']:
    capture_dir = Path(plan['captureDirectory']) / corpus
    capture = read(capture_dir / 'capture.json')
    equal(sha(capture_dir / 'capture.json'), plan['captures'][corpus]['sha256'], corpus + ' capture')
    assert capture['productionInventoryMatch'] is True
    receipts = [r for r in inventory if r['dictionary'] == corpus]
    assert len(receipts) == 6
    mapping = {'unique': 'dedupUniqueCount', 'pendingHits': 'dedupPendingHitCount',
               'persistedHits': 'dedupPersistedHitCount', 'groups': 'sourceGroups',
               'banks': 'sourceBanks', 'encodedBytes': 'encodedContentBytes',
               'contentFileChunks': 'writtenBlockChunks', 'contentFileBytes': 'termContentTotalWriteBytes'}
    for field, evidence_field in mapping.items():
        assert all(capture[field] == r[evidence_field] for r in receipts), (corpus, field)
    blocks = capture['blocks']
    baseline_hashes, baseline_sizes = [], []
    for index, block in enumerate(blocks):
        assert block['number'] == index
        raw = capture_dir / block['filename']
        compressed = capture_dir / block['compressedFilename']
        assert raw.stat().st_size == block['bytes'] and sha(raw) == block['sha256']
        assert compressed.stat().st_size == block['compressedBytes'] and sha(compressed) == block['compressedSha256']
        baseline_hashes.append(block['compressedSha256'])
        baseline_sizes.append(block['compressedBytes'])
    assert sum(baseline_sizes) == capture['compressedBytes']
    assert capture['referenceBytes'] == capture['unique'] * 20
    assert capture['contentFileBytes'] == capture['compressedBytes'] + capture['referenceBytes']
    assert capture['contentFileChunks'] == len(blocks) + capture['groups']
    raw_bytes = sum(b['bytes'] for b in blocks)
    reference = {}
    for level in (-1, -2, -3):
        directory = COHORT / 'compressed-reference' / corpus / f'level{level}'
        paths = sorted(directory.glob('*.zstd-envelope'))
        assert [p.name for p in paths] == [f'{i:04}.zstd-envelope' for i in range(len(blocks))]
        reference[level] = ([sha(p) for p in paths], [p.stat().st_size for p in paths])
    assert reference[-1] == (baseline_hashes, baseline_sizes)
    measures = {arm: [] for arm in ARMS}
    loops = {arm: [] for arm in ARMS}
    verified_passes = 0
    for command in [c for c in commands if c['corpus'] == corpus]:
        block, arm = command['block'], command['arm']
        directory = COHORT / 'observations' / f'{corpus}-{block:02}-{arm}'
        assert command['exitCode'] == 0 and command['signal'] is None and command['error'] is None
        assert command['command'][1:3] == ['--expose-gc', str(HARNESS / 'run-one.mjs')]
        assert command['command'][3:] == [str(COHORT / 'plan.json'), corpus, arm, str(block), str(directory)]
        for name in ('stdout', 'stderr'):
            equal(sha(directory / (name + '.log')), command[name + 'Sha256'], name + ' digest')
        report = read(directory / 'observation.json')
        assert report['status'] == 'passed' and report['planSha256'] == plan_sha
        assert report['corpus'] == corpus and report['arm'] == arm and report['block'] == block
        assert report['level'] == ARMS[arm]
        assert report['sourceBlockCount'] == len(blocks) and report['rawBytes'] == raw_bytes
        assert len(report['observations']) == 3
        hashes, sizes = reference[ARMS[arm]]
        for index, observation in enumerate(report['observations']):
            assert observation['pass'] == index and observation['warmup'] is (index < 2)
            assert observation['exactDecompression'] is True and observation['validEnvelope'] is True
            assert observation['compressedSha256'] == hashes and observation['compressedSizes'] == sizes
            assert observation['compressedBytes'] == sum(sizes)
            times = observation['blockMs']
            assert len(times) == len(blocks) and all(math.isfinite(t) and t >= 0 for t in times)
            equal(sum(times), observation['wrapperCallsMs'], 'wrapper call sum')
            assert observation['loopMs'] + 1e-8 >= observation['wrapperCallsMs'] > 0
            verified_passes += 1
        measured = report['observations'][-1]
        stdout = read(directory / 'stdout.log')
        for key in ('corpus', 'arm', 'level', 'block', 'status'):
            equal(stdout[key], report[key], 'stdout ' + key)
        for key in ('loopMs', 'wrapperCallsMs', 'compressedBytes'):
            equal(stdout[key], measured[key], 'stdout ' + key)
        measures[arm].append(measured['wrapperCallsMs'])
        loops[arm].append(measured['loopMs'])
    assert verified_passes == 96 and all(len(v) == 8 for v in measures.values())
    published = analysis['corpora'][corpus]
    equal(published['sourceBlocks'], len(blocks), 'source block count')
    equal(published['rawBytes'], raw_bytes, 'raw bytes')
    for arm in ARMS:
        equal(published['medianWrapperCallsMs'][arm], statistics.median(measures[arm]), 'wrapper median')
        equal(published['medianLoopMs'][arm], statistics.median(loops[arm]), 'loop median')
    comparisons = {}
    for numerator, denominator in [('B', 'A'), ('B', 'D'), ('C', 'A'), ('C', 'D'), ('D', 'A')]:
        name = numerator + '/' + denominator
        changes = [100 * (n / d - 1) for n, d in zip(measures[numerator], measures[denominator])]
        actual = {'pairedMedianPercent': statistics.median(changes),
                  'equalWorkPercent': 100 * (sum(measures[numerator]) / sum(measures[denominator]) - 1),
                  'fasterPairs': sum(n < 0 for n in changes), 'pairs': 8, 'pairedPercent': changes}
        for key, value in actual.items():
            if isinstance(value, list):
                for got, expected in zip(published['comparisons'][name][key], value):
                    equal(got, expected, name + ' pair')
            else:
                equal(published['comparisons'][name][key], value, name + ' ' + key)
        comparisons[name] = actual
    storage = {}
    for level in (-1, -2, -3):
        compressed = sum(reference[level][1])
        total = compressed + capture['referenceBytes']
        values = {'compressedBytes': compressed, 'compressedDeltaBytes': compressed - capture['compressedBytes'],
                  'compressedDeltaPercent': 100 * (compressed / capture['compressedBytes'] - 1),
                  'contentFileBytes': total, 'contentFileDeltaBytes': total - capture['contentFileBytes'],
                  'contentFileDeltaPercent': 100 * (total / capture['contentFileBytes'] - 1)}
        for key, value in values.items():
            equal(published['levels'][str(level)][key], value, f'{corpus} level {level} {key}')
        for word, percent in [('One', 1), ('Two', 2), ('Five', 5)]:
            equal(published['levels'][str(level)][f'meets{word}PercentContentFileBudget'],
                  values['contentFileDeltaPercent'] <= percent, 'storage budget')
        storage[str(level)] = values
    result['corpora'][corpus] = {'sourceBlocks': len(blocks), 'rawBytes': raw_bytes,
                                'verifiedFullPasses': verified_passes, 'productionInventoryMatch': True,
                                'baselineFramesEqual': True, 'comparisons': comparisons, 'storage': storage}
assert analysis['measuredObservations'] == 64 and analysis['excludedWarmupPasses'] == 128
assert analysis['allParityChecksPassed'] is True
out = ROOT / 'compression-level-study/independent-audit.json'
out.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'status': result['status'], 'observations': 64, 'warmups': 128,
                  'corpora': {k: {'sourceBlocks': v['sourceBlocks'], 'storage': v['storage']}
                              for k, v in result['corpora'].items()}}, indent=2))
