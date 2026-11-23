"""Sample the discovered Chromium process tree without filtering child titles.

The sampling window includes startup, import, semantic readback and restart.
These are diagnostic, non-atomic observations, never authoritative timings or
complete peak-memory measurements. No privilege escalation is attempted.
"""

import errno
import json
import os
from pathlib import Path
import re
import subprocess
import time


BROWSER_NAMES = {"chrome", "chromium", "chromium-browser", "chrome-headless-shell"}
GONE_ERRORS = {errno.ENOENT, errno.ESRCH}
LIVE_TASK_STATES = {"R", "S", "D", "T", "t", "I"}
KNOWN_TASK_STATES = LIVE_TASK_STATES | {"Z", "X", "x", "K", "W", "P"}
SIBLING_RECOVERY_RULE = "stable-zombie-leader-live-sibling-smaps-v1"


def read_error(error, field, pid):
    return {"pid": pid, "field": field, "error": type(error).__name__,
            "errno": getattr(error, "errno", None), "message": str(error)}


def process_inventory(proc=Path("/proc")):
    """Read identities and parentage independently of executable/title access."""
    processes = {}
    failures = []
    for directory in proc.iterdir():
        if not directory.name.isdigit():
            continue
        pid = int(directory.name)
        try:
            # comm may contain spaces and parentheses; fields begin after its
            # final closing parenthesis. Start time prevents ordinary PID reuse.
            fields = (directory / "stat").read_text(errors="replace").rsplit(")", 1)[1].split()
            process = {"pid": pid, "parentPid": int(fields[1]),
                       "startTimeTicks": int(fields[19]), "state": fields[0],
                       "threadCount": int(fields[17]),
                       "executable": None, "comm": None, "argv": None,
                       "metadataReadErrors": []}
        except (OSError, ValueError, IndexError) as error:
            failures.append(read_error(error, "stat", pid))
            continue
        for field, reader in (
            ("executable", lambda: os.readlink(directory / "exe")),
            ("comm", lambda: (directory / "comm").read_text(errors="replace").rstrip("\n")),
            ("argv", lambda: [part.decode(errors="replace") for part in
                              (directory / "cmdline").read_bytes().rstrip(b"\0").split(b"\0")]),
        ):
            try:
                process[field] = reader()
            except OSError as error:
                process["metadataReadErrors"].append(read_error(error, field, pid))
        processes[pid] = process
    return {"processes": processes, "identityReadErrors": failures}


def descendants(seeds, processes):
    selected = set(seeds)
    while True:
        expanded = selected | {pid for pid, process in processes.items()
                               if process["parentPid"] in selected}
        if expanded == selected:
            return selected
        selected = expanded


def browser_identity(process):
    executable = process["executable"]
    if executable is not None:
        # Linux appends this suffix when an open executable has been removed.
        return "exe" if Path(executable.removesuffix(" (deleted)")).name in BROWSER_NAMES else None
    argv = process["argv"]
    if argv and argv[0]:
        # Chromium can rewrite argv[0] to include its arguments. This fallback
        # is only needed when /proc/PID/exe cannot be read.
        first_word = argv[0].split()[0]
        if Path(argv[0]).name in BROWSER_NAMES or Path(first_word).name in BROWSER_NAMES:
            return "argv0-fallback"
    return None


def process_role(process, is_browser_seed):
    command = " ".join(process["argv"] or [])
    match = re.search(r"(?:^|\s)--type(?:=|\s+)([^\s]+)", command)
    if match:
        return match.group(1)
    if is_browser_seed:
        return "browser"
    return "descendant-unknown"


def discover_tree(root_pid, inventory):
    processes = inventory["processes"]
    runner_descendants = descendants({root_pid}, processes)
    seeds = {pid: browser_identity(processes[pid]) for pid in runner_descendants if pid in processes}
    seeds = {pid: reason for pid, reason in seeds.items() if reason is not None}
    selected = descendants(seeds, processes)
    records = []
    for pid in sorted(selected):
        if pid not in processes:
            continue
        process = processes[pid]
        records.append({**process, "browserSeedMatch": seeds.get(pid),
                        "role": process_role(process, pid in seeds)})
    return {"processes": records, "browserSeedPids": sorted(seeds),
            "runnerDescendantPids": sorted(pid for pid in runner_descendants if pid in processes),
            "inventoryIdentityReadErrors": inventory["identityReadErrors"]}


