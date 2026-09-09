"""Regression tests for complete-plan statistics; synthetic timings are not performance data."""
import copy
import math
import unittest
from paired import effects, schedule, validate, PACKAGE


class ProtocolTests(unittest.TestCase):
    def test_balanced_fixed_schedule_and_controls(self):
        for reverse in (False, True):
            plan = schedule(6, reverse)
            self.assertEqual(len(plan), 18)
            self.assertEqual(sum(p['kind'] == 'warmup' for p in plan), 2)
            self.assertEqual(sum(p['kind'] == 'aa' for p in plan), 4)
            for pair in range(1, 7):
                group = [p for p in plan if p['kind'] == 'ab' and p['pair'] == pair]
                self.assertEqual({p['arm'] for p in group}, {'baseline', 'candidate'})
                if pair > 1:
                    self.assertNotEqual(group[0]['arm'], previous)
                previous = group[0]['arm']
            for pair in (2, 5):
                group = [p for p in plan if p['kind'] == 'aa' and p['pair'] == pair]
                self.assertEqual(group[0]['arm'], group[1]['arm'])

    def test_invalid_pair_counts(self):
        for value in (-1, 0, 2, 3, 5):
            with self.assertRaises(ValueError):
                schedule(value)

    def test_slow_observation_cannot_be_hidden_by_paired_median(self):
        plan = schedule(4)
        runs = [dict(p, elapsed_ms=100) for p in plan]
        values = iter([90, 91, 92, 190])
        for r in runs:
            if r['kind'] == 'ab' and r['arm'] == 'candidate':
                r['elapsed_ms'] = next(values)
        result = effects(plan, runs)
        self.assertLess(result['median_paired_percent'], 0)
        self.assertGreater(result['total_equal_work_percent'], 0)
        self.assertAlmostEqual(result['worst_pair_percent'], 90)
        self.assertEqual(result['faster_pairs'], 3)

    def test_incomplete_and_reordered_fail_closed(self):
        plan = schedule(4)
        runs = [dict(p, elapsed_ms=100) for p in plan]
        with self.assertRaises(ValueError):
            effects(plan, runs[:-1])
        runs[2], runs[3] = runs[3], runs[2]
        with self.assertRaises(ValueError):
            effects(plan, runs)

    def valid(self):
        fixture = dict(expectedTitle='fixture', revision='v1', termRows=10)
        source = dict(commit='abc', package_sha256='123', bank_count=4)
        run = dict(totalImportMs=100, validation=dict(title='fixture', revision='v1', termRows=10,
                   contentReadable=True, probeCount=12), importDebug=dict(importerPhaseTimings=[
            dict(phase='term-file-fast-path:terms', details=dict(rows=10, batchedFileCount=4,
                sourceBatchMaxBytes=64*1024*1024, parserSourceTransferredBytes=40))]))
        summary = dict(schemaVersion=3, authoritativeTiming=True, traceEnabled=False,
            dictionary='jmdict', fixture=fixture, importFlags=None, runs=[run],
            source=dict(gitSha='abc', dirty=False, sha256={PACKAGE:'123'}))
        report = dict(status='success', skippedVerification=False,
                      benchmark=dict(productionImportDefaults=True))
        return summary, report, fixture, source

    def test_validation_and_missing_metrics(self):
        summary, report, fixture, source = self.valid()
        result = validate(summary, report, 'jmdict', fixture, 'low', source)
        self.assertEqual(result['elapsed_ms'], 100)
        self.assertIsNone(result['source_metrics']['parserSourceInflateMs'])

    def test_invalid_timings(self):
        for value in (0, -1, math.nan, math.inf, True, None):
            summary, report, fixture, source = self.valid()
            summary['runs'][0]['totalImportMs'] = value
            with self.assertRaises(ValueError):
                validate(summary, report, 'jmdict', fixture, 'low', source)

    def test_protocol_mutations(self):
        for field, value in [('schemaVersion', 2), ('traceEnabled', True),
                ('authoritativeTiming', False), ('dictionary', 'other'), ('importFlags', {})]:
            summary, report, fixture, source = self.valid()
            summary[field] = value
            with self.assertRaises(ValueError):
                validate(summary, report, 'jmdict', fixture, 'low', source)
        summary, report, fixture, source = self.valid()
        for field, value in [('status', 'failure'), ('skippedVerification', True)]:
            bad = copy.deepcopy(report)
            bad[field] = value
            with self.assertRaises(ValueError):
                validate(summary, bad, 'jmdict', fixture, 'low', source)

    def test_dirty_source_policy_and_incomplete_accounting(self):
        for mutation in ('source', 'policy', 'rows', 'files', 'package'):
            summary, report, fixture, source = self.valid()
            details = summary['runs'][0]['importDebug']['importerPhaseTimings'][0]['details']
            if mutation == 'source': summary['source']['dirty'] = True
            if mutation == 'policy': details['sourceBatchMaxBytes'] *= 3
            if mutation == 'rows': details['rows'] -= 1
            if mutation == 'files': details['batchedFileCount'] -= 1
            if mutation == 'package': summary['source']['sha256'][PACKAGE] = 'wrong'
            with self.assertRaises(ValueError):
                validate(summary, report, 'jmdict', fixture, 'low', source)


if __name__ == '__main__':
    unittest.main()
