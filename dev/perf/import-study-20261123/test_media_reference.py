"""Reject incomplete source media coverage independently of browser receipts."""

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from run import media_reference


class MediaReferenceTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='import-media-reference-')
        self.archive = Path(self.temporary.name) / 'source.zip'
        self.fixture = {'mediaFiles': 2, 'mediaBytes': 16,
                        'unreferencedMediaPaths': ['unused.svg']}
        with zipfile.ZipFile(self.archive, 'w') as archive:
            archive.writestr('term_bank_1.json', json.dumps([
                ['a', '', '', '', '', [{'type': 'structured-content', 'content': [
                    {'tag': 'img', 'path': 'a.svg'}, {'tag': 'div', 'content': {'tag': 'img', 'path': 'b.avif'}},
                    {'tag': 'img', 'path': 'a.svg'}]}]],
            ]))
            archive.writestr('a.svg', b'source-a')
            archive.writestr('b.avif', b'source-b')
            archive.writestr('unused.svg', b'unused-source')

    def tearDown(self):
        self.temporary.cleanup()

    def test_all_referenced_images_exclude_only_actual_unreferenced_members(self):
        result = media_reference(self.archive, self.fixture)['all']
        digest = hashlib.sha256()
        for name, data in [('a.svg', b'source-a'), ('b.avif', b'source-b')]:
            digest.update((json.dumps([name, len(data), hashlib.sha256(data).hexdigest()], separators=(',', ':')) + '\n').encode())
        self.assertEqual(result, {'mode': 'all', 'totalFiles': 2, 'totalBytes': 16,
                                  'files': 2, 'bytes': 16, 'sha256': digest.hexdigest()})

    def test_incomplete_source_selection_fails_even_with_matching_count_and_size(self):
        self.fixture.update(mediaFiles=1, mediaBytes=8, unreferencedMediaPaths=['b.avif', 'unused.svg'])
        with self.assertRaisesRegex(ValueError, 'coverage'):
            media_reference(self.archive, self.fixture)

    def test_extra_unreferenced_selection_fails(self):
        self.fixture.update(mediaFiles=3, mediaBytes=29, unreferencedMediaPaths=[])
        with self.assertRaisesRegex(ValueError, 'coverage'):
            media_reference(self.archive, self.fixture)

    def test_duplicate_or_missing_exclusions_fail(self):
        for paths in (['unused.svg', 'unused.svg'], ['missing.svg']):
            self.fixture['unreferencedMediaPaths'] = paths
            with self.assertRaises(ValueError):
                media_reference(self.archive, self.fixture)

    def test_wrong_byte_total_fails(self):
        self.fixture['mediaBytes'] += 1
        with self.assertRaisesRegex(ValueError, 'byte total'):
            media_reference(self.archive, self.fixture)

    def test_empty_media_is_independently_validated(self):
        with zipfile.ZipFile(self.archive, 'w') as archive:
            archive.writestr('term_bank_1.json', '[[]]')
        result = media_reference(self.archive, {'mediaFiles': 0, 'mediaBytes': 0})['all']
        self.assertEqual(result['sha256'], hashlib.sha256().hexdigest())
        self.assertEqual(result['files'], 0)

    def test_fixed_64_image_digest_spans_complete_sorted_source(self):
        with zipfile.ZipFile(self.archive, 'w') as archive:
            refs = [{'tag': 'img', 'path': f'img/{i:03d}.webp'} for i in range(70)]
            archive.writestr('term_bank_1.json', json.dumps(refs))
            for i in range(70):
                archive.writestr(f'img/{i:03d}.webp', bytes([i]))
        result = media_reference(self.archive, {'mediaFiles': 70, 'mediaBytes': 70})
        expected = hashlib.sha256()
        for i in (index * 69 // 63 for index in range(64)):
            row = [f'img/{i:03d}.webp', 1, hashlib.sha256(bytes([i])).hexdigest()]
            expected.update((json.dumps(row, separators=(',', ':')) + '\n').encode())
        self.assertEqual(result['all']['files'], 70)
        self.assertEqual(result['sample'], {'mode': 'sample', 'totalFiles': 70, 'totalBytes': 70,
                                          'files': 64, 'bytes': 64, 'sha256': expected.hexdigest()})


if __name__ == '__main__':
    unittest.main()
