import json
import math
from pathlib import Path
import statistics


def percentile(values, quantile):
    values = sorted(values)
    position = (len(values) - 1) * quantile
    index = math.floor(position)
    return values[index] + (values[min(index + 1, len(values) - 1)] - values[index]) * (position - index)


def assess(observations, *, resamples=20000):
    assert len(observations) == 36
    rounds = []
    for block in range(12):
        rows = {item['arm']: item for item in observations if item['round'] == block}
        assert set(rows) == {'A', 'B', 'C'}
        for row in rows.values():
            for name in ['nativeFusedMs', 'fullGroupMs']:
                assert math.isfinite(row[name]) and row[name] > 0
        rounds.append(rows)
    differences = {}
    metrics = {}
    for control in ['A', 'C']:
        delta = [row['B']['nativeFusedMs'] - row[control]['nativeFusedMs'] for row in rounds]
        percent = [100 * (row['B']['nativeFusedMs'] / row[control]['nativeFusedMs'] - 1) for row in rounds]
        native_equal = 100 * (sum(row['B']['nativeFusedMs'] for row in rounds) / sum(row[control]['nativeFusedMs'] for row in rounds) - 1)
        wall_equal = 100 * (sum(row['B']['fullGroupMs'] for row in rounds) / sum(row[control]['fullGroupMs'] for row in rounds) - 1)
        wall_delta = [row['B']['fullGroupMs'] - row[control]['fullGroupMs'] for row in rounds]
        wall_percent = [100 * (row['B']['fullGroupMs'] / row[control]['fullGroupMs'] - 1) for row in rounds]
        differences[control] = {'deltaMs': delta, 'percent': percent}
        metrics[control] = {'pairedMedianDeltaMs': statistics.median(delta), 'pairedMedianPercent': statistics.median(percent), 'fasterPairs': sum(value < 0 for value in delta), 'nativeEqualWorkPercent': native_equal, 'fullGroupEqualWorkPercent': wall_equal, 'fullGroupPairedMedianDeltaMs': statistics.median(wall_delta), 'fullGroupPairedMedianPercent': statistics.median(wall_percent)}
    bootstrap = {control: {'deltaMs': [], 'percent': []} for control in ['A', 'C']}
    state = 0x000da6c4
    def random_index():
        nonlocal state
        state ^= (state << 13) & 0xffffffff
        state ^= state >> 17
        state ^= (state << 5) & 0xffffffff
        state &= 0xffffffff
        return int((state / 4294967296) * 12)
    for unused in range(resamples):
        indexes = [random_index() for item in range(12)]
        for control in ['A', 'C']:
            for metric in ['deltaMs', 'percent']:
                bootstrap[control][metric].append(statistics.median(differences[control][metric][index] for index in indexes))
    for control in ['A', 'C']:
        metrics[control]['bootstrap95'] = {metric: [percentile(values, 0.025), percentile(values, 0.975)] for metric, values in bootstrap[control].items()}
    control_median = statistics.median(100 * (row['C']['nativeFusedMs'] / row['A']['nativeFusedMs'] - 1) for row in rounds)
    control_equal = 100 * (sum(row['C']['nativeFusedMs'] for row in rounds) / sum(row['A']['nativeFusedMs'] for row in rounds) - 1)
    smaller_saving = min(abs(metrics['A']['pairedMedianPercent']), abs(metrics['C']['pairedMedianPercent']))
    checks = {}
    for control in ['A', 'C']:
        value = metrics[control]
        checks[f'{control}.nativeSavingAtLeast3Percent'] = value['pairedMedianPercent'] <= -3
        checks[f'{control}.atLeast9FasterPairs'] = value['fasterPairs'] >= 9
        checks[f'{control}.nativeEqualWorkLower'] = value['nativeEqualWorkPercent'] < 0
        checks[f'{control}.bothNativeIntervalUpperBoundsNegative'] = all(bounds[1] < 0 for bounds in value['bootstrap95'].values())
        # Compare the original sums to the exact declared ratio. Converting a
        # mathematical 1% boundary to percent can round just above 1 in binary64.
        checks[f'{control}.fullGroupEqualWorkAtMost1PercentRegression'] = sum(row['B']['fullGroupMs'] for row in rounds) <= sum(row[control]['fullGroupMs'] for row in rounds) * 1.01
    checks['control.nativePairedMedianBelowHalfSmallerSaving'] = abs(control_median) < smaller_saving / 2
    checks['control.nativeEqualWorkBelowHalfSmallerSaving'] = abs(control_equal) < smaller_saving / 2
    wall_control_median = statistics.median(100 * (row['C']['fullGroupMs'] / row['A']['fullGroupMs'] - 1) for row in rounds)
    wall_control_equal = 100 * (sum(row['C']['fullGroupMs'] for row in rounds) / sum(row['A']['fullGroupMs'] for row in rounds) - 1)
    return {'metrics': metrics, 'control': {'pairedMedianPercent': control_median, 'equalWorkPercent': control_equal, 'strictAbsoluteLimitPercent': smaller_saving / 2, 'fullGroupPairedMedianPercent': wall_control_median, 'fullGroupEqualWorkPercent': wall_control_equal}, 'bootstrap': {'resamples': resamples, 'generator': 'xorshift32', 'seed': 0x000da6c4, 'sharedIndexesAcrossComparisonsAndMetrics': True, 'percentile': 'type7'}, 'checks': checks, 'advance': all(checks.values())}


if __name__ == '__main__':
    import sys
    source = Path(sys.argv[1])
    report = json.loads(source.read_text())
    assert report['complete'] is True
    result = assess(report['observations'])
    destination = Path(sys.argv[2])
    assert not destination.exists()
    destination.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
