#!/usr/bin/env python3
"""Bounded original-failure regressions for the evidence writer; no product work."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("field_archive", Path(__file__).with_name("archive-evidence.py"))
assert SPEC is not None and SPEC.loader is not None
ARCHIVE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ARCHIVE)


class EvidenceArchiveTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "evidence").mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def archive(self, roots=None):
        return ARCHIVE.archive_evidence(
            self.root, roots or ["evidence"], "output/original.tar.gz", "output/receipt.json")

    def test_dot_root_is_rejected_before_scoped_ancestor_walk(self):
        with self.assertRaisesRegex(RuntimeError, "canonical relative"):
            ARCHIVE.canonical(".")

    def test_pipe_names_and_complete_regular_bytes(self):
        payload = bytes(range(256)) * 8
        (self.root / "evidence/dictionary|generation.records").write_bytes(payload)
        (self.root / "evidence/.hidden").write_bytes(b"hidden receipt\n")
        result = self.archive()
        name = "evidence/dictionary|generation.records"
        self.assertEqual(result["members"][name],
                         {"kind": "file", "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()})
        self.assertIn("evidence/.hidden", result["members"])
        self.assertEqual(json.loads((self.root / "output/receipt.json").read_text()), result)
        with tarfile.open(self.root / "output/original.tar.gz", "r:gz") as source:
            with source.extractfile(name) as stream:
                self.assertEqual(stream.read(), payload)

    def test_intentional_external_dangling_and_directory_cycle_symlinks_are_inert(self):
        (self.root / "outside").mkdir()
        secret = b"must not enter the archive"
        (self.root / "outside/sentinel").write_bytes(secret)
        links = {
            "external": "../outside/sentinel",
            "dangling": "../missing",
            "cycle": ".",
        }
        for name, target in links.items():
            os.symlink(target, self.root / "evidence" / name)
        result = self.archive()
        self.assertEqual(set(result["members"]), {"evidence", *(f"evidence/{name}" for name in links)})
        with tarfile.open(self.root / "output/original.tar.gz", "r:gz") as source:
            for name, target in links.items():
                item = source.getmember("evidence/" + name)
                self.assertTrue(item.issym())
                self.assertEqual(item.linkname, target)
                self.assertEqual(item.size, 0)
                self.assertEqual(result["members"][item.name], {"kind": "symlink", "target": target})
        self.assertEqual((self.root / "outside/sentinel").read_bytes(), secret)
        self.assertTrue((self.root / "evidence/dangling").is_symlink())

    def test_hardlinked_files_are_both_complete_regular_payloads(self):
        payload = b"one inode, two original names\n"
        (self.root / "evidence/first").write_bytes(payload)
        os.link(self.root / "evidence/first", self.root / "evidence/second")
        result = self.archive()
        with tarfile.open(self.root / "output/original.tar.gz", "r:gz") as source:
            for name in ("evidence/first", "evidence/second"):
                item = source.getmember(name)
                self.assertTrue(item.isfile())
                self.assertFalse(item.islnk())
                with source.extractfile(item) as stream:
                    self.assertEqual(stream.read(), payload)
        self.assertEqual(result["members"]["evidence/first"], result["members"]["evidence/second"])

    def test_missing_roots_are_reported_without_replacing_originals(self):
        result = self.archive(["evidence", "unavailable"])
        self.assertEqual(result["missingRequestedRoots"], ["unavailable"])
        before = (self.root / "output/original.tar.gz").read_bytes()
        with self.assertRaisesRegex(RuntimeError, "replace"):
            self.archive()
        self.assertEqual((self.root / "output/original.tar.gz").read_bytes(), before)

    def test_outputs_cannot_include_themselves_or_traverse_a_link(self):
        with self.assertRaisesRegex(RuntimeError, "inside an evidence root"):
            ARCHIVE.archive_evidence(self.root, ["evidence"], "evidence/self.tar.gz", "output/receipt.json")
        (self.root / "outside").mkdir()
        os.symlink("../outside", self.root / "evidence/linked")
        with self.assertRaisesRegex(RuntimeError, "ancestor is a symlink"):
            ARCHIVE.archive_evidence(self.root, ["evidence"], "evidence/linked/out.tar.gz", "output/receipt.json")
        self.assertFalse((self.root / "outside/out.tar.gz").exists())

    def test_fifo_is_rejected_without_reading_it(self):
        os.mkfifo(self.root / "evidence/fifo")
        with self.assertRaisesRegex(RuntimeError, "Unsupported evidence member type"):
            self.archive()

    def test_reader_rejects_changed_regular_bytes(self):
        (self.root / "evidence/file").write_bytes(b"original")
        result = self.archive()
        bad = self.root / "bad.tar.gz"
        with tarfile.open(bad, "w:gz") as target:
            for name, expected in result["members"].items():
                info = tarfile.TarInfo(name)
                if expected["kind"] == "directory":
                    info.type = tarfile.DIRTYPE
                    target.addfile(info)
                else:
                    data = b"modified"
                    info.size = len(data)
                    target.addfile(info, io.BytesIO(data))
        with self.assertRaisesRegex(RuntimeError, "identity changed"):
            ARCHIVE.verify_archive(bad, result["members"])

    def test_reader_rejects_an_unrecorded_or_changed_symlink_target(self):
        os.symlink("../missing", self.root / "evidence/link")
        result = self.archive()
        for target_value in ("../different", "/absolute/never-followed"):
            bad = self.root / "changed-link.tar.gz"
            with tarfile.open(bad, "w:gz") as target:
                directory = tarfile.TarInfo("evidence")
                directory.type = tarfile.DIRTYPE
                target.addfile(directory)
                link = tarfile.TarInfo("evidence/link")
                link.type = tarfile.SYMTYPE
                link.linkname = target_value
                target.addfile(link)
            with self.assertRaisesRegex(RuntimeError, "identity changed"):
                ARCHIVE.verify_archive(bad, result["members"])


if __name__ == "__main__":
    unittest.main()
