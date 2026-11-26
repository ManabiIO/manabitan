# SPDX-License-Identifier: GPL-3.0-or-later
"""Only the reviewed receipt overlay may dirty frozen measurement sources."""

from copy import deepcopy
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from qualification_overlay import (
    BENCHMARK_SUPPORT_PATH, MEMORY_HARNESS_PATH, OVERLAY_IDENTITY, OVERLAY_NAME,
    apply_measurement_overlay, load_measurement_overlay, require_source_state, sha256,
)
from qualification_receipts import CURRENT_BASELINE_SHA


ROOT = Path(__file__).resolve().parents[3]


class MeasurementOverlayWitness(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.overlay = load_measurement_overlay(ROOT, OVERLAY_NAME)
        cls.original = subprocess.check_output(
            ['git', 'show', f'{CURRENT_BASELINE_SHA}:{BENCHMARK_SUPPORT_PATH}'], cwd=ROOT)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.run_git('init', '-q')
        self.support = self.root / BENCHMARK_SUPPORT_PATH
        self.support.parent.mkdir(parents=True)
        self.support.write_bytes(self.original)
        self.harness = self.root / MEMORY_HARNESS_PATH
        self.harness.parent.mkdir(parents=True)
        self.harness.write_bytes(b'original memory harness\n')
        (self.root / '.gitignore').write_text('builds/\n')
        self.run_git('add', '.')
        self.run_git('-c', 'user.name=Qualification test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'source')
        self.package = self.root / 'builds/manabitan-chrome.zip'
        self.package.parent.mkdir()
        self.package.write_bytes(b'frozen product package\n')

    def run_git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root)

    def test_overlay_requires_registered_source_and_both_content_hashes(self):
        self.assertIsNone(load_measurement_overlay(ROOT, None))
        self.assertEqual(sha256(self.original), OVERLAY_IDENTITY['originalSha256'])
        self.assertEqual(sha256(self.overlay['bytes']), OVERLAY_IDENTITY['sha256'])
        with self.assertRaises(ValueError):
            load_measurement_overlay(ROOT, 'unreviewed-overlay')
        with patch('qualification_overlay.subprocess.check_output', return_value=b'changed source'):
            with self.assertRaisesRegex(ValueError, 'hash differs'):
                load_measurement_overlay(ROOT, OVERLAY_NAME)
        for mutation in ('bytes', 'identity'):
            overlay = deepcopy(self.overlay)
            if mutation == 'bytes':
                overlay['bytes'] += b'\n'
            else:
                overlay['identity']['sourceSha'] = 'f' * 40
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                apply_measurement_overlay(self.root, overlay)
            self.assertEqual(self.support.read_bytes(), self.original)

    def test_overlay_and_memory_marker_lifecycle_preserve_packaged_bytes(self):
        packaged_hash = sha256(self.package.read_bytes())
        self.assertEqual(apply_measurement_overlay(self.root, self.overlay), self.original)
        expected = {BENCHMARK_SUPPORT_PATH: OVERLAY_IDENTITY['sha256']}
        self.assertEqual(require_source_state(self.root, expected)['dirtyPaths'], [BENCHMARK_SUPPORT_PATH])
        marker = b'instrumented memory harness\n'
        self.harness.write_bytes(marker)
        require_source_state(self.root, {**expected, MEMORY_HARNESS_PATH: sha256(marker)})
        self.harness.write_bytes(b'original memory harness\n')
        require_source_state(self.root, expected)
        self.support.write_bytes(self.original)
        require_source_state(self.root, {})
        self.assertEqual(sha256(self.package.read_bytes()), packaged_hash)

    def test_untracked_or_staged_changes_and_edited_overlay_fail_closed(self):
        apply_measurement_overlay(self.root, self.overlay)
        expected = {BENCHMARK_SUPPORT_PATH: OVERLAY_IDENTITY['sha256']}
        unknown = self.root / 'unregistered.txt'
        unknown.write_text('unexpected\n')
        with self.assertRaisesRegex(ValueError, 'source state'):
            require_source_state(self.root, expected)
        unknown.unlink()
        self.run_git('add', BENCHMARK_SUPPORT_PATH)
        with self.assertRaisesRegex(ValueError, 'source state'):
            require_source_state(self.root, expected)
        self.run_git('reset', '-q', 'HEAD', '--', BENCHMARK_SUPPORT_PATH)
        self.support.write_bytes(self.overlay['bytes'] + b'\n')
        with self.assertRaisesRegex(ValueError, 'source hash'):
            require_source_state(self.root, expected)
        with self.assertRaisesRegex(ValueError, 'dirty paths'):
            require_source_state(self.root, {'ext/product.js': 'a' * 64})

    def test_overlay_rejects_dirty_or_different_original_before_writing(self):
        self.harness.write_bytes(b'dirty marker\n')
        with self.assertRaisesRegex(ValueError, 'source state'):
            apply_measurement_overlay(self.root, self.overlay)
        self.assertEqual(self.support.read_bytes(), self.original)
        self.harness.write_bytes(b'original memory harness\n')
        self.support.write_bytes(b'another frozen original\n')
        self.run_git('add', BENCHMARK_SUPPORT_PATH)
        self.run_git('-c', 'user.name=Qualification test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'other source')
        with self.assertRaisesRegex(ValueError, 'original hash'):
            apply_measurement_overlay(self.root, self.overlay)
        self.assertEqual(self.support.read_bytes(), b'another frozen original\n')


if __name__ == '__main__':
    unittest.main()
