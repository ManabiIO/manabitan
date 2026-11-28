#!/usr/bin/env python3
"""Frozen, per-host statistics for the owned-tail qualification.

This module is pure: it performs no acquisition, exclusions, file writes, memory
qualification, or pooling across hosts. Its schedule and original comparison
fields reproduce dev/perf/import-qualification-20261125-a7f7.py at c9811071,
blob 7bfac83eedfbae61590b849c0934060c30ff4cef. The additional millisecond
interval uses the same complete-pair bootstrap index samples as the ratio
interval. Intervals are descriptive, not population-general claims.

Only the complete prescribed five-field observation sequence is accepted.
Warmups are retained and validated, then excluded solely by the frozen schedule.
Memory, source, package, semantics, and browser gates remain separate.
"""

import math
import random
import statistics


_DICTIONARY_PAIRS = {"jmdict": 24, "jitendex": 12, "vndb": 12}
_OBSERVATION_FIELDS = frozenset(("id", "kind", "pair", "arm", "totalImportMs"))
_BOOTSTRAP_SAMPLES = 10000
_BOOTSTRAP_SEED = 897
_BOOTSTRAP_INDICES = (249, 9749)


def _arguments(dictionary, initial_order):
    if type(dictionary) is not str or dictionary not in _DICTIONARY_PAIRS:
        raise ValueError("dictionary must be jmdict, jitendex, or vndb")
    if type(initial_order) is not str or initial_order not in ("AB", "BA"):
        raise ValueError("initial_order must be AB or BA")


def schedule(dictionary, initial_order):
    """Return the exact fixed ordinary-run schedule, including four warmups."""
    _arguments(dictionary, initial_order)
    result = []
    opposite = initial_order[::-1]
    for pair, order in enumerate((initial_order, opposite), 1):
        for arm in order:
            result.append({
                "id": f"warmup-{pair}-{arm}",
                "kind": "warmup", "pair": pair, "arm": arm,
            })
    for pair in range(1, _DICTIONARY_PAIRS[dictionary] + 1):
        order = initial_order if pair % 2 else opposite
        for arm in order:
            result.append({
                "id": f"pair-{pair:02d}-{arm}",
                "kind": "candidate", "pair": pair, "arm": arm,
            })
        if pair % 3 == 0:
            control_pair = pair // 3
            control_order = (
                "AC" if (control_pair + (initial_order == "BA")) % 2 else "CA"
            )
            for arm in control_order:
                result.append({
                    "id": f"control-{control_pair:02d}-{arm}",
                    "kind": "control", "pair": control_pair, "arm": arm,
                })
    return result


def _finite(value, label):
    if type(value) not in (int, float):
        raise ValueError(f"{label} must be a finite number")
    try:
        valid = math.isfinite(value)
    except (OverflowError, TypeError, ValueError):
        valid = False
    if not valid:
        raise ValueError(f"{label} must be a finite number")
    return value


def _validate_observations(observations, expected):
    if type(observations) is not list or len(observations) != len(expected):
        raise ValueError("observations must be the complete prescribed list")
    for index, (item, planned) in enumerate(zip(observations, expected)):
        if type(item) is not dict or set(item) != _OBSERVATION_FIELDS:
            raise ValueError(f"observation {index} must have exactly five fields")
        if type(item["pair"]) is not int:
            raise ValueError(f"observation {index} pair must be an integer")
        for name in ("id", "kind", "arm"):
            if type(item[name]) is not str:
                raise ValueError(f"observation {index} {name} must be a string")
        if {name: item[name] for name in planned} != planned:
            raise ValueError(f"observation {index} differs from the fixed schedule")
        duration = _finite(item["totalImportMs"], f"observation {index} duration")
        if duration <= 0:
            raise ValueError(f"observation {index} duration must be positive")