def read_smaps(pid, proc=Path("/proc")):
    values = {}
    for line in (proc / str(pid) / "smaps_rollup").read_text().splitlines():
        key, _, value = line.partition(":")
        if key not in {"Pss", "Rss", "Private_Clean", "Private_Dirty"}:
            continue
        parts = value.split()
        if len(parts) != 2 or parts[1] != "kB":
            raise ValueError("Unexpected smaps_rollup units")
        number = int(parts[0])
        if number < 0:
            raise ValueError("Negative smaps_rollup value")
        values[key] = number
    return {"pssKiB": values["Pss"], "rssKiB": values["Rss"],
            "privateKiB": values["Private_Clean"] + values["Private_Dirty"]}


def tree_signature(tree):
    return [(p["pid"], p["startTimeTicks"], p["parentPid"], p["executable"],
             p["comm"], p["argv"], p["role"]) for p in tree["processes"]]


def confirmed_exited_zombie(before, after):
    """Recognize only an unchanged single-thread zombie without an address space.

    A zombie thread-group leader can still have live sibling threads. Require
    one thread at both ends; missing/unknown counts fail closed. ESRCH alone,
    a missing exe alone, permission failures and PID reuse never qualify.
    """
    if after is None or before.get("smapsReadError", {}).get("errno") != errno.ESRCH:
        return False
    for field in ("pid", "startTimeTicks"):
        if type(before.get(field)) is not int or type(after.get(field)) is not int or before[field] != after[field]:
            return False
    for process in (before, after):
        if (process.get("state") != "Z" or type(process.get("threadCount")) is not int or
                process["threadCount"] != 1 or process.get("executable", "unknown") is not None):
            return False
        if not any(error.get("field") == "executable" and error.get("errno") == errno.ENOENT
                   for error in process.get("metadataReadErrors", [])):
            return False
    return True


def recoverable_zombie_leader(process):
    """Require affirmative evidence, not merely an unavailable executable."""
    if (type(process.get("pid")) is not int or process["pid"] <= 0 or
            type(process.get("startTimeTicks")) is not int or process["startTimeTicks"] < 0 or
            process.get("state") != "Z" or type(process.get("threadCount")) is not int or
            process["threadCount"] <= 1 or process.get("executable", "unknown") is not None):
        return False
    errors = process.get("metadataReadErrors", [])
    return bool(errors) and all(error.get("field") == "executable" and
                                error.get("errno") == errno.ENOENT for error in errors)


def parse_task_identity(tid, stat, status):
    """Read identity from both proc records; preserve their original text."""
    prefix, separator, remainder = stat.partition(" (")
    if not separator or prefix != str(tid) or ")" not in remainder:
        raise ValueError("Task stat PID/comm header does not match its directory")
    fields = remainder.rsplit(")", 1)[1].split()
    if len(fields) < 20 or fields[0] not in KNOWN_TASK_STATES:
        raise ValueError("Missing or invalid task stat fields")
    for index in (1, 17, 19):
        if not re.fullmatch(r"[0-9]+", fields[index]):
            raise ValueError("Invalid task stat identity/count")
    selected = {}
    for line in status.splitlines():
        name, separator, value = line.partition(":")
        if name not in {"Pid", "Tgid", "Threads", "State"}:
            continue
        if not separator or name in selected:
            raise ValueError("Duplicate or malformed task status field")
        selected[name] = value.strip()
    if set(selected) != {"Pid", "Tgid", "Threads", "State"}:
        raise ValueError("Missing task status identity/count/state")
    for name in ("Pid", "Tgid", "Threads"):
        if not re.fullmatch(r"[0-9]+", selected[name]):
            raise ValueError("Invalid task status identity/count")
    status_state = selected["State"].split()[0] if selected["State"] else None
    if status_state not in KNOWN_TASK_STATES:
        raise ValueError("Unknown task status state")
    if int(selected["Pid"]) != tid or int(selected["Threads"]) != int(fields[17]):
        raise ValueError("Task stat and status disagree on identity/count")
    if int(selected["Tgid"]) <= 0 or int(fields[17]) <= 0:
        raise ValueError("Invalid task group/count")
    return {"tid": tid, "tgid": int(selected["Tgid"]),
            "startTimeTicks": int(fields[19]), "parentPid": int(fields[1]),
            "state": fields[0], "statusState": status_state,
            "threadCount": int(fields[17])}


