#!/usr/bin/env python3
"""Fixed six-pair import screen; traces and exhaustive media checks are separate.

Copyright (C) 2026 Manabitan authors
SPDX-License-Identifier: GPL-3.0-or-later
"""

import argparse
import collections
import hashlib
import json
import pathlib
import re
import statistics
import subprocess
import time
import zipfile

PRODUCT_SHA = "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2"
ROOT = pathlib.Path(__file__).resolve().parents[2]
SHARED_FILES = [
    "package.json", "package-lock.json", "test/perf/dictionaries.lock.json",
    "dev/perf/import-benchmark.js", "dev/perf/benchmark-support.js",
    "dev/perf/dictionary-fixtures.js", "dev/perf/host-environment.js",
    "test/chromium/extension-two-dictionary-import.e2e.js",
    "test/e2e/import-timing.js", "test/e2e/chromium-launch-options.js",
    "ext/js/core/safe-performance.js",
]


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def command_output(args, cwd=ROOT):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def package_identity(root):
    package = root / "builds/manabitan-chrome.zip"
    with zipfile.ZipFile(package) as archive:
        entries = {
            entry.filename: hashlib.sha256(archive.read(entry)).hexdigest()
            for entry in archive.infolist() if not entry.is_dir()
        }
    return {"sha256": sha256(package), "entries": entries}


def browser_executable_identity(root):
    # The shared harness fixes channel='chromium' and clears executable overrides.
    executable = pathlib.Path(command_output([
        "node", "--input-type=module", "-e",
        "import {chromium} from '@playwright/test'; process.stdout.write(chromium.executablePath());",
    ], cwd=root)).resolve(strict=True)
    return {"path": str(executable), "bytes": executable.stat().st_size, "sha256": sha256(executable)}


def trace_hotspots(path):
    """Sampled frame time overlaps across threads and is not import latency."""
    nodes = {}
    chunks = []
    for event in json.loads(path.read_text())["traceEvents"]:
        data = event.get("args", {}).get("data", {})
        profile = data.get("cpuProfile")
        if not profile:
            continue
        key = (
            event.get("pid"), event.get("tid"),
            json.dumps(event.get("id2", event.get("id")), sort_keys=True),
        )
        for node in profile.get("nodes", []):
            nodes[(key, node["id"])] = node
        chunks.append((key, profile.get("samples", []), data.get("timeDeltas", [])))
    times = collections.Counter()
    counts = collections.Counter()
    for key, samples, deltas in chunks:
        for node_id, delta in zip(samples, deltas):
            frame = nodes.get((key, node_id), {}).get("callFrame", {})
            name = (frame.get("functionName", "unknown"), frame.get("url", ""), frame.get("lineNumber"))
            times[name] += delta
            counts[name] += 1
    return [
        {"function": key[0], "source": key[1], "zeroBasedLine": key[2],
         "sampledThreadTimeMs": round(duration / 1000, 3), "samples": counts[key]}
        for key, duration in times.most_common(100)
    ]


def logical_storage_files(validation, allowed_size_changes=()):
    files = []
    for entry in validation["storage"]["files"]:
        path = entry["path"]
        if path.startswith("manabitan/sqlite-sahpool-v1/.opaque/"):
            continue
        # Each fresh import chooses a new UUID for its packed media file.
        path = re.sub(
            r"^manabitan-dictionary-media-v1/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin$",
            "manabitan-dictionary-media-v1/<uuid>.bin", path,
        )
        files.append((path, None if path in allowed_size_changes else entry["bytes"]))
    return sorted(files)


def semantic_identity(validation, allowed_size_changes=()):
    """Content samples, lookup results and logical product files must agree."""
    return {
        "title": validation["title"],
        "revision": validation["revision"],
        "termRows": validation["termRows"],
        "contentReadable": validation["contentReadable"],
        "outputDigestSha256": validation["outputDigestSha256"],
        "media": validation["media"],
        "productFiles": logical_storage_files(validation, allowed_size_changes),
        "lookups": [
            {key: item[key] for key in ("pass", "term", "results", "originalTextLength", "hasExactHeadwordMatch", "sha256")}
            for item in validation["lookup"]["observations"]
        ],
    }


