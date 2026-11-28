#!/usr/bin/env python3
"""Pure/synthetic activation-reader tests; no browser, importer or WASM execution."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

SPEC = importlib.util.spec_from_file_location("fields_activation", Path(__file__).with_name("audit-activation.py"))
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)


def fixture(name):
    return {"sha256": "1" * 64, "termRows": 200, "label": name.upper()}


def policy(runtime):
    return {
        "fixtureSha256": "1" * 64, "termRows": 200, "expectedCalls": 2,
        "minimumNativeCalls": 1, "minimumNativeRows": 100,
        "maximumReadinessJavascriptCalls": 1,
        "allowedDeclineMaximums": {"eligibility": 1, "memory-bound": 1, "unsupported-compact": 1},
        "proof": {
            "runId": 1, "attempt": 1, "headSha": "2" * 40, "artifactId": 1,
            "artifactSha256": "3" * 64, "comparisonSha256": "4" * 64,
            "candidateReportSha256": "5" * 64, "fieldCallsSha256": "6" * 64,
            "completeTermByteParity": True, "runtimeSha256": runtime,
        },
    }


def study():
    runtime = {path: str(index) * 64 for index, path in enumerate(sorted(CHECKER.RUNTIME_PATHS), 1)}
    return {
        "schemaVersion": 1, "acquisitionEnabled": True,
        "upstream": {"commit": "7" * 40, "tree": "8" * 40},
        "control": {"commit": "9" * 40, "tree": "a" * 40},
        "candidate": {"commit": "b" * 40, "tree": "c" * 40},
        "schedule": dict(CHECKER.EXPECTED_SCHEDULE),
        "expectedPackageEntries": list(CHECKER.EXPECTED_PACKAGE_ENTRIES),
        "runtimeSha256": runtime,
        "activation": {"sealed": True, "perCorpus": {name: policy(copy.deepcopy(runtime)) for name in CHECKER.DICTIONARIES}},
    }


def native_metrics():
    return {
        "calls": 2, "javascriptCalls": 0,
        "native": {
            "nativeCalls": 2, "nativeRows": 200, "nativeAttempts": 2,
            "inputCopiedBytes": 1624, "outputCopiedBytes": 1640,
            "tableBytesRequested": 2048, "memoryGrowthBytes": 65536,
            "maximumLinearMemoryBytes": 196608, "maximumScratchBytes": 1624,
            "declines": {},
        },
    }


def raw_report(metrics, dictionary="jmdict"):
    details = {"ok": True}
    if metrics is not None:
        details["termRecordFields"] = metrics
    return {"phases": [{"data": {
        "kind": "dictionary-import", "dictionary": dictionary.upper(),
        "importDebugHistory": [{"importerPhaseTimings": [{"phase": "bulk-finalization", "details": details}]}],
    }}]}


class MetricTests(unittest.TestCase):
    def setUp(self):
        self.study = study()
        self.policy = self.study["activation"]["perCorpus"]["jmdict"]
        self.fixtures = {name: fixture(name) for name in CHECKER.DICTIONARIES}

    def validate(self, value):
        return CHECKER.validate_metrics(value, "B", self.policy)

    def test_sealed_source_bound_policy(self):
        self.assertEqual(CHECKER.validate_policy(self.study, "jmdict", self.fixtures), self.policy)

    def test_disabled_and_unsealed_policy_fail_closed(self):
        for key in ("disabled", "unsealed", "null-other-corpus", "empty-other-corpus"):
            value = copy.deepcopy(self.study)
            if key == "disabled":
                value["acquisitionEnabled"] = False
            elif key == "unsealed":
                value["activation"]["sealed"] = False
            elif key == "null-other-corpus":
                value["activation"]["perCorpus"]["vndb"] = None
            else:
                value["activation"]["perCorpus"]["vndb"] = {}
            with self.subTest(key=key), self.assertRaises((CHECKER.ActivationError, KeyError)):
                CHECKER.validate_policy(value, "jmdict", self.fixtures)

    def test_proof_for_other_runtime_or_fixture_fails(self):
        for kind in ("runtime", "fixture", "not-parity"):
            value = copy.deepcopy(self.study)
            target = value["activation"]["perCorpus"]["jmdict"]
            if kind == "runtime":
                target["proof"]["runtimeSha256"][sorted(CHECKER.RUNTIME_PATHS)[0]] = "f" * 64
            elif kind == "fixture":
                target["fixtureSha256"] = "f" * 64
            else:
                target["proof"]["completeTermByteParity"] = False
            with self.subTest(kind=kind), self.assertRaises(CHECKER.ActivationError):
                CHECKER.validate_policy(value, "jmdict", self.fixtures)

    def test_complete_native_metrics(self):
        value = native_metrics()
        result = self.validate(value)
        self.assertEqual(result["readinessJavascriptCalls"], 0)
        self.assertEqual(result["nativeCallFraction"], 1)
        self.assertEqual(result["nativeRowFraction"], 1)
        self.assertEqual(result["metrics"], value)

    def test_natural_readiness_javascript_is_retained(self):
        value = native_metrics()
        value["javascriptCalls"] = 1
        value["native"].update(nativeCalls=1, nativeRows=100, nativeAttempts=1,
                               inputCopiedBytes=812, outputCopiedBytes=820, tableBytesRequested=1024)
        result = self.validate(value)
        self.assertEqual(result["readinessJavascriptCalls"], 1)
        self.assertEqual(result["metrics"]["javascriptCalls"], 1)

    def test_declared_fallback_is_retained_and_counted(self):
        for reason in CHECKER.ALLOWED_DECLINES:
            value = native_metrics()
            value["javascriptCalls"] = 1
            value["native"].update(nativeCalls=1, nativeRows=100, nativeAttempts=1,
                                   inputCopiedBytes=812, outputCopiedBytes=820, tableBytesRequested=1024,
                                   declines={reason: 1})
            if reason == "unsupported-compact":
                value["native"].update(nativeAttempts=2, inputCopiedBytes=1624, tableBytesRequested=2048)
            with self.subTest(reason=reason):
                result = self.validate(value)
                self.assertEqual(result["readinessJavascriptCalls"], 0)
                self.assertEqual(result["declaredFallbackCalls"], 1)

    def test_inactive_controls_have_no_session_metrics(self):
        for arm in ("A", "C"):
            self.assertFalse(CHECKER.validate_metrics(None, arm, self.policy)["nativeActivated"])
            with self.subTest(arm=arm), self.assertRaises(CHECKER.ActivationError):
                CHECKER.validate_metrics(native_metrics(), arm, self.policy)

    def test_zero_native_and_unready_candidate_fail(self):
        for value in (None, {"calls": 2, "javascriptCalls": 2, "native": None}):
            with self.subTest(value=value), self.assertRaises(CHECKER.ActivationError):
                self.validate(value)
        value = native_metrics()
        value["native"].update(nativeCalls=0, nativeRows=0)
        with self.assertRaises(CHECKER.ActivationError):
            self.validate(value)

    def test_calls_attempts_declines_and_coverage_reconcile(self):
        mutators = (
            lambda value: value.update(calls=3),
            lambda value: value.update(javascriptCalls=1),
            lambda value: value["native"].update(nativeAttempts=3),
            lambda value: value["native"].update(nativeRows=201),
            lambda value: value["native"].update(nativeRows=99),
            lambda value: value["native"].update(declines={"eligibility": 1}),
            lambda value: value["native"].update(declines={"unknown": 0}),
        )
        for index, mutate in enumerate(mutators):
            value = native_metrics()
            mutate(value)
            with self.subTest(index=index), self.assertRaises(CHECKER.ActivationError):
                self.validate(value)

    def test_all_failure_and_disable_reasons_are_rejected(self):
        for reason in CHECKER.FAILURE_DECLINES:
            value = native_metrics()
            value["native"]["declines"][reason] = 1
            with self.subTest(reason=reason), self.assertRaises(CHECKER.ActivationError):
                self.validate(value)

    def test_noninteger_boolean_negative_and_unsafe_counts_fail(self):
        for invalid in (True, -1, 1.0, 2 ** 53, float("inf")):
            value = native_metrics()
            value["native"]["nativeCalls"] = invalid
            with self.subTest(value=repr(invalid)), self.assertRaises(CHECKER.ActivationError):
                self.validate(value)

    def test_native_memory_and_complete_copy_bounds(self):
        mutations = (
            ("inputCopiedBytes", 1600), ("inputCopiedBytes", 1625),
            ("outputCopiedBytes", 1600), ("outputCopiedBytes", 2400),
            ("tableBytesRequested", 4), ("tableBytesRequested", 2049),
            ("memoryGrowthBytes", 0), ("maximumLinearMemoryBytes", 65536),
            ("maximumLinearMemoryBytes", CHECKER.MAXIMUM_MEMORY_BYTES + 65536),
            ("maximumScratchBytes", 65538), ("maximumScratchBytes", 1623),
        )
        for key, changed in mutations:
            value = native_metrics()
            value["native"][key] = changed
            with self.subTest(key=key, value=changed), self.assertRaises(CHECKER.ActivationError):
                self.validate(value)

    def test_shared_reference_columns_may_exceed_row_count(self):
        value = native_metrics()
        value["native"]["inputCopiedBytes"] = 100000
        self.assertTrue(self.validate(value)["nativeActivated"])

    def test_duplicate_finalization_wrong_dictionary_and_failure_rejected(self):
        value = raw_report(native_metrics())
        self.assertEqual(CHECKER.extract_activation(value, fixture("jmdict")), native_metrics())
        invalid = copy.deepcopy(value)
        timings = invalid["phases"][0]["data"]["importDebugHistory"][0]["importerPhaseTimings"]
        timings.append(copy.deepcopy(timings[0]))
        with self.assertRaises(CHECKER.ActivationError):
            CHECKER.extract_activation(invalid, fixture("jmdict"))
        invalid = copy.deepcopy(value)
        invalid["phases"][0]["data"]["dictionary"] = "VNDB"
        with self.assertRaises(CHECKER.ActivationError):
            CHECKER.extract_activation(invalid, fixture("jmdict"))
        invalid = copy.deepcopy(value)
        invalid["phases"][0]["data"]["importDebugHistory"][0]["importerPhaseTimings"][0]["details"]["ok"] = False
        with self.assertRaises(CHECKER.ActivationError):
            CHECKER.extract_activation(invalid, fixture("jmdict"))

    def test_both_fixed_timing_schedules_are_balanced(self):
        for order in ("AB", "BA"):
            sequence = CHECKER.timed_schedule(order)
            self.assertEqual(len(sequence), 68)
            self.assertEqual(len({row["id"] for row in sequence}), 68)
            self.assertEqual(CHECKER.Counter(row["kind"] for row in sequence), {"warmup": 4, "candidate": 48, "control": 16})
            self.assertEqual(CHECKER.Counter(row["arm"] for row in sequence if row["kind"] == "candidate"), {"A": 24, "B": 24})
            self.assertEqual("".join(row["arm"] for row in sequence[:2]), order)


class ReaderTests(unittest.TestCase):
    """Synthetic transport fixtures test traversal; common semantic code is not mocked as evidence."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.evidence = self.root / "evidence"
        self.repo.mkdir()
        self.evidence.mkdir()
        self.study = study()
        self.initial = "AB"
        self.semantic_calls = []

        def memory_schedule(replication):
            counts = {"A": 0, "B": 0}
            result = []
            for index, arm in enumerate("ABBA" if replication == 1 else "BAAB", 1):
                counts[arm] += 1
                result.append({"index": index, "arm": arm, "name": arm + str(counts[arm]), "pair": (index - 1) // 2 + 1})
            return result

        def validate(summary, raw, **arguments):
            self.semantic_calls.append(arguments)
            if summary.get("syntheticFailure"):
                raise ValueError("synthetic original semantic failure")
            return {"synthetic": "canonical"}

        def matching(reference, candidate, **arguments):
            CHECKER.same(reference, candidate, "Synthetic semantic difference")

        self.sources = ("test/perf/dictionaries.lock.json", "test/chromium/extension-two-dictionary-import.e2e.js",
                        "builds/manabitan-chrome.zip")
        self.modules = {
            "qualification_receipts": SimpleNamespace(SOURCE_HASH_FIELDS=self.sources, validate_import_summary=validate,
                                                       require_matching_receipts=matching),
            "protocol": SimpleNamespace(schedule=memory_schedule, memory_overlay=lambda value: value + "// markers\n"),
        }
        self.write(self.repo / "test/perf/dictionaries.lock.json",
                   {"dictionaries": {name: fixture(name) for name in CHECKER.DICTIONARIES}})
        harness = self.repo / "test/chromium/extension-two-dictionary-import.e2e.js"
        harness.parent.mkdir(parents=True, exist_ok=True)
        harness.write_text("// synthetic protected harness\n")
        memory = memory_schedule(1)
        self.write(self.evidence / "registered-plan.json", {
            "baseline": self.study["control"]["commit"], "candidate": self.study["candidate"]["commit"],
            "dictionary": "jmdict", "initialOrder": "AB", "pairs": 24, "flags": {},
            "schedule": CHECKER.timed_schedule("AB"), "memorySchedule": memory,
            "expectedPackageEntries": list(CHECKER.EXPECTED_PACKAGE_ENTRIES),
            "expectedWorkers": None, "vndbSahAllocationPolicy": None,
        })
        arms = {}
        for arm, name in (("A", "control"), ("B", "candidate")):
            entries = {path.removeprefix("ext/"): value for path, value in self.study["runtimeSha256"].items()}
            if arm == "A":
                for path in CHECKER.EXPECTED_PACKAGE_ENTRIES:
                    entries[path] = "d" * 64
            package = ("e" if arm == "A" else "f") * 64
            hashes = {path: CHECKER.sha256((self.repo / path).read_bytes()) for path in self.sources
                      if not path.startswith("builds/")}
            hashes["builds/manabitan-chrome.zip"] = package
            arms[arm] = {
                "sha": self.study[name]["commit"], "tree": self.study[name]["tree"],
                "packageSha256": package, "entries": entries, "sourceHashes": hashes,
                "fixtureLockSha256": hashes["test/perf/dictionaries.lock.json"],
            }
        self.write(self.evidence / "source-identities.json",
                   {"arms": arms, "changedPackageEntries": list(CHECKER.EXPECTED_PACKAGE_ENTRIES)})
        self.write(self.evidence / "browser-identity.json", {"version": "123.0.0.0"})
        (self.evidence / "memory").mkdir()
        (self.evidence / "memory/harness-original.js").write_text(harness.read_text())
        (self.evidence / "memory/harness-instrumented.js").write_text(harness.read_text() + "// markers\n")
        observations = [{"path": item["id"], "arm": item["arm"]} for item in CHECKER.timed_schedule("AB")]
        observations.extend({"path": "exhaustive-media-" + arm, "arm": arm} for arm in "AB")
        observations.extend({"path": "memory/" + item["name"], "arm": item["arm"]} for item in memory)
        for item in observations:
            folder = self.evidence / item["path"]
            self.write(folder / "run-1.json", raw_report(native_metrics() if item["arm"] == "B" else None))
            self.write(folder / "summary.json", {})
            self.write(folder / "canonical-receipt.json", {"synthetic": "canonical"})

    def tearDown(self):
        self.temp.cleanup()

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value) + "\n")

    def audit(self):
        return CHECKER.audit(self.study, self.evidence, "jmdict", self.initial, self.repo, self.modules)

    def test_all_74_reports_and_29_candidate_observations_are_read(self):
        before = {path: path.read_bytes() for path in self.evidence.rglob("*.json")}
        result = self.audit()
        self.assertTrue(result["passed"])
        self.assertEqual(len(result["observations"]), 74)
        self.assertEqual(len(self.semantic_calls), 74)
        self.assertEqual(result["registeredReportCounts"]["B"], 29)
        self.assertEqual(sum(bool(row.get("activation", {}).get("nativeActivated")) for row in result["observations"]), 29)
        self.assertEqual(before, {path: path.read_bytes() for path in self.evidence.rglob("*.json")})

    def test_missing_memory_report_is_retained_and_never_replaced(self):
        (self.evidence / "memory/B2/run-1.json").unlink()
        result = self.audit()
        self.assertFalse(result["passed"])
        self.assertEqual(len(result["observations"]), 74)
        self.assertEqual([row["path"] for row in result["failures"]], ["memory/B2"])
        self.assertFalse((self.evidence / "memory/B2/run-1.json").exists())

    def test_semantic_failure_does_not_hide_actual_activation(self):
        self.write(self.evidence / "pair-01-B/summary.json", {"syntheticFailure": True})
        result = self.audit()
        self.assertFalse(result["passed"])
        row = next(row for row in result["observations"] if row["path"] == "pair-01-B")
        self.assertTrue(row["activation"]["nativeActivated"])
        self.assertFalse(row["semanticReceiptValid"])
        self.assertEqual(len(result["observations"]), 74)

    def test_one_candidate_fallback_only_report_rejects_complete_cell(self):
        self.write(self.evidence / "exhaustive-media-B/run-1.json", raw_report(None))
        result = self.audit()
        self.assertFalse(result["passed"])
        self.assertEqual([row["path"] for row in result["failures"]], ["exhaustive-media-B"])
        row = next(row for row in result["observations"] if row["path"] == "exhaustive-media-B")
        self.assertIsNone(row["reportedMetrics"])

    def test_schedule_source_and_overlay_mismatches_fail(self):
        targets = (
            ("registered-plan.json", lambda value: value.update(pairs=12)),
            ("source-identities.json", lambda value: value["arms"]["B"].update(sha="f" * 40)),
            ("source-identities.json", lambda value: value["arms"]["B"]["entries"].update({"lib/term-record-fields.wasm": "0" * 64})),
        )
        for path, mutate in targets:
            original = (self.evidence / path).read_bytes()
            value = json.loads(original)
            mutate(value)
            self.write(self.evidence / path, value)
            with self.subTest(path=path), self.assertRaises(CHECKER.ActivationError):
                self.audit()
            (self.evidence / path).write_bytes(original)
        (self.evidence / "memory/harness-instrumented.js").write_text("not the pinned marker transform")
        with self.assertRaises(CHECKER.ActivationError):
            self.audit()

    def test_unsealed_other_corpus_blocks_reader(self):
        self.study["activation"]["perCorpus"]["vndb"] = None
        with self.assertRaises(CHECKER.ActivationError):
            self.audit()
        self.assertEqual(self.semantic_calls, [])

    def test_strict_json_rejects_duplicates_and_nonfinite_values(self):
        path = self.root / "invalid.json"
        for body in ('{"x":1,"x":2}', '{"x":NaN}', '{"x":1e999}'):
            path.write_text(body)
            with self.subTest(body=body), self.assertRaises(CHECKER.ActivationError):
                CHECKER.read_json(path)


