#!/usr/bin/env python3
"""Pure adversarial tests of the NEW correctness comparator; no importer acquisition."""
import contextlib
import copy
import io
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

MODULE = Path(__file__).with_name("run-all.py")
SPEC = importlib.util.spec_from_file_location("fields_corpus_run_all", MODULE)
DRIVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DRIVER)


class ComparatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.fixture = {"sha256": "1" * 64, "sizeBytes": 10, "termRows": 2}
        self.candidate = "2" * 40
        a_runtime = {"js/dictionary/dictionary-database.js": {"sha256": "a", "bytes": 1},
                     "js/dictionary/term-record-opfs-store.js": {"sha256": "b", "bytes": 1},
                     "js/unchanged.js": {"sha256": "c", "bytes": 1}}
        b_runtime = {**a_runtime}
        for index, path in enumerate(sorted(DRIVER.EXPECTED_RUNTIME_DELTA)):
            b_runtime[path] = {"sha256": "new" + str(index), "bytes": index + 2}
        workers = []
        for worker in range(3):
            requests = []
            for offset in range(4):
                number = worker * 4 + offset + 1
                requests.append({"id": number, "banks": [{"filename": "term_bank_" + str(number) + ".json",
                                                         "signature": number}],
                                 "sourceByteLengths": [number]})
            workers.append({"entry": "term-bank-wasm-parser-worker.js", "ready": 1,
                            "failures": [], "parseRequests": requests})
        counts = {key: 0 for key in DRIVER.PARSER_KEYS}
        counts["fastPathParserParallelGroupCount"] = 12
        counts["fastPathParserParallelWorkerCount"] = 3
        self.report = {
            "passed": True, "newReconstructedDriver": True, "performanceMeasurements": False,
            "dictionary": "jmdict", "fixture": {"sha256": "1" * 64, "bytes": 10},
            "fieldRows": 2, "parserGroups": 12, "parserWorkers": 3,
            "sqlite": {"persistentSqlite": False, "usesFallbackStorageOverride": False},
            "flags": {"skipImageMetadata": True}, "semantic": {"rows": 2},
            "termFiles": [{"path": "manabitan-term-records/dict-test.mbtr", "bytes": 40,
                           "normalizedSha256": "3" * 64, "normalization": {"offset": 8, "bytes": 16},
                           "termPayload": True}],
            "nativeCoverage": {"nativeCalls": 1, "totalCalls": 1, "nativeRows": 2, "totalRows": 2},
        }
        for arm, commit, runtime in (("A", DRIVER.BASELINE, a_runtime), ("B", self.candidate, b_runtime)):
            directory = self.root / arm
            directory.mkdir()
            report = copy.deepcopy(self.report)
            report.update({"arm": arm, "source": {"commit": commit, "runtimeFiles": runtime,
                                                  "kit": {"run.mjs": {"sha256": "same"}}}})
            report["fieldMetrics"] = None if arm == "A" else {
                "calls": 1, "javascriptCalls": 0, "native": {"nativeCalls": 1, "nativeRows": 2}}
            report["optionalAssets"] = [] if arm == "A" else [{"path": "ext/lib/term-record-fields.wasm"}]
            self.write(arm, "report.json", report)
            self.write(arm, "cleanup.json", {"completed": True, "cleanupErrors": []})
            self.write(arm, "field-calls.json", [{"ordinal": 0, "rowCount": 2,
                "contentOffsetBase": 0, "bytes": 40, "sha256": "4" * 64}])
            self.write(arm, "workers.json", workers)
            self.write(arm, "product-work-counts.json", [{"phase": "import-data-banks", "details": counts}])

    def tearDown(self):
        self.temp.cleanup()

    def write(self, arm, filename, value):
        DRIVER.save(self.root / arm / filename, value)

    def mutate(self, arm, filename, callback):
        value = DRIVER.read_json(self.root / arm / filename)
        callback(value)
        self.write(arm, filename, value)

    def compare(self):
        return DRIVER.compare_pair(self.root / "A", self.root / "B", "jmdict", self.fixture, self.candidate)

    def test_exact_pair(self):
        result = self.compare()
        self.assertTrue(result["passed"])
        self.assertEqual(result["completeRuntimeDelta"], sorted(DRIVER.EXPECTED_RUNTIME_DELTA))

    def test_any_term_byte_hash_difference_fails(self):
        self.mutate("B", "report.json", lambda value: value["termFiles"][0].update(normalizedSha256="changed"))
        with self.assertRaises(DRIVER.CorrectnessError):
            self.compare()

    def test_missing_or_duplicate_final_file_fails(self):
        self.mutate("B", "report.json", lambda value: value["termFiles"].append(copy.deepcopy(value["termFiles"][0])))
        with self.assertRaises(DRIVER.CorrectnessError):
            self.compare()

    def test_complete_field_hash_difference_fails(self):
        self.mutate("B", "field-calls.json", lambda value: value[0].update(sha256="changed"))
        with self.assertRaises(DRIVER.CorrectnessError):
            self.compare()

    def test_generated_unrelated_runtime_change_fails(self):
        self.mutate("B", "report.json", lambda value: value["source"]["runtimeFiles"].update(
            {"lib/unexpected.js": {"sha256": "extra", "bytes": 1}}))
        with self.assertRaises(DRIVER.CorrectnessError):
            self.compare()

    def test_observer_change_fails(self):
        self.mutate("B", "report.json", lambda value: value["source"]["kit"].update({"run.mjs": {"sha256": "changed"}}))
        with self.assertRaises(DRIVER.CorrectnessError):
            self.compare()

    def test_native_missing_or_counter_mismatch_fails(self):
        self.mutate("B", "report.json", lambda value: value["fieldMetrics"]["native"].update(nativeCalls=0))
        with self.assertRaises(DRIVER.CorrectnessError):
            self.compare()

    def test_parser_group_boundary_change_fails(self):
        self.mutate("B", "workers.json", lambda value: value[0]["parseRequests"][0]["banks"][0].update(signature=999))
        with self.assertRaises(DRIVER.CorrectnessError):
            self.compare()

    def test_parser_crc_work_change_fails(self):
        self.mutate("B", "product-work-counts.json", lambda value: value[0]["details"].update(
            fastPathParserSourceCrcScannedBytes=1))
        with self.assertRaises(DRIVER.CorrectnessError):
            self.compare()

    def test_source_or_fixture_change_fails(self):
        self.mutate("B", "report.json", lambda value: value["source"].update(commit=DRIVER.BASELINE))
        with self.assertRaises(DRIVER.CorrectnessError):
            self.compare()

    def test_cleanup_failure_invalidates_success_receipt(self):
        self.mutate("B", "cleanup.json", lambda value: value.update(cleanupErrors=["failed"]))
        with self.assertRaises(DRIVER.CorrectnessError):
            self.compare()

    def test_nondestructive_retirement_refuses_changed_bytes(self):
        directory = self.root / "A"
        root = directory / "disk" / "root"
        root.mkdir(parents=True)
        (directory / "disk" / "staging").mkdir()
        (root / "bytes").write_bytes(b"actual")
        self.write("A", "files.json", [{"path": "bytes", "bytes": 6, "sha256": "wrong"}])
        with self.assertRaises(DRIVER.CorrectnessError):
            DRIVER.retire_verified_disk(directory)
        self.assertEqual((root / "bytes").read_bytes(), b"actual")


    def test_runtime_delta_reports_missing_required_change(self):
        a = DRIVER.read_json(self.root / "A" / "report.json")["source"]["runtimeFiles"]
        b = DRIVER.read_json(self.root / "B" / "report.json")["source"]["runtimeFiles"]
        path = "js/dictionary/dictionary-database.js"
        b[path] = a[path]
        result = DRIVER.runtime_delta(a, b)
        self.assertFalse(result["passed"])
        self.assertEqual(result["missingExpectedChanges"], [path])

    def test_generated_license_exception_never_relaxes_pair(self):
        self.mutate("A", "report.json", lambda value: value["source"]["runtimeFiles"].update(
            {"legal-npm.html": {"sha256": "baseline", "bytes": 10}}))
        self.mutate("B", "report.json", lambda value: value["source"]["runtimeFiles"].update(
            {"legal-npm.html": {"sha256": "candidate", "bytes": 10}}))
        with self.assertRaisesRegex(DRIVER.CorrectnessError, "frozen five entries"):
            self.compare()

    def test_runtime_failure_logs_all_actual_path_identities(self):
        a = {"lib/path-sensitive.js": {"bytes": 10, "sha256": "1" * 64}}
        b = {"lib/path-sensitive.js": {"bytes": 11, "sha256": "2" * 64},
             "lib/path-sensitive.js.map": {"bytes": 12, "sha256": "3" * 64}}
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            with self.assertRaises(DRIVER.CorrectnessError):
                DRIVER.require_runtime_delta(a, b, "synthetic-before-import")
        value = json.loads(output.getvalue())
        self.assertEqual(value["context"], "synthetic-before-import")
        comparison = value["comparison"]
        self.assertEqual(comparison["actualChangedPaths"], sorted(b))
        self.assertEqual(comparison["changedPathIdentities"]["lib/path-sensitive.js"], {"A": a["lib/path-sensitive.js"], "B": b["lib/path-sensitive.js"]})
        self.assertIsNone(comparison["changedPathIdentities"]["lib/path-sensitive.js.map"]["A"])

    def test_preflight_retains_full_inventories_before_rejecting(self):
        output = self.root / "preflight"
        output.mkdir()
        prepared = {
            "A": {"runtimeFiles": {"lib/unexpected.js": {"bytes": 1, "sha256": "a"}}},
            "B": {"runtimeFiles": {"lib/unexpected.js": {"bytes": 2, "sha256": "b"}}},
        }
        with mock.patch.object(DRIVER, "prepared_source", side_effect=[prepared["A"], prepared["B"]]):
            with mock.patch.object(DRIVER.subprocess, "check_output") as process:
                with contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaises(DRIVER.CorrectnessError):
                        DRIVER.preflight_runtime(self.root / "A", self.root / "B", self.candidate, output)
                process.assert_not_called()
        self.assertEqual(DRIVER.read_json(output / "prepared-source-A.json"), prepared["A"])
        self.assertEqual(DRIVER.read_json(output / "prepared-source-B.json"), prepared["B"])
        self.assertFalse(DRIVER.read_json(output / "runtime-delta.json")["passed"])

    def test_completed_pair_cannot_drift_from_preflight(self):
        prepared = {arm: {"runtimeFiles": copy.deepcopy(DRIVER.read_json(self.root / arm / "report.json")["source"]["runtimeFiles"])}
                    for arm in ("A", "B")}
        for arm in ("A", "B"):
            self.mutate(arm, "report.json", lambda value: value["source"]["runtimeFiles"].update(
                {"js/unchanged.js": {"sha256": "new-identical-in-both", "bytes": 20}}))
        with self.assertRaisesRegex(DRIVER.CorrectnessError, "after the read-only preflight"):
            DRIVER.compare_pair(self.root / "A", self.root / "B", "jmdict", self.fixture, self.candidate, prepared)

    def test_runtime_inventory_hashes_every_file_and_preserves_legal_names(self):
        runtime = self.root / "inventory"
        (runtime / "lib").mkdir(parents=True)
        (runtime / "lib" / "bytes|name").write_bytes(b"\x00\xffbinary")
        (runtime / ".hidden").write_bytes(b"hidden")
        result = DRIVER.runtime_inventory(runtime)
        self.assertEqual(set(result), {"lib/bytes|name", ".hidden"})
        self.assertEqual(result["lib/bytes|name"], DRIVER.digest(runtime / "lib" / "bytes|name"))
        self.assertEqual(result[".hidden"], DRIVER.digest(runtime / ".hidden"))

    def test_runtime_inventory_rejects_nested_symlink(self):
        runtime = self.root / "inventory"
        runtime.mkdir()
        (runtime / "real").write_bytes(b"same")
        (runtime / "alias").symlink_to(runtime / "real")
        with self.assertRaisesRegex(DRIVER.CorrectnessError, "symlink"):
            DRIVER.runtime_inventory(runtime)

    def test_prepared_tree_rejects_shared_dependency_symlink(self):
        prepared = self.root / "prepared"
        prepared.mkdir()
        shared = self.root / "node_modules"
        shared.mkdir()
        (prepared / "node_modules").symlink_to(shared, target_is_directory=True)
        with mock.patch.object(DRIVER.subprocess, "check_output", side_effect=[self.candidate.encode(), b""]):
            with self.assertRaisesRegex(DRIVER.CorrectnessError, "actual npm ci"):
                DRIVER.prepared_source(prepared, self.candidate)

    def test_arm_console_receipt_keeps_original_counts_and_hashes(self):
        source_before = (self.root / "B" / "report.json").read_bytes()
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            DRIVER.emit_arm_evidence(self.root / "B", "B", "jmdict")
        lines = [json.loads(line) for line in output.getvalue().splitlines()]
        report = next(item for item in lines if item.get("path") == "report.json")
        self.assertEqual(report["receipt"]["fieldMetrics"]["native"]["nativeRows"], 2)
        self.assertIn("runtimeInventory", report["receipt"]["source"])
        self.assertNotIn("runtimeFiles", report["receipt"]["source"])
        self.assertEqual(report["identity"], DRIVER.digest(self.root / "B" / "report.json"))
        calls = next(item for item in lines if item.get("path") == "field-calls.json")
        self.assertEqual(calls["receipt"], DRIVER.read_json(self.root / "B" / "field-calls.json"))
        self.assertEqual((self.root / "B" / "report.json").read_bytes(), source_before)

    def test_evidence_parse_failure_does_not_hide_original_failure(self):
        (self.root / "B" / "failure.json").write_text("{invalid")
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            DRIVER.emit_arm_evidence(self.root / "B", "B", "jmdict")
        lines = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertTrue(any(item["event"] == "arm-evidence-error" and item["path"] == "failure.json"
                            for item in lines))
        self.assertTrue(any(item.get("path") == "report.json" for item in lines))


if __name__ == "__main__":
    unittest.main()
