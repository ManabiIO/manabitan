# SPDX-License-Identifier: GPL-3.0-or-later
"""Rejection-focused tests of the new study policy, not the underlying verifier."""

from copy import deepcopy
import unittest

from compression_receipts import (
    CONTENT_PATH, EXPECTED_CONTENT_DELTAS, comparison_receipt, policy_manifest,
    receipt_digest, require_matching_trial_receipts,
)
from qualification_receipts import STORAGE_KIND, require_matching_receipts


def receipt(dictionary='jmdict', arm='A', total=50000000):
    delta = EXPECTED_CONTENT_DELTAS[dictionary] if arm == 'B' else 0
    content = total // 2
    files = [{'path': CONTENT_PATH, 'bytes': content + delta},
             {'path': 'record-file', 'bytes': total - content - 10},
             {'path': 'index-file', 'bytes': 10}]
    return {'browserVersion': '154.0.8000.0',
            'common': {'dictionary': dictionary, 'fixture': {'identity': 'pinned'}, 'importFlags': None,
                       'validation': {'storage': {'kind': STORAGE_KIND, 'bytes': total + delta, 'files': files},
                                      'termRows': 123, 'outputDigestSha256': 'a' * 64,
                                      'lookup': {'observations': [{'sha256': 'b' * 64}]},
                                      'restart': {'contentReadable': True}}},
            'media': {'mode': 'sample', 'sha256': 'c' * 64, 'bytes': 100}}


def storage(value):
    return value['common']['validation']['storage']


def resize(value, index, delta):
    storage(value)['files'][index]['bytes'] += delta
    storage(value)['bytes'] += delta


def compare(left, right, dictionary='jmdict', left_arm='A', right_arm='B', compare_media=True):
    return require_matching_trial_receipts(left, right, dictionary=dictionary,
                                          reference_arm=left_arm, candidate_arm=right_arm,
                                          compare_media=compare_media)


