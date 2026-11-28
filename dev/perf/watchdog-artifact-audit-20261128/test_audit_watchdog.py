"""Pure archive, identity and analysis tests; no network or benchmark acquisition."""
from copy import deepcopy
import hashlib
import io
from pathlib import Path
import tempfile
import sys
import types
import unittest
from unittest.mock import patch
import urllib.error
import zipfile

from audit_transport import AuditError, GitHub, inspect_zip, parse_json, read_json, safe_name
import audit_watchdog as audit


class Entries:
    def __init__(self, entries):
        self.entries = entries

    def infolist(self):
        return self.entries


def manifest():
    return read_json(Path(__file__).with_name("manifest.json"))


def observations(order="AB"):
    return [{**row, "totalImportMs": 95 if row["arm"] == "B" else 100}
            for row in audit.frozen_schedule(order)]


def source_publication():
    value = manifest()
    run = {"id": audit.RUN_ID, "head_sha": audit.CANDIDATE, "head_branch": audit.BRANCH,
           "run_attempt": 1, "event": "push", "path": audit.WORKFLOW,
           "status": "completed", "conclusion": "success"}
    jobs = {"total_count": 3, "jobs": [
        {"id": item["jobId"], "name": item["jobName"], "run_id": audit.RUN_ID,
         "run_attempt": 1, "head_sha": audit.CANDIDATE, "status": "completed", "conclusion": "success"}
        for item in value["artifacts"]]}
    return value, run, jobs


class AnalysisTests(unittest.TestCase):
    def test_exact_schedules_include_every_original_row(self):
        for order in ("AB", "BA"):
            rows = audit.frozen_schedule(order)
            self.assertEqual(len(rows), 36)
            self.assertEqual(len({row["id"] for row in rows}), 36)
            self.assertEqual([row["arm"] for row in rows[:4]], list(order + order[::-1]))
            self.assertEqual([row["arm"] for row in rows[10:12]], list("AC" if order == "AB" else "CA"))
            self.assertEqual(sum(row["kind"] == "candidate" for row in rows), 24)
            self.assertEqual(sum(row["kind"] == "control" for row in rows), 8)

    def test_pinned_function_isolation_and_independent_bootstrap(self):
        root = Path(__file__).resolve().parents[3]
        namespace = audit.load_paired_summary((root / audit.QUALIFIER).read_bytes())
        self.assertNotIn("parser", namespace)
        self.assertNotIn("run_with_sampling", namespace)
        for order in ("AB", "BA"):
            rows = observations(order)
            namespace["observations"] = rows
            for kind, right in (("candidate", "B"), ("control", "C")):
                self.assertEqual(namespace["paired_summary"](kind, "A", right),
                                 audit.independent_contrast(rows, kind, "A", right))
        with self.assertRaises(AuditError):
            audit.load_paired_summary(b"raise RuntimeError('must not execute')")

    def test_missing_duplicate_boolean_and_nonfinite_durations_fail(self):
        rows = observations()
        for changed in (
            [row for row in rows if row["id"] != "pair-01-A"],
            rows + [next(row for row in rows if row["id"] == "pair-01-A")],
        ):
            with self.assertRaises(AuditError):
                audit.independent_contrast(changed, "candidate", "A", "B")
        for duration in (True, 0, -1, float("inf"), float("nan")):
            changed = deepcopy(rows)
            next(row for row in changed if row["id"] == "pair-01-B")["totalImportMs"] = duration
            with self.assertRaises(AuditError):
                audit.independent_contrast(changed, "candidate", "A", "B")

    def test_frozen_nomination_requires_every_gate(self):
        candidate = {"medianPairedChangePercent": -2, "count": 12, "fasterPairs": 9}
        control = {"medianPairedChangePercent": 1, "equalWorkChangePercent": -1}
        self.assertTrue(audit.nomination(candidate, control, True, True)["nominated"])
        for key, value in (("medianPairedChangePercent", -1.999), ("count", 11), ("fasterPairs", 8)):
            changed = {**candidate, key: value}
            self.assertFalse(audit.nomination(changed, control, True, True)["nominated"])
        for key in control:
            self.assertFalse(audit.nomination(candidate, {**control, key: 1.001}, True, True)["nominated"])
        self.assertFalse(audit.nomination(candidate, control, False, True)["nominated"])
        self.assertFalse(audit.nomination(candidate, control, True, False)["nominated"])
        self.assertFalse(audit.nomination(candidate, control, True, True, False)["nominated"])


class OriginalIdentityTests(unittest.TestCase):
    def test_exact_frozen_manifest_and_original_jobs(self):
        value, run, jobs = source_publication()
        audit.validate_manifest(value)
        self.assertEqual(set(audit.validate_original_jobs(run, jobs, value)),
                         {item["jobId"] for item in value["artifacts"]})
        for key, bad in (("run_attempt", 2), ("head_sha", "0" * 40), ("status", "in_progress")):
            with self.assertRaises(AuditError):
                audit.validate_original_jobs({**run, key: bad}, jobs, value)
        changed = deepcopy(jobs)
        changed["jobs"][0]["id"] += 1
        with self.assertRaises(AuditError):
            audit.validate_original_jobs(run, changed, value)

    def test_existing_output_is_rejected_without_reuse(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary)
            marker = target / "original.txt"
            marker.write_text("retain")
            arguments = ["audit", "--manifest", str(Path(__file__).with_name("manifest.json")),
                         "--output", str(target)]
            with patch.object(sys, "argv", arguments), self.assertRaises(AuditError):
                audit.main()
            self.assertEqual(marker.read_text(), "retain")
            self.assertEqual(sorted(path.name for path in target.iterdir()), ["original.txt"])

    def test_manifest_cannot_weaken_frozen_control_or_artifact_boundary(self):
        value = manifest()
        changed = deepcopy(value)
        changed["nominationPolicy"]["absoluteControlMedianAtMost"] = 2
        with self.assertRaises(AuditError):
            audit.validate_manifest(changed)
        changed = deepcopy(value)
        changed["artifacts"][1]["id"] = changed["artifacts"][0]["id"]
        with self.assertRaises(AuditError):
            audit.validate_manifest(changed)

    def test_json_duplicate_and_overflow_are_rejected(self):
        for text in ('{"x":1,"x":2}', '{"x":NaN}', '{"x":Infinity}', '{"x":1e999}'):
            with self.assertRaises(AuditError):
                parse_json(text)
        self.assertEqual(parse_json('{"x":1.25}'), {"x": 1.25})


