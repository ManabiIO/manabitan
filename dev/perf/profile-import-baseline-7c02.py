#!/usr/bin/env python3
"""Frozen baseline profiling: ordinary import, trace, ordinary import.

Copyright (C) 2026 Manabitan authors
SPDX-License-Identifier: GPL-3.0-or-later

Reuses the existing package builder, import benchmark, and correctness oracle.
The trace is diagnostic only; the two controls do not estimate an optimization.
"""

import argparse
from collections import Counter
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import time


ROOT = Path(__file__).resolve().parents[2]
BASE = "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2"
BROWSER = "153.0.8010.12"
SELF = "dev/perf/profile-import-baseline-7c02.py"
WORKFLOW = ".github/workflows/import-baseline-profile-7c02.yml"
spec = importlib.util.spec_from_file_location("existing_qualification", ROOT / "dev/perf/qualify-import-ca365.py")
qualification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualification)
command = qualification.command
sha256 = qualification.sha256
write_json = qualification.write_json


def json_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def summarize_trace(path):
    """Same ProfileChunk attribution used by the existing trace investigation.

    Keep profile IDs and threads separate; a sum over threads is not elapsed
    time. Run only after the ordinary controls, outside every import interval.
    """
    events = json.loads(path.read_text())["traceEvents"]
    nodes = {}
    chunks = []
    thread_names = {}
    for event in events:
        if event.get("ph") == "M" and event.get("name") == "thread_name":
            thread_names[(event.get("pid"), event.get("tid"))] = event.get("args", {}).get("name")
        data = event.get("args", {}).get("data", {})
        profile = data.get("cpuProfile")
        key = (event.get("pid"), event.get("tid"), json.dumps(event.get("id2", event.get("id")), sort_keys=True))
        if profile:
            for node in profile.get("nodes", []):
                nodes[(key, node["id"])] = node
            chunks.append((key, profile.get("samples", []), data.get("timeDeltas", [])))
    times = Counter()
    counts = Counter()
    missing_nodes = missing_deltas = 0
    for key, samples, deltas in chunks:
        for index, node_id in enumerate(samples):
            node = nodes.get((key, node_id))
            if node is None:
                missing_nodes += 1
                continue
            if index >= len(deltas):
                missing_deltas += 1
                continue
            frame = node.get("callFrame", {})
            identity = (key[0], key[1], frame.get("functionName"), frame.get("url", ""), frame.get("lineNumber"))
            counts[identity] += 1
            times[identity] += deltas[index]
    rows = [{"pid": key[0], "tid": key[1], "thread": thread_names.get((key[0], key[1])),
             "function": key[2], "source": key[3], "line": key[4], "sampledMs": round(value / 1000, 3), "samples": counts[key]}
            for key, value in times.most_common()]
    by_thread = {}
    for row in rows:
        thread = f"{row['pid']}:{row['tid']}"
        entry = by_thread.setdefault(thread, {"thread": row["thread"], "sampledMs": 0, "top": []})
        entry["sampledMs"] += row["sampledMs"]
        if len(entry["top"]) < 12:
            entry["top"].append(row)
    return {"profileChunks": len(chunks), "missingNodeSamples": missing_nodes,
            "missingDeltaSamples": missing_deltas, "top": rows[:40], "threads": by_thread,
            "interpretation": "Per-thread sampled attribution only. Threads overlap; neither their sum nor a traced duration is ordinary import latency. Use the raw trace and ordinary phase receipts to locate waits and critical-path work."}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("dictionary", choices=["jmdict", "jitendex", "vndb"])
    args = parser.parse_args()
    output = ROOT / "builds/profile-baseline-7c02"
    output.mkdir(parents=True, exist_ok=True)
    if (output / "execution.json").exists() or (output / "observations.json").exists():
        raise RuntimeError("Refusing to overwrite a previous observation cohort")
    for name in [SELF, WORKFLOW]:
        shutil.copyfile(ROOT / name, output / Path(name).name)
    if command(["node", "--version"]).stdout.strip() != "v22.22.0":
        raise RuntimeError("Requires Node 22.22.0")
    changed = command(["git", "diff", "--name-only", BASE, "HEAD"]).stdout.splitlines()
    if not set(changed) <= {SELF, WORKFLOW}:
        raise RuntimeError(f"Research branch changes files beyond this wrapper/workflow: {changed}")
    # The normal license-report build regenerates this tracked derived file.
    # Its exact bytes are retained in the built package and receipt below.
    command(["git", "diff", "--exit-code", "--", ".", ":(exclude)ext/legal-npm.html"])
    command(["node", "dev/perf/host-environment.js"], log=output / "host-initial.json")
    # The E2E launcher prepares its standard dictionary cache even for one
    # selected benchmark. Make all fixture acquisition happen before controls.
    command(["node", "dev/perf/prepare-dictionaries.js", "--all"], log=output / "fixtures.log")
    cache = (ROOT / "builds/e2e-dictionary-cache").resolve()
    fixture_lock = json.loads((ROOT / "test/perf/dictionaries.lock.json").read_text())
    fixture = fixture_lock["dictionaries"][args.dictionary]
    archive = cache / fixture["cacheFile"]
    if sha256(archive) != fixture["sha256"] or archive.stat().st_size != fixture["sizeBytes"]:
        raise RuntimeError("Fixture differs from the frozen archive")
    arm, package, members = qualification.prepare_arm("profile-baseline", BASE, output, cache)
    if package["sourceCommit"] != BASE:
        raise RuntimeError("Executed source is not the frozen baseline")
    manifest = json.loads((arm / "dev/data/dictionary-wasm/manifest.json").read_text())
    for target in manifest["targets"]:
        if sha256(arm / "ext/lib" / target["name"]) != target["sha256"]:
            raise RuntimeError("Packaged native module differs from its source-bound manifest")
    execution = {"base": BASE, "sourceTree": package["sourceTree"], "workflowCommit": command(["git", "rev-parse", "HEAD"]).stdout.strip(),
                 "dictionary": args.dictionary, "fixture": fixture, "fixtureLockSha256": sha256(ROOT / "test/perf/dictionaries.lock.json"),
                 "node": "v22.22.0", "browser": BROWSER, "package": package,
                 "nativeManifest": manifest, "packageMemberCount": len(members), "generatedLegalSha256": sha256(ROOT / "ext/legal-npm.html"),
                 "runnerSha256": sha256(ROOT / SELF), "workflowSha256": sha256(ROOT / WORKFLOW),
                 "runId": os.environ.get("GITHUB_RUN_ID"), "runAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
                 "schedule": ["ordinary-before", "trace", "ordinary-after"],
                 "mediaMode": "sample", "failurePolicy": "Each observation attempted once. All failures retained. No replacement runs.",
                 "purpose": "Current baseline critical-path investigation, not candidate qualification or a performance improvement claim."}
    write_json(output / "execution.json", execution)
    print("BASELINE_PROFILE_SOURCE " + json.dumps(execution), flush=True)
    observations = []
    semantic = None
    for name in execution["schedule"]:
        destination = output / name
        destination.mkdir()
        traced = name == "trace"
        record = {"name": name, "dictionary": args.dictionary, "trace": traced,
                  "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "status": "failure"}
        try:
            command(["node", "dev/perf/host-environment.js"], cwd=arm, log=destination / "host-before.json")
            argv = ["node", "dev/perf/import-benchmark.js", args.dictionary, "--runs", "1", "--no-build", "--build-target", "chrome",
                    "--media-check", "sample", "--output", str(destination)]
            if traced:
                argv.append("--trace")
            command(argv, cwd=arm, log=destination / "run.log", timeout=2100)
            report = json.loads((destination / "run-1.json").read_text())
            summary = json.loads((destination / "summary.json").read_text())
            if len(summary["runs"]) != 1 or summary["gitSha"] != BASE or summary["authoritativeTiming"] != (not traced) or summary["traceEnabled"] != traced:
                raise RuntimeError("Source or measurement mode mismatch")
            if report["browserVersion"] != BROWSER or report["packageSha256"] != package["packageSha256"]:
                raise RuntimeError("Executed browser or package mismatch")
            validation = report["benchmark"]["validation"]
            current_semantic = qualification.semantic_receipt(report)
            current_semantic["outputDigestSha256"] = validation["outputDigestSha256"]
            if semantic is not None and current_semantic != semantic:
                raise RuntimeError("Public lookup, restart, media or content probes differ across baseline observations")
            semantic = current_semantic
            write_json(destination / "semantic-receipt.json", current_semantic)
            storage = validation["storage"]
            write_json(destination / "storage-receipt.json", storage)
            run = summary["runs"][0]
            record.update({"status": "success", "authoritativeTiming": not traced,
                           "totalImportMs": run["totalImportMs"], "workerImportMs": run["workerImportMs"],
                           "stepTimingSummary": run["stepTimingSummary"], "step4Breakdown": run["step4Breakdown"],
                           "importerPhaseTimings": run["importDebug"].get("importerPhaseTimings"),
                           "localPhaseTimings": run["importDebug"].get("localPhaseTimings"),
                           "semanticSha256": json_digest(current_semantic), "outputDigestSha256": validation["outputDigestSha256"],
                           "termRows": validation["termRows"], "restart": validation["restart"], "media": validation["media"],
                           "storageBytes": storage["bytes"], "storageFileCount": len(storage["files"]), "storageSha256": json_digest(storage),
                           "source": summary["source"], "browserVersion": report["browserVersion"], "packageSha256": report["packageSha256"]})
            if traced:
                trace_path = destination / "run-1.trace.json"
                record["traceBytes"] = trace_path.stat().st_size
                record["traceSha256"] = sha256(trace_path)
                log = (destination / "run.log").read_text()
                record["traceStop"] = "visible-completion fallback" if "using visible-completion fallback" in log else "worker completion" if "wrote worker import browser trace" in log else "inspect raw log"
        except Exception as error:
            record["error"] = str(error)
        finally:
            command(["node", "dev/perf/host-environment.js"], cwd=arm, log=destination / "host-after.json", check=False)
            observations.append(record)
            write_json(output / "observations.json", observations)
            print("BASELINE_PROFILE_OBSERVATION " + json.dumps(record), flush=True)
    # Do not put trace analysis between ordinary controls. Preserve the raw
    # trace even if its optional attribution summarization cannot be completed.
    trace_summary = None
    trace_error = None
    trace_path = output / "trace/run-1.trace.json"
    if trace_path.is_file():
        try:
            trace_summary = summarize_trace(trace_path)
            write_json(output / "trace-attribution.json", trace_summary)
            print("BASELINE_PROFILE_HOTSPOTS " + json.dumps(trace_summary), flush=True)
        except Exception as error:
            trace_error = str(error)
    complete = all(row["status"] == "success" for row in observations)
    result = {"complete": complete, "base": BASE, "dictionary": args.dictionary, "fixtureSha256": fixture["sha256"],
              "packageSha256": package["packageSha256"], "observations": observations,
              "traceSummaryAvailable": trace_summary is not None, "traceSummaryError": trace_error,
              "ordinaryControlChangePercent": 100 * (observations[2]["totalImportMs"] / observations[0]["totalImportMs"] - 1) if observations[0]["status"] == observations[2]["status"] == "success" else None,
              "interpretation": "Two ordinary baseline observations describe host/order variation only. Trace elapsed time is non-authoritative. Storage inventories are retained without asserting byte-size determinism."}
    write_json(output / "result.json", result)
    concise = {key: value for key, value in result.items() if key != "observations"}
    concise["observations"] = [{key: row[key] for key in ["name", "status", "authoritativeTiming", "totalImportMs", "workerImportMs", "semanticSha256", "storageBytes", "error"] if key in row} for row in observations]
    print("BASELINE_PROFILE_RESULT " + json.dumps(concise), flush=True)
    if not complete:
        sys.exit(1)


if __name__ == "__main__":
    main()
