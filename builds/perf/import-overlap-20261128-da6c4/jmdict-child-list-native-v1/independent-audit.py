"""Independent saved-receipt audit; imports no experiment evaluator."""
import hashlib
import json
import math
from pathlib import Path

ROOT = Path('/tmp/manabitan-da6c4-child-list-study')
OUT = Path('/tmp/manabitan-da6c4-alias-fixture-repair/child-list-independent-audit.json')
def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
def median(values):
    values = sorted(values)
    count = len(values)
    return values[count // 2] if count % 2 else (values[count // 2 - 1] + values[count // 2]) / 2
def quantile(values, q):
    values = sorted(values)
    position = (len(values) - 1) * q
    low = int(position)
    return values[low] + (values[min(low + 1, len(values) - 1)] - values[low]) * (position - low)

plan = json.loads((ROOT / 'plan.json').read_text())
inputs = json.loads((ROOT / 'inputs.json').read_text())
saved = json.loads((ROOT / 'measured-v1/observations.json').read_text())
reported = json.loads((ROOT / 'measured-v1/analysis.json').read_text())
assert saved['complete'] is True and saved['planSha256'] == sha(ROOT / 'plan.json')
assert saved['plan'] == plan
assert sha(ROOT / 'inputs.json') == plan['inputSha256']
assert len(saved['observations']) == len(saved['attempts']) == 36
ordered = [(i, j, arm) for i, order in enumerate(plan['schedule']) for j, arm in enumerate(order)]
assert sorted(plan['schedule']) == sorted(['ABC', 'ACB', 'BAC', 'BCA', 'CAB', 'CBA'] * 2)
rounds = [{} for _ in range(12)]
raw_files = []
for expected, item, attempt in zip(ordered, saved['observations'], saved['attempts']):
    assert (item['round'], item['position'], item['arm']) == expected
    assert (attempt['round'], attempt['position'], attempt['arm']) == expected
    assert attempt['exitCode'] == 0
    raw_path = ROOT / 'measured-v1' / item['rawFile']
    assert sha(raw_path) == item['rawSha256']
    assert sha(ROOT / 'measured-v1' / attempt['log']) == attempt['logSha256']
    raw = json.loads(raw_path.read_text())
    arm = item['arm']; source_arm = 'A' if arm == 'C' else arm
    assert raw['complete'] and raw['arm'] == arm and raw['mode'] == 'measure'
    assert raw['before'] == raw['after'] == inputs['identities'][source_arm]
    assert raw['inputSha256'] == plan['inputSha256']
    assert raw['runnerSha256'] == plan['harnessSha256']['component-arm.mjs']
    assert raw['moduleSha256'] == inputs['identities'][source_arm]['dev/data/dictionary-wasm/term-bank-parser.wasm']
    assert raw['moduleSha256'] != inputs['counterWasm']['sha256']
    assert raw['node'] == plan['node'] and raw['experiments'] == plan['experimentSnapshot']
    assert raw['options'] == plan['parserOptions'] and raw['groupGeometry'] == plan['groupGeometry']
    assert len(raw['warmups']) == 2
    for sweep in raw['warmups'] + [raw['measured']]:
        assert sweep['rows'] == 528299 and sweep['nativeCalls'] == 12 and len(sweep['groups']) == 12
        assert all(g['profile']['fusedParseAttempts'] == 1 and g['profile']['fusedParseFallbacks'] == 0 for g in sweep['groups'])
    assert [g['output'] for g in raw['measured']['groups']] == plan['outputOracle']
    assert all(g['counters'] is None for g in raw['measured']['groups'])
    for name in ('nativeFusedMs', 'fullGroupMs'):
        assert math.isfinite(item[name]) and item[name] > 0 and item[name] == raw['measured'][name]
    rounds[item['round']][arm] = item
    raw_files.append({'path': item['rawFile'], 'sha256': sha(raw_path)})

metrics, pairs = {}, {}
for control in ('A', 'C'):
    deltas = [r['B']['nativeFusedMs'] - r[control]['nativeFusedMs'] for r in rounds]
    percentages = [100 * (r['B']['nativeFusedMs'] / r[control]['nativeFusedMs'] - 1) for r in rounds]
    wall_deltas = [r['B']['fullGroupMs'] - r[control]['fullGroupMs'] for r in rounds]
    wall_percentages = [100 * (r['B']['fullGroupMs'] / r[control]['fullGroupMs'] - 1) for r in rounds]
    pairs[control] = {'deltaMs': deltas, 'percent': percentages}
    metrics[control] = {'pairedMedianDeltaMs': median(deltas), 'pairedMedianPercent': median(percentages),
        'fasterPairs': sum(value < 0 for value in deltas),
        'nativeEqualWorkPercent': 100 * (math.fsum(r['B']['nativeFusedMs'] for r in rounds) / math.fsum(r[control]['nativeFusedMs'] for r in rounds) - 1),
        'fullGroupEqualWorkPercent': 100 * (math.fsum(r['B']['fullGroupMs'] for r in rounds) / math.fsum(r[control]['fullGroupMs'] for r in rounds) - 1),
        'fullGroupPairedMedianDeltaMs': median(wall_deltas), 'fullGroupPairedMedianPercent': median(wall_percentages)}
state = 894660
samples = {control: {name: [] for name in ('deltaMs', 'percent')} for control in ('A', 'C')}
for _ in range(20000):
    indexes = []
    for __ in range(12):
        state = (state ^ (state << 13)) & 0xffffffff
        state = (state ^ (state >> 17)) & 0xffffffff
        state = (state ^ (state << 5)) & 0xffffffff
        indexes.append((state * 12) // 4294967296)
    for control in ('A', 'C'):
        for name in ('deltaMs', 'percent'):
            samples[control][name].append(median(pairs[control][name][i] for i in indexes))
for control in ('A', 'C'):
    metrics[control]['bootstrap95'] = {name: [quantile(values, .025), quantile(values, .975)] for name, values in samples[control].items()}
control_median = median(100 * (r['C']['nativeFusedMs'] / r['A']['nativeFusedMs'] - 1) for r in rounds)
control_equal = 100 * (math.fsum(r['C']['nativeFusedMs'] for r in rounds) / math.fsum(r['A']['nativeFusedMs'] for r in rounds) - 1)
limit = min(abs(metrics['A']['pairedMedianPercent']), abs(metrics['C']['pairedMedianPercent'])) / 2
control_metrics = {'pairedMedianPercent': control_median, 'equalWorkPercent': control_equal,
    'strictAbsoluteLimitPercent': limit,
    'fullGroupPairedMedianPercent': median(100 * (r['C']['fullGroupMs'] / r['A']['fullGroupMs'] - 1) for r in rounds),
    'fullGroupEqualWorkPercent': 100 * (math.fsum(r['C']['fullGroupMs'] for r in rounds) / math.fsum(r['A']['fullGroupMs'] for r in rounds) - 1)}
checks = {}
for control in ('A', 'C'):
    value = metrics[control]
    checks[control + '.nativeSavingAtLeast3Percent'] = value['pairedMedianPercent'] <= -3
    checks[control + '.atLeast9FasterPairs'] = value['fasterPairs'] >= 9
    checks[control + '.nativeEqualWorkLower'] = value['nativeEqualWorkPercent'] < 0
    checks[control + '.bothNativeIntervalUpperBoundsNegative'] = all(pair[1] < 0 for pair in value['bootstrap95'].values())
    checks[control + '.fullGroupEqualWorkAtMost1PercentRegression'] = math.fsum(r['B']['fullGroupMs'] for r in rounds) <= 1.01 * math.fsum(r[control]['fullGroupMs'] for r in rounds)
checks['control.nativePairedMedianBelowHalfSmallerSaving'] = abs(control_median) < limit
checks['control.nativeEqualWorkBelowHalfSmallerSaving'] = abs(control_equal) < limit
discrepancies = []
def compare(left, right, where):
    if isinstance(left, dict):
        assert set(left) == set(right), where
        for key in left: compare(left[key], right[key], where + '.' + key)
    elif isinstance(left, list):
        assert len(left) == len(right), where
        for i, (a, b) in enumerate(zip(left, right)): compare(a, b, where + '.' + str(i))
    elif isinstance(left, (int, float)) and not isinstance(left, bool):
        if not math.isclose(left, right, rel_tol=1e-12, abs_tol=1e-10): discrepancies.append({'path': where, 'independent': left, 'reported': right})
    elif left != right:
        discrepancies.append({'path': where, 'independent': left, 'reported': right})
compare(metrics, reported['metrics'], 'metrics')
compare(control_metrics, reported['control'], 'control')
compare(checks, reported['checks'], 'checks')
assert reported['advance'] == all(checks.values())
assert discrepancies == []
result = {'schemaVersion': 1, 'complete': True, 'scope': 'Independent saved-receipt/source-binding/statistics audit only. No imports, measurements or reruns.',
    'source': {'planSha256': sha(ROOT / 'plan.json'), 'observationsSha256': sha(ROOT / 'measured-v1/observations.json'),
               'analysisSha256': sha(ROOT / 'measured-v1/analysis.json'), 'auditorSha256': sha(Path(__file__))},
    'all36RawReceiptsChecked': True, 'rawFiles': raw_files, 'pairs': pairs, 'metrics': metrics, 'control': control_metrics,
    'checks': checks, 'advance': all(checks.values()), 'discrepancies': discrepancies,
    'bootstrap': {'resamples': 20000, 'seed': 894660, 'finalState': state, 'generator': 'xorshift32', 'quantile': 'type7', 'sharedWholeRoundIndexes': True},
    'interpretation': 'The declared native gain and control gates fail. Larger apparent B/C improvement does not rescue B/A six-of-twelve wins, the confidence intervals crossing zero, or control drift. Complete-group wall diagnostics are not a substitute endpoint. No browser promotion or unchanged rerun.'}
assert not OUT.exists()
OUT.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({key: result[key] for key in ('complete', 'metrics', 'control', 'advance', 'discrepancies', 'bootstrap')}))
