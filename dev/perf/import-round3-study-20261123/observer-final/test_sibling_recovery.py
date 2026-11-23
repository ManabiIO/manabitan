"""Adversarial recovery proof tests, independent of Chromium or hosted data."""

import copy
import errno
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import chromium_memory as sampler
from test_chromium_memory import process_record


def task_text(tid, tgid=22, count=3, start=None, state=None):
    state = state or ("Z" if tid == tgid else "S")
    fields = ["0"] * 20
    fields[0], fields[1], fields[17], fields[19] = state, "20", str(count), str(start if start is not None else tid * 10)
    stat = f"{tid} (comm with (nested) parentheses) " + " ".join(fields) + "\n"
    status = f"Name:\ttest\nState:\t{state} (test state)\nTgid:\t{tgid}\nPid:\t{tid}\nThreads:\t{count}\n"
    return stat, status


def task_snapshot(tids=(22, 23, 24)):
    tasks = []
    for tid in tids:
        stat, status = task_text(tid, count=len(tids))
        tasks.append({**sampler.parse_task_identity(tid, stat, status), "rawStat": stat, "rawStatus": status})
    return {"startedAtEpochSeconds": 1, "finishedAtEpochSeconds": 2, "path": "/proc/22/task",
            "enumeratedTids": list(tids), "tasks": tasks, "errors": []}


def inventory():
    records = {
        10: process_record(10, 1, "/usr/bin/python3", ["python3"]),
        20: process_record(20, 10, "/opt/chrome", ["/opt/chrome rewritten title"]),
        21: process_record(21, 20, "/opt/chrome", ["/opt/chrome --type=renderer"]),
        22: process_record(22, 20, None, [""]),
    }
    records[22].update(state="Z", threadCount=3,
                       metadataReadErrors=[{"pid": 22, "field": "executable", "errno": errno.ENOENT}])
    return {"identityReadErrors": [], "processes": records}


