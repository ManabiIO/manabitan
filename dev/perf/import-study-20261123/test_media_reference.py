"""Exercise source-derived media coverage without starting a browser."""

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from run import media_reference


class MediaReferenceTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="import-media-reference-")
        self.archive = Path(self.temporary.name) / "source.zip"
        self.fixture = {"mediaRows": 2, "mediaProbeMode": "all-referenced-images",
                        "mediaProbePaths": ["a.svg", "b.avif"]}
        with zipfile.ZipFile(self.archive, "w") as archive:
            archive.writestr("term_bank_1.json", json.dumps([
                ["a", "", "", "", "", [{"type": "structured-content", "content": [
                    {"tag": "img", "path": "a.svg"}, {"tag": "div", "content": {"tag": "img", "path": "b.avif"}},
                    {"tag": "img", "path": "a.svg"}]}]],
            ]))
            archive.writestr("a.svg", b"source-a")
            archive.writestr("b.avif", b"source-b")
            archive.writestr("unused.svg", b"unused-source")

    def tearDown(self):
        self.temporary.cleanup()

    def test_all_referenced_images_exclude_unreferenced_archive_members(self):
        result = media_reference(self.archive, self.fixture)
        self.assertEqual([row["path"] for row in result], ["a.svg", "b.avif"])
        self.assertEqual([row["bytes"] for row in result], [8, 8])
        self.assertEqual(result[0]["sha256"], hashlib.sha256(b"source-a").hexdigest())

    def test_incomplete_probe_manifest_fails(self):
        self.fixture["mediaProbePaths"] = ["a.svg"]
        with self.assertRaises(ValueError):
            media_reference(self.archive, self.fixture)

    def test_unreferenced_extra_probe_fails(self):
        self.fixture["mediaProbePaths"] += ["unused.svg"]
        self.fixture["mediaRows"] = 3
        with self.assertRaises(ValueError):
            media_reference(self.archive, self.fixture)

    def test_duplicate_or_unsorted_probes_fail(self):
        for paths in (["a.svg", "a.svg"], ["b.avif", "a.svg"]):
            self.fixture["mediaProbePaths"] = paths
            with self.assertRaises(ValueError):
                media_reference(self.archive, self.fixture)

    def test_existing_five_image_sampling_is_unchanged(self):
        with zipfile.ZipFile(self.archive, "w") as archive:
            for index in range(6):
                archive.writestr(f"img/{index}.webp", bytes([index]))
        fixture = {"mediaRows": 6, "mediaProbePaths": ["img/1.webp"]}
        result = media_reference(self.archive, fixture)
        self.assertEqual([row["path"] for row in result], ["img/0.webp", "img/2.webp", "img/4.webp", "img/5.webp", "img/1.webp"])


if __name__ == "__main__":
    unittest.main()
