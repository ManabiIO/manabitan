#!/usr/bin/env python3
"""Pure adversarial tests of the NEW correctness comparator; no importer acquisition."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

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


if __name__ == "__main__":
    unittest.main()
