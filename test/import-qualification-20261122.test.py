#!/usr/bin/env python3
"""Contract checks for the research runner; no downloads, builds, or browsers."""

from collections import Counter
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("qualification", ROOT / "dev/perf/import-qualification-20261122.py")
STUDY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(STUDY)
CONFIG = json.loads(STUDY.CONFIG.read_text())


class QualificationContracts(unittest.TestCase):
    def test_counterbalanced_adjacent_schedule_and_literal_reverse(self):
        forward = STUDY.schedule("forward")
        reverse = STUDY.schedule("reverse")
        for plan in (forward, reverse):
            self.assertEqual(len(plan), 42)
            self.assertEqual(len({row["name"] for row in plan}), 42)
            self.assertEqual(sum(row["warmup"] for row in plan), 6)
            measured = [row for row in plan if not row["warmup"]]
            self.assertEqual(Counter(row["arm"] for row in measured), {"A": 12, "B": 12, "C": 12})
            blocks = [measured[index:index + 3] for index in range(0, 36, 3)]
            self.assertEqual(Counter(block[0]["order"] for block in blocks),
                             {order: 2 for order in ("ABC", "ACB", "BAC", "BCA", "CAB", "CBA")})
            for index, block in enumerate(blocks):
                self.assertEqual({row["block"] for row in block}, {index + 1})
                self.assertEqual("".join(row["arm"] for row in block), block[0]["order"])
        self.assertEqual([row["arm"] for row in reverse if not row["warmup"]],
                         list(reversed([row["arm"] for row in forward if not row["warmup"]])))

    def test_pinned_refs_and_invalid_configuration_fail_closed(self):
        for case_id in ("parser-jmdict", "parser-jitendex", "parser-vndb", "media-vndb"):
            STUDY.validate_config(CONFIG, case_id)
        self.assertEqual(CONFIG["cases"]["parser-vndb"]["dictionary"], "vndb")
        self.assertEqual(CONFIG["cases"]["parser-vndb"]["sha"], CONFIG["cases"]["parser-jmdict"]["sha"])
        self.assertNotEqual(CONFIG["cases"]["media-vndb"]["sha"], CONFIG["cases"]["parser-vndb"]["sha"])
        for invalid in (None, "develop", "a" * 39, CONFIG["baseline"]):
            config = deepcopy(CONFIG)
            config["cases"]["media-vndb"]["sha"] = invalid
            with self.assertRaises(ValueError):
                STUDY.validate_config(config, "media-vndb")

    def test_symmetric_overlay_is_test_only_and_default_fixtures_stay_unchanged(self):
        lock_path = ROOT / "test/perf/dictionaries.lock.json"
        original = lock_path.read_bytes()
        default_fixtures = json.loads(original)["dictionaries"]
        self.assertNotIn("vndb", default_fixtures)
        for dictionary in ("jmdict", "jitendex", "vndb"):
            overlay = STUDY.overlay_contents(CONFIG, dictionary)
            self.assertEqual(set(overlay), set(STUDY.OVERLAY_FILES))
            self.assertTrue(all(name.startswith(("dev/perf/", "test/")) for name in overlay))
            self.assertEqual(overlay["dev/perf/import-benchmark.js"], (ROOT / "dev/perf/import-benchmark.js").read_bytes())
            self.assertEqual(overlay["dev/perf/benchmark-support.js"], (ROOT / "dev/perf/benchmark-support.js").read_bytes())
            fixtures = json.loads(overlay["test/perf/dictionaries.lock.json"])["dictionaries"]
            self.assertEqual({name: fixture for name, fixture in fixtures.items() if name != "vndb"}, default_fixtures)
            self.assertEqual("vndb" in fixtures, dictionary == "vndb")
            self.assertIn(b"vndbPath: paths.vndb", overlay["dev/perf/dictionary-fixtures.js"])
            self.assertIn(b"vndb: {label: 'VNDB Characters by Bee', filePath: cachedDictionaries.vndbPath}",
                          overlay["test/chromium/extension-two-dictionary-import.e2e.js"])
        self.assertEqual(lock_path.read_bytes(), original)
        with self.assertRaises(ValueError):
            STUDY.replace_once("changed anchor", "expected", "replacement")
        with self.assertRaises(ValueError):
            STUDY.replace_once("expected expected", "expected", "replacement")

    def test_inherited_benchmark_controls_are_removed(self):
        inherited = {"PATH": "/bin", "CI": "true", "MANABITAN_E2E_PHASE_PROFILING": "1",
                     "MANABITAN_CHROMIUM_HEADLESS": "0", "MANABITAN_E2E_STOP_AFTER_INITIAL_IMPORTS": "1"}
        with patch.dict(STUDY.os.environ, inherited, clear=True):
            self.assertEqual(STUDY.clean_environment(), {"PATH": "/bin", "CI": "true"})
        helper = (ROOT / "dev/perf/benchmark-support.js").read_text()
        self.assertIn("MANABITAN_E2E_STRICT_RUNTIME: '1'", helper)
        self.assertIn("MANABITAN_CHROMIUM_ALLOW_HEADED_FALLBACK: '0'", helper)

    def test_package_map_detects_additions_removals_and_changed_entries(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "package.zip"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("a.js", b"before")
                output.writestr("b.js", b"same")
            baseline = STUDY.package_entries(archive)
            candidate = {"a.js": STUDY.digest(b"after"), "c.js": STUDY.digest(b"added")}
            self.assertEqual(STUDY.package_differences(baseline, candidate), ["a.js", "b.js", "c.js"])
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                with zipfile.ZipFile(archive, "a") as output:
                    output.writestr("a.js", b"duplicate")
            with self.assertRaisesRegex(ValueError, "Duplicate"):
                STUDY.package_entries(archive)

    def observation(self):
        fixture = CONFIG["extraFixture"]
        sha = "a" * 40
        package = "b" * 64
        lock = "c" * 64
        overlays = {name: "d" * 64 for name in STUDY.OVERLAY_FILES}
        source = {"sha": sha, "packageSha256": package, "packageLockSha256": lock, "overlaySha256": overlays}
        preparation = {"dictionary": "vndb", "fixture": fixture, "runtime": {"node": "v22.22.0", "browserVersion": "140.0.0.0"}, "identities": {"A": source, "B": source}}
        summary = {"dictionary": "vndb", "buildTarget": "chrome", "authoritativeTiming": True, "traceEnabled": False,
                   "importFlags": None, "gitSha": sha, "fixture": fixture, "hostEnvironment": {"nodeVersion": "v22.22.0"},
                   "source": {"sha256": {STUDY.PACKAGE: package, "package-lock.json": lock, **overlays}},
                   "browserVersion": "140.0.0.0", "runs": [{"packageSha256": package, "totalImportMs": 100, "workerImportMs": 90}]}
        validation = {"title": fixture["expectedTitle"], "revision": fixture["revision"], "termRows": fixture["termRows"],
                      "contentReadable": True, "probeCount": 12}
        report = {"status": "success", "skippedVerification": False, "browserVersion": "140.0.0.0",
                  "benchmark": {"phaseProfiling": False, "phaseScreenshots": False, "processSampling": False,
                                "validation": {**validation, "restart": validation, "outputDigestSha256": "e" * 64}}}
        return summary, report, preparation

    def test_observation_rejects_stale_or_unverified_measurements(self):
        summary, report, preparation = self.observation()
        self.assertEqual(STUDY.verify_observation(summary, report, preparation, "C")["totalImportMs"], 100)
        mutations = [
            lambda summary, report: summary.update(dictionary="jmdict"),
            lambda summary, report: summary.update(gitSha="f" * 40),
            lambda summary, report: summary.update(browserVersion=None),
            lambda summary, report: report.update(browserVersion="141.0.0.0"),
            lambda summary, report: summary["source"]["sha256"].update({STUDY.PACKAGE: "f" * 64}),
            lambda summary, report: summary["source"]["sha256"].update({"dev/perf/benchmark-support.js": "f" * 64}),
            lambda summary, report: summary["runs"][0].update(totalImportMs=float("nan")),
            lambda summary, report: summary["runs"][0].update(totalImportMs=0),
            lambda summary, report: summary.update(fixture={}),
            lambda summary, report: report.update(skippedVerification=True),
            lambda summary, report: report["benchmark"].update(phaseProfiling=True),
            lambda summary, report: report["benchmark"]["validation"].update(restart={}),
            lambda summary, report: report["benchmark"]["validation"].update(outputDigestSha256=""),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                mutated_summary, mutated_report = deepcopy(summary), deepcopy(report)
                mutate(mutated_summary, mutated_report)
                with self.assertRaises(ValueError):
                    STUDY.verify_observation(mutated_summary, mutated_report, preparation, "A")

    def complete_cohort(self, output):
        rows = [{**row, "status": "success", "totalImportMs": 90 if row["arm"] == "B" else 100}
                for row in STUDY.schedule("forward")]
        STUDY.write_json(output / "observations.json", rows)
        STUDY.write_json(output / "schedule.json", STUDY.schedule("forward"))
        STUDY.write_json(output / "preparation.json", {"case": "parser-jmdict", "dictionary": "jmdict", "direction": "forward"})
        STUDY.write_json(output / "config.json", CONFIG)
        receipt = {"case": "parser-jmdict", "dictionary": "jmdict", "direction": "forward"}
        for name in ("observations", "schedule", "preparation", "config"):
            receipt[name + "Sha256"] = STUDY.file_digest(output / (name + ".json"))
        STUDY.write_json(output / "cohort-complete.json", receipt)
        return rows

    def test_analysis_requires_complete_verified_cohort_and_exact_schedule(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            self.assertFalse(STUDY.analyze("parser-jmdict", "jmdict", "forward", output))
            self.assertNotIn("candidateVsBaseline", json.loads((output / "analysis.json").read_text()))
            rows = self.complete_cohort(output)
            self.assertTrue(STUDY.analyze("parser-jmdict", "jmdict", "forward", output))
            analysis = json.loads((output / "analysis.json").read_text())
            self.assertEqual(analysis["candidateVsBaseline"]["pairs"], 12)
            self.assertAlmostEqual(analysis["candidateVsBaseline"]["medianPairedPercent"], -10)
            self.assertEqual(analysis["sameCodeControl"]["medianPairedPercent"], 0)
            self.assertFalse(STUDY.analyze("parser-vndb", "vndb", "forward", output))
            self.assertFalse(STUDY.analyze("media-vndb", "jmdict", "forward", output))
            self.assertFalse(STUDY.analyze("parser-jmdict", "jmdict", "reverse", output))
            STUDY.write_json(output / "run-failure.json", {"error": "Postflight identity changed"})
            self.assertFalse(STUDY.analyze("parser-jmdict", "jmdict", "forward", output))
            self.assertNotIn("candidateVsBaseline", json.loads((output / "analysis.json").read_text()))
            (output / "run-failure.json").unlink()
            (output / "cohort-complete.json").unlink()
            self.assertFalse(STUDY.analyze("parser-jmdict", "jmdict", "forward", output))
            self.complete_cohort(output)
            rows[7]["arm"] = rows[6]["arm"]
            STUDY.write_json(output / "observations.json", rows)
            receipt = json.loads((output / "cohort-complete.json").read_text())
            receipt["observationsSha256"] = STUDY.file_digest(output / "observations.json")
            STUDY.write_json(output / "cohort-complete.json", receipt)
            self.assertFalse(STUDY.analyze("parser-jmdict", "jmdict", "forward", output))

    def test_existing_timing_attempt_is_never_retried(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            STUDY.write_json(output / "preparation.json", {"case": "parser-jmdict", "dictionary": "jmdict", "direction": "forward",
                             "runnerSha256": STUDY.file_digest(STUDY.__file__), "configSha256": STUDY.file_digest(STUDY.CONFIG)})
            STUDY.write_json(output / "schedule.json", STUDY.schedule("forward"))
            STUDY.write_json(output / "observations.json", [{"status": "failed"}])
            with self.assertRaisesRegex(ValueError, "cannot be retried"):
                STUDY.run_study("parser-jmdict", "jmdict", "forward", output)


if __name__ == "__main__":
    unittest.main()