class ArchiveTests(unittest.TestCase):
    def test_canonical_names(self):
        self.assertEqual(str(safe_name("folder/file.json")), "folder/file.json")
        self.assertEqual(str(safe_name("folder/")), "folder")
        for name in (".", "./", "../escape", "/absolute", "a/../b", "a//b", "a//", "a\\b", "C:/file"):
            with self.assertRaises(AuditError):
                safe_name(name)

    def test_duplicates_symlinks_nul_and_file_directory_collisions(self):
        regular = zipfile.ZipInfo("a")
        regular.external_attr = 0o100644 << 16
        directory = zipfile.ZipInfo("a/b/")
        directory.external_attr = 0o40755 << 16
        symlink = zipfile.ZipInfo("link")
        symlink.external_attr = 0o120777 << 16
        nul = zipfile.ZipInfo("truncated\0payload")
        for entries in ([regular, regular], [regular, directory], [symlink], [nul]):
            with self.assertRaises(AuditError):
                inspect_zip(Entries(entries))
        bad_directory = zipfile.ZipInfo("payload/")
        bad_directory.file_size = 1
        with self.assertRaises(AuditError):
            inspect_zip(Entries([bad_directory]))

    def test_member_size_and_hashes(self):
        data = b"exact recorded member bytes"
        got = audit.archive_member_digest(io.BytesIO(data), len(data))
        self.assertEqual(got["sha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual(got["gitBlob"], audit.git_blob(data))
        for count in (len(data) - 1, len(data) + 1):
            with self.assertRaises(AuditError):
                audit.archive_member_digest(io.BytesIO(data), count)

    def test_nested_packages_and_all_original_bytes_are_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            outer = root / "original.zip"
            package = io.BytesIO()
            with zipfile.ZipFile(package, "w") as archive:
                archive.writestr("js/dictionary/zstd-term-content.js", b"runtime")
            with zipfile.ZipFile(outer, "w") as archive:
                for arm in "AB":
                    archive.writestr(f"compression-watchdog-comparison/package-{arm}.zip", package.getvalue())
                archive.writestr("compression-watchdog-source-proof.json", "{}")
            destination = root / "audit"
            destination.mkdir()
            extracted, packages, inventory = audit.unpack_artifact(outer, destination, "jmdict")
            self.assertEqual(set(packages), {"A", "B"})
            self.assertEqual(len(inventory), 3)
            self.assertTrue(outer.exists())
            self.assertTrue((extracted / "compression-watchdog-comparison/package-A.zip").exists())
            self.assertEqual(packages["A"]["entries"], packages["B"]["entries"])

    def test_unexpected_nested_archive_fails_without_deleting_original(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            outer = root / "original.zip"
            with zipfile.ZipFile(outer, "w") as archive:
                archive.writestr("unregistered.zip", b"unregistered")
            destination = root / "audit"
            destination.mkdir()
            with self.assertRaises(AuditError):
                audit.unpack_artifact(outer, destination, "correctness")
            self.assertTrue(outer.exists())
            self.assertTrue((destination / "outer-member-inventory.json").exists())


class DownloadBoundaryTests(unittest.TestCase):
    def test_token_stops_at_signed_redirect_and_bytes_are_verified(self):
        data = b"original artifact bytes"
        expected = {"id": 17, "name": "original", "sizeBytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest()}
        publication = {"runId": 23, "headSha": "a" * 40, "headBranch": "frozen"}
        metadata = {"id": 17, "name": "original", "size_in_bytes": len(data),
                    "digest": "sha256:" + expected["sha256"], "expired": False,
                    "workflow_run": {"id": 23, "head_sha": "a" * 40, "head_branch": "frozen"}}
        seen = []

        def api_open(request, timeout):
            self.assertEqual(request.get_header("Authorization"), "Bearer test-token")
            seen.append("api")
            raise urllib.error.HTTPError(request.full_url, 302, "redirect",
                                         {"Location": "https://example.invalid/signed?opaque=test"}, None)

        def signed_open(request, timeout):
            self.assertIsNone(request.get_header("Authorization"))
            seen.append("signed")
            return io.BytesIO(data)

        with tempfile.TemporaryDirectory() as temporary, patch.dict("os.environ", {"GH_TOKEN": "test-token"}):
            output = Path(temporary)
            api = GitHub("ManabiIO/manabitan", output)
            with patch.object(api, "json", return_value=metadata), \
                    patch("urllib.request.build_opener", return_value=types.SimpleNamespace(open=api_open)), \
                    patch("urllib.request.urlopen", side_effect=signed_open):
                path, actual = api.artifact(expected, publication, output)
            self.assertEqual(path.read_bytes(), data)
            self.assertEqual(actual, metadata)
            self.assertEqual(seen, ["api", "signed"])


if __name__ == "__main__":
    unittest.main()
