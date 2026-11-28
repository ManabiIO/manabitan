"""Prospectively registered JMdict review criteria, evaluated after acquisition."""
import math
import random
import statistics

BASELINE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
CANDIDATE = '9da7dedd17535b4a0f8edb97e56756049bbad7a7'
EXPECTED_PAIRS = 12
EXPECTED_CONTROL_PAIRS = 4


def fixed_schedule(order):
    if order not in ('AB', 'BA'):
        raise ValueError('Expected initial order AB or BA')
    result = []
    for pair, arms in enumerate((order, order[::-1]), 1):
        result.extend({'id': f'warmup-{pair}-{arm}', 'kind': 'warmup', 'pair': pair, 'arm': arm} for arm in arms)
    for pair in range(1, EXPECTED_PAIRS + 1):
        arms = order if pair % 2 else order[::-1]
        result.extend({'id': f'pair-{pair:02d}-{arm}', 'kind': 'candidate', 'pair': pair, 'arm': arm} for arm in arms)
        if pair % 3 == 0:
            control = pair // 3
            arms = 'AC' if (control + (order == 'BA')) % 2 else 'CA'
            result.extend({'id': f'control-{control:02d}-{arm}', 'kind': 'control', 'pair': control, 'arm': arm} for arm in arms)
    return result


def checked_pairs(observations, kind, right, count):
    pairs = {}
    for row in observations:
        if row['kind'] != kind:
            continue
        duration = row['totalImportMs']
        if type(duration) not in (int, float) or not math.isfinite(duration) or duration <= 0:
            raise ValueError('Nonpositive or nonfinite observation')
        if row['arm'] not in ('A', right):
            raise ValueError('Unexpected observation arm')
        pair = pairs.setdefault(row['pair'], {})
        if row['arm'] in pair:
            raise ValueError('Duplicate pair arm')
        pair[row['arm']] = duration
    if sorted(pairs) != list(range(1, count + 1)) or any(set(pair) != {'A', right} for pair in pairs.values()):
        raise ValueError('Incomplete registered pair cohort')
    return [pairs[index] for index in range(1, count + 1)]


def summarize(pairs, right):
    ratios = [pair[right] / pair['A'] for pair in pairs]
    rng = random.Random(897)
    boot = sorted(statistics.median(rng.choices(ratios, k=len(ratios))) for _ in range(10000))
    return {
        'count': len(pairs), 'ratios': ratios,
        'medianPairedChangePercent': (statistics.median(ratios) - 1) * 100,
        'equalWorkChangePercent': (sum(pair[right] for pair in pairs) / sum(pair['A'] for pair in pairs) - 1) * 100,
        'worstPairChangePercent': (max(ratios) - 1) * 100,
        'descriptiveBootstrap95Percent': [(boot[index] - 1) * 100 for index in (249, 9749)],
        'fasterPairs': sum(ratio < 1 for ratio in ratios),
    }


def evaluate_review_criteria(observations, order, producer_analysis=None):
    schedule = fixed_schedule(order)
    if [{key: row[key] for key in ('id', 'kind', 'pair', 'arm')} for row in observations] != schedule:
        raise ValueError('Observation order differs from the complete prospective schedule')
    for row in observations:
        duration = row['totalImportMs']
        if type(duration) not in (int, float) or not math.isfinite(duration) or duration <= 0:
            raise ValueError('Invalid duration in the registered cohort')
    candidate_pairs = checked_pairs(observations, 'candidate', 'B', EXPECTED_PAIRS)
    control_pairs = checked_pairs(observations, 'control', 'C', EXPECTED_CONTROL_PAIRS)
    candidate = summarize(candidate_pairs, 'B')
    control = summarize(control_pairs, 'C')
    if producer_analysis is not None:
        if candidate != producer_analysis['candidateVsBaseline'] or control != producer_analysis['identicalCodeControl']:
            raise ValueError('Producer analysis differs from independent observation arithmetic')
    absolute_savings = [pair['A'] - pair['B'] for pair in candidate_pairs]
    median_absolute_saving = statistics.median(absolute_savings)
    gain = -candidate['medianPairedChangePercent']
    control_drift = abs(control['medianPairedChangePercent'])
    criteria = {
        'atLeastThreePercentMedianPairedGain': gain >= 3,
        'atLeastTwentyMillisecondsMedianPairedSaving': median_absolute_saving >= 20,
        'equalWorkImprovement': candidate['equalWorkChangePercent'] < 0,
        'atLeastTenOfTwelvePairsFaster': candidate['fasterPairs'] >= 10,
        'descriptiveIntervalWhollyBelowZero': candidate['descriptiveBootstrap95Percent'][1] < 0,
        'gainExceedsAbsoluteControlMedianDrift': gain > control_drift,
    }
    return {
        'scope': 'Per-host review threshold for this small build change; no host pooling or control subtraction',
        'completePairs': EXPECTED_PAIRS, 'controlPairs': EXPECTED_CONTROL_PAIRS,
        'candidateVsBaseline': candidate, 'identicalCodeControl': control,
        'pairedAbsoluteSavingsMs': absolute_savings, 'medianPairedAbsoluteSavingMs': median_absolute_saving,
        'criteria': criteria, 'passesPerformanceReview': all(criteria.values()),
        'requiresSeparateSemanticPackageMediaMemoryAndReliabilityGates': True,
    }
