# SPDX-License-Identifier: GPL-3.0-or-later
"""Source, package and complete-cohort witnesses; no browser acquisition."""

import copy
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from protocol import (DEPENDENCY_PATHS, HARNESS, memory_comparison, package_entries,
                      read_summary, receipt_comparison_key, require_dependency_source,
                      require_package_differences, storage_allocation_summary)
from run_memory import schedule
from test_storage_receipts import inventory


def native_receipt(dictionary='jmdict', active_units=43):
    fixture = {'expectedTitle': 'Dictionary', 'revision': 'rev', 'termRows': 12,
               'mediaFiles': 0, 'mediaBytes': 0}
    source = {'commit': 'a' * 40, 'tree': 'b' * 40}
    plan = {'dictionary': dictionary, 'fixture': fixture, 'sourceIdentities': {'A': source},
            'harnessSha256': {HARNESS: 'c' * 64, 'package-lock.json': 'd' * 64},
            'memoryOverlaySha256': 'e' * 64}
    identity = {**source, 'packageSha256': 'f' * 64}
    terms = [f'term-{index}' for index in range(12)]
    validation = {'title': 'Dictionary', 'revision': 'rev', 'termRows': 12, 'contentReadable': True,
                  'probeCount': 12, 'probeTerms': terms,
                  'restart': {'title': 'Dictionary', 'revision': 'rev', 'termRows': 12,
                              'contentReadable': True, 'probeCount': 12, 'mediaFiles': 0},
                  'lookup': {'observations': [{'pass': number, 'term': term, 'results': 1,
                                              'hasExactHeadwordMatch': True, 'sha256': '1' * 64}
                                             for number in range(6) for term in terms]},
                  'media': {'mode': 'sample', 'totalFiles': 0, 'totalBytes': 0,
                            'files': 0, 'bytes': 0, 'sha256': '2' * 64},
                  'storage': inventory(dictionary, active_units)}
    summary = {'schemaVersion': 3, 'dictionary': dictionary, 'fixture': fixture, 'buildTarget': 'chrome',
               'mediaCheck': 'sample', 'traceEnabled': False, 'importFlags': None, 'authoritativeTiming': True,
               'gitSha': source['commit'], 'browserVersion': '153.0',
               'hostEnvironment': {'nodeVersion': 'v22.22.0'},
               'source': {'gitSha': source['commit'], 'dirty': True,
                          'sha256': {HARNESS: plan['memoryOverlaySha256'], 'package-lock.json': 'd' * 64,
                                     'builds/manabitan-chrome.zip': identity['packageSha256']}},
               'runs': [{'browserVersion': '153.0', 'packageSha256': identity['packageSha256'],
                         'validation': validation}]}
    return summary, plan, identity


