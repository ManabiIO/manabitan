# SPDX-License-Identifier: GPL-3.0-or-later
"""Rejection tests for the separate physical/decoded compression proof policy."""

from copy import deepcopy
import hashlib
import json
import unittest

from compression_proof_receipts import (
    BASELINE_SHA, STORAGE_PREDICTION_BASELINE_SHA, PRODUCT_SOURCE_SHA,
    CONTENT_PATH, LOGICAL_DOMAIN, PROOF_DOMAIN, REFERENCE_TAG, comparison_receipt, policy_manifest,
    require_matching_trial_receipts, validate_compression_proof,
)
from compression_receipts import EXPECTED_CONTENT_DELTAS
from qualification_receipts import require_matching_receipts
from test_qualification_receipts import change_validation, observation, validate


def json_witness(value, key='json'):
    text = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    raw = text.encode('utf-8')
    return {key: text, 'utf8Bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def fixture(dictionary='jmdict', arm='A', *, unavailable=False):
    summary, report = observation(dictionary)
    validation = summary['runs'][0]['validation']
    terms, title = validation['probeTerms'], validation['title']
    delta = EXPECTED_CONTENT_DELTAS[dictionary] if arm == 'B' else 0
    content_size = 50000000 + delta
    content = next(item for item in validation['storage']['files'] if item['path'] == CONTENT_PATH)
    validation['storage']['bytes'] += content_size - content['bytes']
    content['bytes'] = content_size
    physical, references, decoded = [], [], []
    for index, term in enumerate(terms):
        offset = 1000 + index * 128 + (250 if arm == 'B' else 0)
        result = {'dictionaryEntries': [{'headwords': [{'term': term, 'reading': ''}],
                   'definitions': [{'dictionary': title, 'entries': ['exact full definition', {'text': '𠮷'}]}]}],
                  'originalTextLength': len(term.encode('utf-16-le')) // 2}
        witness = json_witness(result, 'resultJson')
        decoded.append({'term': term, **witness, 'results': 1,
                        'originalTextLength': result['originalTextLength'], 'hasExactHeadwordMatch': True})
        for row in validation['lookup']['observations']:
            if row['term'] == term:
                row['sha256'] = witness['sha256']
        physical.append({'term': term, 'probes': [{
            'term': term, 'totalLength': -1 if unavailable else content_size,
            'rowSampleCount': 1, 'inBoundsRowCount': 0 if unavailable else 1,
            'outOfBoundsRowCount': 0, 'glossaryReadyRowCount': 1, 'readablePreviewRowCount': 1,
            'rowSample': [{'rawEntryContentOffset': offset, 'rawEntryContentLength': 32,
                           'glossaryLength': 1, 'rawContentPreview': 'physical ' + arm}],
        }]})
        references.append({'term': term, 'probes': [{'term': term, 'rows': [{
            'id': index, 'dictionary': title, 'matchSource': 'expression', 'expression': term,
            'reading': '', 'rawEntryContentOffset': offset, 'rawEntryContentLength': 32,
            'rawEntryContentDictName': REFERENCE_TAG, 'glossaryLength': 1,
            'decodedContentLength': 32, 'readErrorDetails': None,
        }]}]})
    witness = json_witness(physical)
    validation['outputDigestSha256'] = witness['sha256']
    change_validation(summary, report, lambda value: None)
    proof = {'schemaVersion': 1, 'domain': PROOF_DOMAIN,
             'dictionary': {key: deepcopy(validation[key]) for key in ('title', 'revision', 'probeTerms')},
             'physical': {'preRestart': deepcopy(witness), 'postRestart': deepcopy(witness)},
             'references': {'preRestart': deepcopy(references), 'postRestart': deepcopy(references)},
             'decoded': {'preRestart': deepcopy(decoded), 'postRestart': deepcopy(decoded)}}
    report['benchmark']['compressionProof'] = deepcopy(proof)
    receipt = validate(summary, report)
    return receipt, proof, summary, report


def compare(left, right, dictionary='jmdict', left_arm='A', right_arm='B', compare_media=True):
    return require_matching_trial_receipts(left[0], right[0], reference_proof=left[1],
        candidate_proof=right[1], dictionary=dictionary, reference_arm=left_arm,
        candidate_arm=right_arm, compare_media=compare_media)


def rewrite_physical(value, change):
    receipt, proof = value[:2]
    data = json.loads(proof['physical']['preRestart']['json'])
    change(data)
    witness = json_witness(data)
    proof['physical'] = {'preRestart': deepcopy(witness), 'postRestart': deepcopy(witness)}
    receipt['common']['validation']['outputDigestSha256'] = witness['sha256']


def change_references(value, change):
    for stage in ('preRestart', 'postRestart'):
        change(value[1]['references'][stage][0]['probes'][0]['rows'][0])


class CompressionProofPolicyTests(unittest.TestCase):
    def test_active_baseline_is_distinct_from_unchanged_historical_predictions(self):
        self.assertEqual(BASELINE_SHA, 'dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16')
        self.assertEqual(STORAGE_PREDICTION_BASELINE_SHA, '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2')
        self.assertEqual(PRODUCT_SOURCE_SHA, 'f7980e638ea1808701ac28339987663fd8b3dc4e')
        for dictionary, delta in (('jmdict', 312404), ('jitendex', 750018)):
            manifest = policy_manifest(dictionary)
            self.assertEqual(manifest['baselineSha'], BASELINE_SHA)
            self.assertEqual(manifest['compressionProductOriginSha'], PRODUCT_SOURCE_SHA)
            self.assertEqual(manifest['historicalStoragePredictionBaselineSha'], STORAGE_PREDICTION_BASELINE_SHA)
            self.assertEqual(manifest['originalStoragePolicy']['baselineSha'], STORAGE_PREDICTION_BASELINE_SHA)
            self.assertEqual(EXPECTED_CONTENT_DELTAS[dictionary], delta)

    def test_exact_original_validator_then_new_cross_layout_policy_for_both_corpora(self):
        for dictionary in ('jmdict', 'jitendex'):
            with self.subTest(dictionary=dictionary):
                left, right = fixture(dictionary), fixture(dictionary, 'B')
                before = deepcopy((left, right))
                compare(left, right, dictionary)
                compare(right, left, dictionary, 'B', 'A')
                compare(left, right, dictionary, 'C', 'B')
                with self.assertRaises(ValueError):
                    require_matching_receipts(left[0], right[0])
                self.assertEqual((left, right), before)
                self.assertNotIn('compressionProof', left[2]['runs'][0]['validation'])
                self.assertIn('compressionProof', left[3]['benchmark'])

    def test_matching_unavailable_store_sentinel_is_allowed_but_transition_is_not(self):
        compare(fixture(unavailable=True), fixture(arm='B', unavailable=True))
        with self.assertRaises(ValueError):
            compare(fixture(unavailable=True), fixture(arm='B'))

    def test_only_labeled_storage_numbers_and_computed_digest_change(self):
        for arm in ('A', 'B', 'C'):
            raw, proof, _, _ = fixture(arm='B' if arm == 'B' else 'A')
            before = deepcopy((raw, proof))
            copied, audit = comparison_receipt(raw, proof, dictionary='jmdict', arm=arm)
            expected = deepcopy(raw)
            size = EXPECTED_CONTENT_DELTAS['jmdict'] if arm == 'B' else 0
            expected['common']['validation']['storage']['bytes'] -= size
            next(row for row in expected['common']['validation']['storage']['files'] if row['path'] == CONTENT_PATH)['bytes'] -= size
            del expected['common']['validation']['outputDigestSha256']
            expected['common']['validation']['compressionLogicalProjection'] = {
                'domain': LOGICAL_DOMAIN,
                'sha256': validate_compression_proof(raw, proof, dictionary='jmdict')['logicalSha256'],
            }
            self.assertEqual(copied, expected)
            self.assertEqual(audit['originalStorageAudit']['adjustedBytes'], size)
            self.assertEqual((raw, proof), before)

    def test_raw_same_arm_and_a_c_stability_remains_mandatory(self):
        for left_arm, right_arm in (('A', 'A'), ('A', 'C'), ('C', 'A'), ('B', 'B')):
            left = fixture(arm='B' if left_arm == 'B' else 'A')
            right = deepcopy(left)
            compare(left, right, left_arm=left_arm, right_arm=right_arm)
            rewrite_physical(right, lambda data: data[0]['probes'][0]['rowSample'][0].__setitem__('rawContentPreview', 'other readable physical bytes'))
            with self.subTest(pair=(left_arm, right_arm)), self.assertRaises(ValueError):
                compare(left, right, left_arm=left_arm, right_arm=right_arm)

    def test_missing_old_trial_proof_and_unknown_dictionary_or_schema_fail(self):
        raw, proof, _, _ = fixture()
        for value in (None, {}, {**proof, 'schemaVersion': 2}, {**proof, 'schemaVersion': True},
                      {**proof, 'domain': 'other'}, {**proof, 'unexpected': 1}):
            with self.subTest(value=value if value is None else type(value)), self.assertRaises(ValueError):
                comparison_receipt(raw, value, dictionary='jmdict', arm='A')
        for dictionary in ('vndb', 'unknown'):
            with self.assertRaises(ValueError):
                policy_manifest(dictionary)
        raw['common']['validation']['compressionLogicalProjection'] = {'domain': LOGICAL_DOMAIN, 'sha256': 'f' * 64}
        with self.assertRaises(ValueError):
            comparison_receipt(raw, proof, dictionary='jmdict', arm='A')

    def test_original_physical_preimage_hash_bytes_and_receipt_binding_fail_closed(self):
        for change in (
            lambda p: p['physical']['preRestart'].__setitem__('sha256', 'a' * 64),
            lambda p: p['physical']['preRestart'].__setitem__('utf8Bytes', 1),
            lambda p: p['physical']['preRestart'].__setitem__('json', '[]'),
            lambda p: p['physical']['preRestart'].__setitem__('extra', 1),
        ):
            raw, proof, _, _ = fixture()
            change(proof)
            with self.assertRaises(ValueError):
                comparison_receipt(raw, proof, dictionary='jmdict', arm='A')
        raw, proof, _, _ = fixture()
        raw['common']['validation']['outputDigestSha256'] = 'b' * 64
        with self.assertRaises(ValueError):
            comparison_receipt(raw, proof, dictionary='jmdict', arm='A')

    def test_duplicate_json_keys_and_nonfinite_json_are_rejected_even_with_valid_hash(self):
        for text in ('{"x":1,"x":2}', '[NaN]'):
            raw, proof, _, _ = fixture()
            witness = {'json': text, 'utf8Bytes': len(text.encode()), 'sha256': hashlib.sha256(text.encode()).hexdigest()}
            proof['physical'] = {'preRestart': witness, 'postRestart': deepcopy(witness)}
            raw['common']['validation']['outputDigestSha256'] = witness['sha256']
            with self.assertRaises(ValueError):
                comparison_receipt(raw, proof, dictionary='jmdict', arm='A')

    def test_reference_success_requires_exact_format_length_dictionary_and_nonnullable_fields(self):
        for key, value in (
            ('id', None), ('id', True), ('id', -1), ('id', 2 ** 53),
            ('dictionary', 'wrong'), ('matchSource', ''), ('expression', None), ('reading', None),
            ('rawEntryContentDictName', 'raw'), ('rawEntryContentDictName', 'raw-block-v1:jmdict'),
            ('rawEntryContentDictName', 'raw-block-v2:other'), ('decodedContentLength', None),
            ('decodedContentLength', 31), ('rawEntryContentLength', 0), ('glossaryLength', 0),
            ('readErrorDetails', {'message': 'unreadable'}),
        ):
            value_set = fixture(arm='B')
            change_references(value_set, lambda row: row.__setitem__(key, value))
            with self.subTest(field=key, value=value), self.assertRaises(ValueError):
                comparison_receipt(value_set[0], value_set[1], dictionary='jmdict', arm='B')

    def test_safe_compact_reference_bounds_and_physical_binding_are_mandatory(self):
        for offset in (-1, True, 2 ** 53, 50312404 - 19):
            value = fixture(arm='B')
            change_references(value, lambda row: row.__setitem__('rawEntryContentOffset', offset))
            rewrite_physical(value, lambda data: data[0]['probes'][0]['rowSample'][0].__setitem__('rawEntryContentOffset', offset))
            with self.subTest(offset=offset), self.assertRaises(ValueError):
                comparison_receipt(value[0], value[1], dictionary='jmdict', arm='B')
        value = fixture(arm='B')
        change_references(value, lambda row: row.__setitem__('rawEntryContentOffset', 2501))
        with self.assertRaises(ValueError):
            comparison_receipt(value[0], value[1], dictionary='jmdict', arm='B')

    def test_unknown_or_missing_row_fields_fail(self):
        for action in (lambda row: row.__setitem__('extra', 1), lambda row: row.pop('id')):
            value = fixture()
            change_references(value, action)
            with self.assertRaises(ValueError):
                comparison_receipt(value[0], value[1], dictionary='jmdict', arm='A')

    def test_physical_total_counts_preview_and_row_coverage_cannot_be_waived(self):
        for change in (
            lambda p: p.__setitem__('totalLength', 50000001),
            lambda p: p.__setitem__('totalLength', None),
            lambda p: p.__setitem__('rowSampleCount', 2),
            lambda p: p.__setitem__('outOfBoundsRowCount', 1),
            lambda p: p.__setitem__('inBoundsRowCount', 0),
            lambda p: p.__setitem__('glossaryReadyRowCount', 0),
            lambda p: p.__setitem__('readablePreviewRowCount', 0),
            lambda p: p['rowSample'][0].__setitem__('rawContentPreview', '<read-failed>'),
            lambda p: p['rowSample'][0].__setitem__('rawContentPreview', ''),
            lambda p: p['rowSample'][0].__setitem__('rawEntryContentLength', 33),
        ):
            value = fixture()
            rewrite_physical(value, lambda data: change(data[0]['probes'][0]))
            with self.assertRaises(ValueError):
                comparison_receipt(value[0], value[1], dictionary='jmdict', arm='A')

    def test_semantic_reference_identity_cannot_change_across_arms(self):
        for key, changed in (('id', 99), ('matchSource', 'reading'), ('expression', 'different'), ('reading', 'different')):
            left, right = fixture(), fixture(arm='B')
            change_references(right, lambda row: row.__setitem__(key, changed))
            with self.subTest(field=key), self.assertRaises(ValueError):
                compare(left, right)

    def test_physical_reference_and_decoded_restart_changes_fail(self):
        for domain in ('physical', 'references', 'decoded'):
            value = fixture()
            value[1][domain]['postRestart'] = None
            with self.subTest(domain=domain), self.assertRaises(ValueError):
                comparison_receipt(value[0], value[1], dictionary='jmdict', arm='A')

    def test_full_decoded_json_is_bound_to_counts_exact_headwords_and_all_lookup_passes(self):
        for change in (
            lambda p: p['decoded']['preRestart'][0].__setitem__('utf8Bytes', 1),
            lambda p: p['decoded']['preRestart'][0].__setitem__('sha256', 'f' * 64),
            lambda p: p['decoded']['preRestart'][0].__setitem__('results', 2),
            lambda p: p['decoded']['preRestart'][0].__setitem__('hasExactHeadwordMatch', False),
            lambda p: p['decoded']['preRestart'][0].__setitem__('originalTextLength', 0),
            lambda p: p['decoded']['preRestart'].pop(),
        ):
            value = fixture();change(value[1])
            with self.assertRaises(ValueError):
                comparison_receipt(value[0], value[1], dictionary='jmdict', arm='A')
        value = fixture()
        value[0]['common']['validation']['lookup']['observations'][-1]['sha256'] = 'f' * 64
        with self.assertRaises(ValueError):
            comparison_receipt(value[0], value[1], dictionary='jmdict', arm='A')

    def test_self_consistent_but_different_decoded_result_still_fails_cross_arm(self):
        left, right = fixture(), fixture(arm='B')
        for stage in ('preRestart', 'postRestart'):
            row = right[1]['decoded'][stage][0]
            result = json.loads(row['resultJson'])
            result['dictionaryEntries'][0]['definitions'][0]['entries'][0] = 'different full definition'
            row.update(json_witness(result, 'resultJson'))
        changed = right[1]['decoded']['postRestart'][0]
        for row in right[0]['common']['validation']['lookup']['observations']:
            if row['term'] == changed['term']:
                row['sha256'] = changed['sha256']
        validate_compression_proof(right[0], right[1], dictionary='jmdict')
        with self.assertRaises(ValueError):
            compare(left, right)

    def test_exact_storage_delta_budget_other_files_and_flags_are_not_weakened(self):
        for change in (
            lambda s: (s.__setitem__('bytes', s['bytes'] + 1), s['files'][0].__setitem__('bytes', s['files'][0]['bytes'] + 1)),
            lambda s: s.__setitem__('bytes', s['bytes'] - 1),
        ):
            left, right = fixture(), fixture(arm='B')
            change(right[0]['common']['validation']['storage'])
            with self.assertRaises(ValueError):compare(left, right)
        left, right = fixture(), fixture(arm='B')
        right[0]['common']['importFlags'] = {}
        with self.assertRaises(ValueError):compare(left, right)
        # The unchanged storage policy's integer budget is exercised directly;
        # the proof cannot waive it merely by carrying valid decoded witnesses.
        right = fixture(arm='B')
        content = next(row for row in right[0]['common']['validation']['storage']['files'] if row['path'] == CONTENT_PATH)
        shrink = content['bytes'] - 1000000
        content['bytes'] -= shrink;right[0]['common']['validation']['storage']['bytes'] -= shrink
        rewrite_physical(right, lambda data: [p.__setitem__('totalLength', 1000000) for g in data for p in g['probes']])
        with self.assertRaises(ValueError):comparison_receipt(right[0], right[1], dictionary='jmdict', arm='B')

    def test_original_media_exception_is_explicit_and_other_semantics_remain_exact(self):
        left, right = fixture(), fixture(arm='B')
        right[0]['media'] = {'mode': 'all', 'sha256': 'f' * 64, 'bytes': 1000}
        compare(left, right, compare_media=False)
        with self.assertRaises(ValueError):compare(left, right)
        with self.assertRaises(ValueError):compare(left, right, compare_media=0)
        for path in ('browserVersion', 'newSemanticField'):
            left, right = fixture(), fixture(arm='B')
            if path == 'browserVersion':right[0][path] = 'different'
            else:right[0]['common']['validation'][path] = 1
            with self.subTest(field=path), self.assertRaises(ValueError):compare(left, right)


if __name__ == '__main__':
    unittest.main()
