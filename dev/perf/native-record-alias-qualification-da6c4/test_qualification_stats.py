# SPDX-License-Identifier: GPL-3.0-or-later
import unittest
from qualification_stats import analyze, schedule


def observations(order='AB', a=1000, b=850, c=1001):
    return [{**item, 'totalImportMs': {'A': a, 'B': b, 'C': c}[item['arm']]} for item in schedule(order)]


class StatsTests(unittest.TestCase):
    def test_schedule(self):
        for order in ('AB', 'BA'):
            values = schedule(order)
            self.assertEqual(len(values), 36)
            self.assertEqual(len({value['id'] for value in values}), 36)
            self.assertEqual([value['arm'] for value in values[:4]], list(order + order[::-1]))
            self.assertEqual(sum(value['kind'] == 'candidate' for value in values), 24)
            self.assertEqual(sum(value['kind'] == 'control' for value in values), 8)
        self.assertEqual([x['arm'] for x in schedule('AB') if x['kind'] == 'control'], list('ACCAACCA'))
        self.assertEqual([x['arm'] for x in schedule('BA') if x['kind'] == 'control'], list('CAACCAAC'))

    def test_clear_vndb_gain(self):
        result = analyze(observations(), 'vndb', 'AB')
        self.assertTrue(result['passesProspectiveTimingScreen'])
        self.assertEqual(result['candidateVsBaseline']['medianPairedChangeMs'], -150)
        self.assertEqual(result['candidateVsBaseline']['descriptiveBootstrap95Ms'], [-150, -150])
        self.assertEqual(result['candidateVsBaseline']['fasterPairs'], 12)

    def test_absolute_threshold(self):
        result = analyze(observations(a=500, b=450, c=500), 'vndb', 'AB')
        self.assertFalse(result['passesProspectiveTimingScreen'])
        self.assertFalse(result['gates']['medianSavingAtLeast100Ms'])

    def test_control_rejects_apparent_gain(self):
        result = analyze(observations(a=3000, b=2850, c=3090), 'vndb', 'AB')
        self.assertFalse(result['passesProspectiveTimingScreen'])
        self.assertFalse(result['gates']['controlMedianBelowHalfSmallerSaving'])

    def test_tail_is_retained(self):
        values = observations()
        next(x for x in values if x['id'] == 'pair-12-B')['totalImportMs'] = 5000
        result = analyze(values, 'vndb', 'AB')
        self.assertFalse(result['passesProspectiveTimingScreen'])
        self.assertFalse(result['gates']['candidateEqualWorkStrictlyLower'])
        self.assertEqual(result['candidateVsBaseline']['pairs'][-1]['B'], 5000)

    def test_non_target_guard(self):
        self.assertTrue(analyze(observations('BA', b=1005, c=1000), 'jmdict', 'BA')['passesProspectiveTimingScreen'])
        self.assertFalse(analyze(observations('BA', b=1020, c=1000), 'jitendex', 'BA')['passesProspectiveTimingScreen'])
        self.assertFalse(analyze(observations(b=1000, c=1011), 'jmdict', 'AB')['passesProspectiveTimingScreen'])

    def test_incomplete_or_misordered_rejected(self):
        with self.assertRaises(ValueError): analyze(observations()[:-1], 'vndb', 'AB')
        values = observations(); values[4], values[5] = values[5], values[4]
        with self.assertRaises(ValueError): analyze(values, 'vndb', 'AB')
        values = observations(); values[0]['totalImportMs'] = float('nan')
        with self.assertRaises(ValueError): analyze(values, 'vndb', 'AB')


if __name__ == '__main__':
    unittest.main()
