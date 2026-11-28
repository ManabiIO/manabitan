"""Tooling contracts; these do not launch a browser or change package source."""
from copy import deepcopy
from pathlib import Path
import unittest

from activation_overlay import overlay, validate_activation


def fixture():
    index = 'manabitan-term-records/dict-1.mbtr.mbti'
    receipt = {
        'schemaVersion': 1, 'success': True, 'timingEligible': False,
        'floor': 12, 'minimumFloor': 12, 'requestedFlag': True,
        'formatCounts': {'1': 0, '2': 0, '3': 0, '4': 1},
        'formatRows': {'1': 0, '2': 0, '3': 0, '4': 128},
        'format4Rows': 128, 'totalRows': 128, 'chunks': 1,
        'generationMedia': None,
        'database': {'logicalPath': '/dict.sqlite3', 'floor': 12},
        'chunkHeaders': [{'path': index, 'format': 4, 'count': 128, 'firstId': 1, 'fieldBytes': 572}],
        'indexes': [{'path': index, 'rows': 128, 'chunks': 1, 'bytes': 732}],
        'fieldBytes': 572, 'indexBytes': 732,
    }
    expected = {'floor': 12, 'formatCounts': {'4': 1}, 'format4Rows': 128,
                'totalRows': 128, 'chunks': 1, 'requestedFlag': True}
    return receipt, expected


class OverlayContracts(unittest.TestCase):
    def test_exact_overlay_preserves_standard_validation_and_all_existing_source(self):
        root = Path(__file__).resolve().parents[3]
        original = (root / 'test/chromium/extension-two-dictionary-import.e2e.js').read_text()
        result = overlay(original)
        self.assertEqual(result.count('async function collectReferenceFormatActivation('), 1)
        self.assertEqual(result.count('await page.evaluate(collectReferenceFormatActivation,'), 1)
        self.assertEqual(result.count('report.benchmark.validation = {'), 1)
        self.assertEqual(result[result.index('                report.benchmark.validation = {'):],
                         original[original.index('                report.benchmark.validation = {'):])
        self.assertLess(result.index('const media = typeof fixture.mediaFiles'),
                        result.index('await page.evaluate(collectReferenceFormatActivation,'))
        self.assertLess(result.index('const storage = await page.evaluate'),
                        result.index('await page.evaluate(collectReferenceFormatActivation,'))
        with self.assertRaises(ValueError):
            overlay(original + '\n')
        with self.assertRaises(ValueError):
            overlay(result)

    def test_exact_receipt_and_zero_keys(self):
        receipt, expected = fixture()
        summary = validate_activation(receipt, expected)
        self.assertEqual(summary['floor'], 12)
        self.assertEqual(summary['formatCounts']['4'], 1)
        self.assertEqual(receipt, fixture()[0], 'Validation may not normalize or modify source evidence')
        expected['formatCounts'] = {'1': 0, '2': 0, '3': 0, '4': 1}
        validate_activation(receipt, expected)

    def test_disabled_and_enabled_fallback(self):
        for requested in (False, True):
            receipt, expected = fixture()
            receipt.update(floor=10, minimumFloor=10, requestedFlag=requested,
                           format4Rows=0, formatCounts={'1': 0, '2': 1, '3': 0, '4': 0},
                           formatRows={'1': 0, '2': 128, '3': 0, '4': 0})
            receipt['database']['floor'] = 10
            receipt['chunkHeaders'][0]['format'] = 2
            expected.update(floor=10, requestedFlag=requested, format4Rows=0, formatCounts={'2': 1})
            validate_activation(receipt, expected)

    def test_incomplete_or_self_inconsistent_evidence_is_rejected(self):
        mutations = [
            lambda r: r.update(success=False),
            lambda r: r.update(schemaVersion=True),
            lambda r: r.update(timingEligible=True),
            lambda r: r.update(floor=11),
            lambda r: r.update(requestedFlag=False),
            lambda r: r.update(format4Rows=127),
            lambda r: r.update(totalRows=True),
            lambda r: r.update(chunks=0),
            lambda r: r.update(minimumFloor=11),
            lambda r: r['formatCounts'].update({'5': 0}),
            lambda r: r['formatCounts'].update({'4': True}),
            lambda r: r['formatRows'].update({'4': 127}),
            lambda r: r['database'].update(logicalPath='/unknown'),
            lambda r: r['database'].update(floor=11),
            lambda r: r['chunkHeaders'][0].update(format=2),
            lambda r: r['chunkHeaders'][0].update(firstId=2),
            lambda r: r['chunkHeaders'][0].update(count=127),
            lambda r: r['chunkHeaders'][0].update(path='unknown'),
            lambda r: r['indexes'][0].update(bytes=731),
            lambda r: r.update(fieldBytes=573),
        ]
        original, expected = fixture()
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                receipt = deepcopy(original)
                mutate(receipt)
                with self.assertRaises(ValueError):
                    validate_activation(receipt, expected)


if __name__ == '__main__':
    unittest.main()