class ProtocolWitness(unittest.TestCase):
    def test_dependency_copy_requires_exact_tooling_manifests_and_setup(self):
        with tempfile.TemporaryDirectory() as directory:
            source, tooling = Path(directory) / 'source', Path(directory) / 'tooling'
            for root in (source, tooling):
                for name in DEPENDENCY_PATHS:
                    path = root / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(name)
            self.assertEqual(set(require_dependency_source(source, tooling)), set(DEPENDENCY_PATHS))
            for name in DEPENDENCY_PATHS:
                path = tooling / name
                path.write_text('different dependency setup')
                with self.subTest(name=name), self.assertRaises(ValueError):
                    require_dependency_source(source, tooling)
                path.write_text(name)

    def test_package_guard_checks_exact_differences_including_added_and_removed_files(self):
        packages = {'A': {'same': '1', 'old': '2', 'changed': '3'},
                    'B': {'same': '1', 'new': '2', 'changed': '4'}}
        expected = ['changed', 'new', 'old']
        self.assertEqual(require_package_differences(packages, expected), expected)
        for invalid in [[], ['changed'], list(reversed(expected)), expected + ['old'], 'changed']:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                require_package_differences(packages, invalid)

    def test_duplicate_package_members_are_not_hidden_by_a_dictionary(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'package.zip'
            with zipfile.ZipFile(path, 'w') as archive:
                archive.writestr('a.js', 'first')
                with self.assertWarns(UserWarning):
                    archive.writestr('a.js', 'second')
            with self.assertRaises(ValueError):
                package_entries(path)

    def test_native_labels_never_make_external_observer_timing_authoritative(self):
        summary, plan, identity = native_receipt()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            (output / 'summary.json').write_text(json.dumps(summary))
            result = read_summary(output, plan, 'A', identity)
            self.assertFalse(result['authoritativeTiming'])
            self.assertEqual(result['storage']['rawStorageBytes'], summary['runs'][0]['validation']['storage']['bytes'])
            self.assertEqual(len(result['lookup']), 72)

    def test_bounded_storage_does_not_relax_lookup_or_media_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            receipts = []
            for units in (129, 131):
                summary, plan, identity = native_receipt('vndb', units)
                (output / 'summary.json').write_text(json.dumps(summary))
                receipts.append(read_summary(output, plan, 'A', identity))
            self.assertEqual(receipt_comparison_key(receipts[0]), receipt_comparison_key(receipts[1]))
            self.assertEqual(receipts[1]['storage']['rawStorageBytes'] - receipts[0]['storage']['rawStorageBytes'], 8192)
            for field in ('lookup', 'media'):
                changed = copy.deepcopy(receipts[1])
                if field == 'lookup':
                    changed[field][0][3] = '9' * 64
                else:
                    changed[field]['sha256'] = '9' * 64
                self.assertNotEqual(receipt_comparison_key(receipts[0]), receipt_comparison_key(changed))

    def test_storage_allocation_summary_keeps_each_arm_and_failed_slot(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            checks = []
            for observation, units in zip(schedule(1), (129, 131, 130, 129), strict=True):
                summary, plan, identity = native_receipt('vndb', units)
                (output / 'summary.json').write_text(json.dumps(summary))
                checks.append({'name': observation['name'], 'status': 'passed',
                               'receipt': read_summary(output, plan, 'A', identity)})
            result = storage_allocation_summary(checks, schedule(1))
            self.assertEqual(result['activeSahFileBytesByArm'], {'A': [528384, 528384], 'B': [536576, 532480]})
            checks[1] = {'name': 'B1', 'status': 'failed'}
            result = storage_allocation_summary(checks, schedule(1))
            self.assertEqual(result['activeSahFileBytesByArm']['B'], [None, 532480])
            self.assertEqual(result['observations'][1]['correctnessStatus'], 'failed')

    def test_source_overlay_restart_and_lookup_corruption_fail_closed(self):
        mutations = [
            lambda s: s['source'].__setitem__('dirty', False),
            lambda s: s['source'].__setitem__('gitSha', '0' * 40),
            lambda s: s['source']['sha256'].__setitem__(HARNESS, '0' * 64),
            lambda s: s['source']['sha256'].__setitem__('package-lock.json', '0' * 64),
            lambda s: s['runs'][0].__setitem__('packageSha256', '0' * 64),
            lambda s: s['runs'][0]['validation']['restart'].__setitem__('termRows', 11),
            lambda s: s['runs'][0]['validation']['lookup']['observations'][0].__setitem__('results', 0),
            lambda s: s['runs'][0]['validation']['lookup']['observations'][0].__setitem__('hasExactHeadwordMatch', False),
            lambda s: s['runs'][0]['validation']['lookup']['observations'].pop(),
            lambda s: s['runs'][0]['validation']['storage'].__setitem__('bytes', 101),
            lambda s: s['runs'][0]['validation']['media'].__setitem__('totalFiles', 1),
            lambda s: s.__setitem__('traceEnabled', True),
        ]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            for mutation in mutations:
                summary, plan, identity = native_receipt()
                mutation(summary)
                (output / 'summary.json').write_text(json.dumps(summary))
                with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                    read_summary(output, plan, 'A', identity)

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
