# SPDX-License-Identifier: GPL-3.0-or-later
"""Synthetic mutation witnesses; no browser or import timing is performed."""

import copy
import unittest

from storage_receipts import (ALLOCATION_UNIT_BYTES, EXPECTED_PRODUCT_PATHS,
                              GENERATION_MEDIA_PATH, SQLITE_PREFIX, STORAGE_KIND,
                              compare_storage_receipts, normalize_storage_receipt,
                              storage_comparison_key)


def inventory(dictionary='vndb', active_units=129, suffix='a'):
    files = []
    for index, path in enumerate(sorted(EXPECTED_PRODUCT_PATHS[dictionary])):
        if path == GENERATION_MEDIA_PATH:
            path = 'manabitan-dictionary-media-v1/' + ('a' if suffix == 'a' else 'b') * 8 + '-1111-2222-3333-444444444444.bin'
        files.append({'path': path, 'bytes': (index + 1) * 1000})
    files.extend({'path': SQLITE_PREFIX + f'{suffix}{index}', 'bytes': ALLOCATION_UNIT_BYTES} for index in range(7))
    files.append({'path': SQLITE_PREFIX + suffix + 'active', 'bytes': active_units * ALLOCATION_UNIT_BYTES})
    return {'kind': STORAGE_KIND, 'bytes': sum(item['bytes'] for item in files), 'files': files}


def retotal(value):
    value['bytes'] = sum(item['bytes'] for item in value['files'])
    return value