def read_task_inventory(pid, proc=Path("/proc")):
    """Never omit a task whose directory was enumerated but cannot be read."""
    directory = proc / str(pid) / "task"
    result = {"startedAtEpochSeconds": time.time(), "path": str(directory),
              "enumeratedTids": [], "tasks": [], "errors": []}
    try:
        names = sorted(entry.name for entry in directory.iterdir())
        if any(not re.fullmatch(r"[1-9][0-9]*", name) for name in names):
            raise ValueError("Unexpected or noncanonical task directory name")
        tids = sorted(int(name) for name in names)
        if len(set(tids)) != len(tids):
            raise ValueError("Duplicate task identity")
        result["enumeratedTids"] = tids
    except (OSError, ValueError) as error:
        result["errors"].append(read_error(error, "task-directory", pid))
        result["finishedAtEpochSeconds"] = time.time()
        return result
    for tid in tids:
        record = {"tid": tid}
        field = "stat"
        try:
            record["rawStat"] = (directory / str(tid) / "stat").read_text()
            field = "status"
            record["rawStatus"] = (directory / str(tid) / "status").read_text()
            field = "stat-status-parse"
            record.update(parse_task_identity(tid, record["rawStat"], record["rawStatus"]))
        except (OSError, UnicodeError, ValueError, KeyError, IndexError) as error:
            failure = {**read_error(error, field, pid), "tid": tid}
            result["errors"].append(failure)
            record["identityReadError"] = failure
        result["tasks"].append(record)
    result["finishedAtEpochSeconds"] = time.time()
    return result


def task_inventory_failures(snapshot, leader):
    """Validate complete membership and count against the global leader."""
    failures = []
    if snapshot["errors"]:
        failures.append("task-identity-read-failed")
    tids = snapshot["enumeratedTids"]
    tasks = snapshot["tasks"]
    if tids != sorted(set(tids)) or [task["tid"] for task in tasks] != tids:
        failures.append("malformed-task-membership-proof")
    if len(tids) != leader["threadCount"] or leader["pid"] not in tids:
        failures.append("task-membership-or-count-mismatch")
    for task in tasks:
        # An ordinary disappearance/count mismatch must not mask an unrelated
        # malformed group proof from another successfully read task. Failed
        # task records retain their errors and may lack parsed identity fields.
        if "identityReadError" in task:
            continue
        if task["tgid"] != leader["pid"]:
            failures.append("task-group-mismatch")
        if task["threadCount"] != leader["threadCount"] or task["parentPid"] != leader["parentPid"]:
            failures.append("task-count-or-parent-mismatch")
        if task["tid"] == leader["pid"] and (
                task["startTimeTicks"] != leader["startTimeTicks"] or
                task["state"] != "Z" or task["statusState"] != "Z"):
            failures.append("task-leader-identity-or-state-mismatch")
    return sorted(set(failures))


