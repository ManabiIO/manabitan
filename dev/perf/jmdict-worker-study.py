#!/usr/bin/env python3
# Copyright (C) 2026 Manabitan authors
# SPDX-License-Identifier: GPL-3.0-or-later

"""Counterbalanced fresh-process study of the Node production-worker path.

This measures the documented component boundary, never browser import latency.
A/C are identical baseline source. B/D are identical candidate source. Every
observation, including warmups and failures, is retained without retries.
"""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import statistics
import subprocess
import time


def digest(filename):
    return hashlib.sha256(Path(filename).read_bytes()).hexdigest()


def write_json(filename, value):
    with Path(filename).open("x") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")


def git(root, *arguments):
    return subprocess.check_output(["git", "-C", str(root), *arguments], text=True).strip()


RUNTIME_ROOTS = ["ext/js", "ext/lib", "dev/data/dictionary-wasm", "dev/lib"]
PROVENANCE_FILES = ["package.json", "package-lock.json", "dev/dictionary-wasm.js"]


def source_manifest(source):
    files = []

    def add_file(filename):
        assert not filename.is_symlink() and filename.is_file(), f"Nonregular provenance input: {filename}"
        assert filename.resolve(strict=True) == filename, f"Provenance input traverses a symlink: {filename}"
        files.append({"name": filename.relative_to(source).as_posix(), "bytes": filename.stat().st_size, "sha256": digest(filename)})

    def walk(directory):
        assert not directory.is_symlink() and directory.is_dir(), f"Nonregular runtime directory: {directory}"
        assert directory.resolve(strict=True) == directory, f"Runtime directory traverses a symlink: {directory}"
        for filename in directory.iterdir():
            assert not filename.is_symlink(), f"Runtime symlink: {filename}"
            if filename.is_dir():
                walk(filename)
            else:
                add_file(filename)

    for name in RUNTIME_ROOTS:
        walk(source / name)
    for name in PROVENANCE_FILES:
        add_file(source / name)
    files.sort(key=lambda value: value["name"])
    canonical = "".join(json.dumps([value["name"], value["bytes"], value["sha256"]], ensure_ascii=False, separators=(",", ":")) + "\n" for value in files)
    return {
        "path": str(source),
        "commit": git(source, "rev-parse", "HEAD"),
        "trackedDiffSha256": hashlib.sha256(subprocess.check_output(["git", "-C", str(source), "diff", "HEAD", "--binary"])).hexdigest(),
        "runtimeTree": {"roots": RUNTIME_ROOTS, "provenanceFiles": PROVENANCE_FILES, "files": len(files), "bytes": sum(value["bytes"] for value in files), "sha256": hashlib.sha256(canonical.encode()).hexdigest()},
        "files": files,
    }


def summarize(values):
    ordered = sorted(values)
    return {
        "count": len(values),
        "median": statistics.median(values),
        "min": ordered[0],
        "p95": ordered[max(0, math.ceil(len(ordered) * 0.95) - 1)],
        "max": ordered[-1],
    }


