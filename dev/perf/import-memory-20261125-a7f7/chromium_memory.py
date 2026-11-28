"""Sample the discovered Chromium process tree without filtering child titles.

The current run qualifies only the separately marked import window. Startup,
readback and restart remain outside reported import maxima. The legacy broad
summary helper is retained for the reviewed process-coverage witnesses.
These are diagnostic, non-atomic observations, never authoritative timings or
complete peak-memory measurements. No privilege escalation is attempted.
"""

from concurrent.futures import ThreadPoolExecutor
import errno
import json
import os
from pathlib import Path
import re
import subprocess
import time


BROWSER_NAMES = {"chrome", "chromium", "chromium-browser", "chrome-headless-shell"}
GONE_ERRORS = {errno.ENOENT, errno.ESRCH}


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


def sample_memory(root_pid, proc=Path("/proc")):
    started = time.time()
    started_ns = time.monotonic_ns()
    before = discover_tree(root_pid, process_inventory(proc))
    values = []
    unavailable = []
    if before["processes"]:
        # Every read stays inside the complete discovery bracket. Consume in
        # PID order, and join even exceptional tasks before another inventory
        # or scan can begin. This changes acquisition, not coverage rules.
        with ThreadPoolExecutor(max_workers=min(4, len(before["processes"]))) as readers:
            pending = [(process, readers.submit(read_smaps, process["pid"], proc))
                       for process in before["processes"]]
            for process, future in pending:
                pid = process["pid"]
                try:
                    values.append({**process, **future.result()})
                except (OSError, ValueError, KeyError, IndexError) as error:
                    unavailable.append({**process, "smapsReadError": read_error(error, "smaps_rollup", pid)})
    after = discover_tree(root_pid, process_inventory(proc))
    stable = tree_signature(before) == tree_signature(after)
    after_by_pid = {process["pid"]: process for process in after["processes"]}
    zombies = [{**process, "confirmationAfter": after_by_pid[process["pid"]],
                "exclusionReason": "same-identity-single-thread-Z-to-Z-exe-ENOENT-smaps-ESRCH"}
               for process in unavailable if confirmed_exited_zombie(process, after_by_pid.get(process["pid"]))]
    excluded_ids = {process["pid"] for process in zombies}
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
    if persistent_identity_errors:
        reasons.append("incomplete-process-identity-inventory")
    return {"startedAtEpochSeconds": started, "finishedAtEpochSeconds": time.time(),
            "startedAtMonotonicNs": started_ns, "finishedAtMonotonicNs": time.monotonic_ns(),
            "processes": values, "unavailableProcesses": unavailable,
            "confirmedExitedZombies": zombies, "unreadableAddressSpaces": unreadable,
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
    if any("incomplete-process-identity-inventory" in sample["qualificationFailures"] for sample in samples):
        failures.append("process-identity-coverage-unqualified")
    qualified = not failures
    return {
        "schemaVersion": 2,
        "observerRule": "stable-single-thread-zombie-esrch-v1",
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
        "maxSampledPssKiB": max((s["readableProcessPssKiB"] for s in covered), default=None) if qualified else None,
        "maxSampledPrivateKiB": max((s["readableProcessPrivateKiB"] for s in covered), default=None) if qualified else None,
        "samples": samples,
    }



def read_markers(path):
    try:
        lines = path.read_text().splitlines()
        return [json.loads(line) for line in lines if line]
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def summarize_import_window(samples, markers, exit_code):
    failures = []
    valid = (len(markers) == 2 and [m.get('event') for m in markers] == ['start', 'end'] and
             all(isinstance(m.get('monotonicNs'), str) and m['monotonicNs'].isdigit() for m in markers))
    start = int(markers[0]['monotonicNs']) if valid else 0
    end = int(markers[1]['monotonicNs']) if valid else 0
    if not valid or end <= start:
        failures.append('missing-or-invalid-import-window-markers')
    overlapping = [s for s in samples if s['finishedAtMonotonicNs'] >= start and s['startedAtMonotonicNs'] <= end] if valid else []
    inside = [s for s in overlapping if s['startedAtMonotonicNs'] >= start and s['finishedAtMonotonicNs'] <= end]
    covered = [s for s in inside if s['qualifiedForWholeTreePss']]
    before = [s for s in samples if s['qualifiedForWholeTreePss'] and s['finishedAtMonotonicNs'] <= start]
    after = [s for s in samples if s['qualifiedForWholeTreePss'] and s['startedAtMonotonicNs'] >= end]
    before_gap = (start - before[-1]['finishedAtMonotonicNs']) / 1e6 if before else None
    after_gap = (after[0]['startedAtMonotonicNs'] - end) / 1e6 if after else None
    if before_gap is None or before_gap > 250:
        failures.append('missing-covered-pre-import-bracket')
    if after_gap is None or after_gap > 250:
        failures.append('missing-covered-post-import-bracket')
    if len(covered) < 5:
        failures.append('fewer-than-five-covered-import-scans')
    points = [start] + [(s['startedAtMonotonicNs'] + s['finishedAtMonotonicNs']) // 2 for s in covered] + [end]
    gaps = [(b - a) / 1e6 for a, b in zip(points, points[1:])]
    max_gap = max(gaps, default=None) if valid else None
    if max_gap is None or max_gap > 250:
        failures.append('covered-import-scan-gap-over-250ms')
    raw = summarize_samples(overlapping, exit_code)
    failures.extend(raw['qualificationFailures'])
    failures = list(dict.fromkeys(failures))
    qualified = not failures
    return {
        **raw,
        'schemaVersion': 3,
        'observerRule': 'import-window-stable-single-thread-zombie-esrch-v1',
        'scope': 'Discovered Chromium process tree from immediately before file-input dispatch through observed UI import completion; startup, media readback and restart excluded from maxima',
        'sampling': 'Linux /proc smaps_rollup; 25 ms wait between scans; non-atomic stable identity/metadata checks',
        'authoritativeTiming': False,
        'qualifiedForWholeTreePss': qualified,
        'qualificationFailures': failures,
        'windowMarkers': markers,
        'windowDurationMs': (end - start) / 1e6 if valid else None,
        'preImportBracketGapMs': before_gap,
        'postImportBracketGapMs': after_gap,
        'maximumCoveredSampleGapMs': max_gap,
        'allObservedSampleCount': len(samples),
        'overlappingImportSampleCount': len(overlapping),
        'fullyContainedImportSampleCount': len(inside),
        'stableFullyReadImportSampleCount': len(covered),
        'maxSampledPssKiB': max((s['readableProcessPssKiB'] for s in covered), default=None) if qualified else None,
        'maxSampledPrivateKiB': max((s['readableProcessPrivateKiB'] for s in covered), default=None) if qualified else None,
        'limitations': [
            'Non-atomic sampled observations; short-lived processes and unsampled memory changes can be missed.',
            'Only complete scans wholly inside the marked automation import window contribute to maxima.',
            'Markers bracket dispatch through visible completion and include automation overhead, not readback or restart.',
            'PSS apportions shared mappings; private bytes are reported separately. Neither is an exact peak measurement.',
            'All failed and boundary scans are retained; no missing read is assigned a measured zero.',
        ],
        'samples': samples,
    }


def run_with_sampling(args, cwd, log, receipt, markers):
    samples = []
    env = dict(os.environ, MANABITAN_IMPORT_MEMORY_MARKERS=str(markers))
    deadline = time.monotonic() + 1800
    with log.open('x') as stream:
        process = subprocess.Popen(args, cwd=cwd, env=env, stdout=stream, stderr=subprocess.STDOUT)
        while process.poll() is None:
            if time.monotonic() > deadline:
                process.terminate()
                process.wait(timeout=30)
                break
            rows = read_markers(markers)
            end = int(rows[-1]['monotonicNs']) if len(rows) == 2 and rows[-1].get('event') == 'end' and str(rows[-1].get('monotonicNs', '')).isdigit() else None
            if end is None or time.monotonic_ns() <= end + 300_000_000:
                samples.append(sample_memory(process.pid))
            try:
                process.wait(timeout=0.025 if end is None else 0.1)
            except subprocess.TimeoutExpired:
                pass
    summary = summarize_import_window(samples, read_markers(markers), process.returncode)
    with receipt.open('x') as stream:
        stream.write(json.dumps(summary, indent=2) + '\n')
    return {key: value for key, value in summary.items() if key != 'samples'}