def read_sibling_address_space(leader, proc=Path("/proc")):
    """Try one deterministic representative; never retry another sibling."""
    pid = leader["pid"]
    before = read_task_inventory(pid, proc)
    attempt = {"rule": SIBLING_RECOVERY_RULE, "leaderPid": pid,
               "leaderBefore": leader, "tasksBefore": before,
               "representativeTid": None, "representativeReadPath": None,
               "representativeSmaps": None, "representativeReadError": None,
               "representativeReadCount": 0, "qualified": False,
               "qualificationFailures": task_inventory_failures(before, leader)}
    if not attempt["qualificationFailures"]:
        live = [task["tid"] for task in before["tasks"] if task["tid"] != pid and
                task["state"] in LIVE_TASK_STATES and task["statusState"] in LIVE_TASK_STATES]
        if not live:
            attempt["qualificationFailures"].append("no-live-nonleader-task")
        else:
            tid = min(live)
            attempt["representativeTid"] = tid
            attempt["representativeReadPath"] = str(proc / str(pid) / "task" / str(tid) / "smaps_rollup")
            attempt["representativeReadCount"] = 1
            try:
                attempt["representativeSmaps"] = read_smaps(tid, proc / str(pid) / "task")
            except (OSError, UnicodeError, ValueError, KeyError, IndexError) as error:
                attempt["representativeReadError"] = {**read_error(error, "task-smaps_rollup", pid), "tid": tid}
                attempt["qualificationFailures"].append("representative-smaps-read-failed")
    attempt["tasksAfter"] = read_task_inventory(pid, proc)
    return attempt


def confirm_sibling_address_space(attempt, leader_after):
    """Confirm only after the entire ordinary process-tree scan has ended."""
    before = attempt["leaderBefore"]
    failures = attempt["qualificationFailures"]
    attempt["leaderAfter"] = leader_after
    if leader_after is None or not recoverable_zombie_leader(leader_after):
        failures.append("global-leader-no-longer-eligible")
    else:
        fields = ("pid", "startTimeTicks", "parentPid", "state", "threadCount",
                  "executable", "comm", "argv", "role")
        if any(before[field] != leader_after[field] for field in fields):
            failures.append("global-leader-identity-state-or-count-changed")
        failures.extend(task_inventory_failures(attempt["tasksAfter"], leader_after))
    # Comparing both task inventories to the original leader also refuses
    # compensating global/task-count changes during recovery.
    failures.extend(task_inventory_failures(attempt["tasksAfter"], before))
    first, last = attempt["tasksBefore"], attempt["tasksAfter"]
    if not first["errors"] and not last["errors"]:
        signature = lambda snapshot: [(t["tid"], t["tgid"], t["startTimeTicks"],
                                       t["parentPid"], t["threadCount"]) for t in snapshot["tasks"]]
        if first["enumeratedTids"] != last["enumeratedTids"] or signature(first) != signature(last):
            failures.append("task-membership-or-identity-changed")
        representative = next((task for task in last["tasks"] if task["tid"] == attempt["representativeTid"]), None)
        if representative is None or representative["state"] not in LIVE_TASK_STATES or representative["statusState"] not in LIVE_TASK_STATES:
            failures.append("representative-not-live-after-read")
    if attempt["representativeReadCount"] != 1 or attempt["representativeSmaps"] is None:
        failures.append("no-single-successful-representative-read")
    attempt["qualificationFailures"] = sorted(set(failures))
    attempt["qualified"] = not attempt["qualificationFailures"]
    return attempt["qualified"]


def persistent_sibling_recovery_failure(attempt):
    """Retain the old exit-vs-denial distinction at observation scope.

    Every failed proof rejects its sample. A changed global tree may explain
    ordinary disappearance/identity churn, but never permission, parse or
    internally malformed proof failures, even when the primary error is ESRCH.
    """
    errors = attempt["tasksBefore"]["errors"] + attempt["tasksAfter"]["errors"]
    if attempt["representativeReadError"] is not None:
        errors += [attempt["representativeReadError"]]
    if attempt["leaderAfter"] is not None:
        errors += attempt["leaderAfter"].get("metadataReadErrors", [])
    if any(error.get("errno") not in GONE_ERRORS for error in errors):
        return True
    return bool({"malformed-task-membership-proof", "task-group-mismatch"} &
                set(attempt["qualificationFailures"]))


