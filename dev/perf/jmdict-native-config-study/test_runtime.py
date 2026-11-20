#!/usr/bin/env python3
"""Acceptance boundaries for immutable runtime reuse; no runtime downloads."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("native_study_runtime", Path(__file__).with_name("firefox-runtime.py"))
RUNTIME = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNTIME)


class RuntimeIdentityTests(unittest.TestCase):
    def setUp(self):
        self.lock = {"sourceArtifactId": 17, "sourceArtifactName": "frozen", "sourceArtifactBytes": 123,
                     "sourceArtifactSha256": "a" * 64, "sourceRunId": 42, "sourceToolingCommit": "b" * 40,
                     "binarySha256": "c" * 64, "version": "161.0b5"}
        self.metadata = {"id": 17, "name": "frozen", "size_in_bytes": 123, "digest": "sha256:" + "a" * 64,
                         "expired": False, "workflow_run": {"id": 42, "head_sha": "b" * 40}}

    def test_changed_source_metadata_is_rejected_before_runtime_use(self):
        RUNTIME.validate_source_metadata(self.metadata, self.lock)
        for key, value in {"id": 18, "name": "latest", "size_in_bytes": 124, "digest": "sha256:" + "d" * 64,
                           "expired": True, "workflow_run": {"id": 43, "head_sha": "b" * 40}}.items():
            with self.subTest(field=key):
                metadata = copy.deepcopy(self.metadata)
                metadata[key] = value
                with self.assertRaisesRegex(RuntimeError, "Source runtime artifact identity"):
                    RUNTIME.validate_source_metadata(metadata, self.lock)

    def fixture(self, directory):
        archive = directory / "firefox.archive"
        archive.write_bytes(b"synthetic browser archive")
        driver = directory / "geckodriver.tar.gz"
        driver.write_bytes(b"synthetic driver archive")
        receipt = {"schemaVersion": 1, "officialMozillaBuild": True, "binarySha256": self.lock["binarySha256"],
                   "release": self.lock["version"], "archiveFile": archive.name, "archiveBytes": archive.stat().st_size,
                   "archiveSha256": RUNTIME.digest(archive), "archiveSha512": RUNTIME.digest(archive, "sha512"),
                   "officialArchivePath": "linux-x86_64/en-US/firefox-161.0b5.tar.xz",
                   "geckodriver": {"archiveFile": driver.name, "archiveSha256": RUNTIME.digest(driver)}}
        RUNTIME.save(directory / "runtime.json", receipt)
        RUNTIME.save(directory / "source-artifact.json", self.metadata)
        (directory / "SHA512SUMS").write_text(receipt["archiveSha512"] + "  " + receipt["officialArchivePath"] + "\n")
        self.lock["receiptSha256"] = RUNTIME.digest(directory / "runtime.json")
        return receipt

    def test_receipt_archive_and_checksum_records_are_all_required(self):
        for fault in (None, "receipt", "browser", "driver", "checksum"):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                receipt = self.fixture(directory)
                target = {"receipt": "runtime.json", "browser": "firefox.archive", "driver": "geckodriver.tar.gz",
                          "checksum": "SHA512SUMS"}.get(fault)
                if fault == "checksum":
                    (directory / target).write_text("changed checksum record\n")
                elif target:
                    with (directory / target).open("ab") as stream:
                        stream.write(b"changed")
                with patch.object(RUNTIME, "runtime_lock", return_value=self.lock), \
                     patch.object(RUNTIME, "GECKODRIVER_SHA256", receipt["geckodriver"]["archiveSha256"]):
                    if fault is None:
                        self.assertEqual(RUNTIME.verify_artifact(directory), receipt)
                    else:
                        with self.assertRaises(RuntimeError):
                            RUNTIME.verify_artifact(directory)


if __name__ == "__main__":
    unittest.main()
