"""Coverage and clock witnesses for the separate import-only memory observer."""

import copy
import json
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

from chromium_memory import summarize_import_window
from audit_memory import audit_cell
from run_memory import memory_overlay, schedule


def sample(start_ms, pss=100, private=80, duration_ms=20, qualified=True):
    return {'startedAtMonotonicNs': int(start_ms * 1e6),
            'finishedAtMonotonicNs': int((start_ms + duration_ms) * 1e6),
            'qualifiedForWholeTreePss': qualified,
            'qualificationFailures': [] if qualified else ['process-tree-changed-during-scan'],
            'stableObservedProcessTree': qualified, 'unreadableAddressSpaces': [],
            'unavailableProcesses': [], 'confirmedExitedZombies': [],
            'processes': [{'pid': 1}, {'pid': 2}],
            'readableProcessPssKiB': pss, 'readableProcessPrivateKiB': private}


def inputs():
    markers = [{'event': 'start', 'monotonicNs': str(2000 * 1_000_000)},
               {'event': 'end', 'monotonicNs': str(3000 * 1_000_000)}]
    samples = [sample(1900)] + [sample(ms, pss=100 + index, private=80 + index)
                               for index, ms in enumerate(range(2050, 3000, 150))] + [sample(3020)]
    return samples, markers


