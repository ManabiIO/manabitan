#!/usr/bin/env python3
"""Deterministic schedule/statistics/gate tests; no imports are benchmarked."""

import copy
import math
import random
import statistics
import unittest

import tail_stats


# Verbatim function from c9811071, blob7bfac83eedfbae61590b849c0934060c30ff4cef.
# Only this trusted pure function is executed; the acquisition runner is not.
_ORIGINAL_PAIRED_SUMMARY_SOURCE = r'''def paired_summary(kind, left, right):
    pairs = {}
    for item in observations:
        if item["kind"] == kind:
            pairs.setdefault(item["pair"], {})[item["arm"]] = item["totalImportMs"]
    complete = [values for values in pairs.values() if left in values and right in values]
    if len(complete) != len(pairs):
        raise RuntimeError("Incomplete paired observations")
    ratios = [values[right] / values[left] for values in complete]
    rng = random.Random(897)
    resampled = sorted(statistics.median(rng.choices(ratios, k=len(ratios))) for _ in range(10000))
    return {
        "count": len(complete), "ratios": ratios,
        "medianPairedChangePercent": (statistics.median(ratios) - 1) * 100,
        "equalWorkChangePercent": (sum(v[right] for v in complete) / sum(v[left] for v in complete) - 1) * 100,
        "worstPairChangePercent": (max(ratios) - 1) * 100,
        "descriptiveBootstrap95Percent": [(resampled[index] - 1) * 100 for index in (249, 9749)],
        "fasterPairs": sum(ratio < 1 for ratio in ratios),
    }'''


def observations(dictionary="jmdict", order="AB", uniform=False, winning=False):
    result = []
    ratios = (0.972, 1.019, 0.991, 1.003, 0.981, 1.031, 0.963)
    for planned in tail_stats.schedule(dictionary, order):
        item = dict(planned)
        pair = item["pair"]
        baseline = 1000.0 if uniform else 900.0 + pair * 13.7
        if item["kind"] == "candidate" and item["arm"] == "B":
            duration = baseline * (0.98 if winning else 1.0 if uniform else ratios[(pair - 1) % len(ratios)])
        elif item["kind"] == "control" and item["arm"] == "C":
            duration = baseline * (1.0 if uniform else (0.997, 1.004, 1.011)[(pair - 1) % 3])
        else:
            duration = baseline
        item["totalImportMs"] = duration
        result.append(item)
    return result


def reference_summary(items, kind, right):
    namespace = {"observations": items, "random": random, "statistics": statistics}
    exec(compile(_ORIGINAL_PAIRED_SUMMARY_SOURCE, "<frozen-c981-paired-summary>", "exec"), namespace)
    return namespace["paired_summary"](kind, "A", right)


def gate_inputs():
    candidate = {
        "count": 24,
        "pairedMedianDeltaMs": -12.0,
        "medianPairedChangePercent": -1.2,
        "equalWorkChangePercent": -1.1,
        "fasterPairs": 24,
        "descriptiveBootstrap95Ms": [-18.0, -5.0],
        "descriptiveBootstrap95Percent": [-1.8, -0.4],
    }
    control = {
        "medianPairedChangePercent": 0.1,
        "equalWorkChangePercent": -0.1,
    }
    return candidate, control


