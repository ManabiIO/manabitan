"""Witness global read bounds, joined inventories and retained read failures."""

from concurrent.futures import ThreadPoolExecutor
import copy
import errno
import threading
import time
import unittest
from unittest.mock import patch

import chromium_memory as sampler
from audit_memory import audit_read_intervals
from test_chromium_memory import process_record


class ParallelReadsWitness(unittest.TestCase):
    def run_scan(self, denied=None, unexpected=None, concurrent_calls=1):
        records = {10: process_record(10, 1, '/usr/bin/python3', ['python3']),
                   20: process_record(20, 10, '/opt/chrome', ['chrome']),
                   21: process_record(21, 20, '/opt/chrome', ['chrome', '--type=renderer'])}
        records.update({pid: process_record(pid, 21, '/opt/helper', ['arbitrary helper']) for pid in range(22, 29)})
        inventory = {'processes': records, 'identityReadErrors': []}
        mutex = threading.Lock()
        active = maximum = completed = inventories = 0
        first_four = threading.Event()

        def discover(_proc):
            nonlocal inventories
            with mutex:
                # No after-inventory, or next scan, may race an outstanding read.
                self.assertEqual(active, 0)
                self.assertEqual(completed, (inventories // 2) * 9 if inventories % 2 == 0 else ((inventories + 1) // 2) * 9)
                inventories += 1
            return inventory

        def read(pid, _proc):
            nonlocal active, maximum, completed
            with mutex:
                active += 1
                maximum = max(maximum, active)
                if active == 4:
                    first_four.set()
            try:
                self.assertTrue(first_four.wait(5), 'Reads did not execute concurrently')
                time.sleep(0.005)
                if pid == unexpected:
                    raise RuntimeError('unexpected read witness')
                if pid == denied:
                    raise PermissionError(errno.EACCES, 'denied read witness')
                return {'pssKiB': pid, 'rssKiB': pid * 2, 'privateKiB': pid - 1}
            finally:
                with mutex:
                    active -= 1
                    completed += 1

        with patch.object(sampler, 'process_inventory', side_effect=discover), patch.object(sampler, 'read_smaps', side_effect=read):
            if unexpected is not None:
                with self.assertRaisesRegex(RuntimeError, 'unexpected read witness'):
                    sampler.sample_memory(10)
                results = []
            elif concurrent_calls == 1:
                results = [sampler.sample_memory(10)]
            else:
                with ThreadPoolExecutor(max_workers=concurrent_calls) as callers:
                    results = list(callers.map(lambda _: sampler.sample_memory(10), range(concurrent_calls)))
        self.assertEqual(active, 0)
        self.assertEqual(maximum, 4)
        self.assertEqual(completed, 9 * concurrent_calls)
        for result in results:
            audit_read_intervals(result)
            self.assertEqual({p['pid'] for p in result['processes'] + result['unavailableProcesses']}, set(range(20, 29)))
        return results

    def test_all_reads_join_before_after_inventory_and_preserve_pid_order(self):
        result, = self.run_scan()
        self.assertTrue(result['qualifiedForWholeTreePss'])
        self.assertEqual([p['pid'] for p in result['processes']], list(range(20, 29)))
        self.assertEqual(result['readableProcessPssKiB'], sum(range(20, 29)))

    def test_missing_live_address_space_still_fails_closed(self):
        result, = self.run_scan(denied=24)
        self.assertFalse(result['qualifiedForWholeTreePss'])
        self.assertEqual([p['pid'] for p in result['unavailableProcesses']], [24])
        self.assertIn('unreadable-discovered-process-smaps', result['qualificationFailures'])

    def test_global_bound_holds_across_simultaneous_sample_callers(self):
        first, second = self.run_scan(concurrent_calls=2)
        ordered = sorted([first, second], key=lambda value: value['startedAtMonotonicNs'])
        self.assertLessEqual(ordered[0]['finishedAtMonotonicNs'], ordered[1]['startedAtMonotonicNs'])

    def test_unexpected_future_failure_joins_every_other_read_before_raising(self):
        self.run_scan(unexpected=22)

    def test_partial_submission_failure_joins_started_reads_before_releasing_scan(self):
        inventory = {'identityReadErrors': [], 'processes': {
            20: process_record(20, 10, '/opt/chrome', ['chrome']),
            21: process_record(21, 20, '/opt/chrome', ['chrome', '--type=renderer']),
            22: process_record(22, 21, '/opt/helper', ['helper']),
        }}
        completed = []

        def read(pid, _proc):
            time.sleep(0.02)
            completed.append(pid)
            return {'pssKiB': 10, 'rssKiB': 20, 'privateKiB': 5}

        with ThreadPoolExecutor(max_workers=4) as actual:
            class PartialSubmission:
                submissions = 0

                def submit(self, function, *args):
                    self.submissions += 1
                    if self.submissions == 3:
                        raise RuntimeError('submission failed witness')
                    return actual.submit(function, *args)

            with patch.object(sampler, 'process_inventory', return_value=inventory), patch.object(sampler, 'read_smaps', side_effect=read):
                with self.assertRaisesRegex(RuntimeError, 'submission failed witness'):
                    sampler.sample_memory(10, executor=PartialSubmission())
                self.assertEqual(sorted(completed), [20, 21])
                self.assertFalse(sampler.SAMPLE_LOCK.locked())

    def test_audit_rejects_read_overlap_outside_envelope_and_excess_concurrency(self):
        original, = self.run_scan()
        changed = copy.deepcopy(original)
        changed['processes'][0]['smapsReadFinishedAtMonotonicNs'] = changed['phaseIntervals']['discoveryAfter']['endNs']
        with self.assertRaises(AssertionError):
            audit_read_intervals(changed)
        changed = copy.deepcopy(original)
        for process in changed['processes']:
            process['smapsReadStartedAtMonotonicNs'] = changed['phaseIntervals']['smapsReads']['startNs']
            process['smapsReadFinishedAtMonotonicNs'] = changed['phaseIntervals']['smapsReads']['endNs']
        with self.assertRaises(AssertionError):
            audit_read_intervals(changed)


if __name__ == '__main__':
    unittest.main()
