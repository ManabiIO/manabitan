#!/usr/bin/env python3
"""Focused tests for strict post-acquisition CRC evidence validation."""

import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('audit_crc', Path(__file__).with_name('audit-crc.py'))
audit_crc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit_crc)


def report_for(dictionary):
    metrics = copy.deepcopy(audit_crc.EXPECTED[dictionary])
    phase = f"term-file-fast-path:term_bank_1.json..term_bank_{metrics['parserBankSpanCount']}.json"
    return {'phases': [{'data': {'kind': 'dictionary-import', 'importDebugHistory': [
        {'importerPhaseTimings': [{'phase': phase, 'details': metrics}]},
    ]}}]}


def details(report):
    return report['phases'][0]['data']['importDebugHistory'][0]['importerPhaseTimings'][0]['details']


def plan_for(dictionary, first):
    return {'baseline': audit_crc.BASELINE, 'candidate': 'b' * 40, 'dictionary': dictionary,
            'initialOrder': first, 'pairs': 12, 'flags': {}, 'expectedWorkers': None,
            'expectedPackageEntries': audit_crc.PACKAGE_ENTRIES,
            'schedule': audit_crc.timing_schedule(first),
            'memorySchedule': audit_crc.memory_schedule(1 if first == 'AB' else 2),
            'vndbSahAllocationPolicy': {'unitBytes': 4096, 'rangeUnits': [37, 37], 'origin': 'explicit'} if dictionary == 'vndb' else None}


class CrcAuditTests(unittest.TestCase):
    def test_accepts_exact_current_counts(self):
        for dictionary in audit_crc.EXPECTED:
            self.assertEqual(audit_crc.extract_metrics(report_for(dictionary), dictionary), audit_crc.EXPECTED[dictionary])

    def test_rejects_each_changed_or_missing_counter(self):
        for key, expected in audit_crc.EXPECTED['vndb'].items():
            for invalid in [None, True, str(expected), -1, expected + 1, 2 ** 53]:
                report = report_for('vndb')
                details(report)[key] = invalid
                with self.assertRaises(ValueError, msg=(key, invalid)):
                    audit_crc.extract_metrics(report, 'vndb')
            report = report_for('vndb')
            del details(report)[key]
            with self.assertRaises(ValueError, msg=key):
                audit_crc.extract_metrics(report, 'vndb')

    def test_rejects_ambiguous_or_wrong_source_phases(self):
        report = report_for('vndb')
        report['phases'].append(copy.deepcopy(report['phases'][0]))
        with self.assertRaises(ValueError):
            audit_crc.extract_metrics(report, 'vndb')
        report = report_for('vndb')
        timings = report['phases'][0]['data']['importDebugHistory'][0]['importerPhaseTimings']
        timings.append(copy.deepcopy(timings[0]))
        with self.assertRaises(ValueError):
            audit_crc.extract_metrics(report, 'vndb')
        timings.pop()
        timings[0]['phase'] = 'term-file-fast-path:term_bank_1.json..term_bank_664.json'
        with self.assertRaises(ValueError):
            audit_crc.extract_metrics(report, 'vndb')

    def test_requires_the_full_unchanged_schedule(self):
        for dictionary in audit_crc.EXPECTED:
            for first in ['AB', 'BA']:
                plan = plan_for(dictionary, first)
                observations = audit_crc.original_observations(plan)
                self.assertEqual(len(observations), 42)
                self.assertEqual(len({item['path'] for item in observations}), 42)
                for mutation in ['missing', 'duplicate', 'flags', 'allocation']:
                    changed = copy.deepcopy(plan)
                    if mutation == 'missing':
                        changed['schedule'].pop()
                    elif mutation == 'duplicate':
                        changed['schedule'][1] = changed['schedule'][0]
                    elif mutation == 'flags':
                        changed['flags'] = {'experimentalSkipFusedParse': True}
                    else:
                        changed['vndbSahAllocationPolicy'] = {'unitBytes': 4096, 'rangeUnits': [36, 38], 'origin': 'explicit'}
                    with self.assertRaises(ValueError, msg=(dictionary, first, mutation)):
                        audit_crc.original_observations(changed)

    def test_preserves_and_reports_missing_failed_and_unplanned_observations(self):
        with tempfile.TemporaryDirectory(prefix='manabitan-crc-audit-') as directory:
            root = Path(directory)
            plan = plan_for('vndb', 'BA')
            (root / 'registered-plan.json').write_text(json.dumps(plan))
            observations = audit_crc.original_observations(plan)
            for item in observations:
                destination = root / item['path'] / 'run-1.json'
                destination.parent.mkdir(parents=True)
                destination.write_text(json.dumps(report_for('vndb')))
            result = audit_crc.audit(root)
            self.assertTrue(result['passed'])
            self.assertEqual(len(result['observations']), 42)
            missing = root / observations[0]['path'] / 'run-1.json'
            missing.unlink()
            failed = root / observations[1]['path'] / 'run-1.json'
            report = report_for('vndb')
            details(report)['parserFusedFallbacks'] = 1
            failed.write_text(json.dumps(report))
            extra = root / 'replacement' / 'run-1.json'
            extra.parent.mkdir()
            extra.write_text(json.dumps(report_for('vndb')))
            result = audit_crc.audit(root)
            self.assertFalse(result['passed'])
            self.assertEqual(len(result['failures']), 3)
            self.assertEqual(len(result['observations']), 40)
            self.assertTrue(extra.exists())
            self.assertEqual(json.loads(failed.read_text()), report)
            self.assertFalse(missing.exists())


if __name__ == '__main__':
    unittest.main()