class ScheduleTests(unittest.TestCase):
    def test_exact_sizes_and_warmups(self):
        for dictionary, size, pairs, controls in (
            ("jmdict", 68, 24, 8), ("jitendex", 36, 12, 4), ("vndb", 36, 12, 4)
        ):
            for order in ("AB", "BA"):
                with self.subTest(dictionary=dictionary, order=order):
                    items = tail_stats.schedule(dictionary, order)
                    self.assertEqual(len(items), size)
                    self.assertEqual(len({item["id"] for item in items}), size)
                    self.assertEqual(
                        [item["id"] for item in items[:4]],
                        [f"warmup-1-{arm}" for arm in order] +
                        [f"warmup-2-{arm}" for arm in order[::-1]],
                    )
                    self.assertEqual(sum(item["kind"] == "candidate" for item in items), pairs * 2)
                    self.assertEqual(sum(item["kind"] == "control" for item in items), controls * 2)

    def test_frozen_first_six_pairs_and_controls(self):
        expected_ab = (
            "pair-01-A pair-01-B pair-02-B pair-02-A pair-03-A pair-03-B "
            "control-01-A control-01-C pair-04-B pair-04-A pair-05-A pair-05-B "
            "pair-06-B pair-06-A control-02-C control-02-A"
        ).split()
        expected_ba = (
            "pair-01-B pair-01-A pair-02-A pair-02-B pair-03-B pair-03-A "
            "control-01-C control-01-A pair-04-A pair-04-B pair-05-B pair-05-A "
            "pair-06-A pair-06-B control-02-A control-02-C"
        ).split()
        self.assertEqual([x["id"] for x in tail_stats.schedule("jmdict", "AB")[4:20]], expected_ab)
        self.assertEqual([x["id"] for x in tail_stats.schedule("jmdict", "BA")[4:20]], expected_ba)
        self.assertEqual(
            [x["id"] for x in tail_stats.schedule("jmdict", "AB")[-4:]],
            ["pair-24-B", "pair-24-A", "control-08-C", "control-08-A"],
        )
        self.assertEqual(
            [x["id"] for x in tail_stats.schedule("vndb", "BA")[-4:]],
            ["pair-12-A", "pair-12-B", "control-04-A", "control-04-C"],
        )

    def test_reject_unknown_dictionary_and_order(self):
        for dictionary, order in (("JMdict", "AB"), ("other", "AB"), ([], "AB"), ("jmdict", "AC"), ("jmdict", True)):
            with self.subTest(dictionary=dictionary, order=order):
                with self.assertRaises(ValueError):
                    tail_stats.schedule(dictionary, order)

    def test_returned_schedule_is_fresh(self):
        first = tail_stats.schedule("jmdict", "AB")
        first[0]["arm"] = "C"
        self.assertEqual(tail_stats.schedule("jmdict", "AB")[0]["arm"], "A")


class ValidationTests(unittest.TestCase):
    def reject(self, items):
        with self.assertRaises(ValueError):
            tail_stats.analyze(items, "jmdict", "AB")

    def test_incomplete_extra_duplicate_and_reordered(self):
        good = observations()
        self.reject(good[:-1])
        self.reject(good + [dict(good[-1])])
        self.reject(tuple(good))
        duplicate = copy.deepcopy(good)
        duplicate[5] = dict(duplicate[4])
        self.reject(duplicate)
        reordered = copy.deepcopy(good)
        reordered[6], reordered[7] = reordered[7], reordered[6]
        self.reject(reordered)

    def test_every_schedule_field_is_bound(self):
        for key, value in (
            ("id", "other"), ("kind", "control"), ("pair", 99), ("pair", True),
            ("pair", 1.0), ("arm", "C"), ("id", 1), ("kind", None), ("arm", False)
        ):
            with self.subTest(key=key, value=value):
                items = observations()
                items[0][key] = value
                self.reject(items)

    def test_exact_schema_including_no_diagnostic_filtering(self):
        for key in ("id", "kind", "pair", "arm", "totalImportMs"):
            items = observations()
            del items[0][key]
            self.reject(items)
        items = observations()
        items[4]["ownedTailLookaheadCount"] = 0
        self.reject(items)
        items = observations()
        items[4] = None
        self.reject(items)

    def test_all_durations_including_warmups_are_finite_and_positive(self):
        for value in (0, -1, float("nan"), float("inf"), -float("inf"), True, "10", None, 10 ** 1000):
            with self.subTest(value=repr(value)):
                items = observations()
                items[0]["totalImportMs"] = value
                self.reject(items)
        items = observations()
        items[-1]["totalImportMs"] = float("nan")
        self.reject(items)

    def test_nonfinite_derived_ratio_and_total_are_rejected(self):
        items = observations()
        items[4]["totalImportMs"] = 1e-308
        items[5]["totalImportMs"] = 1e308
        self.reject(items)
        items = observations()
        items[4]["totalImportMs"] = 1e308
        items[5]["totalImportMs"] = 1e-308
        self.reject(items)
        items = observations()
        for item in items:
            item["totalImportMs"] = 1e308
        self.reject(items)
        items = observations()
        items[4]["totalImportMs"] = 1.0
        items[5]["totalImportMs"] = 1e307
        self.reject(items)


class ComparisonTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.inputs = {
            ("jmdict", "AB"): observations("jmdict", "AB"),
            ("jmdict", "BA"): observations("jmdict", "BA"),
            ("jitendex", "AB"): observations("jitendex", "AB"),
        }
        cls.results = {
            key: tail_stats.analyze(items, *key)
            for key, items in cls.inputs.items()
        }

    def test_every_original_field_exactly_matches_frozen_runner(self):
        for key, items in self.inputs.items():
            for kind, right, result_key in (
                ("candidate", "B", "candidateVsBaseline"),
                ("control", "C", "identicalCodeControl")
            ):
                with self.subTest(cohort=key, kind=kind):
                    expected = reference_summary(items, kind, right)
                    actual = self.results[key][result_key]
                    self.assertEqual({name: actual[name] for name in expected}, expected)
                    self.assertEqual(
                        set(actual) - set(expected),
                        {"pairedMedianDeltaMs", "descriptiveBootstrap95Ms"},
                    )

    def test_ms_interval_reuses_exact_ratio_resample_indices(self):
        items = self.inputs[("jmdict", "AB")]
        pairs = {}
        for item in items:
            if item["kind"] == "candidate":
                pairs.setdefault(item["pair"], {})[item["arm"]] = item["totalImportMs"]
        deltas = [pair["B"] - pair["A"] for pair in pairs.values()]
        rng = random.Random(897)
        sampled_medians = []
        for _ in range(10000):
            indices = rng.choices(range(len(deltas)), k=len(deltas))
            sampled_medians.append(statistics.median([deltas[index] for index in indices]))
        sampled_medians.sort()
        actual = self.results[("jmdict", "AB")]["candidateVsBaseline"]
        self.assertEqual(actual["pairedMedianDeltaMs"], statistics.median(deltas))
        self.assertEqual(actual["descriptiveBootstrap95Ms"], [sampled_medians[249], sampled_medians[9749]])

    def test_order_does_not_change_same_paired_values(self):
        ab = self.results[("jmdict", "AB")]
        ba = self.results[("jmdict", "BA")]
        self.assertEqual(ab["candidateVsBaseline"], ba["candidateVsBaseline"])
        self.assertEqual(ab["identicalCodeControl"], ba["identicalCodeControl"])
        self.assertNotEqual(ab["schedule"], ba["schedule"])

    def test_no_mutation_exclusions_or_memory_claim(self):
        items = observations("vndb", "BA", uniform=True)
        before = copy.deepcopy(items)
        result = tail_stats.analyze(items, "vndb", "BA")
        self.assertEqual(items, before)
        self.assertEqual(len(result["schedule"]), 36)
        self.assertEqual(result["candidateVsBaseline"]["count"], 12)
        self.assertEqual(result["identicalCodeControl"]["count"], 4)
        self.assertEqual(
            set(result),
            {"schedule", "candidateVsBaseline", "identicalCodeControl", "gates", "timingPassed"},
        )
        self.assertTrue(result["timingPassed"])
        self.assertIs(type(result["timingPassed"]), bool)
        self.assertEqual(result["timingPassed"], all(result["gates"]["checks"].values()))

    def test_clear_synthetic_winner_and_identical_jmdict(self):
        winner = tail_stats.analyze(observations(uniform=True, winning=True), "jmdict", "AB")
        same = tail_stats.analyze(observations(uniform=True), "jmdict", "AB")
        self.assertTrue(winner["timingPassed"])
        self.assertFalse(same["timingPassed"])
        self.assertEqual(winner["candidateVsBaseline"]["pairedMedianDeltaMs"], -20)
        self.assertEqual(winner["candidateVsBaseline"]["fasterPairs"], 24)
        self.assertEqual(same["candidateVsBaseline"]["fasterPairs"], 0)


