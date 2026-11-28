# SPDX-License-Identifier: GPL-3.0-or-later
"""Candidate-only flags must not leak into baseline, controls or memory runs."""

from copy import deepcopy
import json
import os
from pathlib import Path
import sys
import unittest

from import_qualification_controls import (
    import_command, parse_arm_flags, select_arm_flags, semantic_receipt,
    validate_lookahead_participation,
)

ROOT = Path(os.environ.get("MANABITAN_QUALIFICATION_REPO_ROOT", Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(ROOT / "dev/perf/import-memory-20261125-a7f7"))
from qualification_receipts import require_matching_receipts
from test_qualification_receipts import observation, validate


FLAG = {"experimentalTermContentLookahead": True}


def active_summary(prepared=11, compression=11):
    return {"runs": [{"importDebug": {"importerPhaseTimings": [
        {"phase": "term-file-fast-path:term_bank_1.json..term_bank_53.json", "details": {
            "contentLookaheadPreparedCount": prepared,
            "contentLookaheadCompressionCount": compression,
        }},
    ]}}]}


class ArmConfigurationWitness(unittest.TestCase):
    def test_candidate_only_flag_for_timing_controls_full_media_and_memory(self):
        flags = parse_arm_flags("{}", json.dumps(FLAG))
        for arm in "ABC":
            for mode in ("timing", "warmup", "control", "full-media", "memory"):
                with self.subTest(arm=arm, mode=mode):
                    command = import_command("jmdict", "unused-evidence", select_arm_flags(flags, arm),
                                             "all" if mode == "full-media" else "sample")
                    if arm == "B":
                        self.assertEqual(command.count("--flags"), 1)
                        self.assertEqual(json.loads(command[command.index("--flags") + 1]), FLAG)
                    else:
                        self.assertNotIn("--flags", command)
        self.assertEqual(flags, {"A": None, "B": FLAG})

    def test_source_overhead_mode_has_no_flags_on_any_arm(self):
        flags = parse_arm_flags("{}", "{}")
        for arm in "ABC":
            self.assertIsNone(select_arm_flags(flags, arm))
            self.assertNotIn("--flags", import_command("jmdict", "unused", select_arm_flags(flags, arm)))

    def test_invalid_flag_shapes_and_unknown_arms_are_rejected(self):
        for value in ("[]", "null", "true", "1"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_arm_flags("{}", value)
        with self.assertRaises(ValueError):
            select_arm_flags({"A": None, "B": FLAG}, "D")

    def test_native_receipts_validate_each_arm_before_semantic_normalization(self):
        baseline_summary, baseline_report = observation("jmdict")
        candidate_summary, candidate_report = deepcopy((baseline_summary, baseline_report))
        candidate_summary["importFlags"] = deepcopy(FLAG)
        candidate_report["benchmark"]["importFlags"] = deepcopy(FLAG)
        baseline = validate(baseline_summary, baseline_report, import_flags=None)
        candidate = validate(candidate_summary, candidate_report, import_flags=FLAG)
        preserved = deepcopy(candidate)
        require_matching_receipts(semantic_receipt(baseline, None), semantic_receipt(candidate, FLAG))
        self.assertEqual(candidate, preserved)
        with self.assertRaises(ValueError):
            validate(candidate_summary, candidate_report, import_flags=None)
        with self.assertRaises(ValueError):
            semantic_receipt(candidate, None)
        changed = deepcopy(candidate)
        changed["common"]["validation"]["outputDigestSha256"] = "f" * 64
        with self.assertRaises(ValueError):
            require_matching_receipts(semantic_receipt(baseline, None), semantic_receipt(changed, FLAG))

    def test_positive_jmdict_claims_are_required_and_recorded(self):
        receipt = validate_lookahead_participation(active_summary(), "jmdict", FLAG)
        self.assertEqual(receipt["contentLookaheadPreparedCount"], 11)
        self.assertEqual(receipt["contentLookaheadCompressionCount"], 11)
        self.assertTrue(receipt["requested"])
        self.assertTrue(receipt["requiresPositiveClaims"])

    def test_inactive_arms_require_zero_and_accept_missing_legacy_counters(self):
        missing = active_summary()
        missing["runs"][0]["importDebug"]["importerPhaseTimings"][0]["details"] = {}
        for flags in (None, {}, {"experimentalTermContentLookahead": False}):
            for summary in (missing, active_summary(0, 0)):
                with self.subTest(flags=flags, summary=summary):
                    receipt = validate_lookahead_participation(summary, "jmdict", flags)
                    self.assertFalse(receipt["requested"])
                    self.assertEqual(receipt["contentLookaheadPreparedCount"], 0)
                    self.assertEqual(receipt["contentLookaheadCompressionCount"], 0)
            for prepared, compression in ((1, 0), (0, 1), (11, 11), (-1, 0), (True, 0), (None, 0)):
                with self.subTest(flags=flags, prepared=prepared, compression=compression), self.assertRaises(ValueError):
                    validate_lookahead_participation(active_summary(prepared, compression), "jmdict", flags)

    def test_active_other_dictionaries_retain_zero_or_eligible_claims(self):
        for dictionary in ("jitendex", "vndb"):
            no_fast_path = active_summary()
            no_fast_path["runs"][0]["importDebug"]["importerPhaseTimings"] = []
            receipt = validate_lookahead_participation(no_fast_path, dictionary, FLAG)
            self.assertEqual(receipt["fastPathPhases"], 0)
            self.assertEqual(receipt["contentLookaheadPreparedCount"], 0)
            self.assertEqual(receipt["contentLookaheadCompressionCount"], 0)
            for prepared, compression in ((0, 0), (1, 0), (11, 11)):
                with self.subTest(dictionary=dictionary, prepared=prepared, compression=compression):
                    receipt = validate_lookahead_participation(active_summary(prepared, compression), dictionary, FLAG)
                    self.assertTrue(receipt["requested"])
                    self.assertFalse(receipt["requiresPositiveClaims"])
                    self.assertEqual(receipt["contentLookaheadPreparedCount"], prepared)
                    self.assertEqual(receipt["contentLookaheadCompressionCount"], compression)
            with self.assertRaises(ValueError):
                validate_lookahead_participation(active_summary(1, 2), dictionary, FLAG)
            with self.assertRaises(ValueError):
                validate_lookahead_participation(active_summary(None, 0), dictionary, FLAG)

    def test_inactive_or_invalid_counters_cannot_qualify_lookahead(self):
        for prepared, compression in ((0, 0), (11, 0), (1, 2), (None, 1), (True, 1), (-1, 1)):
            with self.subTest(prepared=prepared, compression=compression), self.assertRaises(ValueError):
                validate_lookahead_participation(active_summary(prepared, compression), "jmdict", FLAG)
        missing = active_summary()
        missing["runs"][0]["importDebug"]["importerPhaseTimings"] = []
        with self.assertRaises(ValueError):
            validate_lookahead_participation(missing, "jmdict", FLAG)


if __name__ == "__main__":
    unittest.main()
