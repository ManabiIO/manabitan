#!/usr/bin/env python3
"""Contract tests for study receipts, balanced scheduling and child cleanup.

These synthetic receipts exercise acceptance boundaries. They are not browser
observations and never supply performance evidence for a product candidate.
"""

import collections
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
import unittest


STUDY = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("jmdict_study_driver", STUDY / "run.py")
DRIVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DRIVER)


def replace(value, route, replacement):
    for key in route[:-1]:
        value = value[key]
    value[route[-1]] = replacement


class SummaryContractTests(unittest.TestCase):
    def setUp(self):
        fixture_lock = json.loads((DRIVER.ROOT / "test/perf/dictionaries.lock.json").read_text())
        self.fixture = fixture_lock["dictionaries"]["jmdict"]
        self.arm = {
            "commit": "1" * 40,
            "tree": "2" * 40,
            "packageSha256": "3" * 64,
            "buildTarget": "chrome",
            "expectedInitialPrefetchFileCount": 0,
            "frozenFiles": {"package-lock.json": "4" * 64, "test/perf/dictionaries.lock.json": "5" * 64},
            "commonGeneratedOverlay": {"ext/legal-npm.html": "6" * 64},
        }
        self.state = {
            "dictionary": "jmdict",
            "fixture": copy.deepcopy(self.fixture),
            "browserRuntime": {"binarySha256": "7" * 64},
            "geckodriverSha256": "8" * 64,
        }

    def debug(self):
        prefetch = self.arm["expectedInitialPrefetchFileCount"]
        return {
            "hasResult": True,
            "resultTitle": self.fixture["expectedTitle"],
            "errorCount": 0,
            "addSettingsErrorCount": 0,
            "usesFallbackStorage": False,
            "openStorageDiagnostics": {"mode": "opfs-sahpool"},
            "localPhaseTimings": [{"phase": "worker-import-dictionary", "elapsedMs": 800}],
            "importerPhaseTimings": [
                {
                    "phase": "term-file-fast-path:term_bank_1.json-term_bank_53.json",
                    "details": {
                        "rows": self.fixture["termRows"],
                        "parserSourceCompressedBytes": 15_574_114,
                        "parserSourceTransferredBytes": 15_574_114,
                        "parserSourceUncompressedBytes": 171_092_992,
                        "parserFusedFallbacks": 0,
                        "dedupNativeFallbackCount": 0,
                        "parserDiscardedFusedRows": 0,
                        "sourceInitialPrefetchFileCount": prefetch,
                        "sourceInitialPrefetchEstimatedBytes": 3_226_520 if prefetch else 0,
                        "parserMaxWasmHeapBytes": 38_928_384,
                    },
                },
                {"phase": "bulk-finalization", "details": {"ok": True, "published": True, "housekeepingErrors": []}},
            ],
        }

    def validation(self):
        return {
            "title": self.fixture["expectedTitle"],
            "revision": self.fixture["revision"],
            "termRows": self.fixture["termRows"],
            "contentReadable": True,
            "probeCount": 12,
        }

    def summary(self, browser):
        validation = self.validation()
        if browser == "firefox":
            self.arm["buildTarget"] = "firefox-dev"
            validation.update({"extensionReloadVerified": True, "semanticDigest": "a" * 64, "storageSampleDigest": "b" * 64})
            return {
                "schemaVersion": 1,
                "completed": True,
                "authoritativeTiming": True,
                "skippedVerification": False,
                "error": None,
                "cleanupErrors": [],
                "source": {
                    "commit": self.arm["commit"],
                    "tree": self.arm["tree"],
                    "packageLockSha256": self.arm["frozenFiles"]["package-lock.json"],
                    "commonGeneratedOverlay": copy.deepcopy(self.arm["commonGeneratedOverlay"]),
                },
                "package": {"sha256": self.arm["packageSha256"]},
                "fixture": {**self.fixture, "lockSha256": self.arm["frozenFiles"]["test/perf/dictionaries.lock.json"]},
                "runtime": {"binarySha256": self.state["browserRuntime"]["binarySha256"],
                            "geckodriverSha256": self.state["geckodriverSha256"], "headless": False},
                "browser": {"version": "test-firefox", "freshProfile": True},
                "totalImportMs": 1000,
                "workerImportMs": 800,
                "importResult": {"debug": self.debug()},
                "validation": validation,
                "productionEnvironment": {"flags": None, "profiling": False, "sharedArrayBuffer": True},
                "largestParserWasmHeapBytes": 38_928_384,
            }
        self.arm["buildTarget"] = "chrome"
        validation.update({"restart": self.validation(), "outputDigestSha256": "c" * 64})
        return {
            "schemaVersion": 3,
            "dictionary": "jmdict",
            "authoritativeTiming": True,
            "traceEnabled": False,
            "importFlags": None,
            "gitSha": self.arm["commit"],
            "fixture": copy.deepcopy(self.fixture),
            "buildTarget": "chrome",
            "browserVersion": "test-chromium",
            "runs": [{"packageSha256": self.arm["packageSha256"], "totalImportMs": 1000,
                      "workerImportMs": 800, "importDebug": self.debug(), "validation": validation}],
        }

    def extract(self, summary, browser):
        return DRIVER.extract_summary(summary, self.arm, self.state, browser)

    def test_accepts_both_native_schemas_and_records_the_executed_arm(self):
        for browser in ("chromium", "firefox"):
            for prefetch in (0, 1):
                with self.subTest(browser=browser, prefetch=prefetch):
                    self.arm["expectedInitialPrefetchFileCount"] = prefetch
                    result = self.extract(self.summary(browser), browser)
                    self.assertEqual(result["totalImportMs"], 1000)
                    self.assertEqual(result["workerImportMs"], 800)
                    self.assertEqual(result["validation"]["termRows"], self.fixture["termRows"])
                    self.assertEqual(result["executedPath"]["sourceInitialPrefetchFileCount"], prefetch)
                    self.assertEqual(result["executedPath"]["largestParserWasmHeapBytes"], 38_928_384)

    def test_rejects_missing_or_invalid_authoritative_time_and_browser_version(self):
        for browser in ("chromium", "firefox"):
            for elapsed in (None, False, True, 0, -1, "1000", float("nan"), float("inf")):
                with self.subTest(browser=browser, elapsed=elapsed):
                    summary = self.summary(browser)
                    timing = summary if browser == "firefox" else summary["runs"][0]
                    timing["totalImportMs"] = elapsed
                    with self.assertRaisesRegex(RuntimeError, "Invalid elapsed time"):
                        self.extract(summary, browser)
            for version in (None, "", 143):
                with self.subTest(browser=browser, version=version):
                    summary = self.summary(browser)
                    route = ("browser", "version") if browser == "firefox" else ("browserVersion",)
                    replace(summary, route, version)
                    with self.assertRaisesRegex(RuntimeError, "Missing browser version"):
                        self.extract(summary, browser)

    def test_rejects_firefox_identity_and_verification_failures(self):
        cases = [
            (("schemaVersion",), 3), (("completed",), False), (("authoritativeTiming",), False),
            (("skippedVerification",), True), (("error",), {"message": "reload failed"}),
            (("cleanupErrors",), [{"message": "quit failed"}]),
            (("source", "commit"), "9" * 40), (("source", "tree"), "9" * 40),
            (("source", "packageLockSha256"), "9" * 64),
            (("source", "commonGeneratedOverlay", "ext/legal-npm.html"), "9" * 64),
            (("package", "sha256"), "9" * 64), (("fixture", "sha256"), "9" * 64),
            (("fixture", "lockSha256"), "9" * 64),
            (("runtime", "binarySha256"), "9" * 64), (("runtime", "geckodriverSha256"), "9" * 64),
            (("runtime", "headless"), True), (("browser", "freshProfile"), False),
            (("validation", "termRows"), 1), (("validation", "probeCount"), 11),
            (("validation", "contentReadable"), False), (("validation", "extensionReloadVerified"), False),
            (("validation", "semanticDigest"), None), (("validation", "storageSampleDigest"), "short"),
        ]
        for route, value in cases:
            with self.subTest(field=route):
                summary = self.summary("firefox")
                replace(summary, route, value)
                with self.assertRaises(RuntimeError):
                    self.extract(summary, "firefox")

    def test_rejects_chromium_identity_and_verification_failures(self):
        cases = [
            (("schemaVersion",), 1), (("dictionary",), "jmnedict"), (("authoritativeTiming",), False),
            (("traceEnabled",), True), (("importFlags",), {"experimentalSkipFusedParse": True}),
            (("gitSha",), "9" * 40), (("fixture", "sha256"), "9" * 64), (("buildTarget",), "chrome-dev"),
            (("runs", 0, "packageSha256"), "9" * 64),
            (("runs", 0, "validation", "title"), "wrong dictionary"),
            (("runs", 0, "validation", "revision"), "wrong revision"),
            (("runs", 0, "validation", "termRows"), 1),
            (("runs", 0, "validation", "contentReadable"), False),
            (("runs", 0, "validation", "probeCount"), 11),
            (("runs", 0, "validation", "restart", "termRows"), 1),
            (("runs", 0, "validation", "restart", "contentReadable"), False),
            (("runs", 0, "validation", "restart", "probeCount"), 11),
            (("runs", 0, "validation", "outputDigestSha256"), "short"),
        ]
        for route, value in cases:
            with self.subTest(field=route):
                summary = self.summary("chromium")
                replace(summary, route, value)
                with self.assertRaises(RuntimeError):
                    self.extract(summary, "chromium")
        for count in (0, 2):
            with self.subTest(imports=count):
                summary = self.summary("chromium")
                summary["runs"] *= count
                with self.assertRaisesRegex(RuntimeError, "exactly one import"):
                    self.extract(summary, "chromium")

    def test_rejects_wrong_import_work_fallback_and_failed_publication(self):
        phase = ("importerPhaseTimings", 0)
        details = (*phase, "details")
        finalization = ("importerPhaseTimings", 1, "details")
        cases = [
            (("usesFallbackStorage",), True), (("openStorageDiagnostics", "mode"), "memory"),
            ((*phase, "phase"), "term-file:generic"), ((*details, "rows"), 1),
            ((*details, "parserSourceCompressedBytes"), 0), ((*details, "parserSourceTransferredBytes"), 0),
            ((*details, "parserSourceUncompressedBytes"), 0), ((*details, "parserFusedFallbacks"), 1),
            ((*details, "dedupNativeFallbackCount"), 1), ((*details, "parserDiscardedFusedRows"), 1),
            ((*details, "sourceInitialPrefetchFileCount"), 0), ((*details, "sourceInitialPrefetchEstimatedBytes"), 0),
            ((*finalization, "published"), False), ((*finalization, "ok"), False),
            ((*finalization, "housekeepingErrors"), ["write failed"]),
        ]
        self.arm["expectedInitialPrefetchFileCount"] = 1
        for browser in ("chromium", "firefox"):
            for route, value in cases:
                with self.subTest(browser=browser, field=route):
                    summary = self.summary(browser)
                    debug = summary["importResult"]["debug"] if browser == "firefox" else summary["runs"][0]["importDebug"]
                    replace(debug, route, value)
                    with self.assertRaises(RuntimeError):
                        self.extract(summary, browser)
        for phases in ([], [self.debug()["importerPhaseTimings"][0]]):
            with self.subTest(phases=len(phases)):
                debug = self.debug()
                debug["importerPhaseTimings"] = phases
                with self.assertRaises(RuntimeError):
                    DRIVER.validate_executed_path(debug, self.arm, self.fixture)