def sample_memory(root_pid, proc=Path("/proc")):
    started = time.time()
    before = discover_tree(root_pid, process_inventory(proc))
    values = []
    unavailable = []
    recoveries = []
    for process in before["processes"]:
        pid = process["pid"]
        try:
            values.append({**process, **read_smaps(pid, proc)})
        except (OSError, ValueError, KeyError, IndexError) as error:
            failure = {**process, "smapsReadError": read_error(error, "smaps_rollup", pid)}
            unavailable.append(failure)
            if failure["smapsReadError"]["errno"] == errno.ESRCH and recoverable_zombie_leader(failure):
                recoveries.append(read_sibling_address_space(failure, proc))
    after = discover_tree(root_pid, process_inventory(proc))
    stable = tree_signature(before) == tree_signature(after)
    after_by_pid = {process["pid"]: process for process in after["processes"]}
    recovered_ids = set()
    for index, attempt in enumerate(recoveries):
        if confirm_sibling_address_space(attempt, after_by_pid.get(attempt["leaderPid"])):
            leader = attempt["leaderBefore"]
            recovered_ids.add(leader["pid"])
            values.append({**{key: value for key, value in leader.items() if key != "smapsReadError"},
                           **attempt["representativeSmaps"], "memoryReadMethod": SIBLING_RECOVERY_RULE,
                           "representativeTid": attempt["representativeTid"], "recoveryAttemptIndex": index})
    values.sort(key=lambda value: value["pid"])
    zombies = [{**process, "confirmationAfter": after_by_pid[process["pid"]],
                "exclusionReason": "same-identity-single-thread-Z-to-Z-exe-ENOENT-smaps-ESRCH"}
               for process in unavailable if confirmed_exited_zombie(process, after_by_pid.get(process["pid"]))]
    excluded_ids = {process["pid"] for process in zombies} | recovered_ids
    unreadable = [process for process in unavailable if process["pid"] not in excluded_ids]
    identity_errors = before["inventoryIdentityReadErrors"] + after["inventoryIdentityReadErrors"]
    persistent_identity_errors = [item for item in identity_errors if item["errno"] not in GONE_ERRORS]
    roles = {value["role"] for value in values}
    reasons = []
    if not before["browserSeedPids"]:
        reasons.append("no-browser-seed")
    if len(values) < 2:
        reasons.append("no-multiple-process-coverage")
    if "browser" not in roles:
        reasons.append("no-readable-browser-process")
    if "renderer" not in roles:
        reasons.append("no-readable-renderer-process")
    if not stable:
        reasons.append("process-tree-changed-during-scan")
    if unreadable:
        reasons.append("unreadable-discovered-process-smaps")
    if any(not attempt["qualified"] for attempt in recoveries):
        reasons.append("sibling-address-space-recovery-unqualified")
    if persistent_identity_errors:
        reasons.append("incomplete-process-identity-inventory")
    return {"startedAtEpochSeconds": started, "finishedAtEpochSeconds": time.time(),
            "processes": values, "unavailableProcesses": unavailable,
            "confirmedExitedZombies": zombies, "unreadableAddressSpaces": unreadable,
            "addressSpaceRecoveryAttempts": recoveries,
            "discoveryBefore": before, "discoveryAfter": after,
            "stableObservedProcessTree": stable, "observedRoles": sorted(roles),
            "qualifiedForWholeTreePss": not reasons, "qualificationFailures": reasons,
            # These sums are explicitly partial unless qualification passes.
            "readableProcessPssKiB": sum(value["pssKiB"] for value in values),
            "readableProcessPrivateKiB": sum(value["privateKiB"] for value in values)}


