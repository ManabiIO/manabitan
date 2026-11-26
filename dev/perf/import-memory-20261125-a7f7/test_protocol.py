# SPDX-License-Identifier: GPL-3.0-or-later
"""Retained paired-memory gate witness, independent of dictionary storage policy."""

import copy
import unittest

from protocol import memory_comparison, schedule


class ProtocolWitness(unittest.TestCase):
    def test_fixed_pairing_gates_each_metric_and_preserves_invalid_pairs(self):
        for replication in (1, 2):
            rows = [{**item, 'qualifiedForWholeTreePss': True,
                     'maxSampledPssKiB': 1000 if item['arm'] == 'A' else 1040,
                     'maxSampledPrivateKiB': 1000 if item['arm'] == 'A' else 1040}
                    for item in schedule(replication)]
            self.assertTrue(memory_comparison(rows, 'jmdict', replication, schedule)['passesProspectiveMemoryScreen'])
            # A good median cannot mask a >10% individual increase.
            changed = copy.deepcopy(rows)
            for item in changed:
                if item['arm'] == 'B':
                    item['maxSampledPrivateKiB'] = 900 if item['pair'] == 1 else 1110
            result = memory_comparison(changed, 'jmdict', replication, schedule)
            self.assertFalse(result['passesProspectiveMemoryScreen'])
            self.assertLess(result['metrics']['maxSampledPrivateKiB']['medianPairedChangePercent'], 5)
            changed = copy.deepcopy(rows)
            changed[0].update(qualifiedForWholeTreePss=False, maxSampledPssKiB=None, maxSampledPrivateKiB=None)
            result = memory_comparison(changed, 'jmdict', replication, schedule)
            self.assertFalse(result['everyObservationQualified'])
            self.assertIsNone(result['pairs'][0]['maxSampledPssKiB']['changePercent'])
            self.assertIsNotNone(result['pairs'][1]['maxSampledPssKiB']['changePercent'])
            self.assertIsNone(result['metrics']['maxSampledPssKiB']['medianPairedChangePercent'])
            with self.assertRaises(ValueError):
                memory_comparison(rows[:-1], 'jmdict', replication, schedule)


if __name__ == '__main__':
    unittest.main()
