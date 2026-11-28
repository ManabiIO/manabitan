# SPDX-License-Identifier: GPL-3.0-or-later
"""Pure fixed-plan scheduling and descriptive per-host alias qualification gates."""
import math
import random
import statistics


def schedule(initial_order):
    if initial_order not in ('AB', 'BA'):
        raise ValueError('Unknown initial order')
    opposite = initial_order[::-1]
    result = []
    for pair, order in enumerate((initial_order, opposite), 1):
        result.extend({'id': f'warmup-{pair}-{arm}', 'kind': 'warmup', 'pair': pair, 'arm': arm} for arm in order)
    for pair in range(1, 13):
        order = initial_order if pair % 2 else opposite
        result.extend({'id': f'pair-{pair:02d}-{arm}', 'kind': 'candidate', 'pair': pair, 'arm': arm} for arm in order)
        if pair % 3 == 0:
            control_pair = pair // 3
            control_order = 'AC' if (control_pair + (initial_order == 'BA')) % 2 else 'CA'
            result.extend({'id': f'control-{control_pair:02d}-{arm}', 'kind': 'control', 'pair': control_pair, 'arm': arm} for arm in control_order)
    return result


def paired_summary(observations, kind, left, right, count):
    pairs = {}
    for item in observations:
        if item['kind'] != kind:
            continue
        pair = pairs.setdefault(item['pair'], {})
        if item['arm'] in pair or item['arm'] not in (left, right):
            raise ValueError('Duplicate or unexpected paired arm')
        duration = item['totalImportMs']
        if type(duration) not in (int, float) or not math.isfinite(duration) or duration <= 0:
            raise ValueError('Invalid import endpoint')
        pair[item['arm']] = duration
    if set(pairs) != set(range(1, count + 1)) or any(set(value) != {left, right} for value in pairs.values()):
        raise ValueError('Incomplete fixed paired observations')
    rows = [pairs[index] for index in range(1, count + 1)]
    differences = [value[right] - value[left] for value in rows]
    percentages = [(value[right] / value[left] - 1) * 100 for value in rows]
    rng = random.Random(897)
    sampled_ms, sampled_percent = [], []
    for _ in range(10000):
        indexes = rng.choices(range(count), k=count)
        sampled_ms.append(statistics.median(differences[index] for index in indexes))
        sampled_percent.append(statistics.median(percentages[index] for index in indexes))
    sampled_ms.sort(); sampled_percent.sort()
    total_left = sum(value[left] for value in rows)
    total_right = sum(value[right] for value in rows)
    return {
        'count': count, 'leftArm': left, 'rightArm': right,
        'pairs': [{'pair': index + 1, **value, 'differenceMs': differences[index],
                   'changePercent': percentages[index]} for index, value in enumerate(rows)],
        'medianPairedChangeMs': statistics.median(differences),
        'medianPairedChangePercent': statistics.median(percentages),
        'equalWorkChangePercent': (total_right / total_left - 1) * 100,
        'leftEqualWorkMs': total_left, 'rightEqualWorkMs': total_right,
        'descriptiveBootstrap95Ms': [sampled_ms[index] for index in (249, 9749)],
        'descriptiveBootstrap95Percent': [sampled_percent[index] for index in (249, 9749)],
        'fasterPairs': sum(value < 0 for value in differences),
        'worstPairChangePercent': max(percentages),
        'bootstrap': {'draws': 10000, 'random': 'random.Random(897)',
                      'sharedPairIndexesForMsAndPercent': True, 'sortedIndexes': [249, 9749]},
    }


def analyze(observations, dictionary, initial_order):
    if dictionary not in ('jmdict', 'jitendex', 'vndb'):
        raise ValueError('Unknown dictionary')
    plan = schedule(initial_order)
    if len(observations) != len(plan):
        raise ValueError('Incomplete acquisition; no timing conclusion')
    for expected, actual in zip(plan, observations):
        if any(actual.get(key) != value for key, value in expected.items()):
            raise ValueError('Observation order differs from the frozen plan')
        duration = actual.get('totalImportMs')
        if type(duration) not in (int, float) or not math.isfinite(duration) or duration <= 0:
            raise ValueError('Missing endpoint, including excluded warmups')
    candidate = paired_summary(observations, 'candidate', 'A', 'B', 12)
    control = paired_summary(observations, 'control', 'A', 'C', 4)
    if dictionary == 'vndb':
        limit = 0.5 * min(abs(candidate['medianPairedChangePercent']), abs(candidate['equalWorkChangePercent']))
        gates = {
            'medianSavingAtLeast100Ms': candidate['medianPairedChangeMs'] <= -100,
            'medianSavingAtLeast1Percent': candidate['medianPairedChangePercent'] <= -1,
            'upperDescriptive95MsBelowZero': candidate['descriptiveBootstrap95Ms'][1] < 0,
            'upperDescriptive95PercentBelowZero': candidate['descriptiveBootstrap95Percent'][1] < 0,
            'atLeast9Of12Faster': candidate['fasterPairs'] >= 9,
            'candidateEqualWorkStrictlyLower': candidate['rightEqualWorkMs'] < candidate['leftEqualWorkMs'],
            'controlMedianBelowHalfSmallerSaving': abs(control['medianPairedChangePercent']) < limit,
            'controlEqualWorkBelowHalfSmallerSaving': abs(control['equalWorkChangePercent']) < limit,
        }
    else:
        limit = 1
        gates = {
            'medianIncreaseAtMost1Percent': candidate['medianPairedChangePercent'] <= 1,
            'equalWorkIncreaseAtMost1Percent': candidate['equalWorkChangePercent'] <= 1,
            'upperDescriptive95PercentAtMost3': candidate['descriptiveBootstrap95Percent'][1] <= 3,
            'controlMedianAtMost1Percent': abs(control['medianPairedChangePercent']) <= 1,
            'controlEqualWorkAtMost1Percent': abs(control['equalWorkChangePercent']) <= 1,
        }
    return {'complete': True, 'dictionary': dictionary, 'initialOrder': initial_order,
            'candidateVsBaseline': candidate, 'identicalCodeControl': control,
            'controlLimitPercent': limit, 'gates': gates, 'passesProspectiveTimingScreen': all(gates.values()),
            'scope': 'One source-bound host/corpus/order. All36 observations retained, four warmups excluded by the fixed plan. Descriptive paired bootstrap, no population or pooled-host claim. Complete semantic/source/memory gates and every other cell remain mandatory.'}
