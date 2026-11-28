# SPDX-License-Identifier: GPL-3.0-or-later
import collections
import unittest

from run import ORDERS, paired_summary, plan


class ProtocolTests(unittest.TestCase):
    def test_balances_every_position_and_carries_unchanged_control(self):
        for replication in (1, 2):
            rows = plan(replication)
            self.assertEqual(len(rows), 39)
            self.assertEqual(collections.Counter(row['arm'] for row in rows[:3]), {'A': 1, 'B': 1, 'C': 1})
            timed = rows[3:]
            for position in range(3):
                self.assertEqual(collections.Counter(row['arm'] for row in timed[position::3]), {'A': 4, 'B': 4, 'C': 4})
            self.assertEqual(len({row['id'] for row in rows}), 39)

    def test_second_host_reverses_every_complete_block(self):
        left, right = plan(1)[3:], plan(2)[3:]
        for index in range(0, len(ORDERS) * 3, 3):
            self.assertEqual([row['arm'] for row in left[index:index + 3]][::-1], [row['arm'] for row in right[index:index + 3]])

    def test_pairs_by_block_without_control_subtraction(self):
        rows = [{**item, 'totalImportMs': {'A': 100, 'B': 90, 'C': 105}[item['arm']]} for item in plan(1)]
        self.assertAlmostEqual(paired_summary(rows, 'B', 'A')['medianPairedChangePercent'], -10)
        self.assertAlmostEqual(paired_summary(rows, 'B', 'C')['medianPairedChangePercent'], 100 * (90 / 105 - 1))
        self.assertAlmostEqual(paired_summary(rows, 'C', 'A')['medianPairedChangePercent'], 5)
        self.assertEqual(paired_summary(rows, 'B', 'A')['fasterPairs'], 12)

    def test_rejects_incomplete_cohort(self):
        rows = [{**item, 'totalImportMs': 100} for item in plan(1)]
        with self.assertRaises(ValueError):
            paired_summary(rows[:-1], 'B', 'A')


if __name__ == '__main__':
    unittest.main()