def _paired_summary(observations, kind, left, right):
    pairs = {}
    for item in observations:
        if item["kind"] == kind:
            pairs.setdefault(item["pair"], {})[item["arm"]] = item["totalImportMs"]
    complete = list(pairs.values())
    if not complete or any(set(values) != {left, right} for values in complete):
        raise ValueError("incomplete paired observations")
    left_values = [values[left] for values in complete]
    right_values = [values[right] for values in complete]
    ratios = [
        _finite(b / a, "paired ratio")
        for a, b in zip(left_values, right_values)
    ]
    if any(ratio <= 0 for ratio in ratios):
        raise ValueError("paired ratios must remain positive")
    deltas = [
        _finite(b - a, "paired millisecond difference")
        for a, b in zip(left_values, right_values)
    ]
    left_total = _finite(sum(left_values), "baseline equal-work total")
    right_total = _finite(sum(right_values), "comparison equal-work total")
    result = {
        "count": len(complete),
        "ratios": ratios,
        "medianPairedChangePercent": _finite(
            (statistics.median(ratios) - 1) * 100, "median percent"
        ),
        "equalWorkChangePercent": _finite(
            (right_total / left_total - 1) * 100, "equal-work percent"
        ),
        "worstPairChangePercent": _finite(
            (max(ratios) - 1) * 100, "worst-pair percent"
        ),
        "fasterPairs": sum(ratio < 1 for ratio in ratios),
        "pairedMedianDeltaMs": _finite(
            statistics.median(deltas), "median millisecond difference"
        ),
    }
    rng = random.Random(_BOOTSTRAP_SEED)
    ratio_medians = []
    delta_medians = []
    for _ in range(_BOOTSTRAP_SAMPLES):
        # choices(range(...)) consumes exactly the same random stream as the
        # original choices(ratios,...); one index vector serves both endpoints.
        indices = rng.choices(range(len(complete)), k=len(complete))
        ratio_medians.append(_finite(
            statistics.median([ratios[index] for index in indices]),
            "bootstrap median ratio",
        ))
        delta_medians.append(_finite(
            statistics.median([deltas[index] for index in indices]),
            "bootstrap median millisecond difference",
        ))
    ratio_medians.sort()
    delta_medians.sort()
    result["descriptiveBootstrap95Percent"] = [
        _finite((ratio_medians[index] - 1) * 100, "bootstrap percent endpoint")
        for index in _BOOTSTRAP_INDICES
    ]
    result["descriptiveBootstrap95Ms"] = [
        delta_medians[index] for index in _BOOTSTRAP_INDICES
    ]
    return result


def _evaluate_gates(dictionary, candidate, control):
    """Evaluate only the prospectively fixed timing gates."""
    if dictionary == "jmdict":
        control_limit = 0.5 * min(
            -candidate["medianPairedChangePercent"],
            -candidate["equalWorkChangePercent"],
        )
        checks = {
            "medianSavingsAtLeast10Ms": candidate["pairedMedianDeltaMs"] <= -10,
            "medianSavingsAtLeast1Percent":
                candidate["medianPairedChangePercent"] <= -1,
            "atLeast18Of24PairsFaster": candidate["fasterPairs"] >= 18,
            "equalWorkFaster": candidate["equalWorkChangePercent"] < 0,
            "millisecondIntervalUpperBelowZero":
                candidate["descriptiveBootstrap95Ms"][1] < 0,
            "percentIntervalUpperBelowZero":
                candidate["descriptiveBootstrap95Percent"][1] < 0,
            "controlMedianWithinHalfCandidateBenefit":
                abs(control["medianPairedChangePercent"]) < control_limit,
            "controlEqualWorkWithinHalfCandidateBenefit":
                abs(control["equalWorkChangePercent"]) < control_limit,
        }
        return {
            "policy": "jmdict-advancement-per-host",
            "thresholds": {
                "candidatePairCount": 24,
                "minimumMedianSavingsMs": 10,
                "minimumMedianSavingsPercent": 1,
                "minimumFasterPairs": 18,
                "equalWorkChangePercentExclusiveMaximum": 0,
                "bootstrap95UpperExclusiveMaximum": 0,
                "controlDriftLimitPercent": control_limit,
                "controlDriftComparison": "absolute values strictly below limit",
            },
            "checks": checks,
        }
    return {
        "policy": "nonregression-per-host",
        "thresholds": {
            "candidatePairCount": 12,
            "candidateMedianChangePercentInclusiveMaximum": 1,
            "candidateEqualWorkChangePercentInclusiveMaximum": 1,
            "candidateBootstrap95PercentUpperInclusiveMaximum": 3,
            "controlAbsoluteMedianChangePercentInclusiveMaximum": 1,
            "controlAbsoluteEqualWorkChangePercentInclusiveMaximum": 1,
        },
        "checks": {
            "candidateMedianAtMost1Percent":
                candidate["medianPairedChangePercent"] <= 1,
            "candidateEqualWorkAtMost1Percent":
                candidate["equalWorkChangePercent"] <= 1,
            "candidatePercentIntervalUpperAtMost3Percent":
                candidate["descriptiveBootstrap95Percent"][1] <= 3,
            "controlAbsoluteMedianAtMost1Percent":
                abs(control["medianPairedChangePercent"]) <= 1,
            "controlAbsoluteEqualWorkAtMost1Percent":
                abs(control["equalWorkChangePercent"]) <= 1,
        },
    }


def analyze(observations, dictionary, initial_order):
    """Validate and analyze one complete host cohort; never infer memory success."""
    expected = schedule(dictionary, initial_order)
    _validate_observations(observations, expected)
    candidate = _paired_summary(observations, "candidate", "A", "B")
    control = _paired_summary(observations, "control", "A", "C")
    gates = _evaluate_gates(dictionary, candidate, control)
    return {
        "schedule": expected,
        "candidateVsBaseline": candidate,
        "identicalCodeControl": control,
        "gates": gates,
        "timingPassed": all(gates["checks"].values()),
    }
