"""Exact artifact transport checks; no corpus or browser work."""
from contextlib import redirect_stdout
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

from pack_artifacts import inventory, preserve, verify_archive


class ArtifactTests(unittest.TestCase):
    def test_pipe_names_and_binary_bytes_survive_without_direct_upload(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            evidence, destination = root / "evidence", root / "upload"
            (evidence / "cohort/opfs").mkdir(parents=True)
            payload = bytes(range(256)) * 7
            (evidence / "cohort/opfs/dictionary|raw.bin").write_bytes(payload)
            (evidence / "outcome.json").write_text('{"passed":false}\n')
            expected = inventory(evidence)
            with redirect_stdout(io.StringIO()):
                receipt = preserve(evidence, destination)
            self.assertTrue(receipt["complete"])
            self.assertEqual(receipt["members"], expected)
            self.assertEqual(verify_archive(destination / receipt["archivePath"], expected), expected)
            self.assertTrue((evidence / "cohort/opfs/dictionary|raw.bin").is_file())
            self.assertFalse(any("|" in item.name for item in destination.iterdir()))
            with tarfile.open(destination / receipt["archivePath"], "r:gz") as archive:
                self.assertEqual(archive.extractfile("cohort/opfs/dictionary|raw.bin").read(), payload)
            self.assertEqual(hashlib.sha256((destination / receipt["archivePath"]).read_bytes()).hexdigest(),
                             receipt["archiveSha256"])

    def test_only_the_named_reproducible_worktree_is_excluded(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            evidence, destination = root / "evidence", root / "upload"
            (evidence / "cohort-sources/A/node_modules").mkdir(parents=True)
            (evidence / "cohort-sources/A/node_modules/duplicate").write_text("reproducible")
            (evidence / "cohort").mkdir()
            (evidence / "cohort/observations.json").write_text("[]\n")
            (evidence / "source-state").mkdir()
            (evidence / "source-state/A.diff.patch").write_bytes(b"original diagnostic\n")
            with redirect_stdout(io.StringIO()):
                receipt = preserve(evidence, destination)
            self.assertEqual([item["path"] for item in receipt["members"]],
                             ["cohort/observations.json", "source-state/A.diff.patch"])
            self.assertEqual(receipt["excludedReproducibleDirectory"], "cohort-sources")
            self.assertFalse(receipt["originalsDeleted"])

    def test_undeclared_symlink_is_not_followed_or_silently_omitted(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            evidence, destination = root / "evidence", root / "upload"
            evidence.mkdir()
            (root / "external").write_text("outside")
            (evidence / "alias").symlink_to(root / "external")
            with redirect_stdout(io.StringIO()), self.assertRaises(ValueError):
                preserve(evidence, destination)
            receipt = json.loads((destination / "artifact-preservation.json").read_text())
            self.assertFalse(receipt["complete"])
            self.assertTrue(receipt["failures"])

    def test_destination_cannot_be_nested_and_empty_evidence_cannot_qualify(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            evidence = root / "evidence"
            evidence.mkdir()
            with self.assertRaises(ValueError):
                preserve(evidence, evidence / "upload")
            with redirect_stdout(io.StringIO()), self.assertRaises(ValueError):
                preserve(evidence, root / "upload")
            self.assertFalse(json.loads((root / "upload/artifact-preservation.json").read_text())["complete"])

    def test_archive_member_digest_mismatch_is_fatal(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            evidence, destination = root / "evidence", root / "upload"
            evidence.mkdir()
            (evidence / "outcome.json").write_text('{"passed":false}\n')
            with redirect_stdout(io.StringIO()):
                receipt = preserve(evidence, destination)
            expected = receipt["members"]
            expected[0]["sha256"] = "0" * 64
            with self.assertRaises(ValueError):
                verify_archive(destination / receipt["archivePath"], expected)


if __name__ == "__main__":
    unittest.main()
