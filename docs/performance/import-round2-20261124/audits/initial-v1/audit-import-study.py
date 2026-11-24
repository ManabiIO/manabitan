#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Independently audit every retained observation in a frozen import study."""

import argparse
import hashlib
import json
import math
from pathlib import Path
import statistics


ORDERS = ["ABC", "CBA", "BAC", "CAB", "BCA", "ACB", "ACB", "BCA", "CAB", "BAC", "CBA", "ABC"]


def read(path):
    return json.loads(path.read_text())


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def audit(root):
    protocol = read(root / "protocol.json")
    state = read(root / "state.json")
    observations = read(root / "observations.json")
    fixture = protocol["fixture"]
    dictionary = protocol["dictionary"]
    stage = protocol["stage"]
    check(state["status"] == "success", "Study did not complete")
    check(protocol["warmupsExcluded"] == 0, "Excluded warmup")
    check(protocol["harnessOverlay"] is None, "Harness overlay")
    check(protocol["nodeVersion"] == "v22.22.0", "Unpinned Node")
    check(hashlib.sha256((root / "runner.py").read_bytes()).hexdigest() == protocol["runnerSha256"], "Runner identity mismatch")
    expected_orders = ORDERS[:6] if stage == "screen" else ORDERS if stage == "qualification" else []
    check(protocol["orders"] == expected_orders, "Order schedule differs")
    check(protocol["plannedBlocks"] == len(expected_orders), "Block count differs")
    expected_names = []
    if stage == "baseline":
        expected_names += [f"baseline-{index:02d}-A" for index in range(1, 4)]
    expected_names += [f"block-{block:02d}-{position}-{arm}"
                       for block, order in enumerate(expected_orders, 1)
                       for position, arm in enumerate(order, 1)]
    expected_names += [f"diagnostic-{arm}" for arm in protocol["diagnosticArms"]]
    check([o["name"] for o in observations] == expected_names, "Observation omission/reorder")
    check(state["attemptedObservations"] == len(expected_names), "Attempt count differs")
    checked_fixture = read(root / "fixture.json")
    check(checked_fixture["sizeBytes"] == fixture["sizeBytes"], "Fixture size differs")
    check(checked_fixture["sha256"] == fixture["sha256"], "Fixture digest differs")
    packages = {arm: read(root / f"package-{arm}.json") for arm in protocol["sourceIdentities"]}
    check(packages["C"]["archiveSha256"] == packages["A"]["archiveSha256"], "Control package differs")
    check(packages["C"]["entries"] == packages["A"]["entries"], "Control entries differ")
    if "B" in packages:
        a, b = packages["A"]["entries"], packages["B"]["entries"]
        differences = [name for name in sorted(set(a) | set(b)) if a.get(name) != b.get(name)]
        check(differences and differences == read(root / "package-differences.json"), "Package difference list differs")
    else:
        differences = []
    common = {}
    times = {arm: [] for arm in "ABC"}
    receipts = []
    for observation in observations:
        name, arm = observation["name"], observation["arm"]
        check(observation["status"] == "success", f"Failed observation: {name}")
        summary = read(root / observation["summary"])
        check(summary["schemaVersion"] == 3 and len(summary["runs"]) == 1, f"Summary shape: {name}")
        run = summary["runs"][0]
        source = protocol["sourceIdentities"][arm]
        check(summary["dictionary"] == dictionary and summary["fixture"] == fixture, f"Fixture mismatch: {name}")
        check(summary["gitSha"] == source["commit"] == summary["source"]["gitSha"], f"Source mismatch: {name}")
        check(summary["source"]["dirty"] is False, f"Dirty source: {name}")
        check(run["packageSha256"] == packages[arm]["archiveSha256"], f"Package mismatch: {name}")
        check(summary["buildTarget"] == "chrome" and summary["authoritativeTiming"] is True, f"Timing source: {name}")
        check(summary["traceEnabled"] is False and run["tracePath"] is None, f"Trace contamination: {name}")
        check(summary["importFlags"] is None, f"Nondefault flags: {name}")
        check(summary["hostEnvironment"]["nodeVersion"] == "v22.22.0", f"Node mismatch: {name}")
        check(summary["browserVersion"] == state["browserVersion"] == run["browserVersion"], f"Browser mismatch: {name}")
        for path, digest in summary["source"]["sha256"].items():
            if path in protocol["unchangedHarnessSha256"]:
                check(digest == protocol["unchangedHarnessSha256"][path], f"Harness mismatch: {name}/{path}")
        duration = run["totalImportMs"]
        check(isinstance(duration, (int, float)) and math.isfinite(duration) and duration > 0, f"Invalid timing: {name}")
        check(duration == observation["totalImportMs"], f"Timing mismatch: {name}")
        debug = run["importDebug"]
        check(debug["hasResult"] is True and debug["errorCount"] == 0 and debug["addSettingsErrorCount"] == 0, f"Import failed: {name}")
        check(debug["usesFallbackStorage"] is False and debug["openStorageDiagnostics"]["mode"] == "opfs-sahpool", f"Storage fallback: {name}")
        check(debug["useImportSession"] is True and debug["finalizeImportSession"] is True, f"Import lifecycle incomplete: {name}")
        validation = run["validation"]
        check(validation["title"] == fixture["expectedTitle"] and validation["revision"] == fixture["revision"], f"Inventory identity: {name}")
        check(validation["termRows"] == fixture["termRows"] and validation["contentReadable"] is True, f"Inventory/content: {name}")
        check(validation["probeCount"] == 12 and len(validation["probeTerms"]) == 12, f"Probe count: {name}")
        lookup = validation["lookup"]["observations"]
        check(len(lookup) == 72, f"Lookup count: {name}")
        expected_queries = {(p, term) for p in range(6) for term in validation["probeTerms"]}
        check({(row["pass"], row["term"]) for row in lookup} == expected_queries, f"Lookup coverage: {name}")
        check(all(row["results"] > 0 and row["hasExactHeadwordMatch"] is True for row in lookup), f"Lookup failure: {name}")
        identity = sorted((row["pass"], row["term"], row["results"], row["sha256"]) for row in lookup)
        media = validation["media"]
        check(media["mode"] == observation["mediaCheck"] == summary["mediaCheck"], f"Media mode: {name}")
        check(media["totalFiles"] == fixture.get("mediaFiles", 0) and media["totalBytes"] == fixture.get("mediaBytes", 0), f"Media inventory: {name}")
        if media["mode"] == "all":
            check(media["files"] == media["totalFiles"] and media["bytes"] == media["totalBytes"], f"Incomplete exhaustive media: {name}")
        else:
            check(media["files"] == min(64, media["totalFiles"]), f"Incomplete sampled media: {name}")
        values = {"lookup": identity, "sampledContentDigest": validation["outputDigestSha256"],
                  "storageBytes": validation["storage"]["bytes"], f"media-{media['mode']}": media}
        phases = [p for p in debug["importerPhaseTimings"] if p["phase"].startswith("term-file-fast-path:")]
        values["parserExperiments"] = [p["details"]["parserExperiments"] for p in phases]
        for key, value in values.items():
            if key in common:
                check(common[key] == value, f"Receipt differs: {name}/{key}")
            common[key] = value
        if observation["cohort"] == "timed":
            times[arm].append(duration)
        receipts.append({"name": name, "arm": arm, "totalImportMs": duration, "mediaMode": media["mode"], "lookupReceipts": len(lookup)})
    check(read(root / "correctness.json")["status"] == "passed", "Missing successful correctness receipt")
    comparisons = {}
    if expected_orders:
        analysis = read(root / "analysis.json")
        check(analysis["allTimingsMs"] == times, "Analysis omitted or altered observations")
        for label, left, right in [("candidate", "A", "B"), ("candidateVsSecondBaseline", "C", "B"), ("identicalProductControl", "A", "C")]:
            changes = [(b / a - 1) * 100 for a, b in zip(times[left], times[right], strict=True)]
            check(changes == analysis[label]["pairedChangesPercent"], f"Paired changes: {label}")
            check(statistics.median(changes) == analysis[label]["pairedMedianPercent"], f"Median: {label}")
            comparisons[label] = analysis[label]
    return {"status": "passed", "stage": stage, "dictionary": dictionary,
            "sourceIdentities": protocol["sourceIdentities"], "runnerSha256": protocol["runnerSha256"],
            "browserVersion": state["browserVersion"], "attemptedObservations": len(observations),
            "lookupReceipts": len(observations) * 72, "exhaustiveDiagnostics": len(protocol["diagnosticArms"]),
            "changedPackageMembers": differences, "comparisons": comparisons, "observations": receipts,
            "limits": "Full inventory and media identity; 12 sampled terms over six lookup passes. This audit does not prove all-term semantics or process peak memory. Baselines and screens establish no speedup."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = audit(args.root.resolve())
    serialized = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(serialized)
    print(serialized)


if __name__ == "__main__":
    main()
