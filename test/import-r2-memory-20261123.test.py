"""Small fail-closed contracts for the separate memory-study coordinator."""

import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("memory_study", ROOT / "dev/perf/import-r2-memory-20261123.py")
study = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(study)


class MemoryStudyContracts(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.output = Path(self.directory.name)
        self.config = json.loads(study.CONFIG.read_text())
        self.case = "transfer-jmdict"
        self.replication = 1

    def tearDown(self):
        self.directory.cleanup()

    def verified(self, summary, _report, _preparation, arm):
        self.assertEqual(summary["arm"], arm)
        return {"outputDigestSha256": "a" * 64, "browserVersion": "100.0.0.1",
                "packageSha256": arm * 64, "workReceipt": {"rows": 526942}}

    def receipt(self):
        study.write_json(self.output / "cohort-complete.json", {
            "case": self.case, "dictionary": "jmdict", "replication": self.replication,
            "authoritativeTiming": False,
            **{name + "Sha256": study.file_digest(self.output / f"{name}.json")
               for name in ("observations", "schedule", "preparation", "config")},
        })

    def complete_fixture(self):
        study.write_json(self.output / "config.json", self.config)
        study.write_json(self.output / "schedule.json", study.schedule(self.replication))
        changes = sorted(self.config["cases"][self.case]["packageDifferences"])
        study.write_json(self.output / "preparation.json", {
            "case": self.case, "dictionary": "jmdict", "replication": self.replication,
            "authoritativeTiming": False, "studySourceHashes": study.source_hashes(),
            "identities": {"A": {"sha": self.config["baseline"]}, "B": {"sha": self.config["cases"][self.case]["sha"]}},
            "packageDifferences": changes,
        })
        for arm in ("A", "B"):
            study.write_json(self.output / f"package-entries-{arm}.json", {name: arm * 64 for name in changes})
        rows = []
        for item in study.schedule(self.replication):
            folder = self.output / "observations" / item["name"]
            folder.mkdir(parents=True)
            pss = 1000 if item["arm"] == "A" else 950
            sample = {
                "qualifiedForWholeTreePss": True, "stableObservedProcessTree": True,
                "unreadableAddressSpaces": [], "qualificationFailures": [],
                "readableProcessPssKiB": pss, "readableProcessPrivateKiB": pss // 2,
                "processes": [{"pid": 1}, {"pid": 2}], "unavailableProcesses": [],
                "confirmedExitedZombies": [],
            }
            memory = study.observer.summarize_samples([sample], 0)
            study.write_json(folder / "chromium-memory.json", memory)
            study.write_json(folder / "summary.json", {"arm": item["arm"]})
            study.write_json(folder / "run-1.json", {})
            rows.append({**item, "status": "success", "authoritativeTiming": False,
                         "memory": {key: value for key, value in memory.items() if key != "samples"},
                         **self.verified({"arm": item["arm"]}, {}, {}, item["arm"]),
                         "receiptHashes": study.observation_hashes(folder)})
        study.write_json(self.output / "observations.json", rows)
        self.receipt()

    def analyze(self):
        with patch.object(study, "validate_observation", side_effect=self.verified):
            value = study.analyze(self.case, self.replication, self.output)
        result = json.loads((self.output / "memory-analysis.json").read_text())
        self.assertFalse(result["authoritativeTiming"])
        if not value:
            self.assertEqual(result["pairs"], [])
            self.assertTrue(result["qualificationFailures"])
        return value, result

    def test_exact_balanced_schedules(self):
        self.assertEqual("".join(row["arm"] for row in study.schedule(1)), "ABBA")
        self.assertEqual("".join(row["arm"] for row in study.schedule(2)), "BAAB")
        with self.assertRaises(ValueError):
            study.schedule(3)

    def test_pinned_source_and_unchanged_observer(self):
        study.validate_config(self.config, self.case)
        bad = copy.deepcopy(self.config)
        bad["observer"]["sha256"] = "0" * 64
        with self.assertRaises(ValueError):
            study.validate_config(bad, self.case)

    def test_complete_cells_only_produce_memory_comparisons(self):
        for replication in (1, 2):
            with self.subTest(replication=replication):
                self.replication = replication
                self.output = Path(self.directory.name) / str(replication)
                self.complete_fixture()
                valid, result = self.analyze()
                self.assertTrue(valid)
                self.assertEqual(len(result["pairs"]), 2)
                self.assertAlmostEqual(result["medianPairedPercent"]["maxSampledPssKiB"], -5)
                self.assertNotIn("totalImportMs", result)

    def test_missing_final_receipt_withholds_results(self):
        self.complete_fixture()
        (self.output / "cohort-complete.json").unlink()
        self.assertFalse(self.analyze()[0])

    def test_postflight_failure_withholds_results(self):
        self.complete_fixture()
        study.write_json(self.output / "run-failure.json", {"error": "postflight identity changed"})
        self.assertFalse(self.analyze()[0])

    def test_duplicate_arm_with_fresh_receipt_is_rejected(self):
        self.complete_fixture()
        rows = json.loads((self.output / "observations.json").read_text())
        rows[1]["arm"] = "A"
        study.write_json(self.output / "observations.json", rows)
        self.receipt()
        self.assertFalse(self.analyze()[0])

    def test_wrong_prepared_source_is_rejected(self):
        self.complete_fixture()
        path = self.output / "preparation.json"
        prep = json.loads(path.read_text())
        prep["identities"]["B"]["sha"] = "1" * 40
        study.write_json(path, prep)
        self.receipt()
        self.assertFalse(self.analyze()[0])

    def test_changed_raw_receipt_is_rejected(self):
        self.complete_fixture()
        path = self.output / "observations" / study.schedule(1)[0]["name"] / "run-1.json"
        study.write_json(path, {"changed": True})
        self.assertFalse(self.analyze()[0])

    def test_failed_memory_observation_is_not_averaged_away(self):
        self.complete_fixture()
        path = self.output / "observations.json"
        rows = json.loads(path.read_text())
        rows[-1]["status"] = "failed"
        study.write_json(path, rows)
        self.receipt()
        self.assertFalse(self.analyze()[0])

    def test_sample_maximum_is_recomputed(self):
        self.complete_fixture()
        path = self.output / "observations.json"
        rows = json.loads(path.read_text())
        folder = self.output / "observations" / rows[0]["name"]
        memory = json.loads((folder / "chromium-memory.json").read_text())
        memory["maxSampledPssKiB"] = 1
        study.write_json(folder / "chromium-memory.json", memory)
        rows[0]["memory"]["maxSampledPssKiB"] = 1
        rows[0]["receiptHashes"] = study.observation_hashes(folder)
        study.write_json(path, rows)
        self.receipt()
        self.assertFalse(self.analyze()[0])

    def test_readback_validation_must_match_summary(self):
        validation = {"probeTerms": [str(i) for i in range(12)]}
        debug = {"hasResult": True, "errorCount": 0, "addSettingsErrorCount": 0, "usesFallbackStorage": False,
                 "openStorageDiagnostics": {"mode": "opfs-sahpool"}}
        timing = {"trigger": "file-input-change", "sequenceBefore": 0, "sequence": 1, "errorCount": 0,
                  "startedAtMs": 1, "completedAtMs": 2, "nextFrameAtMs": 3}
        report = {"benchmark": {"validation": validation}, "phases": [{"data": {
            "kind": "dictionary-import", "browserTiming": timing, "importDebug": debug,
        }}]}
        summary = {"runs": [{"validation": validation, "importDebug": debug}]}
        with patch.object(study.common, "verify_observation", return_value={"totalImportMs": 4, "workerImportMs": 3, "outputDigestSha256": "a" * 64}):
            result = study.validate_observation(summary, report, {}, "A")
            self.assertEqual(result, {"outputDigestSha256": "a" * 64})
            timing["nextFrameAtMs"] = None
            self.assertEqual(study.validate_observation(summary, report, {}, "A"), result)
            timing["nextFrameAtMs"] = 3
            for key, invalid in (("trigger", "programmatic"), ("sequence", 2), ("nextFrameAtMs", 0), ("errorCount", 1)):
                old = timing[key]
                timing[key] = invalid
                with self.assertRaises(ValueError):
                    study.validate_observation(summary, report, {}, "A")
                timing[key] = old
            debug["usesFallbackStorage"] = True
            with self.assertRaises(ValueError):
                study.validate_observation(summary, report, {}, "A")
            debug["usesFallbackStorage"] = False
            summary["runs"][0]["validation"] = {}
            with self.assertRaises(ValueError):
                study.validate_observation(summary, report, {}, "A")


if __name__ == "__main__":
    unittest.main()