class FixtureGuardTests(unittest.TestCase):
    """The full lock may cover other dictionaries; the study binds exactly its three inputs."""

    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location(
            "fields_source_fixture_guard", Path(__file__).with_name("verify-source.py"))
        cls.guard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.guard)

    def setUp(self):
        self.selected = {
            name: {**fixture(name), "metadata": {"entries": [name, "pinned"]}}
            for name in ("jmdict", "jitendex", "vndb")
        }
        self.lock = copy.deepcopy(self.selected)

    def test_exact_selected_metadata_passes_without_mutation(self):
        before = copy.deepcopy((self.lock, self.selected))
        self.guard.verify_fixture_metadata(self.lock, self.selected)
        self.assertEqual((self.lock, self.selected), before)

    def test_unrelated_fourth_lock_entry_does_not_expand_study(self):
        self.lock["jmnedict"] = {"sha256": "f" * 64, "termRows": 999}
        self.guard.verify_fixture_metadata(self.lock, self.selected)
        self.assertEqual(set(self.selected), {"jmdict", "jitendex", "vndb"})
        self.assertIn("jmnedict", self.lock)

    def test_each_selected_lock_entry_is_required(self):
        for name in self.selected:
            value = copy.deepcopy(self.lock)
            del value[name]
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, "Selected fixture missing"):
                self.guard.verify_fixture_metadata(value, self.selected)

    def test_each_selected_study_entry_is_required(self):
        for name in self.selected:
            value = copy.deepcopy(self.selected)
            del value[name]
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, "Study fixture key set"):
                self.guard.verify_fixture_metadata(self.lock, value)

    def test_extra_study_entry_is_rejected_even_when_present_in_lock(self):
        self.lock["jmnedict"] = {"sha256": "f" * 64}
        value = copy.deepcopy(self.selected)
        value["jmnedict"] = copy.deepcopy(self.lock["jmnedict"])
        with self.assertRaisesRegex(RuntimeError, "Study fixture key set"):
            self.guard.verify_fixture_metadata(self.lock, value)

    def test_any_selected_metadata_change_is_rejected(self):
        for name in self.selected:
            for change in ("digest", "rows", "nested", "extra"):
                value = copy.deepcopy(self.selected)
                if change == "digest":
                    value[name]["sha256"] = "f" * 64
                elif change == "rows":
                    value[name]["termRows"] += 1
                elif change == "nested":
                    value[name]["metadata"]["entries"][1] = "changed"
                else:
                    value[name]["unexpected"] = True
                with self.subTest(name=name, change=change), self.assertRaisesRegex(
                        RuntimeError, "Pinned selected fixture metadata"):
                    self.guard.verify_fixture_metadata(self.lock, value)

    def test_dictionary_containers_are_required(self):
        for value in (None, [], "jmdict", 3):
            for side in ("lock", "study"):
                args = (value, self.selected) if side == "lock" else (self.lock, value)
                with self.subTest(value=value, side=side), self.assertRaisesRegex(
                        RuntimeError, "Fixture dictionaries must be objects"):
                    self.guard.verify_fixture_metadata(*args)


if __name__ == "__main__":
    unittest.main()
