#!/usr/bin/env python3
"""Fixed, separately instrumented memory screen for retained-buffer changes.

Copyright (C) 2026 Manabitan authors
SPDX-License-Identifier: GPL-3.0-or-later
"""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import time

from chromium_memory import run_with_sampling
from overlay_helpers import memory_overlay, schedule


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
spec = importlib.util.spec_from_file_location("qualification", ROOT / "dev/perf/qualify-import-ca365.py")
study = importlib.util.module_from_spec(spec)
spec.loader.exec_module(study)
command, save, digest = study.command, study.write_json, study.sha256


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("candidate")
    parser.add_argument("dictionary", choices=["jmdict", "jitendex", "vndb"])
    parser.add_argument("replication", type=int, choices=[1, 2])
    args = parser.parse_args()
    config = json.loads(study.PROTOCOL_PATH.read_text())
    candidate = config["candidates"][args.candidate]
    if command(["node", "--version"]).stdout.strip() != "v22.22.0":
        raise RuntimeError("Memory qualification requires Node 22.22.0")
    output = ROOT / "builds/memory-qualification"
    output.mkdir(parents=True, exist_ok=False)
    shutil.copytree(HERE, output / "observer-source", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copyfile(study.PROTOCOL_PATH, output / "protocol.json")
    shutil.copyfile(ROOT / "dev/perf/qualify-import-ca365.py", output / "executed-packager.py")
    shutil.copyfile(ROOT / ".github/workflows/import-memory-ca365.yml", output / "executed-workflow.yml")
    command(["git", "diff", "--exit-code", config["base"], candidate["commit"], "--",
             "package.json", "package-lock.json", "dev/perf", "test/chromium", "test/e2e", "test/perf",
             "ext/js/pages/settings/dictionary-import-controller.js"])
    (output / "candidate.patch").write_bytes(subprocess.check_output(
        ["git", "diff", "--binary", config["base"], candidate["commit"]], cwd=ROOT))
    shutil.copyfile(ROOT / "test/chromium/extension-two-dictionary-import.e2e.js", output / "original-harness.e2e.js")
    original_harness = (ROOT / "test/chromium/extension-two-dictionary-import.e2e.js").read_text()
    overlay = memory_overlay(original_harness)
    overlay_sha = hashlib.sha256(overlay.encode()).hexdigest()
    (output / "memory-harness.e2e.js").write_text(overlay)
    plan = {
        "schemaVersion": 1, "candidate": args.candidate, "dictionary": args.dictionary,
        "replication": args.replication, "schedule": schedule(args.replication), "config": config,
        "workflowCommit": command(["git", "rev-parse", "HEAD"]).stdout.strip(),
        "workflowRun": os.environ.get("GITHUB_RUN_ID"), "workflowAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
        "authoritativeTiming": False,
        "scope": "Separate import-window PSS/private diagnosis. The observer and test-only markers perturb timing; all internal benchmark authoritativeTiming labels are overridden by this outer protocol.",
        "memoryOverlaySha256": overlay_sha,
        "originalHarnessSha256": hashlib.sha256(original_harness.encode()).hexdigest(),
        "promotionCriteria": {"maximumMedianPairedIncreasePercent": 5, "maximumIndividualPairedIncreasePercent": 10,
                              "everyObservationQualified": True},
        "frozenCoverage": {"minimumFullyCoveredImportScans": 5, "maximumCoveredGapMs": 250,
                           "maximumBracketGapMs": 250, "betweenScanWaitMs": 25},
        "limitations": "Non-atomic sampled process-tree maxima; these are not exact peaks or proof of all-workload memory nonregression.",
    }
    save(output / "plan.json", plan)
    command(["node", "dev/perf/prepare-dictionaries.js", args.dictionary], log=output / "fixture-prepare.log")
    cache = (ROOT / "builds/e2e-dictionary-cache").resolve()
    fixture = json.loads((ROOT / "test/perf/dictionaries.lock.json").read_text())["dictionaries"][args.dictionary]
    if digest(cache / fixture["cacheFile"]) != fixture["sha256"]:
        raise RuntimeError("Pinned source archive mismatch")
    save(output / "fixture.json", fixture)
    arms, receipts, members = {}, {}, {}
    for arm, commit in [("A", config["base"]), ("B", candidate["commit"])]:
        location, receipt, hashes = study.prepare_arm("memory-" + arm, commit, output, cache)
        arms[arm], receipts[arm], members[arm] = location, receipt, hashes
        harness_path = location / "test/chromium/extension-two-dictionary-import.e2e.js"
        if digest(harness_path) != plan["originalHarnessSha256"]:
            raise RuntimeError("Memory harness differs between arms")
        harness_path.write_text(overlay)
    changes = sorted(name for name in members["A"].keys() | members["B"].keys()
                     if members["A"].get(name) != members["B"].get(name))
    save(output / "package-delta.json", changes)
    if changes != sorted(candidate["packagedDelta"]):
        raise RuntimeError("Unreviewed package differences in memory screen")
    observations, validation_failures = [], []
    semantic = None
    for item in plan["schedule"]:
        destination = output / item["name"]
        destination.mkdir()
        arm_root, receipt = arms[item["arm"]], receipts[item["arm"]]
        try:
            command(["node", "dev/perf/host-environment.js"], cwd=arm_root, log=destination / "host-before.json")
            memory = run_with_sampling(
                ["node", "dev/perf/import-benchmark.js", args.dictionary, "--runs", "1", "--no-build",
                 "--build-target", "chrome", "--media-check", "all", "--output", str(destination)],
                arm_root, destination / "run.log", destination / "memory.json", destination / "markers.jsonl")
        except BaseException as error:
            save(destination / "acquisition-failure.json", {
                **item, "status": "incomplete", "type": type(error).__name__, "error": str(error),
                "sampleMaxima": None, "retried": False,
            })
            raise
        observations.append({**item, **memory})
        save(output / "observations.json", observations)
        try:
            report = json.loads((destination / "run-1.json").read_text())
            summary = json.loads((destination / "summary.json").read_text())
            if len(summary["runs"]) != 1:
                raise RuntimeError("Expected one complete import in each memory observation")
            if report["status"] != "success" or report["skippedVerification"]:
                raise RuntimeError("Memory observation failed import validation")
            if report["packageSha256"] != receipt["packageSha256"] or report["browserVersion"] != config["browserVersion"]:
                raise RuntimeError("Executed release or browser mismatch")
            if summary["gitSha"] != receipt["sourceCommit"] or summary["source"]["sha256"]["test/chromium/extension-two-dictionary-import.e2e.js"] != overlay_sha:
                raise RuntimeError("Source lineage or applied overlay mismatch")
            current = study.semantic_receipt(report)
            media = current["media"]
            if media["mode"] != "all" or media["files"] != fixture["mediaFiles"] or media["files"] != media["totalFiles"] or \
                    media["bytes"] != fixture["mediaBytes"] or media["bytes"] != media["totalBytes"]:
                raise RuntimeError("Memory observation did not verify every persisted media payload")
            if semantic is not None and current != semantic:
                raise RuntimeError("Public lookup, restart, or complete media readback differs across observations")
            semantic = current
            if memory["windowDurationMs"] is None or memory["windowDurationMs"] < summary["runs"][0]["totalImportMs"]:
                raise RuntimeError("Marked memory window does not cover browser import interval")
            save(destination / "semantic-receipt.json", current)
        except Exception as error:
            validation_failures.append({"name": item["name"], "error": str(error)})
            save(output / "validation-failures.json", validation_failures)
        command(["node", "dev/perf/host-environment.js"], cwd=arm_root, log=destination / "host-after.json", check=False)
        print(json.dumps({"name": item["name"], "qualified": memory["qualifiedForWholeTreePss"],
                          "pssKiB": memory["maxSampledPssKiB"], "privateKiB": memory["maxSampledPrivateKiB"]}), flush=True)
    qualified = all(row["qualifiedForWholeTreePss"] for row in observations)
    pairs = []
    for index in [1, 2]:
        cohort = {row["arm"]: row for row in observations if row["pair"] == index}
        pair = {"pair": index, "qualified": all(row["qualifiedForWholeTreePss"] for row in cohort.values())}
        for metric in ["maxSampledPssKiB", "maxSampledPrivateKiB"]:
            a, b = cohort["A"][metric], cohort["B"][metric]
            pair[metric] = {"baseline": a, "candidate": b, "changePercent": 100 * (b / a - 1) if pair["qualified"] and a > 0 else None}
        pairs.append(pair)
    metrics = {}
    for metric in ["maxSampledPssKiB", "maxSampledPrivateKiB"]:
        changes = [pair[metric]["changePercent"] for pair in pairs]
        metrics[metric] = {"medianPairedChangePercent": statistics.median(changes) if qualified else None,
                           "maximumPairedChangePercent": max(changes) if qualified else None}
    passes = qualified and all(row["medianPairedChangePercent"] <= 5 and row["maximumPairedChangePercent"] <= 10 for row in metrics.values())
    save(output / "memory-comparison.json", {
        "schemaVersion": 1, "authoritativeTiming": False, "observations": observations, "pairs": pairs,
        "metrics": metrics, "everyObservationQualified": qualified, "passesProspectiveMemoryScreen": passes,
        "validationFailures": validation_failures,
    })
    command(["python3", str(HERE / "audit_memory.py"), str(output)], log=output / "independent-audit.log")
    if not passes or validation_failures:
        raise RuntimeError("Memory coverage, prospective memory gate, or semantic validation failed; no observations replaced")


if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        save(ROOT / "builds/memory-qualification/failure-status.json", {
            "status": "failed-or-incomplete", "type": type(error).__name__, "error": str(error),
            "recordedAtEpochSeconds": time.time(), "qualified": False, "retried": False,
        })
        raise