class ScheduleTests(unittest.TestCase):
    def test_every_block_and_position_is_balanced_without_dropping_warmups(self):
        for replication in ("forward", "reverse"):
            with self.subTest(replication=replication):
                plan = DRIVER.build_schedule({"warmupsPerArm": 2, "blocks": 24}, replication)
                self.assertEqual(len(plan), 104)
                self.assertEqual(len({item["label"] for item in plan}), 104)
                self.assertTrue(all(item["warmup"] for item in plan[:8]))
                self.assertTrue(all(not item["warmup"] for item in plan[8:]))
                self.assertEqual(collections.Counter(item["arm"] for item in plan[:8]), dict.fromkeys("ABCD", 2))
                positions = collections.Counter()
                transitions = collections.Counter()
                for block in range(24):
                    rows = [item for item in plan[8:] if item["block"] == block]
                    order = [item["arm"] for item in rows]
                    self.assertEqual(sorted(order), list("ABCD"))
                    positions.update(enumerate(order))
                    transitions.update(zip(order, order[1:]))
                self.assertEqual(positions, {(position, arm): 6 for position in range(4) for arm in "ABCD"})
                self.assertEqual(transitions, {(left, right): 6 for left in "ABCD" for right in "ABCD" if left != right})

    def test_reverse_replication_reverses_each_complete_group(self):
        manifest = {"warmupsPerArm": 2, "blocks": 24}
        forward = DRIVER.build_schedule(manifest, "forward")
        reverse = DRIVER.build_schedule(manifest, "reverse")
        for start in range(0, len(forward), 4):
            self.assertEqual(reverse[start:start + 4], list(reversed(forward[start:start + 4])))


