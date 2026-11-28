#!/usr/bin/env python3
"""Pure policy tests; synthetic values are not browser or performance evidence."""
import copy
import importlib.util
import math
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("fields_policy", Path(__file__).with_name("qualification_policy.py"))
POLICY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(POLICY)


def observations(kind="candidate", count=24, factor=0.97):
    left, right = ("A", "B") if kind == "candidate" else ("A", "C")
    result = []
    for pair in range(1, count + 1):
        duration = 100.0 + pair
        result.extend([
            {"id": str(pair) + "-" + left, "kind": kind, "pair": pair, "arm": left, "totalImportMs": duration},
            {"id": str(pair) + "-" + right, "kind": kind, "pair": pair, "arm": right, "totalImportMs": duration * factor},
        ])
    return result


def contrast(median=-2.0, faster=18, count=24, equal=None):
    return {
        "count": count, "medianPairedChangePercent": median,
        "equalWorkChangePercent": median if equal is None else equal, "fasterPairs": faster,
    }


def control(median=0.0, equal=0.0):
    return contrast(median, 4, 8, equal)


def cell(dictionary, order, median=-2.0):
    candidate, identical = contrast(median), control()
    return {
        "dictionary": dictionary, "initialOrder": order, "candidateVsBaseline": candidate,
        "identicalCodeControl": identical,
        "qualification": POLICY.cell_qualification(
            dictionary, candidate, identical, True, True, True, True, True),
    }


class ScheduleAndArithmeticTests(unittest.TestCase):
    def test_both_frozen_schedules_have_every_original_timing_role(self):
        for initial in ("AB", "BA"):
            rows = POLICY.frozen_schedule(initial)
            with self.subTest(initial=initial):
                self.assertEqual(len(rows), 68)
                self.assertEqual(len({row["id"] for row in rows}), 68)
                self.assertEqual(sum(row["kind"] == "warmup" for row in rows), 4)
                self.assertEqual(sum(row["kind"] == "candidate" for row in rows), 48)
                self.assertEqual(sum(row["kind"] == "control" for row in rows), 16)
                self.assertEqual("".join(row["arm"] for row in rows[:2]), initial)
                self.assertEqual("".join(row["arm"] for row in rows[2:4]), initial[::-1])
                for number in range(1, 9):
                    pair = [row for row in rows if row["kind"] == "control" and row["pair"] == number]
                    expected = "AC" if (number + (initial == "BA")) % 2 else "CA"
                    self.assertEqual("".join(row["arm"] for row in pair), expected)

    def test_schedule_cannot_silently_change_pair_count_or_order(self):
        for order, count in (("AB", 12), ("BA", 25), ("AA", 24)):
            with self.subTest(order=order, count=count), self.assertRaises(ValueError):
                POLICY.frozen_schedule(order, count)

    def test_original_complete_pair_math_excludes_warmups_and_controls(self):
        rows = observations(factor=0.975)
        rows += observations("control", 8, 4.0)
        rows += [{"kind": "warmup", "pair": 1, "arm": "A", "totalImportMs": 0.001}]
        result = POLICY.independent_contrast(rows, "candidate", "A", "B")
        self.assertEqual(result["count"], 24)
        self.assertEqual(result["fasterPairs"], 24)
        self.assertEqual(len(result["ratios"]), 24)
        self.assertAlmostEqual(result["medianPairedChangePercent"], -2.5)
        self.assertAlmostEqual(result["equalWorkChangePercent"], -2.5)
        self.assertAlmostEqual(result["descriptiveBootstrap95Percent"][0], -2.5)
        self.assertAlmostEqual(result["descriptiveBootstrap95Percent"][1], -2.5)

    def test_controls_use_exact_eight_pairs_and_ties_are_not_faster(self):
        result = POLICY.independent_contrast(observations("control", 8, 1.0), "control", "A", "C")
        self.assertEqual(result["count"], 8)
        self.assertEqual(result["fasterPairs"], 0)
        self.assertEqual(result["medianPairedChangePercent"], 0)
        self.assertEqual(result["equalWorkChangePercent"], 0)
        self.assertEqual(result["descriptiveBootstrap95Percent"], [0, 0])

    def test_complete_pair_and_role_inventory_rejects_missing_duplicate_or_unknown(self):
        base = observations()
        cases = (
            base[:-1],
            base + [dict(base[0])],
            [{**row, "arm": "C"} if index == 1 else row for index, row in enumerate(base)],
            [{**row, "pair": True} if index < 2 else row for index, row in enumerate(base)],
        )
        for rows in cases:
            with self.subTest(rows=len(rows)), self.assertRaises(ValueError):
                POLICY.independent_contrast(rows, "candidate", "A", "B")
        with self.assertRaises(ValueError):
            POLICY.independent_contrast([], "warmup", "A", "B")

    def test_nonpositive_boolean_and_nonfinite_recorded_durations_reject(self):
        for value in (True, 0, -1, math.inf, math.nan):
            rows = observations()
            rows[0]["totalImportMs"] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                POLICY.independent_contrast(rows, "candidate", "A", "B")

    def test_equal_work_uses_all_unadjusted_original_durations(self):
        rows = observations(factor=1.0)
        for row in rows:
            if row["arm"] == "B":
                row["totalImportMs"] *= 0.9 if row["pair"] <= 12 else 1.05
        result = POLICY.independent_contrast(rows, "candidate", "A", "B")
        totals = {arm: sum(row["totalImportMs"] for row in rows if row["arm"] == arm) for arm in "AB"}
        self.assertEqual(result["fasterPairs"], 12)
        self.assertEqual(result["equalWorkChangePercent"], 100 * (totals["B"] / totals["A"] - 1))
        self.assertAlmostEqual(result["medianPairedChangePercent"], -2.5)