def metrics(report):
    timing = report["timing"]
    return {
        "wallMs": timing["componentMs"],
        "cpuMs": timing["cpuUserMs"] + timing["cpuSystemMs"],
        "finalizationMs": timing["finalizationMs"],
        "maxRssKiB": report["runtime"]["maxRssKiB"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", required=True, type=Path)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--fixture", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--blocks", type=int, default=12)
    parser.add_argument("--order", choices=["forward", "reverse"], default="forward")
    parser.add_argument("--device-memory", default="8")
    parser.add_argument("--hardware-concurrency", type=int, default=4)
    parser.add_argument("--expected-canonical-sha256", required=True)
    args = parser.parse_args()
    assert args.blocks > 0 and args.blocks % 4 == 0, "Use complete four-block order cycles"
    assert args.hardware_concurrency > 0
    assert len(args.expected_canonical_sha256) == 64
    for name in ["NODE_OPTIONS", "NODE_V8_COVERAGE"]:
        assert not os.environ.get(name), f"Fixed studies reject inherited instrumentation: {name}"

    root = Path(__file__).resolve().parents[2]
    harness = root / "dev/perf/jmdict-component-benchmark.js"
    adapter = root / "dev/perf/node-import-workers.js"
    node = args.node.resolve(strict=True)
    baseline = args.baseline.resolve(strict=True)
    candidate = args.candidate.resolve(strict=True)
    fixture = args.fixture.resolve(strict=True)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    for source in [baseline, candidate]:
        subprocess.run([
            "git", "-C", str(source), "diff", "--exit-code", "HEAD", "--",
            "ext/js", "dev/lib", "dev/data/dictionary-wasm", "package.json", "package-lock.json", "dev/dictionary-wasm.js",
        ], check=True, stdout=subprocess.DEVNULL)

    orders = [list("ABDC"), list("BCAD"), list("CDBA"), list("DACB")]
    if args.order == "reverse":
        orders = [list(reversed(order)) for order in orders]
    schedule = [{"name": f"warmup-{arm}", "block": None, "arm": arm} for arm in orders[0]]
    for block in range(args.blocks):
        for arm in orders[block % len(orders)]:
            schedule.append({"name": f"block-{block + 1:02d}-{arm}", "block": block + 1, "arm": arm})
    manifests = {"baseline": source_manifest(baseline), "candidate": source_manifest(candidate)}
    for name, manifest in manifests.items():
        write_json(output / f"{name}-source-manifest.json", manifest)
    common_inputs = [
        Path(__file__), harness, adapter, fixture,
        root / "test/fixtures/opfs-continuation/node-opfs-adapter.mjs",
        root / "dev/perf/dictionary-fixtures.js",
        root / "test/perf/dictionaries.lock.json",
        root / "ext/js/core/json.js",
        root / "ext/js/core/safe-performance.js",
        root / "package.json",
        root / "package-lock.json",
    ]
    locked_files = {str(filename): digest(filename) for filename in common_inputs}
    protocol = {
        "schemaVersion": 1,
        "boundary": "Node production-parser/compression-worker component; not browser latency",
        "sourceHeads": {name: manifest["commit"] for name, manifest in manifests.items()},
        "sourceIdentities": {name: {key: manifest[key] for key in ["commit", "trackedDiffSha256", "runtimeTree"]} for name, manifest in manifests.items()},
        "sourceManifests": {name: {"path": str(output / f"{name}-source-manifest.json"), "sha256": digest(output / f"{name}-source-manifest.json")} for name in manifests},
        "sources": {"A": str(baseline), "B": str(candidate), "C": str(baseline), "D": str(candidate)},
        "node": str(node),
        "nodeVersion": subprocess.check_output([str(node), "--version"], text=True).strip(),
        "nodeBinarySha256": digest(node),
        "nodeArguments": ["--max-old-space-size=1400"],
        "inheritedInstrumentation": {"NODE_OPTIONS": None, "NODE_V8_COVERAGE": None},
        "lockedFiles": locked_files,
        "blocks": args.blocks,
        "order": args.order,
        "schedule": schedule,
        "deviceMemory": args.device_memory,
        "hardwareConcurrency": args.hardware_concurrency,
        "expectedCanonicalSha256": args.expected_canonical_sha256,
        "oracle": "Row count 526942 and the complete canonical persisted-artifact SHA256 in every observation; exhaustive reopened source-row comparison is a separate prerequisite",
        "timingPolicy": "Fresh process per observation; one excluded warmup per arm; no retries, tail removal, sample extension, pooling across runs, or control subtraction",
        "controls": ["C/A identical baseline", "D/B identical candidate"],
        "comparisons": ["B/A candidate", "D/A candidate"],
        "note": "Paired medians describe this fixed cohort; controls reveal host variation and are not a correction. Max RSS includes post-timer artifact hashing in each fresh Node process.",
    }
    write_json(output / "protocol.json", protocol)
    observations = []
    expected_work = None
    started = time.monotonic()
    try:
        for ordinal, item in enumerate(schedule, 1):
            for filename, expected in locked_files.items():
                assert digest(filename) == expected, f"Input changed: {filename}"
            command = [
                str(node), "--max-old-space-size=1400", str(harness),
                "--source", protocol["sources"][item["arm"]],
                "--fixture", str(fixture), "--output", str(output / f"{item['name']}.json"),
                "--node-workers", "--no-verify", "--device-memory", args.device_memory,
                "--hardware-concurrency", str(args.hardware_concurrency),
            ]
            before = time.monotonic()
            receipt = {**item, "ordinal": ordinal, "command": command}
            with (output / f"{item['name']}.log").open("x") as log:
                try:
                    result = subprocess.run(command, cwd=root, stdout=log, stderr=subprocess.STDOUT, timeout=180)
                    receipt["exitCode"] = result.returncode
                except subprocess.TimeoutExpired:
                    receipt["exitCode"] = None
                    receipt["error"] = "Observation exceeded fixed 180-second timeout"
                receipt["elapsedSeconds"] = time.monotonic() - before
            write_json(output / f"{item['name']}-exit.json", receipt)
            assert receipt["exitCode"] == 0, f"Observation failed: {item['name']}"
            report = json.loads((output / f"{item['name']}.json").read_text())
            assert report["rows"] == 526942
            assert report["runtime"]["node"] == protocol["nodeVersion"]
            assert report["runtime"]["execArgv"] == protocol["nodeArguments"]
            assert report["storedFilesCanonicalSha256"] == args.expected_canonical_sha256
            assert report["boundary"]["kind"] == "node-parallel-import-components"
            assert not report["timing"]["profiled"] and not report["timing"]["instrumentedDiagnostic"]
            worker = report["workerTransport"]
            assert worker["errors"] == []
            assert worker["compressionJobs"] == worker["completedCompressionJobs"]
            assert worker["compressionSpanJobs"] == worker["sourceConsumedMessages"]
            work = {key: value for key, value in worker.items() if key != "errors"}
            if expected_work is None:
                expected_work = work
            assert work == expected_work, f"Executed work changed: {item['name']}"
            source_key = "baseline" if item["arm"] in "AC" else "candidate"
            for key in ["commit", "trackedDiffSha256", "runtimeTree"]:
                assert report["source"][key] == protocol["sourceIdentities"][source_key][key], f"Product source identity changed ({key}): {item['name']}"
            assert report["harnessSha256"] == locked_files[str(harness)]
            assert report["adapterSha256"] == locked_files[str(root / "test/fixtures/opfs-continuation/node-opfs-adapter.mjs")]
            assert report["workerTransportSha256"] == locked_files[str(adapter)]
            for filename, expected in locked_files.items():
                assert digest(filename) == expected, f"Input changed during observation: {filename}"
            observation = {**receipt, "metrics": metrics(report), "reportSha256": digest(output / f"{item['name']}.json")}
            observations.append(observation)
            with (output / "observations.jsonl").open("a") as journal:
                journal.write(json.dumps(observation, sort_keys=True) + "\n")
            print(f"{ordinal}/{len(schedule)} {item['name']}: {report['timing']['componentMs']:.2f} ms", flush=True)

        measured = [item for item in observations if item["block"] is not None]
        by_block = {(item["block"], item["arm"]): item["metrics"] for item in measured}
        comparisons = {}
        for numerator, denominator in [("C", "A"), ("D", "B"), ("B", "A"), ("D", "A")]:
            comparison = {}
            for metric in ["wallMs", "cpuMs", "maxRssKiB"]:
                pairs = [(by_block[(block, denominator)][metric], by_block[(block, numerator)][metric]) for block in range(1, args.blocks + 1)]
                changes = [100 * (new / old - 1) for old, new in pairs]
                comparison[metric] = {
                    **summarize(changes),
                    "equalWorkChangePercent": 100 * (sum(new for old, new in pairs) / sum(old for old, new in pairs) - 1),
                    "fasterPairs": sum(new < old for old, new in pairs),
                    "pairedChangesPercent": changes,
                }
            comparisons[f"{numerator}/{denominator}"] = comparison
        for filename, expected in locked_files.items():
            assert digest(filename) == expected, f"Input changed: {filename}"
        summary = {
            "status": "complete",
            "protocol": protocol,
            "elapsedSeconds": time.monotonic() - started,
            "observations": len(observations),
            "executedWork": expected_work,
            "arms": {arm: {metric: summarize([item["metrics"][metric] for item in measured if item["arm"] == arm]) for metric in ["wallMs", "cpuMs", "maxRssKiB"]} for arm in "ABCD"},
            "comparisons": comparisons,
        }
        write_json(output / "summary.json", summary)
        print(json.dumps({"output": str(output), "comparisons": comparisons}, indent=2))
    except BaseException as error:
        write_json(output / "failure.json", {"status": "failed", "error": repr(error), "completedObservations": len(observations), "elapsedSeconds": time.monotonic() - started})
        raise


if __name__ == "__main__":
    main()
