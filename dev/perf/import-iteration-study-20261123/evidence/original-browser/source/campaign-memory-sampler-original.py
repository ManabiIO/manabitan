"""Diagnostic PSS sampling for the Chromium descendants of one benchmark run.

These observations are separate from the authoritative timing schedule. The
window includes browser startup, import, sampled readback and browser restart.
PSS apportions shared mappings rather than summing duplicate RSS mappings.
"""

import json
from pathlib import Path
import subprocess
import time


def process_inventory():
    result = {}
    for directory in Path("/proc").iterdir():
        if not directory.name.isdigit():
            continue
        try:
            stat = (directory / "stat").read_text().rsplit(")", 1)[1].split()
            command = (directory / "cmdline").read_bytes().split(b"\0", 1)[0].decode()
            result[int(directory.name)] = (int(stat[1]), Path(command).name)
        except (OSError, ValueError, IndexError, UnicodeError):
            continue
    return result


def chromium_descendants(root_pid, processes):
    descendants = {root_pid}
    while True:
        expanded = descendants | {pid for pid, (parent, _) in processes.items() if parent in descendants}
        if expanded == descendants:
            break
        descendants = expanded
    return sorted(pid for pid in descendants if processes.get(pid, (0, ""))[1] in {
        "chrome", "chromium", "chromium-browser", "chrome-headless-shell",
    })


def sample_memory(root_pid):
    process_ids = chromium_descendants(root_pid, process_inventory())
    values = []
    unavailable = []
    for pid in process_ids:
        try:
            fields = {}
            for line in Path(f"/proc/{pid}/smaps_rollup").read_text().splitlines():
                key, _, value = line.partition(":")
                if key in {"Pss", "Rss", "Private_Clean", "Private_Dirty"}:
                    fields[key] = int(value.split()[0])
            values.append({"pid": pid, "pssKiB": fields["Pss"], "rssKiB": fields["Rss"],
                           "privateKiB": fields["Private_Clean"] + fields["Private_Dirty"]})
        except (OSError, ValueError, KeyError, IndexError):
            unavailable.append(pid)
    stable = process_ids == chromium_descendants(root_pid, process_inventory())
    return {"atEpochSeconds": time.time(), "processes": values, "unavailablePids": unavailable,
            "discoveredPids": process_ids, "stableObservedProcessSet": stable,
            "pssKiB": sum(value["pssKiB"] for value in values),
            "privateKiB": sum(value["privateKiB"] for value in values)}


def run_with_sampling(args, cwd, log, receipt):
    samples = []
    with log.open("w") as stream:
        process = subprocess.Popen(args, cwd=cwd, stdout=stream, stderr=subprocess.STDOUT)
        while process.poll() is None:
            sample = sample_memory(process.pid)
            if sample["processes"] or sample["unavailablePids"]:
                samples.append(sample)
            try:
                process.wait(timeout=0.1)
            except subprocess.TimeoutExpired:
                pass
    covered = [sample for sample in samples if sample["processes"] and not sample["unavailablePids"]
               and sample["stableObservedProcessSet"]]
    summary = {
        "scope": "Chromium descendant process tree during startup, import, sampled readback and restart",
        "authoritativeTiming": False,
        "sampling": "Linux /proc smaps_rollup PSS; 100ms wait between scans; PID sets checked before and after each scan",
        "limitation": "Sampled process tree, not an atomic peak measurement; short-lived processes between scans can be missed",
        "benchmarkExitCode": process.returncode,
        "sampleCount": len(samples),
        "stableFullyReadSampleCount": len(covered),
        "maxSampledPssKiB": max((sample["pssKiB"] for sample in covered), default=None),
        "maxSampledPrivateKiB": max((sample["privateKiB"] for sample in covered), default=None),
        "samples": samples,
    }
    receipt.write_text(json.dumps(summary, indent=2) + "\n")
    if process.returncode != 0:
        raise subprocess.CalledProcessError(process.returncode, args)
    if not covered:
        raise RuntimeError("No stable Chromium process-memory samples")
    return {key: value for key, value in summary.items() if key != "samples"}
