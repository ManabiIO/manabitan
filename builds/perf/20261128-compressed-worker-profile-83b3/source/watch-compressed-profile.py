#!/usr/bin/env python3
"""Supervise one direct profiler child; sampled RSS is not a peak guarantee."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import signal
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--log", required=True)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a direct child command is required")
    output, log, receipt = map(Path, (args.out, args.log, args.receipt))
    for target in (output, log, receipt):
        if target.exists():
            raise FileExistsError(target)
    if not Path(command[0]).is_file():
        raise FileNotFoundError(command[0])
    # Verify the only proc interface used by this supervisor before starting Node.
    if "VmRSS:" not in Path("/proc/self/status").read_text():
        raise RuntimeError("/proc process RSS observation is unavailable")
    interval = 0.05
    rss_limit = 400 * 1024 * 1024
    output_limit = 16 * 1024 * 1024
    started = time.monotonic()
    report = {
        "schemaVersion": 1,
        "complete": False,
        "command": command,
        "cwd": os.getcwd(),
        "supervisorSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "rssLimitBytes": rss_limit,
        "nominalSampleIntervalSeconds": interval,
        "rssBoundary": "Direct child /proc/<pid>/status VmRSS, sampled; no transient peak or finite hidden container limit guarantee",
        "combinedOutputLimitBytes": output_limit,
        "outerDeadlineSeconds": 120,
        "samples": [],
        "terminationReason": None,
    }
    child = None
    received_signal = None

    def on_signal(number, _frame):
        nonlocal received_signal
        received_signal = number

    for number in (signal.SIGTERM, signal.SIGINT):
        signal.signal(number, on_signal)

    def external_bytes():
        total = log.stat().st_size if log.exists() else 0
        if output.exists():
            total += sum(p.stat().st_size for p in output.rglob("*") if p.is_file())
        return total

    def write_receipt():
        encoded = (json.dumps(report, indent=2) + "\n").encode()
        if len(encoded) > 1024 * 1024:
            raise RuntimeError("RSS receipt exceeds 1 MiB bound")
        receipt.write_bytes(encoded)
        return len(encoded)

    try:
        with log.open("xb") as stream:
            child = subprocess.Popen(command, stdout=stream, stderr=subprocess.STDOUT)
            report["childPid"] = child.pid
            while child.poll() is None:
                if received_signal is not None:
                    report["terminationReason"] = f"external-signal-{received_signal}"
                    break
                try:
                    status = Path(f"/proc/{child.pid}/status").read_text()
                except FileNotFoundError:
                    if child.poll() is not None:
                        break
                    raise
                rss_rows = [line for line in status.splitlines() if line.startswith("VmRSS:")]
                if rss_rows:
                    fields = rss_rows[0].split()
                    if fields[2] != "kB":
                        raise RuntimeError("Unexpected VmRSS units")
                    rss = int(fields[1]) * 1024
                    report["samples"].append({"elapsedSeconds": time.monotonic() - started, "rssBytes": rss})
                    if rss > rss_limit:
                        report["terminationReason"] = "sampled-child-rss-exceeded-400MiB"
                        break
                elif child.poll() is None:
                    raise RuntimeError("Live direct child has no observable VmRSS")
                receipt_bytes = write_receipt()
                if external_bytes() + receipt_bytes > output_limit:
                    report["terminationReason"] = "combined-evidence-output-exceeded-16MiB"
                    break
                time.sleep(interval)
            if report["terminationReason"] is not None and child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    child.kill()
            report["childExitCode"] = child.wait()
            report["receivedSignal"] = received_signal
            if received_signal is not None and report["terminationReason"] is None:
                report["terminationReason"] = f"external-signal-{received_signal}"
            report["elapsedSeconds"] = time.monotonic() - started
            usage = resource.getrusage(resource.RUSAGE_CHILDREN)
            report["childResourceUsage"] = {
                "userSeconds": usage.ru_utime,
                "systemSeconds": usage.ru_stime,
                "maxRssKiB": usage.ru_maxrss,
                "voluntaryContextSwitches": usage.ru_nvcsw,
                "involuntaryContextSwitches": usage.ru_nivcsw,
            }
            report["maximumSampledRssBytes"] = max((sample["rssBytes"] for sample in report["samples"]), default=None)
            report["complete"] = report["childExitCode"] == 0 and report["terminationReason"] is None and received_signal is None and bool(report["samples"])
            if external_bytes() + len((json.dumps(report, indent=2) + "\n").encode()) > output_limit:
                report["complete"] = False
                report["terminationReason"] = "combined-evidence-output-exceeded-16MiB"
            write_receipt()
            return 0 if report["complete"] else 1
    except BaseException as error:
        report["complete"] = False
        report["supervisorFailure"] = {"type": type(error).__name__, "message": str(error)[:2048]}
        raise
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        report["receivedSignal"] = received_signal
        if received_signal is not None:
            report["complete"] = False
            if report["terminationReason"] is None:
                report["terminationReason"] = f"external-signal-{received_signal}"
        write_receipt()


if __name__ == "__main__":
    sys.exit(main())