@unittest.skipUnless(sys.platform == "linux", "The study's process-group cleanup targets Linux")
class CommandTests(unittest.TestCase):
    def test_nonzero_exit_keeps_receipt_and_both_logs_before_raising(self):
        with tempfile.TemporaryDirectory(prefix="jmdict-study-command-") as temporary:
            root = Path(temporary)
            code = "import sys; print('original stdout'); print('original stderr', file=sys.stderr); sys.exit(7)"
            with contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError, "failed"):
                    DRIVER.command("failure", [sys.executable, "-c", code], root, root, timeout=5)
            output = root / "commands/failure"
            receipt = json.loads((output / "command.json").read_text())
            self.assertIs(receipt["complete"], False)
            self.assertEqual(receipt["exitCode"], 7)
            self.assertEqual((output / "stdout.log").read_text(), "original stdout\n")
            self.assertEqual((output / "stderr.log").read_text(), "original stderr\n")
            self.assertGreaterEqual(receipt["completedAt"], receipt["startedAt"])

    def test_timeout_stops_a_descendant_that_ignores_termination(self):
        with tempfile.TemporaryDirectory(prefix="jmdict-study-timeout-") as temporary:
            root = Path(temporary)
            child_pid_file = root / "child.pid"
            child_code = (
                "import os, signal, time; from pathlib import Path; "
                "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                f"Path({str(child_pid_file)!r}).write_text(str(os.getpid())); time.sleep(60)"
            )
            parent_code = (
                "import subprocess, sys, time; from pathlib import Path\n"
                f"subprocess.Popen([sys.executable, '-c', {child_code!r}])\n"
                f"while not Path({str(child_pid_file)!r}).exists(): time.sleep(0.01)\n"
                "print('descendant ready', flush=True)\n"
                "time.sleep(60)\n"
            )
            child_pid = None
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    receipt = DRIVER.command("timeout", [sys.executable, "-c", parent_code], root, root, timeout=1, required=False)
                child_pid = int(child_pid_file.read_text())
                self.assertIs(receipt["complete"], False)
                self.assertIs(receipt["timedOut"], True)
                self.assertEqual(receipt["exitCode"], -signal.SIGTERM)
                self.assertEqual(json.loads((root / "commands/timeout/command.json").read_text()), receipt)
                self.assertIn("descendant ready", (root / "commands/timeout/stdout.log").read_text())
                deadline = time.monotonic() + 2
                while self.process_is_running(child_pid) and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertFalse(self.process_is_running(child_pid), "Timed-out descendant survived process-group cleanup")
            finally:
                if child_pid is None and child_pid_file.exists():
                    child_pid = int(child_pid_file.read_text())
                if child_pid is not None:
                    try:
                        os.kill(child_pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    @staticmethod
    def process_is_running(pid):
        try:
            # An orphan can briefly remain as a zombie until the host reaps it.
            state = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()[0]
            return state not in ("Z", "X")
        except FileNotFoundError:
            return False


if __name__ == "__main__":
    unittest.main(verbosity=2)
