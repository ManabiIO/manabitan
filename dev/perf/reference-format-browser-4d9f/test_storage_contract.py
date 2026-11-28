"""Ensure the storage exception cannot hide unrelated semantic changes."""
from copy import deepcopy
import unittest

from storage_contract import normalize_receipt


CONTENT = 'manabitan-term-content.bin'
INDEX = 'manabitan-term-records/example.mbtr.mbti'
CASE = {'modes': {
    'off': {'termFiles': {CONTENT: 100, INDEX: 200}},
    'on': {'termFiles': {CONTENT: 100, INDEX: 180}},
}}


def receipt(mode):
    files = [{'path': path, 'bytes': size} for path, size in CASE['modes'][mode]['termFiles'].items()]
    files.extend([{'path': 'manabitan-dictionary-media-v1/{generation}.bin', 'bytes': 300},
                  {'path': 'manabitan/sqlite-sahpool-v1/.opaque/{opaque}', 'bytes': 8192}])
    return {'browserVersion': '153.0.8010.12', 'common': {
        'importFlags': {'experimentalReferenceTableFields': mode == 'on'},
        'validation': {'termRows': 5, 'lookup': {'sha256': 'original'},
                       'storage': {'kind': 'retained-kind', 'bytes': sum(item['bytes'] for item in files), 'files': files}},
    }, 'media': {'sha256': 'all-original-media'}}


class StorageContractTests(unittest.TestCase):
    def test_only_declared_changes_normalize_and_originals_remain_intact(self):
        off, on = receipt('off'), receipt('on')
        originals = deepcopy([off, on])
        self.assertEqual(normalize_receipt(off, CASE, 'off'), normalize_receipt(on, CASE, 'on'))
        self.assertEqual([off, on], originals)

    def test_wrong_or_numeric_flag_is_rejected(self):
        for value in (False, 1, 'true', None):
            item = receipt('on')
            item['common']['importFlags']['experimentalReferenceTableFields'] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_receipt(item, CASE, 'on')

    def test_missing_extra_or_wrong_term_bytes_are_rejected(self):
        for operation in ('missing', 'extra', 'wrong-bytes'):
            item = receipt('on')
            files = item['common']['validation']['storage']['files']
            if operation == 'missing':
                files.pop(1)
            elif operation == 'extra':
                files.append({'path': 'manabitan-term-records/unexpected.mbtr', 'bytes': 1})
            else:
                files[1]['bytes'] += 1
            with self.subTest(operation=operation), self.assertRaises(ValueError):
                normalize_receipt(item, CASE, 'on')

    def test_media_and_sqlite_byte_changes_remain_visible(self):
        reference = normalize_receipt(receipt('off'), CASE, 'off')
        for index in (2, 3):
            item = receipt('on')
            item['common']['validation']['storage']['files'][index]['bytes'] += 4096
            normalized = normalize_receipt(item, CASE, 'on')
            with self.subTest(index=index):
                self.assertNotEqual(normalized, reference)
                self.assertEqual(normalized['common']['validation']['storage']['files'][index],
                                 item['common']['validation']['storage']['files'][index])

    def test_lookup_media_count_and_unknown_semantic_fields_remain_visible(self):
        reference = normalize_receipt(receipt('off'), CASE, 'off')
        for operation in ('lookup', 'media', 'count', 'unknown'):
            item = receipt('on')
            if operation == 'lookup':
                item['common']['validation']['lookup']['sha256'] = 'changed'
            elif operation == 'media':
                item['media']['sha256'] = 'changed'
            elif operation == 'count':
                item['common']['validation']['termRows'] += 1
            else:
                item['common']['validation']['unexpected'] = True
            with self.subTest(operation=operation):
                self.assertNotEqual(normalize_receipt(item, CASE, 'on'), reference)


if __name__ == '__main__':
    unittest.main()
