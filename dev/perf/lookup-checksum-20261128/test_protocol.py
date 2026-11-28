"""The activation witness must fail closed without changing semantic receipts."""

from copy import deepcopy
import importlib.util
import pathlib
import sys
import unittest

DIRECTORY = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("checksum_activation", DIRECTORY / "audit-activation.py")
ACTIVATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ACTIVATION)
sys.path.insert(0, str(DIRECTORY.parent / "import-memory-20261125-a7f7"))
from test_qualification_receipts import observation, validate
from qualification_receipts import require_matching_receipts


def report_with_metrics(metrics):
    summary, report = observation("jmdict")
    details = {"ok": True}
    if metrics is not None:
        details["termRecordLookupChecksum"] = metrics
    report["phases"][0]["data"] = None
    report["phases"][1]["data"]["importDebugHistory"] = [{
        "importerPhaseTimings": [{"phase": "bulk-finalization", "details": details}],
    }]
    return summary, report


class ChecksumProtocolTests(unittest.TestCase):
    def test_added_debug_counters_do_not_change_the_unchanged_semantic_receipt(self):
        summary, report = report_with_metrics(None)
        baseline = validate(summary, report)
        details = report["phases"][1]["data"]["importDebugHistory"][0]["importerPhaseTimings"][0]["details"]
        details["termRecordLookupChecksum"] = {"nativeCalls": 33, "nativeBytes": 123456, "javascriptCalls": 3}
        before = deepcopy((summary, report))
        require_matching_receipts(baseline, validate(summary, report))
        self.assertEqual((summary, report), before)
        metrics = ACTIVATION.validate_metrics(ACTIVATION.activation(report), "B")
        self.assertEqual(metrics["lookupChunks"], 12)
        self.assertEqual(metrics["nativeCallFraction"], 33 / 36)

    def test_absent_control_counter_passes_but_absent_candidate_counter_fails(self):
        _, report = report_with_metrics(None)
        self.assertIsNone(ACTIVATION.validate_metrics(ACTIVATION.activation(report), "A"))
        with self.assertRaises(ValueError):
            ACTIVATION.validate_metrics(ACTIVATION.activation(report), "B")

    def test_fallback_only_candidate_and_active_control_fail(self):
        with self.assertRaises(ValueError):
            ACTIVATION.validate_metrics({"nativeCalls": 0, "nativeBytes": 0, "javascriptCalls": 36}, "B")
        with self.assertRaises(ValueError):
            ACTIVATION.validate_metrics({"nativeCalls": 36, "nativeBytes": 123456, "javascriptCalls": 0}, "A")

    def test_invalid_or_incomplete_counts_fail(self):
        for changed in ({"nativeCalls": True}, {"nativeCalls": -1}, {"nativeBytes": 0},
                        {"nativeBytes": 2 ** 53}, {"javascriptCalls": 1}, {"extra": 1}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                ACTIVATION.validate_metrics({"nativeCalls": 36, "nativeBytes": 123456, "javascriptCalls": 0, **changed}, "B")

    def test_duplicate_or_failed_finalization_is_not_an_activation_witness(self):
        _, report = report_with_metrics({"nativeCalls": 36, "nativeBytes": 123456, "javascriptCalls": 0})
        timings = report["phases"][1]["data"]["importDebugHistory"][0]["importerPhaseTimings"]
        timings.append(deepcopy(timings[0]))
        with self.assertRaises(ValueError):
            ACTIVATION.activation(report)
        timings.pop()
        timings[0]["details"]["ok"] = False
        with self.assertRaises(ValueError):
            ACTIVATION.activation(report)


if __name__ == "__main__":
    unittest.main()
