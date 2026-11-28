#!/usr/bin/env python3
"""Synthetic records-reader regressions; no product, browser, import or timing execution."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

DIRECTORY = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("fields_browser_reader", DIRECTORY / "audit_fields_browser.py")
READER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(READER)
REPOSITORY = DIRECTORY.parents[2]


def manifest():
    artifacts = []
    for index, (kind, (dictionary, initial)) in enumerate(READER.CELLS.items(), 1):
        artifacts.append({
            "kind": kind, "id": index, "jobId": index + 20,
            "jobName": "Complete import (" + dictionary + ", " + initial + ")",
            "name": "native-record-fields-browser-" + kind + "-" + "b" * 40,
            "sizeBytes": 100, "sha256": "c" * 64, "expectedConclusion": "success",
        })
    return {
        "schemaVersion": 1, "repository": "ManabiIO/manabitan", "enabled": True,
        "upstream": {"commit": "dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16",
                     "tree": "d911260f1a57f518d59b3a12127fcc3b2293c918"},
        "cleanSources": {
            "control": {"commit": "1" * 40, "tree": "2" * 40},
            "candidate": {"commit": "3" * 40, "tree": "4" * 40},
        },
        "qualificationPolicy": copy.deepcopy(READER.POLICY),
        "publication": {
            "runId": 123, "headSha": "b" * 40, "headTree": "a" * 40,
            "headBranch": "perf/native-record-fields-browser-acquire-20261128-1c413",
            "runAttempt": 1, "event": "push", "workflowPath": READER.PRODUCER_WORKFLOW,
        },
        "expectedRunConclusion": "success",
        "study": {"path": READER.PRODUCER_PREFIX + "/study.json", "gitBlob": "d" * 40, "sha256": "e" * 64, "bytes": 100},
        "sourceManifest": {"path": READER.PRODUCER_PREFIX + "/source.json", "gitBlob": "f" * 40, "sha256": "a" * 64, "bytes": 100},
        "correctnessPrerequisite": {"reader": {"gitBlob": "f" * 40, "sha256": "a" * 64, "bytes": 100}, "manifest": {}},
        "artifacts": artifacts,
    }


class BoundaryTests(unittest.TestCase):
    def test_inert_manifest_rejects_before_any_api_or_original_read(self):
        with patch.object(READER, "GitHub", side_effect=AssertionError("network must not run")):
            with self.assertRaisesRegex(READER.AuditError, "Inert"):
                READER.validate_manifest({"schemaVersion": 1, "repository": "ManabiIO/manabitan", "enabled": False})

    def test_enabled_manifest_requires_exact_six_original_roles_and_first_attempt(self):
        value = manifest()
        self.assertIs(READER.validate_manifest(value), value)
        mutations = (
            lambda changed: changed["publication"].update(runAttempt=2),
            lambda changed: changed["upstream"].update(commit="develop"),
            lambda changed: changed["publication"].update(headBranch="replacement"),
            lambda changed: changed["artifacts"].pop(),
            lambda changed: changed["artifacts"][1].update(id=changed["artifacts"][0]["id"]),
            lambda changed: changed["artifacts"][1].update(jobId=changed["artifacts"][0]["jobId"]),
            lambda changed: changed["artifacts"][0].update(expectedConclusion="queued"),
            lambda changed: changed["qualificationPolicy"].update(targetFasterPairsAtLeast=17),
            lambda changed: changed.update(correctnessPrerequisite={"reader": None, "manifest": None}),
        )
        for mutate in mutations:
            changed = copy.deepcopy(value)
            mutate(changed)
            with self.subTest(mutate=repr(mutate)), self.assertRaises(READER.AuditError):
                READER.validate_manifest(changed)

    def test_api_original_run_job_heads_attempts_and_conclusions_are_bound(self):
        frozen = manifest()
        run = {
            "id": 123, "head_sha": "b" * 40, "head_branch": frozen["publication"]["headBranch"],
            "run_attempt": 1, "event": "push", "path": READER.PRODUCER_WORKFLOW,
            "status": "completed", "conclusion": "success",
        }
        jobs = {"total_count": 6, "jobs": [
            {"id": item["jobId"], "run_id": 123, "run_attempt": 1, "head_sha": "b" * 40,
             "name": item["jobName"], "status": "completed", "conclusion": item["expectedConclusion"]}
            for item in frozen["artifacts"]
        ]}
        self.assertEqual(len(READER.validate_original_jobs(run, jobs, frozen)), 6)
        for field, bad in (("run_attempt", 2), ("head_sha", "c" * 40), ("status", "in_progress"), ("conclusion", "failure")):
            changed = copy.deepcopy(jobs)
            changed["jobs"][0][field] = bad
            with self.subTest(field=field), self.assertRaises(READER.AuditError):
                READER.validate_original_jobs(run, changed, frozen)

    def test_immutable_reader_blob_requires_valid_digest_before_api_then_exact_bytes(self):
        data = b"immutable pure reader"
        identity = {"gitBlob": READER.git_blob(data), "sha256": READER.digest(data), "bytes": len(data)}
        api = SimpleNamespace(json=lambda *args: {
            "sha": identity["gitBlob"], "encoding": "base64", "size": len(data),
            "content": READER.base64.b64encode(data).decode(),
        })
        self.assertEqual(READER.verified_blob(api, identity, "synthetic"), data)
        with self.assertRaises(READER.AuditError):
            READER.verified_blob(api, {**identity, "sha256": "0" * 64}, "synthetic")
        no_api = SimpleNamespace(json=lambda *args: self.fail("Malformed identity must not reach API"))
        with self.assertRaises(READER.AuditError):
            READER.verified_blob(no_api, {**identity, "gitBlob": "../other"}, "synthetic")

    def test_standalone_correctness_reader_keeps_exact_neighbor_filenames(self):
        # Synthetic inert module only; no real correctness API or product executes.
        module_bytes = b"from pathlib import Path\ndef filename():\n    return Path(__file__).name\n"
        activation_bytes = b"# synthetic inert activation dependency\n"
        reader_identity = {"sha256": READER.digest(module_bytes)}
        with tempfile.TemporaryDirectory() as temporary, patch.dict(READER.sys.modules), \
                patch.object(READER, "ACTIVATION_SHA256", READER.digest(activation_bytes)):
            root = Path(temporary)
            module = READER.load_correctness_reader(module_bytes, reader_identity, activation_bytes, root / "trusted")
            self.assertEqual(module.filename(), "audit.py")
            self.assertEqual({path.name for path in (root / "trusted").iterdir() if path.is_file()},
                             {"audit.py", "transport.py", "field_activation.py"})
            self.assertEqual((root / "trusted/audit.py").read_bytes(), module_bytes)
            self.assertEqual((root / "trusted/field_activation.py").read_bytes(), activation_bytes)
            self.assertEqual((root / "trusted/transport.py").read_bytes(),
                             (DIRECTORY / "audit_transport.py").read_bytes())
            with self.assertRaisesRegex(READER.AuditError, "dependency"):
                READER.load_correctness_reader(module_bytes, reader_identity, b"changed", root / "rejected")

    def test_full_tree_delta_includes_added_removed_and_mode_changes(self):
        left = {"kept": {"sha": "a", "mode": "100644"}, "removed": {"sha": "b", "mode": "100644"},
                "mode": {"sha": "c", "mode": "100644"}}
        right = {"kept": {"sha": "a", "mode": "100644"}, "added": {"sha": "d", "mode": "100644"},
                 "mode": {"sha": "c", "mode": "100755"}}
        self.assertEqual(READER.tree_delta(left, right), ["added", "mode", "removed"])


class ReadinessBudgetTests(unittest.TestCase):
    def comparison(self):
        plan = {
            "groupCount": 2, "fieldCallCount": 4, "termRows": 100,
            "groups": [
                {"firstBank": 1, "rowCount": 30, "fieldCallOrdinals": [0, 1], "fieldCallRows": [10, 20]},
                {"firstBank": 3, "rowCount": 70, "fieldCallOrdinals": [2, 3], "fieldCallRows": [30, 40]},
            ],
        }
        return {"passed": True, "fieldCalls": 4, "sourceGroupFieldPlan": plan,
                "sourceGroupFieldPlanSha256": READER.digest(
                    json.dumps(plan, sort_keys=True, separators=(",", ":"), allow_nan=False).encode())}

    def derive(self, value):
        return READER.derive_readiness_budget(value, {"sha256": "c" * 64, "termRows": 100},
            SimpleNamespace(ALLOWED_DECLINES=("eligibility", "memory-bound", "unsupported-compact")))

    def test_complete_original_corpus_order_is_accepted_without_lexical_assumption(self):
        comparisons = [{"dictionary": name, "receipt": index}
                       for index, name in enumerate(("jmdict", "jitendex", "vndb"))]
        expected = {item["dictionary"]: item for item in comparisons}
        self.assertEqual(READER.corpus_comparisons_by_dictionary(comparisons), expected)
        self.assertEqual(READER.corpus_comparisons_by_dictionary(list(reversed(comparisons))), expected)
        with self.assertRaisesRegex(READER.AuditError, "Complete"):
            READER.corpus_comparisons_by_dictionary(comparisons[:2] + [comparisons[0]])
        with self.assertRaisesRegex(READER.AuditError, "Complete"):
            READER.corpus_comparisons_by_dictionary(comparisons[:2])

    def test_first_source_group_budget_keeps_all_of_its_split_field_calls(self):
        result = self.derive(self.comparison())
        self.assertEqual(result, {
            "fixtureSha256": "c" * 64, "termRows": 100, "expectedCalls": 4,
            "minimumNativeCalls": 2, "minimumNativeRows": 70, "maximumReadinessJavascriptCalls": 2,
            "allowedDeclineMaximums": {"eligibility": 0, "memory-bound": 0, "unsupported-compact": 0},
        })

    def test_changed_plan_hash_or_nonprefix_allowance_fails_closed(self):
        value = self.comparison()
        value["sourceGroupFieldPlan"]["groups"][0]["fieldCallRows"] = [15, 15]
        with self.assertRaisesRegex(READER.AuditError, "identity"):
            self.derive(value)
        value = self.comparison()
        value["sourceGroupFieldPlan"]["groups"][0]["fieldCallOrdinals"] = [1, 2]
        value["sourceGroupFieldPlanSha256"] = READER.digest(json.dumps(
            value["sourceGroupFieldPlan"], sort_keys=True, separators=(",", ":"), allow_nan=False).encode())
        with self.assertRaisesRegex(READER.AuditError, "prefix"):
            self.derive(value)

    def test_failure_or_whole_corpus_startup_allowance_cannot_be_a_budget(self):
        value = self.comparison()
        value["passed"] = False
        with self.assertRaisesRegex(READER.AuditError, "passing"):
            self.derive(value)
        value = self.comparison()
        value["sourceGroupFieldPlan"] = {
            "groupCount": 1, "fieldCallCount": 4, "termRows": 100,
            "groups": [{"firstBank": 1, "rowCount": 100, "fieldCallOrdinals": [0, 1, 2, 3],
                        "fieldCallRows": [10, 20, 30, 40]}],
        }
        value["sourceGroupFieldPlanSha256"] = READER.digest(json.dumps(
            value["sourceGroupFieldPlan"], sort_keys=True, separators=(",", ":"), allow_nan=False).encode())
        with self.assertRaisesRegex(READER.AuditError, "zero native"):
            self.derive(value)


class ArchiveTests(unittest.TestCase):
    def test_every_nonpackage_member_and_every_nested_package_byte_is_retained(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            outer = root / "original.zip"
            nested = io.BytesIO()
            with zipfile.ZipFile(nested, "w") as package:
                package.writestr("js/example.js", b"original source\n")
                package.writestr("lib/example.wasm", bytes(range(256)))
            with zipfile.ZipFile(outer, "w") as archive:
                archive.writestr(READER.CELL_DIRECTORY + "/package-A.zip", nested.getvalue())
                archive.writestr(READER.CELL_DIRECTORY + "/package-B.zip", nested.getvalue())
                archive.writestr("metadata/.hidden.txt", b"retained original")
                archive.writestr("metadata/failed.json", '{"passed":false,"value":7}\n')
            output = root / "audit"
            output.mkdir()
            extracted, packages, inventory = READER.unpack_artifact(outer, output)
            self.assertEqual(set(packages), {"A", "B"})
            self.assertEqual(packages["A"]["entries"], packages["B"]["entries"])
            self.assertEqual((extracted / "metadata/.hidden.txt").read_bytes(), b"retained original")
            self.assertEqual(READER.read_json(extracted / "metadata/failed.json"), {"passed": False, "value": 7})
            self.assertEqual(len(inventory), 4)
            self.assertTrue(outer.exists())

    def test_unexpected_nested_archive_rejects_without_deleting_original_bytes(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            outer = root / "original.zip"
            with zipfile.ZipFile(outer, "w") as archive:
                archive.writestr("unexpected.tar.gz", b"not silently skipped")
            original = outer.read_bytes()
            output = root / "audit"
            output.mkdir()
            with self.assertRaisesRegex(READER.AuditError, "Unexpected nested"):
                READER.unpack_artifact(outer, output)
            self.assertEqual(outer.read_bytes(), original)
            self.assertTrue((output / "outer-member-inventory.json").exists())

    def test_partial_preflight_artifact_keeps_its_failure_without_inventing_packages(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            outer = root / "original.zip"
            with zipfile.ZipFile(outer, "w") as archive:
                archive.writestr(READER.METADATA_DIRECTORY + "/source-before-setup.json", '{"passed":false}\n')
            output = root / "audit"
            output.mkdir()
            extracted, packages, _ = READER.unpack_artifact(outer, output)
            self.assertEqual(packages, {})
            self.assertEqual(READER.read_json(extracted / READER.METADATA_DIRECTORY / "source-before-setup.json"), {"passed": False})


class ObservationRetentionTests(unittest.TestCase):
    """Stubs isolate traversal and failure retention; they are not semantic or corpus proof."""
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        self.extracted = self.base / "extracted"
        self.root = self.extracted / READER.CELL_DIRECTORY
        self.metadata = self.extracted / READER.METADATA_DIRECTORY
        self.root.mkdir(parents=True)
        self.metadata.mkdir(parents=True)
        self.initial = "AB"
        self.sequence = READER.frozen_schedule(self.initial)
        self.harness = (REPOSITORY / READER.HARNESS).read_bytes()
        protocol_path = REPOSITORY / READER.MEMORY_DIRECTORY / "protocol.py"
        protocol_spec = importlib.util.spec_from_file_location("synthetic_fields_protocol", protocol_path)
        protocol = importlib.util.module_from_spec(protocol_spec)
        protocol_spec.loader.exec_module(protocol)
        self.protocol = protocol
        self.memory_schedule = protocol.schedule(1)
        self.overlay = protocol.memory_overlay(self.harness.decode())
        self.study = {"upstream": manifest()["upstream"], "control": {"commit": "1" * 40},
                      "candidate": {"commit": "3" * 40}}
        self.identities = {"arms": {
            arm: {"sha": str(index) * 40, "packageSha256": str(index) * 64,
                  "sourceHashes": {READER.HARNESS: READER.digest(self.harness)}}
            for index, arm in enumerate("AB", 1)
        }}
        self.cell = next(item for item in manifest()["artifacts"] if item["kind"] == "jmdict-AB")
        self.api = SimpleNamespace(source=lambda commit, path: self.harness)
        self.original_receipt = {"synthetic": "same"}
        self.semantic_calls = []

        def validate(summary, report, **arguments):
            self.semantic_calls.append(arguments)
            if report.get("syntheticSemanticFailure"):
                raise ValueError("synthetic original semantic failure")
            return dict(self.original_receipt)

        def matching(left, right, **arguments):
            if left != right:
                raise ValueError("synthetic original receipt difference")

        modules = {
            "protocol": protocol,
            "qualification_receipts": SimpleNamespace(validate_import_summary=validate, require_matching_receipts=matching),
        }
        self.locations = [(item["id"], item["arm"], item) for item in self.sequence]
        self.locations += [("exhaustive-media-" + arm, arm, None) for arm in "AB"]
        self.locations += [("memory/" + item["name"], item["arm"], None) for item in self.memory_schedule]
        self.recorded = []
        for location, arm, scheduled in self.locations:
            duration = 97.0 if arm == "B" else 100.0
            self.write(self.root / location / "summary.json", {"runs": [{"totalImportMs": duration}]})
            self.write(self.root / location / "run-1.json", {"synthetic": True})
            self.write(self.root / location / "canonical-receipt.json", self.original_receipt)
            if scheduled is not None:
                self.recorded.append({**scheduled, "totalImportMs": duration})
        self.write(self.root / "observations.json", self.recorded)
        self.write(self.root / "registered-plan.json", {
            "baseline": self.study["control"]["commit"], "candidate": self.study["candidate"]["commit"],
            "dictionary": "jmdict", "initialOrder": "AB", "pairs": 24, "flags": {}, "schedule": self.sequence,
            "mediaCheck": "sample per timed observation; separate all-media verification after timing",
            "failurePolicy": "Stop on first failed observation; retain all completed and failed evidence",
            "memoryPolicy": "Separate instrumented A/B observations after all timing and media verification",
            "sourceBoundary": "Each revision built independently before timing; no product or harness overlays",
            "expectedPackageEntries": READER.PACKAGE_ENTRIES, "expectedWorkers": None,
            "vndbSahAllocationPolicy": None, "memorySchedule": self.memory_schedule,
            "statistics": "Per-host paired median and equal-work ratios; descriptive percentile bootstrap interval of paired median, 10000 complete-pair resamples, seed 897. No pooling hosts or timing from instrumented runs.",
        })
        self.write(self.root / "browser-identity.json", {"version": "123.0.0.0", "versionOutput": "Chromium 123.0.0.0", "sha256": "a" * 64})
        memory_root = self.root / "memory"
        (memory_root / "harness-original.js").write_bytes(self.harness)
        (memory_root / "harness-instrumented.js").write_text(self.overlay)
        self.write(memory_root / "plan.json", {
            "schedule": self.memory_schedule, "replication": 1, "dictionary": "jmdict",
            "authoritativeTiming": False, "sourceHashes": self.identities["arms"],
            "overlaySha256": READER.digest(self.overlay.encode()),
        })
        self.memory_result = {
            "passed": True, "comparison": {"synthetic": True}, "audit": {"synthetic": True},
            "auditFailure": None, "semanticFailures": [],
            "observations": [{**item, "allObservedSampleCount": 5, "stableFullyReadImportSampleCount": 4,
                              "qualifiedForWholeTreePss": True, "qualificationFailures": [],
                              "maxSampledPssKiB": 100, "maxSampledPrivateKiB": 90}
                             for item in self.memory_schedule],
        }
        self.activation_result = {
            "passed": True, "observations": [{"path": location, "synthetic": True}
                                           for location, _, _ in self.locations],
        }
        self.study_bytes = b"synthetic immutable study"
        self.activation_bytes = b"synthetic immutable checker"
        self.write(self.metadata / "activation.json", {
            **self.activation_result,
            "studyFile": {"bytes": len(self.study_bytes), "sha256": READER.digest(self.study_bytes)},
            "checkerFile": {"bytes": len(self.activation_bytes), "sha256": READER.digest(self.activation_bytes)},
        })
        self.namespace = READER.load_paired_summary((REPOSITORY / READER.QUALIFIER).read_bytes())
        self.context = {
            "study": self.study, "modules": modules, "trees": {}, "namespace": self.namespace,
            "fixtures": {"jmdict": {"synthetic": True}},
            "activation": SimpleNamespace(audit=lambda *args: copy.deepcopy(self.activation_result)),
            "originalRepository": self.base,
            "studyBytes": self.study_bytes, "activationBytes": self.activation_bytes,
        }
        self.write_analysis()
        self.patches = [
            patch.object(READER, "verify_metadata", return_value={"allRequiredStepsSucceeded": True}),
            patch.object(READER, "verify_packages", return_value=self.identities),
            patch.object(READER, "audit_recorded_memory", side_effect=lambda *args: copy.deepcopy(self.memory_result)),
        ]
        for value in self.patches:
            value.start()

    def tearDown(self):
        for value in reversed(self.patches):
            value.stop()
        self.temporary.cleanup()

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, sort_keys=True, allow_nan=False) + "\n")

    def write_analysis(self):
        candidate = READER.independent_contrast(self.recorded, "candidate", "A", "B")
        controls = READER.independent_contrast(self.recorded, "control", "A", "C")
        passed = self.memory_result["passed"]
        self.write(self.root / "analysis.json", {
            "status": "correctness-memory-passed" if passed else "memory-or-semantics-failed",
            "candidateVsBaseline": candidate, "identicalCodeControl": controls, "memoryPassed": passed,
            "timingInterpretation": "Descriptive paired comparison only. A passing correctness/memory status is not a latency or speedup claim.",
            "timingScope": "File input change through post-UI completion; fresh profile per observation",
            "limits": "One host/cohort only; independent opposite-order replication required. Memory observations remain separate.",
        })

    def audit(self):
        output = self.base / "audit"
        output.mkdir()
        return READER.audit_browser(self.extracted, {}, self.cell, {}, self.api, self.context,
                                    manifest(), output, True)

    def test_all_74_original_rows_and_complete_contrasts_survive_without_mutation(self):
        before = {str(path.relative_to(self.extracted)): path.read_bytes() for path in self.extracted.rglob("*") if path.is_file()}
        result = self.audit()
        self.assertTrue(result["evidenceValidated"])
        self.assertTrue(result["qualification"]["passesCellPolicy"])
        self.assertEqual(len(result["allOriginalObservations"]), 74)
        self.assertEqual(len(result["acceptedTimingObservations"]), 68)
        self.assertEqual(len(self.semantic_calls), 74)
        self.assertEqual(result["candidateVsBaseline"]["count"], 24)
        self.assertEqual(result["identicalCodeControl"]["count"], 8)
        self.assertEqual(sum(row["includedInContrasts"] for row in result["allOriginalObservations"]), 64)
        self.assertEqual(before, {str(path.relative_to(self.extracted)): path.read_bytes()
                                  for path in self.extracted.rglob("*") if path.is_file()})

    def test_missing_memory_original_is_retained_as_failed_row_with_complete_timing(self):
        missing = self.root / "memory/B2/run-1.json"
        missing.unlink()
        result = self.audit()
        self.assertFalse(result["evidenceValidated"])
        self.assertFalse(result["qualification"]["passesCellPolicy"])
        self.assertEqual(len(result["allOriginalObservations"]), 74)
        self.assertEqual(result["candidateVsBaseline"]["count"], 24)
        row = next(row for row in result["allOriginalObservations"] if row["path"] == "memory/B2")
        self.assertTrue(row["failures"])
        self.assertFalse(missing.exists())

    def test_late_strict_memory_failure_retains_all_timings_but_never_qualifies(self):
        self.memory_result["passed"] = False
        self.memory_result["auditFailure"] = {"type": "ValueError", "message": "synthetic original strict failure"}
        self.write_analysis()
        result = self.audit()
        self.assertTrue(result["evidenceValidated"])
        self.assertFalse(result["qualification"]["passesCellPolicy"])
        self.assertEqual(result["candidateVsBaseline"]["count"], 24)
        self.assertEqual(result["memory"]["auditFailure"], self.memory_result["auditFailure"])

    def test_original_activation_failure_is_reported_without_excluding_candidate_pairs(self):
        self.activation_result["passed"] = False
        self.write(self.metadata / "activation.json", {
            **self.activation_result,
            "studyFile": {"bytes": len(self.study_bytes), "sha256": READER.digest(self.study_bytes)},
            "checkerFile": {"bytes": len(self.activation_bytes), "sha256": READER.digest(self.activation_bytes)},
        })
        result = self.audit()
        self.assertTrue(result["evidenceValidated"])
        self.assertFalse(result["qualification"]["passesCellPolicy"])
        self.assertEqual(result["candidateVsBaseline"]["count"], 24)

    def test_mismatched_original_activation_receipt_fails_integrity(self):
        original = READER.read_json(self.metadata / "activation.json")
        original["passed"] = False
        self.write(self.metadata / "activation.json", original)
        result = self.audit()
        self.assertFalse(result["evidenceValidated"])
        self.assertTrue(any(row["stage"] == "original-activation-receipt" for row in result["integrityFailures"]))
        self.assertEqual(len(result["allOriginalObservations"]), 74)

    def test_nonmemory_semantic_failure_is_retained_and_cannot_form_complete_pairs(self):
        self.write(self.root / "pair-01-B/run-1.json", {"syntheticSemanticFailure": True})
        result = self.audit()
        self.assertFalse(result["evidenceValidated"])
        self.assertIsNone(result["candidateVsBaseline"])
        row = next(row for row in result["allOriginalObservations"] if row["path"] == "pair-01-B")
        self.assertEqual(row["recordedTotalImportMs"], 97.0)
        self.assertFalse(row["includedInContrasts"])
        self.assertTrue(row["failures"])


if __name__ == "__main__":
    unittest.main()