class GateBoundaryTests(unittest.TestCase):
    def passed(self, dictionary, candidate, control):
        return all(tail_stats._evaluate_gates(dictionary, candidate, control)["checks"].values())

    def test_jmdict_inclusive_savings_and_pair_boundaries(self):
        candidate, control = gate_inputs()
        candidate.update(pairedMedianDeltaMs=-10.0, medianPairedChangePercent=-1.0, fasterPairs=18)
        self.assertTrue(self.passed("jmdict", candidate, control))
        for key, value in (
            ("pairedMedianDeltaMs", math.nextafter(-10.0, 0.0)),
            ("medianPairedChangePercent", math.nextafter(-1.0, 0.0)),
            ("fasterPairs", 17),
        ):
            changed = dict(candidate)
            changed[key] = value
            with self.subTest(key=key):
                self.assertFalse(self.passed("jmdict", changed, control))

    def test_jmdict_equal_work_and_both_intervals_are_strict(self):
        candidate, control = gate_inputs()
        for key, value in (
            ("equalWorkChangePercent", 0.0),
            ("descriptiveBootstrap95Ms", [-10.0, 0.0]),
            ("descriptiveBootstrap95Percent", [-1.0, 0.0]),
        ):
            changed = dict(candidate)
            changed[key] = value
            with self.subTest(key=key):
                self.assertFalse(self.passed("jmdict", changed, control))

    def test_jmdict_control_limit_uses_smaller_benefit_and_is_strict(self):
        candidate, control = gate_inputs()
        candidate["medianPairedChangePercent"] = -2.0
        candidate["equalWorkChangePercent"] = -0.8
        gates = tail_stats._evaluate_gates("jmdict", candidate, control)
        self.assertEqual(gates["thresholds"]["controlDriftLimitPercent"], 0.4)
        for key in ("medianPairedChangePercent", "equalWorkChangePercent"):
            for sign in (-1, 1):
                changed = dict(control)
                changed[key] = sign * 0.4
                self.assertFalse(self.passed("jmdict", candidate, changed))
                changed[key] = sign * math.nextafter(0.4, 0.0)
                self.assertTrue(self.passed("jmdict", candidate, changed))

    def test_nonregression_inclusive_boundaries_without_rounding(self):
        candidate, control = gate_inputs()
        candidate.update(
            count=12, medianPairedChangePercent=1.0, equalWorkChangePercent=1.0,
            descriptiveBootstrap95Percent=[-1.0, 3.0],
        )
        control.update(medianPairedChangePercent=-1.0, equalWorkChangePercent=1.0)
        for dictionary in ("jitendex", "vndb"):
            self.assertTrue(self.passed(dictionary, candidate, control))
            for key, value in (
                ("medianPairedChangePercent", math.nextafter(1.0, 2.0)),
                ("equalWorkChangePercent", math.nextafter(1.0, 2.0)),
                ("descriptiveBootstrap95Percent", [-1.0, math.nextafter(3.0, 4.0)]),
            ):
                changed = dict(candidate)
                changed[key] = value
                self.assertFalse(self.passed(dictionary, changed, control))
            for key in ("medianPairedChangePercent", "equalWorkChangePercent"):
                for sign in (-1, 1):
                    changed = dict(control)
                    changed[key] = sign * math.nextafter(1.0, 2.0)
                    self.assertFalse(self.passed(dictionary, candidate, changed))


if __name__ == "__main__":
    unittest.main()
