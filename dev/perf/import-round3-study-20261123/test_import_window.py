"""Synthetic prospective-scope tests; no previous campaign data or browser."""
from contextlib import redirect_stdout
from copy import deepcopy
import errno
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import chromium_memory
from import_window import derive_import_window, import_bounds, window_plan
import run_import_memory
from test_study import fixture as readback_fixture


FIXTURE = {"label": "Synthetic", "expectedTitle": "fixture", "sizeBytes": 12345, "termRows": 12}


def import_records():
    def phase(name, start, end, details=None):
        return {"phase": name, "startEpochMs": start, "endEpochMs": end,
                "elapsedMs": end - start, "details": details or {}}
    debug = {"hasResult": True, "resultTitle": "fixture", "errorCount": 0,
             "addSettingsErrorCount": 0, "usesFallbackStorage": False,
             "importerPhaseTimings": [
                 phase("archive-and-index", 10000, 10040, {"ok": True, "archiveSizeBytes": 12345}),
                 phase("import-data-banks", 10040, 10800),
                 phase("bulk-finalization", 10800, 10980, {"ok": True}),
                 phase("write-summary", 10980, 10980),
                 phase("post-finalization-integrity-sample", 11000, 11000,
                       {"skipped": True, "reason": "transaction-commit-completed", "termCount": 12}),
             ]}
    report = {"phases": [{"name": "Synthetic: total import", "data": {
        "kind": "dictionary-import", "dictionary": "Synthetic", "importDebug": debug}}]}
    return report, {"importDebug": deepcopy(debug), "validation": readback_fixture()}


def sample(start, end, pss=100, private=80):
    return {"startedAtEpochSeconds": start, "finishedAtEpochSeconds": end,
            "qualifiedForWholeTreePss": True, "qualificationFailures": [],
            "processes": [{"pid": 1, "role": "browser"}, {"pid": 2, "role": "renderer"}],
            "stableObservedProcessTree": True, "unavailableProcesses": [],
            "unreadableAddressSpaces": [], "confirmedExitedZombies": [],
            "addressSpaceRecoveryAttempts": [], "readableProcessPssKiB": pss,
            "readableProcessPrivateKiB": private}


def unreadable(value, stable=True, error=errno.ESRCH):
    value["qualifiedForWholeTreePss"] = False
    value["stableObservedProcessTree"] = stable
    value["qualificationFailures"] = ["unreadable-discovered-process-smaps"]
    if not stable:
        value["qualificationFailures"].append("process-tree-changed-during-scan")
    value["unavailableProcesses"] = [{"pid": 3, "smapsReadError": {"errno": error}}]
    value["unreadableAddressSpaces"] = deepcopy(value["unavailableProcesses"])


def receipt(samples=None, exit_code=0):
    if samples is None:
        samples = [sample(9.80, 9.90, 999), sample(9.98, 10.01, 888),
                   sample(10.05, 10.07, 100), sample(10.25, 10.27, 150),
                   sample(10.50, 10.52, 120), sample(10.99, 11.02, 777),
                   sample(11.10, 11.12, 666)]
    return chromium_memory.summarize_samples(samples, exit_code)


def resummarize(raw):
    return receipt(raw["samples"], raw["benchmarkExitCode"])


def derive(raw=None):
    report, result = import_records()
    return derive_import_window(raw or receipt(), report, result, FIXTURE)