def capture(root, dictionary, output, media="sample", trace=False, flags=None):
    command = [
        "node", "dev/perf/import-benchmark.js", dictionary,
        "--runs", "1", "--no-build", "--build-target", "chrome",
        "--media-check", media, "--output", str(output),
    ]
    if trace:
        command.append("--trace")
    if flags is not None:
        command.extend(["--flags", json.dumps(flags, separators=(",", ":"), sort_keys=True)])
    output.mkdir()
    write_json(output / "command.json", command)
    write_json(output / "host-before.json", json.loads(command_output(["node", "dev/perf/host-environment.js"])))
    process = {"status": "running", "trace": trace, "mediaCheck": media}
    write_json(output / "process.json", process)
    start = time.time()
    try:
        with (output / "runner.log").open("w") as log:
            completed = subprocess.run(command, cwd=root, stdout=log, stderr=subprocess.STDOUT, timeout=1200, check=False)
        process["exitCode"] = completed.returncode
        if completed.returncode != 0:
            raise RuntimeError(f"Capture failed ({completed.returncode}): {output / 'runner.log'}")
        summary = json.loads((output / "summary.json").read_text())
        if summary["traceEnabled"] != trace or summary["authoritativeTiming"] == trace:
            raise RuntimeError("Harness timing/trace identity mismatch")
        if len(summary["runs"]) != 1:
            raise RuntimeError("Expected one complete import observation")
        run = summary["runs"][0]
        report = json.loads(pathlib.Path(run["reportJsonPath"]).read_text())
        process["status"] = "complete"
        return summary, run, report["benchmark"]["validation"]
    except Exception as error:
        process["status"] = "failed"
        process["error"] = str(error)
        raise
    finally:
        process["processElapsedSeconds"] = time.time() - start
        write_json(output / "process.json", process)
        write_json(output / "host-after.json", json.loads(command_output(["node", "dev/perf/host-environment.js"])))


