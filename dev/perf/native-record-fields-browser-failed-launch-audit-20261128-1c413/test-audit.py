#!/usr/bin/env python3
"""Pure synthetic tests; no product, network, browser or imports are executed."""
import base64
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

import audit as AUDIT


def fixture_receipts(kind="jmdict-AB"):
    dictionary, order = kind.split("-")
    source = {
        "schemaVersion": 1, "passed": False, "phase": "launch", "studyHead": AUDIT.HEAD,
        "error": "RuntimeError('Pinned fixture metadata changed')",
        "timingAcquired": False, "productExecuted": False,
    }
    activation = {
        "schemaVersion": 1, "passed": False, "observations": [],
        "checkerFile": AUDIT.CHECKER_IDENTITY, "studyFile": AUDIT.STUDY_IDENTITY,
        "failure": {
            "type": "FileNotFoundError",
            "error": "[Errno 2] No such file or directory: 'builds/perf/native-record-fields-browser-cell/registered-plan.json'",
        },
        "scope": "No acquisition; disabled/unsealed or incomplete original evidence fails closed",
    }
    outcomes = {
        "cellComplete": False, "dictionary": dictionary, "initialOrder": order,
        "numericQualificationDecided": False, "runAttempt": "1",
        "required": list(AUDIT.STEP_OUTCOMES), "failed": list(AUDIT.STEP_OUTCOMES),
        "steps": {name: {"outcome": value, "conclusion": value}
                  for name, value in AUDIT.STEP_OUTCOMES.items()},
    }
    return source, activation, outcomes


def payloads(kind="jmdict-AB"):
    source, activation, outcomes = fixture_receipts(kind)
    result = {name: ("immutable synthetic source " + name).encode() for name in AUDIT.SOURCE_PATHS}
    for name, value in (("source-before-setup.json", source), ("activation.json", activation),
                        ("step-outcomes.json", outcomes)):
        result[AUDIT.METADATA + "/" + name] = (json.dumps(value, sort_keys=True) + "\n").encode()
    result[AUDIT.METADATA + "/source-before-setup.log"] = (
        json.dumps(source, sort_keys=True) + "\nTraceback: retained original guard failure\n").encode()
    result[AUDIT.METADATA + "/activation.log"] = (
        json.dumps(activation, sort_keys=True) + "\nTraceback: retained absent-plan failure\n").encode()
    return result


def write_payloads(root, values):
    for name, data in values.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def original_api(manifest):
    run = {
        "id": AUDIT.RUN, "head_sha": AUDIT.HEAD, "head_branch": AUDIT.BRANCH, "run_attempt": 1,
        "event": "push", "path": AUDIT.WORKFLOW, "status": "completed", "conclusion": "failure",
    }
    jobs = {"total_count": 6, "jobs": []}
    for entry in manifest["artifacts"]:
        jobs["jobs"].append({
            "id": entry["jobId"], "run_id": AUDIT.RUN, "head_sha": AUDIT.HEAD, "run_attempt": 1,
            "name": entry["jobName"], "status": "completed", "conclusion": "failure",
            "steps": [{"name": name, "conclusion": outcome} for name, outcome in AUDIT.STEP_NAMES.items()],
        })
    return run, jobs


