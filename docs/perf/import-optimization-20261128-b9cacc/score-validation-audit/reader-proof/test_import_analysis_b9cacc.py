"""Negative controls for the read-only import evidence auditor."""
import copy
import hashlib
import importlib.util
import io
import pathlib
import unittest
from unittest.mock import patch
import zipfile

PATH = pathlib.Path(__file__).with_name("import-analysis-b9cacc-v2.py")
SPEC = importlib.util.spec_from_file_location("frozen_import_reader", PATH)
reader = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reader)

def digest(value):
    return hashlib.sha256(value).hexdigest()

class PackageAuditTests(unittest.TestCase):
    def setUp(self):
        self.payloads = {
            "A": {"runtime.js": {"bytes": 3, "sha256": digest(b"old")}},
            "B": {"runtime.js": {"bytes": 3, "sha256": digest(b"new")},
                  "worker.js": {"bytes": 6, "sha256": digest(b"worker")}},
        }
        self.scope = patch.multiple(reader, EXPECTED_ENTRIES={"runtime.js"},
            EXPECTED_ADDED_ENTRIES={"worker.js"}, EXPECTED_RUNTIME_PAYLOADS=self.payloads)
        self.scope.start()
        self.addCleanup(self.scope.stop)

    def fixture(self, a=None, b=None):
        files = {
            "A": a if a is not None else [("runtime.js", b"old")],
            "B": b if b is not None else [("runtime.js", b"new"), ("worker.js", b"worker")],
        }
        outer, identities = io.BytesIO(), {"arms": {}}
        with zipfile.ZipFile(outer, "w") as archive:
            for arm in ("A", "B"):
                package = io.BytesIO()
                with zipfile.ZipFile(package, "w") as nested:
                    for name, data in files[arm]:
                        nested.writestr(name, data)
                raw = package.getvalue()
                archive.writestr(f"package-{arm}.zip", raw)
                identities["arms"][arm] = {"sha": arm * 40, "tree": arm.lower() * 40,
                    "packageSha256": digest(raw), "entries": {name: digest(data) for name, data in files[arm]}}
        outer.seek(0)
        archive = zipfile.ZipFile(outer)
        self.addCleanup(archive.close)
        return archive, identities

    def test_exact_nested_packages_pass(self):
        archive, identities = self.fixture()
        proof = reader.inspect_packages(archive, "", identities)
        self.assertEqual(proof["status"], "verified")
        self.assertEqual(proof["changedPackageEntries"], ["runtime.js"])
        self.assertEqual(proof["addedPackageEntries"], ["worker.js"])
        self.assertEqual(proof["removedPackageEntries"], [])

    def test_changed_zip_digest_is_rejected(self):
        archive, identities = self.fixture()
        identities["arms"]["B"]["packageSha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "nested package digest"):
            reader.inspect_packages(archive, "", identities)

    def test_fabricated_producer_member_map_is_rejected(self):
        archive, identities = self.fixture()
        identities["arms"]["B"]["entries"]["runtime.js"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "complete package member map"):
            reader.inspect_packages(archive, "", identities)

    def test_runtime_payload_source_binding_is_independent_of_producer_map(self):
        archive, identities = self.fixture(b=[("runtime.js", b"bad"), ("worker.js", b"worker")])
        with self.assertRaisesRegex(ValueError, "source-frozen runtime payload"):
            reader.inspect_packages(archive, "", identities)

    def test_duplicate_nested_member_is_rejected(self):
        archive, identities = self.fixture(b=[("runtime.js", b"new"), ("worker.js", b"worker"), ("worker.js", b"worker")])
        with self.assertRaisesRegex(ValueError, "Duplicate nested"):
            reader.inspect_packages(archive, "", identities)

    def test_undeclared_added_member_is_rejected(self):
        archive, identities = self.fixture(b=[("runtime.js", b"new"), ("worker.js", b"worker"), ("extra.js", b"x")])
        with self.assertRaisesRegex(ValueError, "nested added entries"):
            reader.inspect_packages(archive, "", identities)

    def test_declared_added_member_must_exist(self):
        archive, identities = self.fixture(b=[("runtime.js", b"new")])
        with self.assertRaises(ValueError):
            reader.inspect_packages(archive, "", identities)

    def test_removed_existing_member_is_rejected(self):
        archive, identities = self.fixture(a=[("runtime.js", b"old"), ("retained.js", b"keep")])
        with self.assertRaisesRegex(ValueError, "nested removed entries"):
            reader.inspect_packages(archive, "", identities)

class SourceAndCompletenessTests(unittest.TestCase):
    def setUp(self):
        self.experiment = copy.deepcopy(reader.CONFIG["experiments"]["parser-worker-bundle"])
        reader.configure(self.experiment)
        self.run_receipt = {"id": self.experiment["runId"], "head_sha": self.experiment["workflowHead"],
            "head_branch": self.experiment["sourceBranch"], "event": "push", "run_attempt": 1,
            "path": self.experiment["workflowPath"], "status": "completed", "conclusion": "success",
            "repository": {"id": 1165902460, "full_name": reader.REPOSITORY},
            "head_repository": {"id": 1165902460, "full_name": reader.REPOSITORY}}

    def test_distinct_workflow_and_runtime_heads_are_explicit(self):
        self.assertNotEqual(self.experiment["workflowHead"], self.experiment["candidate"])
        reader.require_run_identity(self.run_receipt)

    def test_runtime_sha_cannot_substitute_for_workflow_sha(self):
        self.run_receipt["head_sha"] = self.experiment["candidate"]
        with self.assertRaisesRegex(ValueError, "source run head_sha"):
            reader.require_run_identity(self.run_receipt)

    def test_second_source_attempt_is_rejected(self):
        self.run_receipt["run_attempt"] = 2
        with self.assertRaisesRegex(ValueError, "source run attempt"):
            reader.require_run_identity(self.run_receipt)

    def test_wrong_branch_is_rejected(self):
        self.run_receipt["head_branch"] = "develop"
        with self.assertRaisesRegex(ValueError, "source run head_branch"):
            reader.require_run_identity(self.run_receipt)

    def test_initial_reader_cannot_accept_twelve_pair_confirmation(self):
        self.experiment["pairs"] = 12
        with self.assertRaisesRegex(ValueError, "initial cohort pair count"):
            reader.configure(self.experiment)

    def test_missing_artifacts_fail_closed_without_waiting(self):
        def api(path):
            if path == f"/actions/runs/{self.experiment['runId']}":
                return self.run_receipt
            for arm, sha in (("A", self.experiment["baseline"]), ("B", self.experiment["candidate"])):
                if path == "/git/commits/" + sha:
                    return {"sha": sha, "tree": {"sha": self.experiment["expectedTrees"][arm]}}
            if "/artifacts?" in path:
                return {"total_count": 0, "artifacts": []}
            if "/jobs?" in path:
                return {"total_count": 0, "jobs": []}
            raise AssertionError("Unexpected API request " + path)
        with patch.object(reader, "api", side_effect=api), patch.object(reader.time, "sleep", side_effect=AssertionError("No polling")):
            result = reader.inspect_experiment("parser-worker-bundle", self.experiment)
        self.assertFalse(result["completeFrozenCohortAudited"])
        self.assertEqual(len(result["missingArtifacts"]), 6)
        self.assertEqual(result["cells"], [])

if __name__ == "__main__":
    unittest.main()