def summarize_samples(samples, exit_code):
    covered = [sample for sample in samples if sample["qualifiedForWholeTreePss"]]
    failures = []
    if exit_code != 0:
        failures.append("benchmark-command-failed")
    if not covered:
        failures.append("no-stable-fully-read-browser-renderer-tree")
    # A process that exits during a scan invalidates that sample. Denied reads
    # or missing reads in an otherwise stable tree invalidate the entire run;
    # they cannot silently disappear from a reported whole-tree maximum.
    unreadable_stable = [sample for sample in samples
                         if sample["stableObservedProcessTree"] and sample["unreadableAddressSpaces"]]
    denied = [item for sample in samples for item in sample["unreadableAddressSpaces"]
              if item["smapsReadError"]["errno"] not in GONE_ERRORS]
    if unreadable_stable or denied:
        failures.append("process-smaps-coverage-unqualified")
    if any(persistent_sibling_recovery_failure(attempt) for sample in samples
           for attempt in sample["addressSpaceRecoveryAttempts"]):
        failures.append("sibling-recovery-permission-parse-or-proof-failure")
    if any("incomplete-process-identity-inventory" in sample["qualificationFailures"] for sample in samples):
        failures.append("process-identity-coverage-unqualified")
    qualified = not failures
    return {
        "schemaVersion": 3,
        "observerRule": SIBLING_RECOVERY_RULE,
        "scope": "Discovered Chromium process trees during startup, import, semantic readback and restart",
        "authoritativeTiming": False,
        "sampling": "Linux /proc smaps_rollup PSS; 100ms wait between scans; PID, start-time, parentage and process metadata checked before and after each scan",
        "limitations": [
            "Non-atomic sampled observations; processes and memory can change between individual reads.",
            "Short-lived processes between scans and processes reparented before discovery can be missed.",
            "Only stable fully read trees containing browser and renderer processes contribute; this is not a complete peak measurement.",
            "PSS apportions shared mappings; changing external sharers can affect it. Private bytes are reported separately.",
            "The window includes startup, readback and browser restart, not just import.",
            "Confirmed single-thread zombies have no userspace address space; their task identities and ESRCH reads are retained separately, without inventing a measured PSS value.",
            "A zombie leader with live siblings is measured once through a deterministic live task only when complete task identities, membership, counts and global leader metadata remain consistent. All primary failures and recovery proof are retained.",
            "Task-directory availability after leader exit is not assumed. Every failed recovery proof rejects the sample. Stable unreadable trees and any secondary permission, parse or malformed proof failure invalidate the observation; expected exits during changed trees reject only their samples. Snapshots cannot detect all intervening changes.",
        ],
        "benchmarkExitCode": exit_code,
        "qualifiedForWholeTreePss": qualified,
        "qualificationFailures": failures,
        "sampleCount": len(samples),
        "stableFullyReadTreeSampleCount": len(covered),
        "observedProcessCountRange": [min((len(s["processes"]) for s in covered), default=0),
                                      max((len(s["processes"]) for s in covered), default=0)],
        "samplesWithUnavailableSmaps": sum(bool(s["unavailableProcesses"]) for s in samples),
        "samplesWithUnreadableAddressSpaces": sum(bool(s["unreadableAddressSpaces"]) for s in samples),
        "confirmedExitedZombieObservationCount": sum(len(s["confirmedExitedZombies"]) for s in samples),
        "confirmedExitedZombieIdentityCount": len({(p["pid"], p["startTimeTicks"]) for s in samples for p in s["confirmedExitedZombies"]}),
        "successfulSiblingRecoveryCount": sum(a["qualified"] for s in samples for a in s["addressSpaceRecoveryAttempts"]),
        "failedSiblingRecoveryCount": sum(not a["qualified"] for s in samples for a in s["addressSpaceRecoveryAttempts"]),
        "maxSampledPssKiB": max((s["readableProcessPssKiB"] for s in covered), default=None) if qualified else None,
        "maxSampledPrivateKiB": max((s["readableProcessPrivateKiB"] for s in covered), default=None) if qualified else None,
        "samples": samples,
    }


def run_with_sampling(args, cwd, log, receipt):
    samples = []
    with log.open("x") as stream:
        process = subprocess.Popen(args, cwd=cwd, stdout=stream, stderr=subprocess.STDOUT)
        while process.poll() is None:
            samples.append(sample_memory(process.pid))
            try:
                process.wait(timeout=0.1)
            except subprocess.TimeoutExpired:
                pass
    summary = summarize_samples(samples, process.returncode)
    with receipt.open("x") as stream:
        stream.write(json.dumps(summary, indent=2) + "\n")
    # The caller preserves all predeclared observations, including failed
    # memory qualification. A failure is not retried or replaced.
    return {key: value for key, value in summary.items() if key != "samples"}