class FrozenGateTests(unittest.TestCase):
    def qualify(self, dictionary="jmdict", candidate=None, identical=None):
        return POLICY.cell_qualification(dictionary, contrast() if candidate is None else candidate,
                                         control() if identical is None else identical,
                                         True, True, True, True, True)

    def test_jmdict_exact_two_percent_and_eighteen_faster_boundary(self):
        self.assertTrue(self.qualify()["passesCellPolicy"])
        self.assertFalse(self.qualify(candidate=contrast(-1.9999))["passesCellPolicy"])
        self.assertFalse(self.qualify(candidate=contrast(-2, 17))["passesCellPolicy"])

    def test_complete_pair_counts_cannot_be_reduced(self):
        self.assertFalse(self.qualify(candidate=contrast(-10, 12, 12))["passesCellPolicy"])
        self.assertFalse(self.qualify(identical=contrast(0, 2, 4))["passesCellPolicy"])
        result = POLICY.cell_qualification("jmdict", None, None, True, True, True, True, True)
        self.assertFalse(result["passesCellPolicy"])

    def test_both_signed_same_code_statistics_must_fit_each_frozen_limit(self):
        for dictionary, limit in (("jmdict", 1), ("jitendex", 3), ("vndb", 3)):
            for sign in (-1, 1):
                self.assertTrue(self.qualify(dictionary, identical=control(sign * limit, sign * limit))["passesCellPolicy"])
                self.assertFalse(self.qualify(dictionary, identical=control(sign * (limit + 0.0001), 0))["passesCellPolicy"])
                self.assertFalse(self.qualify(dictionary, identical=control(0, sign * (limit + 0.0001)))["passesCellPolicy"])

    def test_every_independent_evidence_gate_is_mandatory(self):
        for index in range(5):
            inputs = [True] * 5
            inputs[index] = False
            with self.subTest(index=index):
                result = POLICY.cell_qualification("jmdict", contrast(), control(), *inputs)
                self.assertFalse(result["passesCellPolicy"])

    def test_both_original_jmdict_hosts_and_all_six_cells_required(self):
        cells = [cell(dictionary, order) for dictionary, order in POLICY.CELLS.values()]
        self.assertTrue(POLICY.qualify_study(cells, True, True)["qualifiesFrozenStudy"])
        self.assertFalse(POLICY.qualify_study(cells[:-1], True, True)["qualifiesFrozenStudy"])
        self.assertFalse(POLICY.qualify_study(cells[:-1] + [cells[0]], True, True)["qualifiesFrozenStudy"])
        changed = copy.deepcopy(cells)
        changed[1] = cell("jmdict", "BA", -1.9)
        self.assertFalse(POLICY.qualify_study(changed, True, True)["qualifiesFrozenStudy"])

    def test_single_nontarget_slowdown_is_reported_but_both_original_hosts_reject(self):
        for dictionary in ("jitendex", "vndb"):
            cells = [cell(name, order) for name, order in POLICY.CELLS.values()]
            index = next(index for index, row in enumerate(cells) if row["dictionary"] == dictionary and row["initialOrder"] == "AB")
            cells[index] = cell(dictionary, "AB", 3.01)
            self.assertTrue(cells[index]["qualification"]["nonTargetMedianSlowdownAboveThreePercent"])
            self.assertTrue(POLICY.qualify_study(cells, True, True)["qualifiesFrozenStudy"])
            other = next(index for index, row in enumerate(cells) if row["dictionary"] == dictionary and row["initialOrder"] == "BA")
            cells[other] = cell(dictionary, "BA", 3.0)
            self.assertTrue(POLICY.qualify_study(cells, True, True)["qualifiesFrozenStudy"])
            cells[other] = cell(dictionary, "BA", 3.0001)
            result = POLICY.qualify_study(cells, True, True)
            self.assertFalse(result["qualifiesFrozenStudy"])
            self.assertEqual(result["repeatedNonTargetRegressions"], [dictionary])

    def test_prerequisite_or_reader_failure_never_qualifies_or_authorizes_a_pr(self):
        cells = [cell(dictionary, order) for dictionary, order in POLICY.CELLS.values()]
        for correctness, prerequisites, errors in ((False, True, False), (True, False, False), (True, True, True)):
            result = POLICY.qualify_study(cells, correctness, prerequisites, errors)
            self.assertFalse(result["qualifiesFrozenStudy"])
            self.assertFalse(result["productPrAuthorizedByReader"])


if __name__ == "__main__":
    unittest.main()