class ImportWindowWitness(unittest.TestCase):
    def test_fixed_schedule_keeps_both_adjacent_orders(self):
        self.assertEqual(''.join(x['arm'] for x in schedule(1)), 'ABBA')
        self.assertEqual(''.join(x['arm'] for x in schedule(2)), 'BAAB')
        for rep in (1, 2):
            self.assertEqual([x['pair'] for x in schedule(rep)], [1, 1, 2, 2])

    def test_all_covered_inside_scans_and_brackets_qualify(self):
        samples, markers = inputs()
        result = summarize_import_window(samples, markers, 0)
        self.assertTrue(result['qualifiedForWholeTreePss'], result['qualificationFailures'])
        self.assertEqual(result['maxSampledPssKiB'], 106)
        self.assertEqual(result['maxSampledPrivateKiB'], 86)
        self.assertEqual(result['stableFullyReadImportSampleCount'], 7)
        self.assertEqual(result['windowDurationMs'], 1000)

    def test_outside_window_peaks_and_crossing_boundary_scans_never_contribute(self):
        samples, markers = inputs()
        samples = [sample(1600, pss=9999), samples[0], sample(1990, pss=9999)] + samples[1:-1] + [sample(2990, pss=9999), samples[-1], sample(3200, pss=9999)]
        result = summarize_import_window(samples, markers, 0)
        self.assertTrue(result['qualifiedForWholeTreePss'], result['qualificationFailures'])
        self.assertEqual(result['maxSampledPssKiB'], 106)
        self.assertEqual(len(result['samples']), len(samples))

    def test_sparse_coverage_or_missing_bracket_fails_closed(self):
        original, markers = inputs()
        cases = [original[1:], original[:-1], original[:3] + original[-2:],
                 [s for s in original if s['startedAtMonotonicNs'] not in (2350_000_000, 2500_000_000)]]
        for samples in cases:
            with self.subTest(samples=len(samples)):
                result = summarize_import_window(samples, markers, 0)
                self.assertFalse(result['qualifiedForWholeTreePss'])
                self.assertIsNone(result['maxSampledPssKiB'])
                self.assertIsNone(result['maxSampledPrivateKiB'])

    def test_readable_peaks_cannot_mask_missing_live_address_space_inside_window(self):
        samples, markers = inputs()
        samples[2]['unreadableAddressSpaces'] = [{'smapsReadError': {'errno': 13}}]
        samples[2]['qualifiedForWholeTreePss'] = False
        samples[2]['qualificationFailures'] = ['unreadable-discovered-process-smaps']
        result = summarize_import_window(samples, markers, 0)
        self.assertFalse(result['qualifiedForWholeTreePss'])
        self.assertIn('process-smaps-coverage-unqualified', result['qualificationFailures'])
        self.assertIsNone(result['maxSampledPssKiB'])

    def test_failures_outside_window_are_retained_but_do_not_change_import_maximum(self):
        samples, markers = inputs()
        failure = sample(1600, qualified=False)
        failure['unreadableAddressSpaces'] = [{'smapsReadError': {'errno': 13}}]
        result = summarize_import_window([failure] + samples, markers, 0)
        self.assertTrue(result['qualifiedForWholeTreePss'], result['qualificationFailures'])
        self.assertEqual(result['samples'][0], failure)

    def test_malformed_or_incomplete_markers_and_failed_command_fail_closed(self):
        samples, markers = inputs()
        for value in [[], markers[:1], list(reversed(markers)), markers + markers, [{**markers[0], 'monotonicNs': 'bad'}, markers[1]]]:
            result = summarize_import_window(samples, value, 0)
            self.assertFalse(result['qualifiedForWholeTreePss'])
            self.assertIsNone(result['maxSampledPssKiB'])
        self.assertFalse(summarize_import_window(samples, markers, 1)['qualifiedForWholeTreePss'])

    def test_offline_audit_recomputes_raw_coverage_and_rejects_forged_maxima(self):
        samples, markers = inputs()
        processes = [
            {'pid': 10, 'startTimeTicks': 100, 'parentPid': 1, 'executable': '/opt/chrome', 'comm': 'chrome', 'argv': ['chrome'], 'role': 'browser'},
            {'pid': 11, 'startTimeTicks': 110, 'parentPid': 10, 'executable': '/opt/chrome', 'comm': 'chrome', 'argv': ['chrome', '--type=renderer'], 'role': 'renderer'},
        ]
        for row in samples:
            start = row['startedAtMonotonicNs']
            row['smapsReadConcurrencyLimit'] = 4
            row['phaseIntervals'] = {
                'discoveryBefore': {'startNs': start, 'endNs': start + 1_000_000},
                'smapsReads': {'startNs': start + 1_000_000, 'endNs': start + 10_000_000},
                'discoveryAfter': {'startNs': start + 10_000_000, 'endNs': row['finishedAtMonotonicNs']},
            }
            row['processes'] = [{**p, 'pssKiB': row['readableProcessPssKiB'] // 2, 'privateKiB': row['readableProcessPrivateKiB'] // 2,
                'smapsReadStartedAtMonotonicNs': start + 2_000_000,
                'smapsReadFinishedAtMonotonicNs': start + 8_000_000} for p in processes]
            row['readableProcessPssKiB'] = sum(p['pssKiB'] for p in row['processes'])
            row['readableProcessPrivateKiB'] = sum(p['privateKiB'] for p in row['processes'])
            row['discoveryBefore'] = {'processes': processes, 'browserSeedPids': [10, 11], 'inventoryIdentityReadErrors': []}
            row['discoveryAfter'] = copy.deepcopy(row['discoveryBefore'])
            row['observedRoles'] = ['browser', 'renderer']
        memory = summarize_import_window(samples, markers, 0)
        with tempfile.TemporaryDirectory(prefix='memory-offline-audit-') as directory:
            root = Path(directory)
            plan = {'schedule': schedule(1)}
            (root / 'plan.json').write_text(json.dumps(plan))
            observations = []
            for observation in plan['schedule']:
                location = root / observation['name']
                location.mkdir()
                (location / 'memory.json').write_text(json.dumps(memory))
                (location / 'markers.jsonl').write_text(''.join(json.dumps(m) + '\n' for m in markers))
                observations.append({**observation, **{k: v for k, v in memory.items() if k != 'samples'}})
            (root / 'observations.json').write_text(json.dumps(observations))
            comparison = {'observations': observations, 'everyObservationQualified': True, 'passesProspectiveMemoryScreen': True,
                          'metrics': {metric: {'medianPairedChangePercent': 0.0, 'maximumPairedChangePercent': 0.0} for metric in ('maxSampledPssKiB', 'maxSampledPrivateKiB')},
                          'pairs': [{'pair': i, 'qualified': True, **{metric: {'baseline': memory[metric], 'candidate': memory[metric], 'changePercent': 0.0} for metric in ('maxSampledPssKiB', 'maxSampledPrivateKiB')}} for i in (1, 2)]}
            (root / 'memory-comparison.json').write_text(json.dumps(comparison))
            self.assertTrue(audit_cell(root)['passesProspectiveMemoryScreen'])
            altered = copy.deepcopy(memory)
            altered['maxSampledPssKiB'] += 1
            (root / 'A1/memory.json').write_text(json.dumps(altered))
            with self.assertRaises(AssertionError):
                audit_cell(root)
            (root / 'A1/memory.json').write_text(json.dumps(memory))
            changed_markers = copy.deepcopy(markers)
            changed_markers[0]['monotonicNs'] = '1'
            (root / 'A1/markers.jsonl').write_text(''.join(json.dumps(m) + '\n' for m in changed_markers))
            with self.assertRaises(AssertionError):
                audit_cell(root)

    def test_node_and_python_monotonic_clocks_share_the_linux_epoch(self):
        before = time.monotonic_ns()
        observed = int(subprocess.check_output(['node', '-e', 'console.log(process.hrtime.bigint().toString())'], text=True))
        after = time.monotonic_ns()
        self.assertLessEqual(before, observed)
        self.assertLessEqual(observed, after)

    def test_test_only_overlay_marks_each_import_boundary_once(self):
        root = Path(__file__).resolve().parents[3]
        source = (root / 'test/chromium/extension-two-dictionary-import.e2e.js').read_text()
        changed = memory_overlay(source)
        self.assertEqual(changed.count("recordImportMemoryMarker('start')"), 1)
        self.assertEqual(changed.count("recordImportMemoryMarker('end')"), 1)
        self.assertLess(changed.index("recordImportMemoryMarker('start')"), changed.index("await page.setInputFiles('#dictionary-import-file-input'"))
        self.assertIn("process.hrtime.bigint().toString()", changed)
        with self.assertRaises(ValueError):
            memory_overlay(changed)


if __name__ == '__main__':
    unittest.main()
