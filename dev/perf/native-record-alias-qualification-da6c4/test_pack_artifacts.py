# SPDX-License-Identifier: GPL-3.0-or-later
"""Deterministic artifact transport gates; no corpus or timing process."""
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

from pack_artifacts import inventory, preserve, verify_archive


class ArtifactPreservationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.evidence = self.root / 'evidence'
        self.evidence.mkdir()
        self.destination = self.root / 'upload'

    def tearDown(self):
        self.temporary.cleanup()

    def test_pipe_paths_and_exact_original_bytes_survive(self):
        opfs = self.evidence / 'observation/layout/opfs'
        opfs.mkdir(parents=True)
        (opfs / 'dict-28|VNDB%20Characters.mbtr').write_bytes(bytes(range(256)) * 17)
        (self.evidence / 'run-state.json').write_text('{"complete": false}\n')
        before = inventory(self.evidence)
        receipt = preserve(self.evidence, self.destination)
        self.assertTrue(receipt['complete'])
        self.assertFalse(receipt['originalsDeleted'])
        self.assertEqual(inventory(self.evidence), before)
        self.assertEqual(verify_archive(self.destination / receipt['archivePath'], before), before)
        self.assertTrue(all('|' not in path.name for path in self.destination.iterdir()))
        self.assertEqual((self.destination / 'run-state.json').read_bytes(), (self.evidence / 'run-state.json').read_bytes())

    def test_symlink_is_rejected_with_failure_receipt(self):
        (self.evidence / 'link').symlink_to('/dev/null')
        with self.assertRaisesRegex(ValueError, 'symlink'):
            preserve(self.evidence, self.destination)
        receipt = json.loads((self.destination / 'artifact-preservation.json').read_text())
        self.assertFalse(receipt['complete'])
        self.assertEqual(len(receipt['failures']), 1)

    def test_empty_evidence_is_not_reported_complete(self):
        with self.assertRaisesRegex(ValueError, 'Empty evidence'):
            preserve(self.evidence, self.destination)
        self.assertFalse(json.loads((self.destination / 'artifact-preservation.json').read_text())['complete'])

    def test_missing_member_or_changed_checksum_fails(self):
        (self.evidence / 'one.bin').write_bytes(b'one')
        before = inventory(self.evidence)
        receipt = preserve(self.evidence, self.destination)
        wrong = [{**before[0], 'sha256': '0' * 64}]
        with self.assertRaisesRegex(ValueError, 'differ'):
            verify_archive(self.destination / receipt['archivePath'], wrong)
        filename = self.root / 'empty.tar.gz'
        with tarfile.open(filename, 'w:gz'):
            pass
        with self.assertRaisesRegex(ValueError, 'differ'):
            verify_archive(filename, before)


if __name__ == '__main__':
    unittest.main()
