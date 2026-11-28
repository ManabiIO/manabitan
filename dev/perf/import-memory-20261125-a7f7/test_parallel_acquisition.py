"""Bounded concurrent acquisition witnesses; no import or performance claims."""

from concurrent.futures import Future, ThreadPoolExecutor
import copy
import errno
import threading
import unittest
from unittest.mock import patch

import chromium_memory as sampler
from test_chromium_memory import process_record


def inventory(count=3):
    records = {10: process_record(10, 1, "/usr/bin/python3", ["python3"])}
    for index in range(count):
        pid = 20 + index
        parent = 10 if index == 0 else 20 if index == 1 else 21
        executable = "/opt/chrome" if index < 2 else "/opt/helper"
        argv = [executable, "--type=renderer"] if index == 1 else [executable]
        records[pid] = process_record(pid, parent, executable, argv)
    return {"identityReadErrors": [], "processes": records}


def metrics(pid):
    return {"pssKiB": pid, "rssKiB": pid * 2, "privateKiB": pid // 2}


def normalized(sample):
    return {key: value for key, value in sample.items()
            if key not in {"startedAtEpochSeconds", "finishedAtEpochSeconds",
                           "startedAtMonotonicNs", "finishedAtMonotonicNs"}}


class SerialExecutor:
    """Run the same per-PID readers serially over immutable test snapshots."""

    def __init__(self, max_workers):
        self.max_workers = max_workers

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def submit(self, function, *args):
        future = Future()
        try:
            future.set_result(function(*args))
        except BaseException as error:
            future.set_exception(error)
        return future


def snapshot_sample(before, after, errors=None, executor=ThreadPoolExecutor):
    errors = errors or {}

    def read(pid, _proc):
        if pid in errors:
            kind, args = errors[pid]
            raise kind(*args)
        return metrics(pid)

    with patch.object(sampler, "process_inventory", side_effect=[copy.deepcopy(before), copy.deepcopy(after)]), \
            patch.object(sampler, "read_smaps", side_effect=read), \
            patch.object(sampler, "ThreadPoolExecutor", executor):
        return sampler.sample_memory(10)


def snapshot_cases():
    original = inventory()
    yield "stable", original, copy.deepcopy(original), {}
    yield "denied", original, copy.deepcopy(original), {22: (PermissionError, (errno.EACCES, "denied witness"))}
    yield "missing-metric", original, copy.deepcopy(original), {22: (KeyError, ("Pss",))}
    for name, field, value in [
        ("reused-pid", "startTimeTicks", 999),
        ("metadata-changed", "comm", "changed"),
        ("reparented", "parentPid", 20),
    ]:
        after = copy.deepcopy(original)
        after["processes"][22][field] = value
        yield name, original, after, {}
    after = copy.deepcopy(original)
    after["processes"].pop(22)
    yield "exited", original, after, {22: (ProcessLookupError, (errno.ESRCH, "exited witness"))}
    after = copy.deepcopy(original)
    after["processes"][23] = process_record(23, 21, "/opt/helper", ["new child"])
    yield "new-descendant", original, after, {}
    before = copy.deepcopy(original)
    before["identityReadErrors"] = [{"pid": 99, "field": "stat", "error": "PermissionError",
                                      "errno": errno.EACCES, "message": "denied identity"}]
    yield "persistent-inventory-error", before, copy.deepcopy(original), {}
    zombie = copy.deepcopy(original)
    zombie["processes"][22].update(state="Z", executable=None,
                                    metadataReadErrors=[{"field": "executable", "errno": errno.ENOENT}])
    yield "confirmed-zombie", zombie, copy.deepcopy(zombie), {22: (ProcessLookupError, (errno.ESRCH, "zombie witness"))}
    threaded = copy.deepcopy(zombie)
    threaded["processes"][22]["threadCount"] = 2
    yield "zombie-live-sibling", threaded, copy.deepcopy(threaded), {22: (ProcessLookupError, (errno.ESRCH, "threaded witness"))}
    yield "empty-tree", inventory(0), inventory(0), {}
    yield "browser-only", inventory(1), inventory(1), {}


class ParallelAcquisitionWitness(unittest.TestCase):
    def test_serial_and_parallel_snapshot_results_match(self):
        for name, before, after, errors in snapshot_cases():
            with self.subTest(case=name):
                serial = snapshot_sample(before, after, errors, SerialExecutor)
                parallel = snapshot_sample(before, after, errors)
                self.assertEqual(normalized(parallel), normalized(serial))
                self.assertEqual(parallel["discoveryBefore"]["processes"],
                                 sampler.discover_tree(10, before)["processes"])

    def test_out_of_order_reads_join_before_after_inventory_and_final_timestamps(self):
        for denied in (False, True):
            with self.subTest(denied=denied):
                ready = threading.Barrier(3)
                completed = {pid: threading.Event() for pid in (20, 21, 22)}
                completion_order = []
                events = []
                pools = []
                inventories = 0
                wall_calls = 0
                monotonic_calls = 0

                def pool(max_workers):
                    self.assertEqual(max_workers, 3)
                    self.assertEqual(inventories, 1)
                    result = ThreadPoolExecutor(max_workers=max_workers)
                    pools.append(result)
                    return result

                def read(pid, _proc):
                    self.assertEqual(inventories, 1)
                    ready.wait(timeout=5)
                    if pid < 22:
                        self.assertTrue(completed[pid + 1].wait(timeout=5))
                    completion_order.append(pid)
                    completed[pid].set()
                    if denied and pid == 22:
                        raise PermissionError(errno.EACCES, "out-of-order denied witness")
                    return metrics(pid)

                def discover(_proc):
                    nonlocal inventories
                    inventories += 1
                    events.append("before" if inventories == 1 else "after")
                    if inventories == 1:
                        self.assertEqual(completion_order, [])
                    else:
                        self.assertEqual(completion_order, [22, 21, 20])
                        self.assertTrue(all(not thread.is_alive() for thread in pools[0]._threads))
                    return inventory()

                def wall_time():
                    nonlocal wall_calls
                    wall_calls += 1
                    events.append("wall-start" if wall_calls == 1 else "wall-end")
                    self.assertEqual(inventories, 0 if wall_calls == 1 else 2)
                    return wall_calls * 10.0

                def monotonic_time():
                    nonlocal monotonic_calls
                    monotonic_calls += 1
                    events.append("monotonic-start" if monotonic_calls == 1 else "monotonic-end")
                    self.assertEqual(inventories, 0 if monotonic_calls == 1 else 2)
                    return monotonic_calls * 100

                with patch.object(sampler, "process_inventory", side_effect=discover), \
                        patch.object(sampler, "read_smaps", side_effect=read), \
                        patch.object(sampler, "ThreadPoolExecutor", side_effect=pool), \
                        patch.object(sampler.time, "time", side_effect=wall_time), \
                        patch.object(sampler.time, "monotonic_ns", side_effect=monotonic_time):
                    result = sampler.sample_memory(10)
                self.assertEqual(events, ["wall-start", "monotonic-start", "before", "after", "wall-end", "monotonic-end"])
                self.assertEqual(result["startedAtMonotonicNs"], 100)
                self.assertEqual(result["finishedAtMonotonicNs"], 200)
                self.assertEqual([process["pid"] for process in result["processes"]], [20, 21] if denied else [20, 21, 22])
                self.assertEqual([process["pid"] for process in result["unavailableProcesses"]], [22] if denied else [])
                self.assertEqual(result["qualifiedForWholeTreePss"], not denied)
                self.assertEqual(result["readableProcessPssKiB"], 41 if denied else 63)

    def test_fixed_pool_bound_and_every_discovered_pid_read_once(self):
        for count in (0, 1, 2, 9):
            with self.subTest(count=count):
                limits = []

                def pool(max_workers):
                    limits.append(max_workers)
                    return ThreadPoolExecutor(max_workers=max_workers)

                with patch.object(sampler, "process_inventory", return_value=inventory(count)), \
                        patch.object(sampler, "read_smaps", side_effect=lambda pid, _proc: metrics(pid)) as read, \
                        patch.object(sampler, "ThreadPoolExecutor", side_effect=pool):
                    result = sampler.sample_memory(10)
                self.assertEqual(limits, [min(4, count)] if count else [])
                self.assertEqual(sorted(call.args[0] for call in read.call_args_list), list(range(20, 20 + count)))
                self.assertEqual([process["pid"] for process in result["processes"]], list(range(20, 20 + count)))

    def test_unexpected_reader_failure_joins_pending_tasks_before_escaping(self):
        ready = threading.Barrier(3)
        shutdown_started = threading.Event()
        completed = []
        pools = []

        class JoiningExecutor(ThreadPoolExecutor):
            def __init__(self, max_workers):
                super().__init__(max_workers=max_workers)
                pools.append(self)

            def shutdown(self, wait=True, *, cancel_futures=False):
                shutdown_started.set()
                return super().shutdown(wait=wait, cancel_futures=cancel_futures)

        def read(pid, _proc):
            ready.wait(timeout=5)
            if pid == 20:
                raise RuntimeError("unexpected reader witness")
            self.assertTrue(shutdown_started.wait(timeout=5))
            completed.append(pid)
            return metrics(pid)

        with patch.object(sampler, "process_inventory", return_value=inventory()) as discover, \
                patch.object(sampler, "read_smaps", side_effect=read), \
                patch.object(sampler, "ThreadPoolExecutor", JoiningExecutor):
            with self.assertRaisesRegex(RuntimeError, "unexpected reader witness"):
                sampler.sample_memory(10)
        self.assertEqual(discover.call_count, 1)
        self.assertEqual(sorted(completed), [21, 22])
        self.assertTrue(all(not thread.is_alive() for thread in pools[0]._threads))

    def test_successive_scans_have_no_surviving_reader_threads(self):
        pools = []

        def pool(max_workers):
            self.assertTrue(all(not thread.is_alive() for previous in pools for thread in previous._threads))
            result = ThreadPoolExecutor(max_workers=max_workers)
            pools.append(result)
            return result

        with patch.object(sampler, "process_inventory", return_value=inventory()), \
                patch.object(sampler, "read_smaps", side_effect=lambda pid, _proc: metrics(pid)), \
                patch.object(sampler, "ThreadPoolExecutor", side_effect=pool):
            first = sampler.sample_memory(10)
            second = sampler.sample_memory(10)
        self.assertEqual(normalized(first), normalized(second))
        self.assertLessEqual(first["finishedAtMonotonicNs"], second["startedAtMonotonicNs"])
        self.assertTrue(all(not thread.is_alive() for previous in pools for thread in previous._threads))


if __name__ == "__main__":
    unittest.main(verbosity=2)
