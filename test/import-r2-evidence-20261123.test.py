#!/usr/bin/env python3
"""Evidence transport and corruption checks; these do not run benchmarks."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile


SOURCE = Path(__file__).resolve().parents[1] / "dev/perf/import-r2-evidence-20261123.py"
SPEC = importlib.util.spec_from_file_location("r2_evidence", SOURCE)
EVIDENCE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EVIDENCE)


class EvidenceIntegrity(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.raw = self.root / "raw"
        self.raw.mkdir()
        (self.raw / "cell").mkdir()
        (self.raw / "cell" / "failure.log").write_bytes(b"failed\n\x00\xff\n")
        with zipfile.ZipFile(self.raw / "cell.zip", "w") as archive:
            archive.writestr("failure.log", b"failed\n\x00\xff\n")
        self.specification = self.root / "spec.json"
        self.specification.write_text(json.dumps([{"label": "run", "path": str(self.raw)}]))
        self.output = self.root / "bundle"

    def freeze(self):
        with contextlib.redirect_stdout(io.StringIO()):
            EVIDENCE.freeze(self.specification, self.output)

    def verify(self):
        with contextlib.redirect_stdout(io.StringIO()):
            EVIDENCE.verify(self.output)

    def test_original_binary_failure_bytes_survive_transport_deduplication(self):
        self.freeze()
        self.verify()
        members = json.loads((self.output / "raw-members.json").read_text())
        self.assertEqual([row["path"] for row in members], ["run/cell/failure.log"])
        transports = json.loads((self.output / "original-zips.json").read_text())
        self.assertEqual(transports[0]["members"][0]["sha256"], members[0]["sha256"])

    def test_changed_expanded_transport_is_rejected(self):
        (self.raw / "cell" / "failure.log").write_bytes(b"replacement")
        with self.assertRaisesRegex(ValueError, "Expanded transport bytes differ"):
            self.freeze()

    def test_corrupt_archive_is_rejected(self):
        self.freeze()
        path = self.output / "raw-evidence.tar.xz"
        data = bytearray(path.read_bytes())
        data[len(data) // 2] ^= 1
        path.write_bytes(data)
        with self.assertRaisesRegex(ValueError, "Archive digest mismatch"):
            self.verify()

    def test_changed_member_index_is_rejected(self):
        self.freeze()
        path = self.output / "raw-members.json"
        path.write_bytes(path.read_bytes() + b" ")
        with self.assertRaisesRegex(ValueError, "Member index changed"):
            self.verify()

    def test_unsafe_transport_path_is_rejected(self):
        with zipfile.ZipFile(self.raw / "cell.zip", "w") as archive:
            archive.writestr("../escape", b"bad")
        with self.assertRaisesRegex(ValueError, "Unsafe transport member"):
            self.freeze()

    def test_symlink_evidence_is_rejected(self):
        (self.raw / "linked.log").symlink_to(self.raw / "cell" / "failure.log")
        with self.assertRaisesRegex(ValueError, "Evidence cannot contain symlinks"):
            self.freeze()

    def test_existing_bundle_is_not_overwritten(self):
        self.freeze()
        before = (self.output / "manifest.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "Evidence destination must be new"):
            self.freeze()
        self.assertEqual((self.output / "manifest.json").read_bytes(), before)

    def test_incomplete_browser_case_roster_is_rejected(self):
        (self.raw / "import-r2-qualification-example-forward").mkdir()
        with self.assertRaisesRegex(ValueError, "Missing or unexpected browser cells"):
            EVIDENCE.audit_browser(self.raw, self.output, ["example"], self.root / "unused.json")


if __name__ == "__main__":
    unittest.main()