class SiblingRecoveryProof(unittest.TestCase):
    def run_sample(self, before=None, after=None, tasks_before=None, tasks_after=None,
                   primary_error=None, sibling_error=None):
        before = copy.deepcopy(inventory() if before is None else before)
        after = copy.deepcopy(before if after is None else after)
        tasks_before = copy.deepcopy(task_snapshot() if tasks_before is None else tasks_before)
        tasks_after = copy.deepcopy(tasks_before if tasks_after is None else tasks_after)
        reads = []

        def read(pid, proc):
            reads.append((pid, str(proc)))
            if proc == Path("/proc/22/task"):
                if sibling_error is not None:
                    raise sibling_error
                return {"pssKiB": 150, "rssKiB": 200, "privateKiB": 100}
            if pid == 22:
                raise primary_error or ProcessLookupError(errno.ESRCH, "leader address space absent")
            return {"pssKiB": 10, "rssKiB": 20, "privateKiB": 5}

        with patch.object(sampler, "process_inventory", side_effect=[before, after]), \
                patch.object(sampler, "read_task_inventory", side_effect=[tasks_before, tasks_after]) as task_reads, \
                patch.object(sampler, "read_smaps", side_effect=read):
            result = sampler.sample_memory(10)
        return result, reads, task_reads.call_count

    def assert_rejected(self, result, expect_attempt=True, whole_observation=True):
        self.assertFalse(result["qualifiedForWholeTreePss"])
        self.assertEqual([p["pid"] for p in result["unreadableAddressSpaces"]], [22])
        self.assertNotIn(22, [p["pid"] for p in result["processes"]])
        self.assertEqual(len(result["unavailableProcesses"]), 1)
        if expect_attempt:
            self.assertFalse(result["addressSpaceRecoveryAttempts"][0]["qualified"])
            self.assertTrue(result["addressSpaceRecoveryAttempts"][0]["qualificationFailures"])
        good, _, _ = self.run_sample()
        summary = sampler.summarize_samples([good, result], 0)
        self.assertEqual(summary["qualifiedForWholeTreePss"], not whole_observation)
        if whole_observation:
            self.assertIsNone(summary["maxSampledPssKiB"])
            self.assertIsNone(summary["maxSampledPrivateKiB"])
        else:
            self.assertEqual(summary["maxSampledPssKiB"], good["readableProcessPssKiB"])

    def test_deterministic_single_read_and_exactly_once_aggregation(self):
        result, reads, task_reads = self.run_sample()
        self.assertTrue(result["qualifiedForWholeTreePss"], result["qualificationFailures"])
        self.assertEqual(reads, [(20, "/proc"), (21, "/proc"), (22, "/proc"), (23, "/proc/22/task")])
        self.assertEqual(task_reads, 2)
        self.assertEqual([p["pid"] for p in result["processes"]], [20, 21, 22])
        self.assertEqual(result["readableProcessPssKiB"], 170)
        self.assertEqual(result["readableProcessPrivateKiB"], 110)
        self.assertEqual(result["unavailableProcesses"][0]["smapsReadError"]["errno"], errno.ESRCH)
        self.assertEqual(result["unreadableAddressSpaces"], [])
        self.assertEqual(result["confirmedExitedZombies"], [])
        attempt = result["addressSpaceRecoveryAttempts"][0]
        self.assertEqual(attempt["leaderBefore"], result["unavailableProcesses"][0])
        self.assertEqual(attempt["representativeReadPath"], "/proc/22/task/23/smaps_rollup")
        summary = sampler.summarize_samples([result], 0)
        self.assertTrue(summary["qualifiedForWholeTreePss"])
        self.assertEqual(summary["maxSampledPssKiB"], 170)
        self.assertEqual(summary["successfulSiblingRecoveryCount"], 1)

    def test_live_scheduler_state_changes_do_not_change_identity(self):
        first, last = task_snapshot(), task_snapshot()
        first["tasks"][1]["statusState"] = "R"
        last["tasks"][1]["state"] = "R"
        result, _, _ = self.run_sample(tasks_before=first, tasks_after=last)
        self.assertTrue(result["qualifiedForWholeTreePss"])

    def test_ineligible_primary_read_never_attempts_recovery(self):
        for error in (PermissionError(errno.EACCES, "denied"), FileNotFoundError(errno.ENOENT, "gone"),
                      ValueError("parse"), KeyError("Pss")):
            with self.subTest(error=repr(error)):
                result, reads, task_reads = self.run_sample(primary_error=error)
                self.assertEqual(task_reads, 0)
                self.assertEqual(len(reads), 3)
                self.assertEqual(result["addressSpaceRecoveryAttempts"], [])
                self.assert_rejected(result, expect_attempt=False)

    def test_leader_eligibility_is_strict(self):
        leader = inventory()["processes"][22]
        self.assertTrue(sampler.recoverable_zombie_leader(leader))
        changes = [
            ("pid", None), ("pid", True), ("pid", 0), ("startTimeTicks", None),
            ("startTimeTicks", True), ("startTimeTicks", -1), ("state", "S"),
            ("threadCount", 1), ("threadCount", True), ("threadCount", None),
            ("threadCount", "3"), ("executable", "/opt/helper"),
            ("metadataReadErrors", []),
            ("metadataReadErrors", [{"field": "executable", "errno": errno.EACCES}]),
            ("metadataReadErrors", [{"field": "executable", "errno": errno.ESRCH}]),
            ("metadataReadErrors", [{"field": "executable", "errno": errno.ENOENT},
                                    {"field": "comm", "errno": errno.EACCES}]),
        ]
        for key, value in changes:
            with self.subTest(key=key, value=value):
                changed = {**copy.deepcopy(leader), key: value}
                self.assertFalse(sampler.recoverable_zombie_leader(changed))

    def test_ineligible_global_leader_never_reads_tasks(self):
        for key, value in (("state", "S"), ("threadCount", True),
                           ("executable", "/opt/helper"), ("metadataReadErrors", []),
                           ("metadataReadErrors", [{"field": "executable", "errno": errno.EACCES}])):
            with self.subTest(key=key, value=value):
                before = inventory()
                before["processes"][22][key] = value
                result, _, task_reads = self.run_sample(before=before)
                self.assertEqual(task_reads, 0)
                self.assertEqual(result["addressSpaceRecoveryAttempts"], [])
                self.assert_rejected(result, expect_attempt=False)

    def test_global_after_identity_state_count_and_metadata_are_required(self):
        changes = [
            ("startTimeTicks", 221), ("parentPid", 21), ("state", "S"), ("threadCount", 2),
            ("threadCount", True), ("executable", "/opt/helper"), ("comm", "changed"),
            ("argv", ["changed"]), ("metadataReadErrors", []),
            ("metadataReadErrors", [{"field": "executable", "errno": errno.EACCES}]),
        ]
        for key, value in changes:
            with self.subTest(key=key, value=value):
                after = inventory()
                after["processes"][22][key] = value
                result, reads, _ = self.run_sample(after=after)
                self.assertEqual(len([read for read in reads if read[1] != "/proc"]), 1)
                persistent = key == "metadataReadErrors" and bool(value)
                self.assert_rejected(result, whole_observation=result["stableObservedProcessTree"] or persistent)
        after = inventory()
        del after["processes"][22]
        result, _, _ = self.run_sample(after=after)
        self.assert_rejected(result, whole_observation=False)

    def test_task_count_group_leader_membership_and_reuse_fail_closed(self):
        def remove_task(snapshot):
            snapshot["tasks"].pop()
            snapshot["enumeratedTids"].pop()

        def replace_tid(snapshot):
            snapshot["tasks"][2]["tid"] = 25
            snapshot["enumeratedTids"][2] = 25

        mutations = {
            "missing-task": remove_task,
            "replacement-tid": replace_tid,
            "tid-reused": lambda s: s["tasks"][1].update(startTimeTicks=999),
            "wrong-tgid": lambda s: s["tasks"][1].update(tgid=999),
            "wrong-thread-count": lambda s: s["tasks"][1].update(threadCount=2),
            "changed-parent": lambda s: s["tasks"][1].update(parentPid=21),
            "wrong-leader-start": lambda s: s["tasks"][0].update(startTimeTicks=999),
            "leader-not-z": lambda s: s["tasks"][0].update(state="S"),
            "leader-status-not-z": lambda s: s["tasks"][0].update(statusState="S"),
            "representative-z": lambda s: s["tasks"][1].update(state="Z"),
            "representative-status-z": lambda s: s["tasks"][1].update(statusState="Z"),
            "enumeration-order": lambda s: s["enumeratedTids"].reverse(),
            "duplicate-task": lambda s: s["tasks"].append(copy.deepcopy(s["tasks"][1])),
            "missing-leader": lambda s: (s["enumeratedTids"].pop(0), s["tasks"].pop(0)),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                after = task_snapshot()
                mutate(after)
                result, _, _ = self.run_sample(tasks_after=after)
                self.assert_rejected(result)

    def test_invalid_first_snapshot_prevents_smaps_read(self):
        for mutation in (lambda s: s["tasks"][1].update(tgid=999),
                         lambda s: s["enumeratedTids"].pop(),
                         lambda s: s["tasks"][0].update(startTimeTicks=999),
                         lambda s: [task.update(state="Z") for task in s["tasks"]]):
            first = task_snapshot()
            mutation(first)
            result, reads, task_reads = self.run_sample(tasks_before=first)
            self.assertEqual(task_reads, 2)
            self.assertEqual(len(reads), 3)
            self.assert_rejected(result)

    def test_task_read_errors_before_or_after_never_qualify(self):
        for side in ("tasks_before", "tasks_after"):
            for field in ("task-directory", "stat", "status", "stat-status-parse"):
                for code in (errno.EACCES, errno.EPERM, errno.ENOENT, errno.ESRCH, None):
                    with self.subTest(side=side, field=field, code=code):
                        snapshot = task_snapshot()
                        snapshot["errors"] = [{"pid": 22, "tid": 23, "field": field, "errno": code}]
                        result, reads, _ = self.run_sample(**{side: snapshot})
                        self.assertEqual(len(reads), 3 if side == "tasks_before" else 4)
                        self.assert_rejected(result)

    def test_representative_read_failure_never_tries_second_live_sibling(self):
        for error in (PermissionError(errno.EACCES, "denied"), ProcessLookupError(errno.ESRCH, "gone"),
                      FileNotFoundError(errno.ENOENT, "gone"), ValueError("parse"), KeyError("Pss")):
            with self.subTest(error=repr(error)):
                result, reads, task_reads = self.run_sample(sibling_error=error)
                self.assertEqual(reads[-1], (23, "/proc/22/task"))
                self.assertNotIn((24, "/proc/22/task"), reads)
                self.assertEqual(len(reads), 4)
                self.assertEqual(task_reads, 2)
                self.assertIsNotNone(result["addressSpaceRecoveryAttempts"][0]["representativeReadError"])
                self.assert_rejected(result)

    def test_secondary_permission_and_parse_failures_propagate_despite_global_churn(self):
        for error in (PermissionError(errno.EACCES, "denied"), ValueError("malformed smaps"), KeyError("Pss")):
            with self.subTest(error=repr(error)):
                after = inventory()
                after["processes"][22]["startTimeTicks"] += 1
                result, _, _ = self.run_sample(after=after, sibling_error=error)
                self.assertFalse(result["stableObservedProcessTree"])
                self.assert_rejected(result)
                good, _, _ = self.run_sample()
                summary = sampler.summarize_samples([good, result], 0)
                self.assertIn("sibling-recovery-permission-parse-or-proof-failure", summary["qualificationFailures"])

    def test_expected_exit_rejects_sample_without_reclassifying_good_samples(self):
        after = inventory()
        del after["processes"][22]
        for code in (errno.ESRCH, errno.ENOENT):
            with self.subTest(errno=code):
                gone = task_snapshot()
                gone["errors"] = [{"pid": 22, "field": "task-directory", "errno": code}]
                result, reads, _ = self.run_sample(after=after, tasks_after=gone,
                                                  sibling_error=OSError(code, "process exited"))
                self.assertFalse(result["stableObservedProcessTree"])
                self.assertEqual(len(reads), 4)
                self.assert_rejected(result, whole_observation=False)

    def test_malformed_task_proof_propagates_despite_global_churn(self):
        after = inventory()
        after["processes"][22]["startTimeTicks"] += 1
        for mutation in (lambda s: s["tasks"][1].update(tgid=999),
                         lambda s: s["enumeratedTids"].reverse()):
            snapshot = task_snapshot()
            mutation(snapshot)
            result, _, _ = self.run_sample(after=after, tasks_after=snapshot)
            self.assertFalse(result["stableObservedProcessTree"])
            self.assert_rejected(result)

    def test_count_or_gone_failure_cannot_mask_independent_wrong_group_proof(self):
        after = inventory()
        after["processes"][22]["startTimeTicks"] += 1
        for side in ("tasks_before", "tasks_after"):
            for mode in ("count", "gone", "both"):
                with self.subTest(side=side, mode=mode):
                    snapshot = task_snapshot()
                    snapshot["tasks"][1]["tgid"] = 999
                    if mode in ("count", "both"):
                        snapshot["tasks"].pop()
                        snapshot["enumeratedTids"].pop()
                    if mode in ("gone", "both"):
                        error = {"pid": 22, "tid": 24, "field": "stat", "errno": errno.ENOENT}
                        snapshot["errors"] = [error]
                        if mode == "gone":
                            snapshot["tasks"][2] = {"tid": 24, "identityReadError": error}
                    result, _, _ = self.run_sample(after=after, **{side: snapshot})
                    self.assertFalse(result["stableObservedProcessTree"])
                    self.assert_rejected(result)
                    proof = result["addressSpaceRecoveryAttempts"][0]
                    self.assertIn("task-group-mismatch", proof["qualificationFailures"])
                    self.assertTrue(sampler.persistent_sibling_recovery_failure(proof))


class TaskRecordParsing(unittest.TestCase):
    def test_identity_parser_handles_parentheses_and_rejects_malformed_fields(self):
        stat, status = task_text(23)
        parsed = sampler.parse_task_identity(23, stat, status)
        self.assertEqual((parsed["tid"], parsed["tgid"], parsed["startTimeTicks"]), (23, 22, 230))
        cases = [
            (stat.replace("23 (", "24 (", 1), status), ("23 (bad) S", status),
            (stat.replace(") S 20", ") ? 20"), status),
            (stat, status.replace("Pid:\t23", "Pid:\t24")),
            (stat, status.replace("Tgid:\t22", "Tgid:\t0")),
            (stat, status.replace("Threads:\t3", "Threads:\t2")),
            (stat, status.replace("Threads:\t3", "Threads:\t3 extra")),
            (stat, status.replace("State:\tS", "State:\t?")),
            (stat, status.replace("State:\tS (test state)", "State:")),
            (stat, status.replace("Tgid:\t22\n", "")),
            (stat, status + "Tgid:\t22\n"), (stat, status + "Threads:\t3\n"),
        ]
        for index, (bad_stat, bad_status) in enumerate(cases):
            with self.subTest(index=index):
                with self.assertRaises((ValueError, KeyError, IndexError)):
                    sampler.parse_task_identity(23, bad_stat, bad_status)

    def test_task_reader_preserves_complete_raw_records_and_read_failures(self):
        with tempfile.TemporaryDirectory(prefix="task-inventory-") as temporary:
            proc = Path(temporary)
            for tid in (22, 23, 24):
                directory = proc / "22" / "task" / str(tid)
                directory.mkdir(parents=True)
                stat, status = task_text(tid)
                (directory / "stat").write_text(stat)
                (directory / "status").write_text(status)
            result = sampler.read_task_inventory(22, proc)
            self.assertEqual(result["enumeratedTids"], [22, 23, 24])
            self.assertEqual(result["errors"], [])
            self.assertEqual(result["tasks"][1]["rawStat"], task_text(23)[0])
            self.assertEqual(result["tasks"][1]["rawStatus"], task_text(23)[1])
            (proc / "22" / "task" / "23" / "status").unlink()
            missing = sampler.read_task_inventory(22, proc)
            self.assertEqual(missing["enumeratedTids"], [22, 23, 24])
            self.assertEqual(len(missing["tasks"]), 3)
            self.assertEqual(missing["errors"][0]["tid"], 23)
            self.assertEqual(missing["errors"][0]["errno"], errno.ENOENT)
            self.assertEqual(missing["tasks"][1]["rawStat"], task_text(23)[0])
            (proc / "22" / "task" / "23" / "status").write_text("Pid: broken\n")
            malformed = sampler.read_task_inventory(22, proc)
            self.assertEqual(malformed["errors"][0]["field"], "stat-status-parse")
            with patch.object(Path, "iterdir", side_effect=PermissionError(errno.EACCES, "denied")):
                denied = sampler.read_task_inventory(22, proc)
            self.assertEqual(denied["errors"][0]["field"], "task-directory")
            self.assertEqual(denied["errors"][0]["errno"], errno.EACCES)
            (proc / "22" / "task" / "023").mkdir()
            alias = sampler.read_task_inventory(22, proc)
            self.assertEqual(alias["errors"][0]["field"], "task-directory")

    def test_sibling_smaps_uses_exact_task_path_and_strict_existing_units(self):
        with tempfile.TemporaryDirectory(prefix="task-smaps-") as temporary:
            proc = Path(temporary) / "22" / "task"
            directory = proc / "23"
            directory.mkdir(parents=True)
            path = directory / "smaps_rollup"
            valid = "Pss: 150 kB\nRss: 200 kB\nPrivate_Clean: 20 kB\nPrivate_Dirty: 80 kB\n"
            path.write_text(valid)
            self.assertEqual(sampler.read_smaps(23, proc), {"pssKiB": 150, "rssKiB": 200, "privateKiB": 100})
            for invalid in (valid.replace("150 kB", "150 B"), valid.replace("150", "-1"),
                            valid.replace("Pss: 150 kB\n", ""), valid.replace("150", "nan")):
                path.write_text(invalid)
                with self.assertRaises((ValueError, KeyError)):
                    sampler.read_smaps(23, proc)


if __name__ == "__main__":
    unittest.main(verbosity=2)