def summarize(observations):
    by_pair = collections.defaultdict(dict)
    for item in observations:
        if item["kind"] == "timing":
            by_pair[item["pair"]][item["arm"]] = item
    if len(by_pair) != 6 or any(set(pair) != {"A", "B"} for pair in by_pair.values()):
        raise RuntimeError("Incomplete fixed six-pair schedule")
    results = {}
    for boundary in ("totalImportMs", "workerImportMs"):
        baseline = [pair["A"][boundary] for pair in by_pair.values()]
        candidate = [pair["B"][boundary] for pair in by_pair.values()]
        ratios = [b / a for a, b in zip(baseline, candidate)]
        results[boundary] = {
            "baselineMs": baseline, "candidateMs": candidate,
            "medianPairedChangePercent": (statistics.median(ratios) - 1) * 100,
            "equalWorkChangePercent": (sum(candidate) / sum(baseline) - 1) * 100,
            "fasterPairs": sum(value < 1 for value in ratios),
            "baselineMedianMs": statistics.median(baseline),
            "candidateMedianMs": statistics.median(candidate),
        }
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dictionary", choices=["jmdict", "jitendex", "vndb"])
    parser.add_argument("--baseline-root", required=True, type=pathlib.Path)
    parser.add_argument("--candidate-root", required=True, type=pathlib.Path)
    parser.add_argument("--expected-package-path", action="append", default=[])
    parser.add_argument("--allow-storage-size-change", action="append", default=[])
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--candidate-flags", type=json.loads)
    parser.add_argument("--require-lookahead", action="store_true")
    args = parser.parse_args()
    roots = {"A": args.baseline_root.resolve(), "B": args.candidate_root.resolve()}
    flags = {"A": None, "B": args.candidate_flags}
    if args.require_lookahead and (args.dictionary != "jmdict" or flags["B"] != {"experimentalTermContentLookahead": True}):
        raise ValueError("Lookahead execution gate requires JMdict and its exact registered candidate flag")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    plan = [{"name": f"warmup-{arm}", "kind": "warmup", "arm": arm} for arm in "AB"]
    for pair in range(1, 7):
        for arm in ("AB" if pair % 2 else "BA"):
            plan.append({"name": f"pair-{pair:02}-{arm}", "kind": "timing", "pair": pair, "arm": arm})
    for arm in "AB":
        plan.append({"name": f"exhaustive-{arm}", "kind": "exhaustive-media", "arm": arm})
    for arm in "AB":
        plan.append({"name": f"trace-{arm}", "kind": "trace", "arm": arm})
    status = {
        "status": "running", "dictionary": args.dictionary,
        "scope": "Exploratory fixed six-pair screen; no cross-device qualification",
        "plan": plan, "observations": [],
        "node": command_output(["node", "--version"]),
        "comparisonBoundary": "Browser file-input change through post-UI completion; worker RPC reported separately",
        "correctnessScope": "All pinned rows counted, twelve content probes, restart readback, lookup output, sampled media during timing, exhaustive referenced media separately",
        "storageScope": "Logical product files equal except explicitly permitted size changes; packed media UUIDs normalized; SQLite opaque allocation paths/sizes retained but excluded from exact comparison",
        "allowedStorageSizeChanges": args.allow_storage_size_change,
        "importFlags": flags,
        "requireLookahead": args.require_lookahead,
    }
    write_json(output / "comparison.json", status)
    try:
        sources = {arm: command_output(["git", "rev-parse", "HEAD"], cwd=root) for arm, root in roots.items()}
        if sources["A"] != PRODUCT_SHA:
            raise RuntimeError("Unexpected baseline source")
        status["sources"] = sources
        for filename in SHARED_FILES:
            if sha256(roots["A"] / filename) != sha256(roots["B"] / filename):
                raise RuntimeError(f"Comparison changes shared harness/dependency/fixture: {filename}")
        status["sharedSourceHashes"] = {file: sha256(roots["A"] / file) for file in SHARED_FILES}
        browser_executables = {arm: browser_executable_identity(root) for arm, root in roots.items()}
        if browser_executables["A"]["sha256"] != browser_executables["B"]["sha256"]:
            raise RuntimeError("Chromium executable differs between arms")
        status["browserExecutables"] = browser_executables
        packages = {arm: package_identity(root) for arm, root in roots.items()}
        all_names = set(packages["A"]["entries"]) | set(packages["B"]["entries"])
        changed = sorted(name for name in all_names if packages["A"]["entries"].get(name) != packages["B"]["entries"].get(name))
        if changed != sorted(set(args.expected_package_path)):
            raise RuntimeError(f"Unexpected packaged changes: {changed}")
        status["packagedChanges"] = changed
        status["packageHashes"] = {arm: package["sha256"] for arm, package in packages.items()}
        for arm in roots:
            write_json(output / f"package-entries-{arm}.json", packages[arm]["entries"])
            (output / f"source-status-{arm}.txt").write_text(command_output(["git", "status", "--porcelain"], cwd=roots[arm]) + "\n")
        identities = {}
        browser_version = None
        for item in plan:
            arm = item["arm"]
            trace = item["kind"] == "trace"
            media = "all" if item["kind"] == "exhaustive-media" else "sample"
            summary, run, validation = capture(roots[arm], args.dictionary, output / item["name"], media=media, trace=trace, flags=flags[arm])
            if summary["importFlags"] != flags[arm]:
                raise RuntimeError("Observed import flags differ from the registered arm")
            phases = run["importDebug"]["importerPhaseTimings"]
            lookahead = {metric: sum(phase.get("details", {}).get(metric, 0) for phase in phases if phase.get("phase", "").startswith("term-file-fast-path:"))
                         for metric in ("contentLookaheadPreparedCount", "contentLookaheadCompressionCount")}
            if arm == "A" and any(lookahead.values()):
                raise RuntimeError("Baseline unexpectedly executed content lookahead")
            if arm == "B" and args.require_lookahead and not all(value > 0 for value in lookahead.values()):
                raise RuntimeError("Candidate did not execute the intended speculative content path")
            if run["packageSha256"] != packages[arm]["sha256"] or summary["gitSha"] != sources[arm]:
                raise RuntimeError(f"Observed source/package differs: {item['name']}")
            if browser_version is None:
                browser_version = summary["browserVersion"]
            elif summary["browserVersion"] != browser_version:
                raise RuntimeError("Browser runtime changed across observations")
            identity = semantic_identity(validation, args.allow_storage_size_change)
            if media not in identities:
                identities[media] = identity
            elif identities[media] != identity:
                raise RuntimeError(f"Content, lookup, media or product storage changed: {item['name']}")
            observation = {
                **item, "totalImportMs": run["totalImportMs"], "workerImportMs": run["workerImportMs"],
                "packageSha256": run["packageSha256"], "validation": validation,
                "logicalStorageFiles": logical_storage_files(validation),
                "phases": phases,
                "lookahead": lookahead,
                "importFlags": flags[arm],
            }
            status["observations"].append(observation)
            status["browserVersion"] = browser_version
            if trace:
                write_json(output / item["name"] / "trace-hotspots.json", trace_hotspots(output / item["name"] / "run-1.trace.json"))
            write_json(output / "comparison.json", status)
            print(f"{args.dictionary} {item['name']}: {run['totalImportMs']:.3f}ms", flush=True)
        for arm, root in roots.items():
            if browser_executable_identity(root) != browser_executables[arm]:
                raise RuntimeError("Chromium executable changed during the fixed schedule")
        status["timingSummary"] = summarize(status["observations"])
        status["status"] = "complete"
        print(json.dumps(status["timingSummary"], indent=2), flush=True)
    except Exception as error:
        status["status"] = "failed"
        status["error"] = str(error)
        raise
    finally:
        write_json(output / "comparison.json", status)


if __name__ == "__main__":
    main()