class CompressionReceiptPolicyTests(unittest.TestCase):
    def test_integrates_with_original_validated_receipts_for_all_three_fixture_shapes(self):
        from test_qualification_receipts import change_validation, observation, set_active_sah_units, validate

        for dictionary, delta in EXPECTED_CONTENT_DELTAS.items():
            summary, report = observation(dictionary)

            def prepare(validation):
                value = validation['storage']
                content = next(item for item in value['files'] if item['path'] == CONTENT_PATH)
                value['bytes'] += 50000000 - content['bytes']
                content['bytes'] = 50000000
                if dictionary == 'vndb':
                    set_active_sah_units(validation, 37)

            change_validation(summary, report, prepare)
            baseline = validate(summary, report, vndb_sah_allocation_units=(37, 37))

            def add_delta(validation):
                value = validation['storage']
                next(item for item in value['files'] if item['path'] == CONTENT_PATH)['bytes'] += delta
                value['bytes'] += delta

            change_validation(summary, report, add_delta)
            candidate = validate(summary, report, vndb_sah_allocation_units=(37, 37))
            originals = deepcopy((summary, report, baseline, candidate))
            with self.subTest(dictionary=dictionary):
                compare(baseline, candidate, dictionary)
                compare(candidate, baseline, dictionary, 'B', 'A')
                normalized, _ = comparison_receipt(candidate, dictionary=dictionary, arm='B')
                self.assertEqual(normalized, baseline)
                self.assertEqual((summary, report, baseline, candidate), originals)

    def test_exact_policy_is_frozen_and_manifest_is_a_copy(self):
        self.assertEqual(dict(EXPECTED_CONTENT_DELTAS), {'jmdict': 312404, 'jitendex': 750018, 'vndb': 0})
        with self.assertRaises(TypeError):
            EXPECTED_CONTENT_DELTAS['jmdict'] = 0
        manifest = policy_manifest('jmdict')
        manifest['candidateMinusBaselineBytes'] = 0
        self.assertEqual(policy_manifest('jmdict')['candidateMinusBaselineBytes'], 312404)

    def test_each_corpus_accepts_only_its_exact_delta_in_both_directions(self):
        for dictionary in EXPECTED_CONTENT_DELTAS:
            left, right = receipt(dictionary), receipt(dictionary, 'B')
            originals = deepcopy((left, right))
            with self.subTest(dictionary=dictionary):
                compare(left, right, dictionary)
                compare(right, left, dictionary, 'B', 'A')
                compare(left, right, dictionary, 'C', 'B')
                self.assertEqual((left, right), originals)
                if dictionary != 'vndb':
                    with self.assertRaises(ValueError):
                        require_matching_receipts(left, right)

    def test_comparison_copy_changes_only_the_two_declared_numbers(self):
        for dictionary, delta in EXPECTED_CONTENT_DELTAS.items():
            raw = receipt(dictionary, 'B')
            original = deepcopy(raw)
            copied, audit = comparison_receipt(raw, dictionary=dictionary, arm='B')
            self.assertEqual(copied, receipt(dictionary))
            self.assertEqual(raw, original)
            self.assertEqual(audit['adjustedBytes'], delta)
            self.assertEqual(audit['rawReceiptSha256'], receipt_digest(raw))
            self.assertEqual(audit['comparisonReceiptSha256'], receipt_digest(copied))
            copied['common']['fixture']['identity'] = 'mutated copy'
            self.assertEqual(raw, original)

    def test_a_and_c_copies_are_exact_and_their_comparison_has_no_allowance(self):
        for arm in ('A', 'C'):
            raw = receipt()
            copied, audit = comparison_receipt(raw, dictionary='jmdict', arm=arm)
            self.assertEqual(copied, raw)
            self.assertIsNot(copied, raw)
            self.assertEqual(audit['adjustedBytes'], 0)
        compare(receipt(), receipt(), left_arm='A', right_arm='C')
        changed = receipt()
        resize(changed, 0, 1)
        with self.assertRaises(ValueError):
            compare(receipt(), changed, left_arm='A', right_arm='C')

    def test_within_b_arm_is_exact(self):
        compare(receipt(arm='B'), receipt(arm='B'), left_arm='B', right_arm='B')
        changed = receipt(arm='B')
        resize(changed, 0, 1)
        with self.assertRaises(ValueError):
            compare(receipt(arm='B'), changed, left_arm='B', right_arm='B')

    def test_zero_increase_vndb_is_strict(self):
        for delta in (-1, 1, 312404, 750018):
            changed = receipt('vndb', 'B')
            resize(changed, 0, delta)
            with self.subTest(delta=delta), self.assertRaises(ValueError):
                compare(receipt('vndb'), changed, 'vndb')

    def test_missing_wrong_and_off_by_one_deltas_fail(self):
        for dictionary, expected in EXPECTED_CONTENT_DELTAS.items():
            for actual in {expected - 1, expected + 1, 0, 312404, 750018} - {expected}:
                changed = receipt(dictionary)
                resize(changed, 0, actual)
                original = deepcopy(changed)
                with self.subTest(dictionary=dictionary, actual=actual), self.assertRaises(ValueError):
                    compare(receipt(dictionary), changed, dictionary)
                self.assertEqual(changed, original)

    def test_exact_total_increase_in_wrong_file_fails(self):
        changed = receipt()
        resize(changed, 1, EXPECTED_CONTENT_DELTAS['jmdict'])
        with self.assertRaises(ValueError):
            compare(receipt(), changed)

    def test_other_file_changes_cannot_cancel_each_other(self):
        changed = receipt(arm='B')
        resize(changed, 1, 1)
        resize(changed, 2, -1)
        with self.assertRaises(ValueError):
            compare(receipt(), changed)

    def test_two_percent_budget_is_exact_inclusive_and_integer(self):
        for dictionary, delta in EXPECTED_CONTENT_DELTAS.items():
            if delta == 0:
                continue
            total = delta * 50
            compare(receipt(dictionary, total=total), receipt(dictionary, 'B', total=total), dictionary)
            with self.subTest(dictionary=dictionary), self.assertRaises(ValueError):
                compare(receipt(dictionary, total=total - 1), receipt(dictionary, 'B', total=total - 1), dictionary)

    def test_unknown_dictionary_arm_and_flags_fail(self):
        for dictionary, arm in (('unknown', 'A'), ('jmdict', 'a'), ('jmdict', ''), ('jmdict', None)):
            with self.subTest(dictionary=dictionary, arm=arm), self.assertRaises(ValueError):
                comparison_receipt(receipt(), dictionary=dictionary, arm=arm)
        for flags in ({}, {'experimental': True}, False):
            changed = receipt()
            changed['common']['importFlags'] = flags
            with self.subTest(flags=flags), self.assertRaises(ValueError):
                comparison_receipt(changed, dictionary='jmdict', arm='A')
        with self.assertRaises(ValueError):
            comparison_receipt(receipt('jitendex'), dictionary='jmdict', arm='A')

    def test_malformed_storage_fails_without_mutating_input(self):
        mutations = (
            lambda value: storage(value).__setitem__('bytes', storage(value)['bytes'] + 1),
            lambda value: storage(value).__setitem__('kind', 'physical allocation'),
            lambda value: storage(value).__setitem__('extra', 1),
            lambda value: storage(value).__setitem__('files', []),
            lambda value: storage(value)['files'][0].__setitem__('path', 'missing-content'),
            lambda value: storage(value)['files'][1].__setitem__('path', CONTENT_PATH),
            lambda value: storage(value)['files'][0].__setitem__('bytes', True),
            lambda value: storage(value)['files'][0].__setitem__('bytes', 1.0),
            lambda value: storage(value)['files'][0].__setitem__('bytes', -1),
            lambda value: storage(value)['files'][0].__setitem__('bytes', 2 ** 53),
            lambda value: storage(value)['files'][0].__setitem__('unknown', 0),
        )
        for mutation in mutations:
            changed = receipt(arm='B')
            mutation(changed)
            original = deepcopy(changed)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                comparison_receipt(changed, dictionary='jmdict', arm='B')
            self.assertEqual(changed, original)

    def test_original_semantics_browser_lookup_restart_fixture_and_media_stay_binding(self):
        mutations = (
            lambda value: value.__setitem__('browserVersion', '154.0.8000.1'),
            lambda value: value['common']['fixture'].__setitem__('identity', 'wrong'),
            lambda value: value['common']['validation'].__setitem__('termRows', 122),
            lambda value: value['common']['validation'].__setitem__('outputDigestSha256', 'f' * 64),
            lambda value: value['common']['validation']['lookup']['observations'][0].__setitem__('sha256', 'f' * 64),
            lambda value: value['common']['validation']['restart'].__setitem__('contentReadable', False),
            lambda value: value['media'].__setitem__('sha256', 'f' * 64),
            lambda value: value['common']['validation'].__setitem__('new-semantic-field', 1),
        )
        for mutation in mutations:
            changed = receipt(arm='B')
            mutation(changed)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                compare(receipt(), changed)

    def test_full_media_comparison_uses_only_original_explicit_exception(self):
        changed = receipt(arm='B')
        changed['media'] = {'mode': 'all', 'sha256': 'f' * 64, 'bytes': 1000}
        compare(receipt(), changed, compare_media=False)
        with self.assertRaises(ValueError):
            compare(receipt(), changed)
        resize(changed, 0, 1)
        with self.assertRaises(ValueError):
            compare(receipt(), changed, compare_media=False)
        with self.assertRaises(ValueError):
            compare(receipt(), receipt(arm='B'), compare_media=0)


if __name__ == '__main__':
    unittest.main()