class StorageReceiptTests(unittest.TestCase):
    def test_frozen_vndb_bounds_preserve_every_raw_size(self):
        baseline = inventory()
        for units in (129, 130, 131):
            with self.subTest(units=units):
                candidate = inventory(active_units=units, suffix='b')
                result = compare_storage_receipts(baseline, candidate, 'vndb')
                self.assertEqual(result['rawStorageDeltaBytes'], (units - 129) * 4096)
                self.assertEqual(result['activeSahDeltaBytes'], (units - 129) * 4096)
                self.assertTrue(result['nonSahBytesEqual'])
                self.assertEqual(result['candidate']['rawStorageBytes'], candidate['bytes'])
                self.assertEqual(result['candidate']['rawFiles'], sorted(candidate['files'], key=lambda row: row['path']))
                self.assertEqual(result['candidate']['sahPool']['sortedFileBytes'], [4096] * 7 + [units * 4096])

    def test_file_enumeration_and_documented_random_names_do_not_change_key(self):
        a, b = inventory(), inventory(suffix='b')
        b['files'].reverse()
        self.assertEqual(storage_comparison_key(normalize_storage_receipt(a, 'vndb')),
                         storage_comparison_key(normalize_storage_receipt(b, 'vndb')))

    def test_other_dictionaries_keep_exact_sah_allocation(self):
        for dictionary, units in (('jmdict', 43), ('jitendex', 1333)):
            with self.subTest(dictionary=dictionary):
                a, b = inventory(dictionary, units), inventory(dictionary, units, 'b')
                compare_storage_receipts(a, b, dictionary)
                b['files'][-1]['bytes'] += 4096
                with self.assertRaisesRegex(ValueError, 'invariants differ'):
                    compare_storage_receipts(a, retotal(b), dictionary)

    def test_outside_vndb_bounds_fails_even_when_both_arms_agree(self):
        for units in (128, 132, 200):
            with self.subTest(units=units):
                a = inventory(active_units=units)
                with self.assertRaisesRegex(ValueError, '129–131'):
                    compare_storage_receipts(a, a, 'vndb')

    def test_unaligned_active_allocation_fails(self):
        value = inventory()
        value['files'][-1]['bytes'] += 1
        with self.assertRaisesRegex(ValueError, 'aligned'):
            normalize_storage_receipt(retotal(value), 'vndb')

    def test_each_non_sah_size_change_fails_comparison(self):
        baseline = inventory()
        for index in range(len(EXPECTED_PRODUCT_PATHS['vndb'])):
            with self.subTest(path=baseline['files'][index]['path']):
                candidate = copy.deepcopy(baseline)
                candidate['files'][index]['bytes'] += 1
                with self.assertRaisesRegex(ValueError, 'invariants differ'):
                    compare_storage_receipts(baseline, retotal(candidate), 'vndb')

    def test_balanced_non_sah_changes_cannot_hide_behind_equal_total(self):
        baseline = inventory()
        candidate = copy.deepcopy(baseline)
        candidate['files'][0]['bytes'] += 1
        candidate['files'][1]['bytes'] -= 1
        self.assertEqual(candidate['bytes'], baseline['bytes'])
        with self.assertRaisesRegex(ValueError, 'invariants differ'):
            compare_storage_receipts(baseline, candidate, 'vndb')

    def test_unknown_path_is_rejected_even_on_baseline(self):
        for path in ('unexpected.bin', 'manabitan-term-records/new.mbti', SQLITE_PREFIX + 'nested/file',
                     'manabitan-dictionary-media-v1/not-a-uuid.bin', GENERATION_MEDIA_PATH):
            with self.subTest(path=path):
                value = inventory()
                value['files'].append({'path': path, 'bytes': 1})
                with self.assertRaises(ValueError):
                    normalize_storage_receipt(retotal(value), 'vndb')

    def test_each_required_non_sah_path_must_exist(self):
        original = inventory()
        for index in range(len(EXPECTED_PRODUCT_PATHS['vndb'])):
            with self.subTest(path=original['files'][index]['path']):
                value = copy.deepcopy(original)
                value['files'].pop(index)
                with self.assertRaisesRegex(ValueError, 'Missing required'):
                    normalize_storage_receipt(retotal(value), 'vndb')

    def test_extra_and_missing_sah_files_fail(self):
        extra = inventory()
        extra['files'].append({'path': SQLITE_PREFIX + 'newempty', 'bytes': 4096})
        missing = inventory()
        missing['files'].pop()
        for value in (extra, missing):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, 'file count'):
                    normalize_storage_receipt(retotal(value), 'vndb')

    def test_empty_sah_sizes_and_multiple_active_files_fail(self):
        for size in (0, 4095, 8192):
            with self.subTest(size=size):
                value = inventory()
                value['files'][-2]['bytes'] = size
                with self.assertRaisesRegex(ValueError, 'empty SAH'):
                    normalize_storage_receipt(retotal(value), 'vndb')

    def test_duplicates_and_two_generation_files_fail(self):
        duplicate = inventory()
        duplicate['files'].append(dict(duplicate['files'][0]))
        another_generation = inventory()
        another_generation['files'].append(dict(inventory(suffix='b')['files'][0]))
        for value in (duplicate, another_generation):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, '[Dd]uplicate'):
                    normalize_storage_receipt(retotal(value), 'vndb')

    def test_total_must_reconcile_with_every_file(self):
        value = inventory()
        value['bytes'] += 1
        with self.assertRaisesRegex(ValueError, 'complete file inventory'):
            normalize_storage_receipt(value, 'vndb')

    def test_invalid_sizes_and_receipt_schema_fail(self):
        for size in (-1, 1.5, True, None, 2 ** 53):
            with self.subTest(size=size):
                value = inventory()
                value['files'][0]['bytes'] = size
                with self.assertRaises(ValueError):
                    normalize_storage_receipt(value, 'vndb')
        for value in ({}, {'kind': 'different'}, {'kind': STORAGE_KIND, 'bytes': 0, 'files': []}):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    normalize_storage_receipt(value, 'vndb')

    def test_unknown_fixture_and_cross_fixture_paths_fail(self):
        with self.assertRaises(ValueError):
            normalize_storage_receipt(inventory(), 'other')
        with self.assertRaises(ValueError):
            normalize_storage_receipt(inventory(), 'jmdict')

    def test_offline_normalized_field_tampering_fails(self):
        for target in ('nonSahFiles', 'sahPool', 'rawStorageBytes'):
            with self.subTest(target=target):
                value = normalize_storage_receipt(inventory(), 'vndb')
                if target == 'nonSahFiles':
                    value[target][0]['bytes'] += 1
                elif target == 'sahPool':
                    value[target]['activeFileBytes'] += 4096
                else:
                    value[target] += 1
                with self.assertRaises(ValueError):
                    storage_comparison_key(value)


if __name__ == '__main__':
    unittest.main()