class FailureReaderTests(unittest.TestCase):
    def setUp(self):
        self.manifest = AUDIT.read_json(Path(__file__).with_name("manifest.json"))

    def test_exact_frozen_manifest_and_original_api(self):
        AUDIT.validate_manifest(self.manifest)
        run, jobs = original_api(self.manifest)
        self.assertEqual(len(AUDIT.validate_original_api(run, jobs, self.manifest)), 6)

    def test_inert_changed_attempt_and_incomplete_original_manifest_fail(self):
        for change in (
            {"enabled": False}, {"expectedRunConclusion": "success"},
            {"publication": {**self.manifest["publication"], "runAttempt": 2}},
            {"publication": {**self.manifest["publication"], "headSha": "0" * 40}},
            {"artifacts": self.manifest["artifacts"][:-1]},
            {"archiveSources": {}},
        ):
            with self.subTest(change=change), self.assertRaises(AUDIT.AuditError):
                AUDIT.validate_manifest({**self.manifest, **change})
        value = deepcopy(self.manifest)
        value["artifacts"][1]["jobId"] = value["artifacts"][0]["jobId"]
        with self.assertRaises(AUDIT.AuditError):
            AUDIT.validate_manifest(value)

    def test_executed_acquisition_or_different_failure_is_not_zero_acquisition(self):
        run, jobs = original_api(self.manifest)
        for name, new_outcome in (
            ("Acquire the original frozen comparisons and separate media and memory checks", "success"),
            ("Prepare exact Node and locked dependencies", "success"),
            ("Bind original attempt, immutable source and completed prerequisites", "success"),
            ("Preserve every original report, package, source proof and failure", "failure"),
        ):
            changed = deepcopy(jobs)
            next(step for step in changed["jobs"][0]["steps"] if step["name"] == name)["conclusion"] = new_outcome
            with self.subTest(name=name), self.assertRaises(AUDIT.AuditError):
                AUDIT.validate_original_api(run, changed, self.manifest)
        changed = deepcopy(jobs)
        changed["jobs"][0]["steps"].append({"name": "Unexpected earlier failure", "conclusion": "failure"})
        with self.assertRaises(AUDIT.AuditError):
            AUDIT.validate_original_api(run, changed, self.manifest)

    def test_closed_member_set_rejects_any_report_plan_or_package(self):
        names = sorted(AUDIT.SOURCE_PATHS | AUDIT.METADATA_PATHS)
        AUDIT.validate_members(names)
        for extra in (
            "builds/perf/native-record-fields-browser-cell/registered-plan.json",
            "builds/perf/native-record-fields-browser-cell/pair-01-A/summary.json",
            "builds/perf/native-record-fields-browser-cell/package-A.zip",
        ):
            with self.subTest(extra=extra), self.assertRaises(AUDIT.AuditError):
                AUDIT.validate_members(names + [extra])
        with self.assertRaises(AUDIT.AuditError):
            AUDIT.validate_members(names[:-1])
        with self.assertRaises(AUDIT.AuditError):
            AUDIT.validate_members(names[:-1] + [names[0]])

    def test_original_zip_is_fully_hashed_and_extracted(self):
        values = payloads()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "original.zip"
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
                for name, data in values.items():
                    output.writestr(name, data)
            inventory = AUDIT.extract_original(archive, root / "members")
            self.assertEqual(len(inventory), 13)
            self.assertEqual({item["path"]: item["sha256"] for item in inventory},
                             {name: AUDIT.digest(data) for name, data in values.items()})
            self.assertTrue(archive.exists())
            for name, data in values.items():
                self.assertEqual((root / "members" / name).read_bytes(), data)

    def test_unsafe_zip_member_is_rejected_before_extraction(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "original.zip"
            with zipfile.ZipFile(archive, "w") as output:
                for name, data in payloads().items():
                    output.writestr(name, data)
                output.writestr("../outside.txt", b"must not escape")
            with self.assertRaises(AUDIT.AuditError):
                AUDIT.extract_original(archive, root / "members")
            self.assertFalse((root / "outside.txt").exists())

    def test_exact_failed_receipts_remain_failed_and_empty(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_payloads(root, payloads())
            result = AUDIT.verify_failure_receipts(root, "jmdict-AB")
            self.assertFalse(result["source"]["passed"])
            self.assertFalse(result["activation"]["passed"])
            self.assertEqual(result["activation"]["observations"], [])
            self.assertFalse(result["outcome"]["cellComplete"])

    def test_source_guard_success_or_execution_flags_are_rejected(self):
        for change in ({"passed": True}, {"timingAcquired": True}, {"productExecuted": True},
                       {"error": "Unrelated failure"}, {"studyHead": "0" * 40}):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                write_payloads(root, payloads())
                path = root / AUDIT.METADATA / "source-before-setup.json"
                AUDIT.write_json(path, {**AUDIT.read_json(path), **change})
                with self.assertRaises(AUDIT.AuditError):
                    AUDIT.verify_failure_receipts(root, "jmdict-AB")

    def test_any_observation_or_different_activation_failure_rejects_zero_claim(self):
        for change in ({"passed": True}, {"observations": [{"path": "warmup-1-A"}]},
                       {"failure": {"type": "RuntimeError", "error": "different"}},
                       {"studyFile": {"bytes": 1, "sha256": "0" * 64}}):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                write_payloads(root, payloads())
                path = root / AUDIT.METADATA / "activation.json"
                AUDIT.write_json(path, {**AUDIT.read_json(path), **change})
                with self.assertRaises(AUDIT.AuditError):
                    AUDIT.verify_failure_receipts(root, "jmdict-AB")

    def test_changed_missing_or_nonempty_outcome_cannot_pass(self):
        for change in ({"cellComplete": True}, {"numericQualificationDecided": True},
                       {"runAttempt": "2"}, {"failed": []}, {"steps": {}}, {"dictionary": "vndb"}):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                write_payloads(root, payloads())
                path = root / AUDIT.METADATA / "step-outcomes.json"
                AUDIT.write_json(path, {**AUDIT.read_json(path), **change})
                with self.assertRaises(AUDIT.AuditError):
                    AUDIT.verify_failure_receipts(root, "jmdict-AB")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_payloads(root, payloads())
            (root / AUDIT.METADATA / "activation.json").unlink()
            with self.assertRaises(FileNotFoundError):
                AUDIT.verify_failure_receipts(root, "jmdict-AB")

    def test_log_equality_and_unique_timestamped_json(self):
        source, _, _ = fixture_receipts()
        line = json.dumps(source, sort_keys=True)
        self.assertEqual(AUDIT.one_json("\ufeff2026-11-28T10:37:51Z " + line + "\n", "phase"), source)
        for log in (line + "\n" + line, "no JSON"):
            with self.subTest(log=log), self.assertRaises(AUDIT.AuditError):
                AUDIT.one_json(log, "phase")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_payloads(root, payloads())
            path = root / AUDIT.METADATA / "source-before-setup.log"
            path.write_text(json.dumps({**source, "passed": True}) + "\n")
            with self.assertRaises(AUDIT.AuditError):
                AUDIT.verify_failure_receipts(root, "jmdict-AB")

    def test_complete_synthetic_cell_can_only_verify_original_failure(self):
        values = payloads()
        source, activation, outcomes = fixture_receipts()
        log = "\n".join("2026-11-28T10:37:51Z " + json.dumps(item, sort_keys=True)
                        for item in (source, activation, outcomes)) + "\n"
        log_bytes = log.encode()
        manifest = {"publication": self.manifest["publication"], "archiveSources": {
            name: {"gitBlob": AUDIT.git_blob(values[name]), "bytes": len(values[name]),
                   "sha256": AUDIT.digest(values[name])} for name in AUDIT.SOURCE_PATHS
        }}
        entry = {
            "kind": "jmdict-AB", "id": 1, "jobId": 2,
            "originalJobLog": {"gitBlob": AUDIT.git_blob(log_bytes), "bytes": len(log_bytes),
                               "sha256": AUDIT.digest(log_bytes)},
        }
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            class FakeApi:
                def artifact(self, expected, publication, destination):
                    path = destination / "original.zip"
                    with zipfile.ZipFile(path, "w") as output:
                        for name, data in values.items():
                            output.writestr(name, data)
                    return path, {"id": 1}
                def source(self, commit, name):
                    return values[name]
                def json(self, suffix, label):
                    return {"sha": AUDIT.git_blob(log_bytes), "encoding": "base64",
                            "content": base64.b64encode(log_bytes).decode()}
            result = AUDIT.audit_cell(FakeApi(), entry, manifest, {"id": 2}, root / "cell")
            self.assertTrue(result["auditPassed"])
            self.assertTrue(result["verifiedZeroAcquisition"])
            self.assertEqual(result["originalReportCount"], 0)
            self.assertFalse(result["originalCellPassed"])
            self.assertFalse(result["qualificationPassed"])
            self.assertTrue((root / "cell" / "original.zip").is_file())
            self.assertEqual((root / "cell" / "original-job.log").read_bytes(), log_bytes)


if __name__ == "__main__":
    unittest.main()
