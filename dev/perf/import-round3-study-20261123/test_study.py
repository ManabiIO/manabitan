#!/usr/bin/env python3
"""Check the schedule and fail-closed readback rules before collecting data."""

from collections import Counter
from copy import deepcopy
import json
from pathlib import Path
import re
import unittest

from readback import validate_readback, verify_cross_arm
from run_memory import fixed_schedule as memory_schedule
from run_timing import fixed_schedule as timing_schedule


def fixture():
    terms = [f"term-{i}" for i in range(12)]
    physical = [{"term": term, "probes": [{
        "rowSampleCount": 1, "readablePreviewRowCount": 1,
        "rowSample": [{"rawEntryContentOffset": 0, "rawContentPreview": "[]", "sequence": 1}],
    }]} for term in terms]
    semantic = [{"term": term, "result": {"dictionaryEntries": [{"glossary": ["word"]}]}} for term in terms]
    validation = {"title": "fixture", "revision": "r1", "termRows": 12, "contentReadable": True,
                  "probeCount": 12, "probeTerms": terms, "semanticProbeEntryCount": 12,
                  "semanticProbes": semantic, "physicalProbes": physical,
                  "outputDigestSha256": "a" * 64, "semanticDigestSha256": "b" * 64}
    return validation


def report(validation):
    state = {"physicalProbes": validation["physicalProbes"],
             "physicalDigestSha256": validation["outputDigestSha256"],
             "semanticProbes": validation["semanticProbes"],
             "semanticDigestSha256": validation["semanticDigestSha256"]}
    return {"status": "success", "skippedVerification": False,
            "benchmark": {"validation": deepcopy(validation),
                          "readbackDiagnostics": {"preRestart": deepcopy(state), "postRestart": deepcopy(state)}}}


def validate(value):
    validate_readback(report(value), value, {"expectedTitle": "fixture", "revision": "r1", "termRows": 12})


class StudyRules(unittest.TestCase):
    def test_timing_schedule(self):
        for replication in (1, 2):
            schedule = timing_schedule(replication)
            self.assertEqual(len(schedule), 26)
            self.assertEqual(Counter(arm for _, _, arm in schedule), {"A": 17, "B": 9})
            pairs = [item for item in schedule if item[0] == "candidate"]
            for index in range(0, 16, 2):
                self.assertEqual({item[2] for item in pairs[index:index + 2]}, {"A", "B"})
            self.assertEqual(Counter(kind for kind, _, _ in schedule),
                             {"warmup": 2, "candidate": 16, "control-before": 4, "control-after": 4})
        self.assertEqual([arm for _, _, arm in timing_schedule(1)[6:22]],
                         ["B" if arm == "A" else "A" for _, _, arm in timing_schedule(2)[6:22]])

    def test_memory_schedule(self):
        for replication in (1, 2):
            schedule = memory_schedule(replication)
            self.assertEqual(Counter(schedule), {arm: 2 for arm in "ABCD"})
            self.assertEqual(schedule[:4], list(reversed(schedule[4:])))
            self.assertEqual(set(schedule[:4]), set("ABCD"))

    def test_frozen_source_configuration(self):
        config = json.loads((Path(__file__).parent / "candidates.json").read_text())
        for specification in [*config["timing"].values(), config["memory"]]:
            self.assertEqual(len(set(specification["arms"].values())), len(specification["arms"]))
            for sha in specification["arms"].values():
                self.assertIsNotNone(re.fullmatch(r"[0-9a-f]{40}", sha))
            for rule in specification["packageRules"]:
                self.assertEqual(len(rule["paths"]), len(set(rule["paths"])))
                self.assertTrue(all(path.startswith("js/dictionary/") for path in rule["paths"]))

    def test_complete_restart_readback(self):
        value = fixture()
        validate(value)
        modified = report(value)
        modified["benchmark"]["readbackDiagnostics"]["postRestart"]["semanticProbes"][0]["result"]["dictionaryEntries"] = []
        with self.assertRaises(ValueError):
            validate_readback(modified, value, {"expectedTitle": "fixture", "revision": "r1", "termRows": 12})

    def test_preview_counts_and_semantic_entries_are_checked(self):
        for mutation in ("counter", "empty", "availability", "rows", "terms"):
            value = fixture()
            if mutation == "counter":
                value["physicalProbes"][0]["probes"][0]["readablePreviewRowCount"] = 0
            elif mutation == "empty":
                value["semanticProbes"][0]["result"]["dictionaryEntries"] = []
            elif mutation == "availability":
                value["semanticProbes"][0]["result"]["dictionaryAvailability"] = {"degraded": True}
            elif mutation == "rows":
                value["termRows"] += 1
            else:
                value["probeTerms"][0] = "different"
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                validate(value)

    def test_exact_candidates_reject_changed_physical_bytes(self):
        a, b = fixture(), fixture()
        b["physicalProbes"][0]["probes"][0]["rowSample"][0]["rawEntryContentOffset"] = 12
        validate(a)
        validate(b)
        with self.assertRaises(ValueError):
            verify_cross_arm([{"arm": "A", "validation": a}, {"arm": "B", "validation": b}],
                             {"A": 1, "B": 1}, [{"baseline": "A", "candidate": "B", "allowReferenceLayoutChange": False}])

    def test_only_precise_reference_paths_can_differ(self):
        a, b = fixture(), fixture()
        probe = b["physicalProbes"][0]["probes"][0]
        probe["rowSample"][0]["rawEntryContentOffset"] = 12
        probe["rowSample"][0]["rawContentPreview"] = "<read-null>"
        probe["readablePreviewRowCount"] = 0
        validate(a)
        validate(b)
        observations = [{"arm": "A", "validation": a}, {"arm": "B", "validation": b}]
        rules = [{"baseline": "A", "candidate": "B", "allowReferenceLayoutChange": True}]
        self.assertEqual(len(verify_cross_arm(observations, {"A": 1, "B": 1}, rules)["differences"]["A-B"]), 3)
        probe["rowSample"][0]["sequence"] = 9
        with self.assertRaises(ValueError):
            verify_cross_arm(observations, {"A": 1, "B": 1}, rules)

    def test_same_named_field_outside_allowed_location_is_rejected(self):
        a, b = fixture(), fixture()
        a["physicalProbes"][0]["rawContentPreview"] = "a"
        b["physicalProbes"][0]["rawContentPreview"] = "b"
        with self.assertRaises(ValueError):
            verify_cross_arm([{"arm": "A", "validation": a}, {"arm": "B", "validation": b}],
                             {"A": 1, "B": 1}, [{"baseline": "A", "candidate": "B", "allowReferenceLayoutChange": True}])

    def test_missing_observations_and_semantic_change_are_rejected(self):
        a, b = fixture(), fixture()
        rules = [{"baseline": "A", "candidate": "B", "allowReferenceLayoutChange": True}]
        observations = [{"arm": "A", "validation": a}, {"arm": "B", "validation": b}]
        with self.assertRaises(ValueError):
            verify_cross_arm(observations, {"A": 2, "B": 1}, rules)
        b["semanticProbes"][0]["result"]["dictionaryEntries"][0]["glossary"] = ["changed"]
        with self.assertRaises(ValueError):
            verify_cross_arm(observations, {"A": 1, "B": 1}, rules)


if __name__ == "__main__":
    unittest.main(verbosity=2)