class ImportWindowRules(unittest.TestCase):
    def test_exact_schedule_and_frozen_plan(self):
        self.assertEqual(run_import_memory.fixed_schedule(1), list("ABBA"))
        self.assertEqual(run_import_memory.fixed_schedule(2), list("BAAB"))
        for invalid in (0, 3, True, 1.0, "1", None):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                run_import_memory.fixed_schedule(invalid)
        plan = window_plan()
        self.assertEqual(plan["minimumQualifiedScans"], 3)
        self.assertEqual(plan["minimumQualifiedScanStartSpanMs"], 250)
        self.assertFalse(plan["authoritativeTiming"])
        self.assertTrue(plan["wholeLifecycleReceiptRetained"])

    def test_only_complete_scans_selected_and_original_unmodified(self):
        raw = receipt()
        original = deepcopy(raw)
        result = derive(raw)
        self.assertTrue(result["qualifiedForImportWindowPss"])
        self.assertEqual(result["selectedSampleIndices"], [2, 3, 4])
        self.assertEqual(result["excludedSampleIndices"], [0, 1, 5, 6])
        self.assertEqual(result["qualifiedSampleIndices"], [2, 3, 4])
        self.assertEqual(result["qualifiedScanStartSpanMs"], 450)
        self.assertEqual(result["maxSampledPssKiB"], 150)
        self.assertEqual(raw, original)
        self.assertEqual(raw["maxSampledPssKiB"], 999)

    def test_inclusive_boundaries_and_exact_minimum_span(self):
        raw = receipt([sample(9.9, 9.99), sample(10, 10.02), sample(10.125, 10.14),
                       sample(10.25, 10.27), sample(11.01, 11.1)])
        result = derive(raw)
        self.assertTrue(result["qualifiedForImportWindowPss"])
        self.assertEqual(result["qualifiedScanStartSpanMs"], 250)
        raw["samples"][3]["finishedAtEpochSeconds"] = 11
        self.assertEqual(derive(resummarize(raw))["selectedSampleIndices"], [1, 2, 3])

    def test_outside_failure_stays_failed_in_original_receipt(self):
        raw = receipt()
        unreadable(raw["samples"][-1])
        raw = resummarize(raw)
        original = deepcopy(raw)
        result = derive(raw)
        self.assertFalse(raw["qualifiedForWholeTreePss"])
        self.assertTrue(result["qualifiedForImportWindowPss"])
        self.assertFalse(result["wholeLifecycleQualifiedForWholeTreePss"])
        self.assertEqual(result["wholeLifecycleQualificationFailures"], ["process-smaps-coverage-unqualified"])
        self.assertEqual(raw, original)

    def test_inside_stable_failure_rejects_despite_three_other_good_scans(self):
        raw = receipt()
        raw["samples"].insert(3, sample(10.12, 10.14, 1000))
        unreadable(raw["samples"][3])
        result = derive(resummarize(raw))
        self.assertEqual(result["qualifiedSampleCount"], 3)
        self.assertEqual(result["selectedSampleCount"], 4)
        self.assertFalse(result["qualifiedForImportWindowPss"])
        self.assertEqual(result["qualificationFailures"], ["process-smaps-coverage-unqualified"])
        self.assertIsNone(result["maxSampledPssKiB"])
        self.assertIsNone(result["maxSampledPrivateKiB"])

    def test_denial_and_parse_failure_reject_even_when_tree_changes(self):
        for error in (errno.EACCES, errno.EPERM, None):
            raw = receipt()
            raw["samples"].insert(3, sample(10.12, 10.14))
            unreadable(raw["samples"][3], stable=False, error=error)
            with self.subTest(error=error):
                result = derive(resummarize(raw))
                self.assertIn("process-smaps-coverage-unqualified", result["qualificationFailures"])
                self.assertIsNone(result["maxSampledPssKiB"])

    def test_changed_tree_exit_rejects_sample_with_unchanged_observer_rule(self):
        raw = receipt()
        raw["samples"].insert(3, sample(10.12, 10.14, 1000))
        unreadable(raw["samples"][3], stable=False)
        result = derive(resummarize(raw))
        self.assertTrue(result["qualifiedForImportWindowPss"])
        self.assertEqual(result["selectedSampleIndices"], [2, 3, 4, 5])
        self.assertEqual(result["qualifiedSampleIndices"], [2, 4, 5])
        self.assertEqual(result["maxSampledPssKiB"], 150)

    def test_secondary_sibling_and_identity_failures_are_not_filtered_out(self):
        for failure in ("sibling", "identity"):
            raw = receipt()
            value = sample(10.12, 10.14)
            value["qualifiedForWholeTreePss"] = False
            value["stableObservedProcessTree"] = False
            if failure == "sibling":
                value["qualificationFailures"] = ["sibling-address-space-recovery-unqualified"]
                value["addressSpaceRecoveryAttempts"] = [{
                    "qualified": False, "tasksBefore": {"errors": [{"errno": errno.EACCES}]},
                    "tasksAfter": {"errors": []}, "representativeReadError": None,
                    "leaderAfter": None, "qualificationFailures": ["task-inventory-read-failed"]}]
                expected = "sibling-recovery-permission-parse-or-proof-failure"
            else:
                value["qualificationFailures"] = ["incomplete-process-identity-inventory"]
                expected = "process-identity-coverage-unqualified"
            raw["samples"].insert(3, value)
            with self.subTest(failure=failure):
                self.assertIn(expected, derive(resummarize(raw))["qualificationFailures"])

    def test_minimum_count_and_span_are_both_required(self):
        cases = [([sample(10.0, 10.02), sample(10.5, 10.52)], "fewer-than-three-qualified-import-window-scans"),
                 ([sample(10.0, 10.02), sample(10.1, 10.12), sample(10.249, 10.26)],
                  "qualified-import-window-scan-start-span-below-250ms"),
                 ([], "no-stable-fully-read-browser-renderer-tree")]
        for selected, failure in cases:
            raw = receipt([sample(9.8, 9.9), *selected, sample(11.1, 11.2)])
            with self.subTest(failure=failure):
                result = derive(raw)
                self.assertFalse(result["qualifiedForImportWindowPss"])
                self.assertIn(failure, result["qualificationFailures"])
                self.assertIsNone(result["maxSampledPssKiB"])
                self.assertNotIn("maxSampledPssKiB", result["scopedObserverCounts"])

    def test_failed_command_rejects_even_with_sufficient_good_samples(self):
        result = derive(receipt(exit_code=1))
        self.assertIn("benchmark-command-failed", result["qualificationFailures"])
        self.assertIsNone(result["maxSampledPssKiB"])

    def test_unique_start_bulk_end_markers_required(self):
        for name in ("archive-and-index", "bulk-finalization", "post-finalization-integrity-sample"):
            for mutation in ("missing", "duplicate"):
                report, result = import_records()
                phases = report["phases"][0]["data"]["importDebug"]["importerPhaseTimings"]
                found = next(phase for phase in phases if phase["phase"] == name)
                phases.remove(found) if mutation == "missing" else phases.append(deepcopy(found))
                result["importDebug"] = deepcopy(report["phases"][0]["data"]["importDebug"])
                with self.subTest(name=name, mutation=mutation), self.assertRaises(ValueError):
                    import_bounds(report, result, FIXTURE)

    def test_successful_pinned_markers_required(self):
        mutations = [(0, "ok", False), (0, "archiveSizeBytes", 12346), (2, "ok", False),
                     (4, "skipped", False), (4, "reason", "performed-sampling"),
                     (4, "termCount", 11), (4, "termCount", True)]
        for index, key, value in mutations:
            report, result = import_records()
            debug = report["phases"][0]["data"]["importDebug"]
            debug["importerPhaseTimings"][index]["details"][key] = value
            result["importDebug"] = deepcopy(debug)
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                import_bounds(report, result, FIXTURE)

    def test_structured_phase_binding_and_success_required(self):
        for mutation in ("missing", "duplicate", "kind", "label", "debug-mismatch", "fallback", "errors", "result"):
            report, result = import_records()
            data = report["phases"][0]["data"]
            if mutation == "missing":
                report["phases"] = []
            elif mutation == "duplicate":
                report["phases"].append(deepcopy(report["phases"][0]))
            elif mutation == "kind":
                data["kind"] = "other"
            elif mutation == "label":
                data["dictionary"] = "other"
            elif mutation == "debug-mismatch":
                result["importDebug"]["resultTitle"] = "other"
            else:
                key, value = {"fallback": ("usesFallbackStorage", True), "errors": ("errorCount", 1),
                              "result": ("hasResult", False)}[mutation]
                data["importDebug"][key] = value
                result["importDebug"] = deepcopy(data["importDebug"])
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                import_bounds(report, result, FIXTURE)

    def test_phase_bounds_and_elapsed_time_are_checked(self):
        cases = [("startEpochMs", 9999), ("endEpochMs", 11001), ("startEpochMs", 10801),
                 ("startEpochMs", -1), ("startEpochMs", True), ("startEpochMs", 10040.0),
                 ("elapsedMs", float("nan")), ("elapsedMs", float("inf")), ("elapsedMs", 1)]
        for key, value in cases:
            report, result = import_records()
            debug = report["phases"][0]["data"]["importDebug"]
            changed = debug["importerPhaseTimings"][1]
            changed[key] = value
            if key != "elapsedMs":
                changed["elapsedMs"] = changed["endEpochMs"] - changed["startEpochMs"]
            result["importDebug"] = deepcopy(debug)
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                import_bounds(report, result, FIXTURE)
        report, result = import_records()
        debug = report["phases"][0]["data"]["importDebug"]
        debug["importerPhaseTimings"][0], debug["importerPhaseTimings"][2] = (
            debug["importerPhaseTimings"][2], debug["importerPhaseTimings"][0])
        result["importDebug"] = deepcopy(debug)
        with self.assertRaises(ValueError):
            import_bounds(report, result, FIXTURE)

    def test_sampler_bounds_and_enclosing_collection_are_checked(self):
        for mutation in ("empty", "nan", "inf", "negative", "reversed", "overlap", "bool", "missing-start", "missing-end"):
            raw = receipt()
            if mutation == "empty":
                raw["samples"] = []
            elif mutation == "missing-start":
                raw["samples"] = raw["samples"][2:]
            elif mutation == "missing-end":
                raw["samples"] = raw["samples"][:5]
            elif mutation == "overlap":
                raw["samples"][3]["startedAtEpochSeconds"] = 10.06
            elif mutation == "reversed":
                raw["samples"][3]["finishedAtEpochSeconds"] = 10.24
            else:
                raw["samples"][3]["startedAtEpochSeconds"] = {
                    "nan": float("nan"), "inf": float("inf"), "negative": -1, "bool": True}[mutation]
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                derive(raw)

    def test_observer_identity_required(self):
        for key, value in (("schemaVersion", 2), ("observerRule", "other"), ("authoritativeTiming", True)):
            raw = receipt()
            raw[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                derive(raw)


class ImportWindowDriver(unittest.TestCase):
    def run_driver(self, failure=None, replication=1):
        with tempfile.TemporaryDirectory(prefix="import-window-driver-") as temporary:
            directory = Path(temporary)
            spec = {"arms": {"A": "a" * 40, "B": "b" * 40}, "packageRules": [],
                    "layoutRules": [{"baseline": "A", "candidate": "B", "allowReferenceLayoutChange": False}]}
            state = {"evidence": directory, "arms": spec["arms"], "packages": {"A": "a", "B": "b"},
                     "fixture": FIXTURE}
            started = []

            def begin(_state, index, arm, name):
                started.append((index, arm))
                output = directory / name
                output.mkdir()
                report, _ = import_records()
                if failure == "marker" and index == 1:
                    report["phases"][0]["data"]["importDebug"]["importerPhaseTimings"].pop()
                (output / "run-1.json").write_text(json.dumps(report))
                return output, directory, [str(index)]

            def sampled(command, _root, _log, path):
                raw = receipt()
                unreadable(raw["samples"][-1])
                if failure == "coverage" and command == ["1"]:
                    unreadable(raw["samples"][3])
                raw = resummarize(raw)
                path.write_text(json.dumps(raw))
                return {key: value for key, value in raw.items() if key != "samples"}

            def finish(_state, output, _arm):
                index = int(output.name.split("-")[1])
                if failure == "import" and index == 1:
                    raise ValueError("synthetic failed import/readback")
                report = json.loads((output / "run-1.json").read_text())
                result = {"importDebug": deepcopy(report["phases"][0]["data"]["importDebug"]),
                          "validation": readback_fixture()}
                if failure == "physical" and index == 1:
                    result["validation"]["physicalProbes"][0]["probes"][0]["rowSample"][0]["rawEntryContentOffset"] = 99
                return result

            with patch.object(run_import_memory, "configuration", return_value=("jmdict", replication, {"privateMemory": spec})), \
                    patch.object(run_import_memory, "prepare", return_value=state), \
                    patch.object(run_import_memory, "begin_observation", side_effect=begin), \
                    patch.object(run_import_memory, "finish_observation", side_effect=finish), \
                    patch.object(chromium_memory, "run_with_sampling", side_effect=sampled), \
                    redirect_stdout(io.StringIO()):
                if failure is None:
                    run_import_memory.main()
                else:
                    with self.assertRaises(RuntimeError):
                        run_import_memory.main()
            observations = json.loads((directory / "observations.json").read_text())
            comparison = json.loads((directory / "import-window-comparison.json").read_text())
            original = [json.loads(path.read_text()) for path in sorted(directory.glob("memory-*/chromium-memory.json"))]
            self.assertEqual(started, list(enumerate(run_import_memory.fixed_schedule(replication))))
            self.assertEqual(len(observations), 4)
            self.assertEqual(len(original), 4)
            self.assertTrue(all(not item["qualifiedForWholeTreePss"] for item in original))
            return observations, comparison

    def test_scope_is_separate_from_retained_full_lifecycle_failure(self):
        for replication in (1, 2):
            with self.subTest(replication=replication):
                observations, comparison = self.run_driver(replication=replication)
                self.assertTrue(comparison["qualifiedMemoryMeasurement"])
                self.assertTrue(comparison["qualifiedCrossArmReadback"])
                self.assertEqual(len(comparison["pairs"]), 2)
                self.assertEqual(comparison["wholeLifecycleQualifiedObservationCount"], 0)
                self.assertEqual(len(comparison["wholeLifecycleQualificationFailures"]), 4)
                self.assertTrue(all(item["importWindow"]["qualifiedForImportWindowPss"] for item in observations))

    def test_all_fixed_observations_preserved_after_each_kind_of_failure(self):
        for failure in ("coverage", "marker", "import", "physical"):
            with self.subTest(failure=failure):
                observations, comparison = self.run_driver(failure=failure)
                self.assertFalse(comparison["qualifiedMemoryMeasurement"])
                self.assertEqual(comparison["pairs"], [])
                self.assertTrue(comparison["qualificationFailures"])
                if failure == "coverage":
                    self.assertTrue(comparison["qualifiedCrossArmReadback"])
                    self.assertIsNone(observations[1]["importWindow"]["maxSampledPssKiB"])
                elif failure == "marker":
                    self.assertTrue(comparison["qualifiedCrossArmReadback"])
                    self.assertIsNotNone(observations[1]["windowFailure"])
                elif failure == "import":
                    self.assertIsNotNone(observations[1]["failure"])
                else:
                    self.assertFalse(comparison["qualifiedCrossArmReadback"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
