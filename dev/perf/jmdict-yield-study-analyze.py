#!/usr/bin/env python3
"""Summarize explicitly selected study artifacts without combining their cells."""

import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import statistics


DRIVER_PATH = Path(__file__).with_name("jmdict-yield-study") / "run.py"
SPEC = importlib.util.spec_from_file_location("jmdict_study_driver", DRIVER_PATH)
DRIVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DRIVER)


def checked(condition, message):
    if not condition:
        raise RuntimeError(message)


def read(path):
    return json.loads(Path(path).read_text())


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def distribution(values):
    ordered = sorted(values)
    return {"count": len(values), "min": ordered[0], "median": statistics.median(values),
            "p95": ordered[math.ceil(0.95 * len(values)) - 1], "max": ordered[-1]}


def equivalent_statistics(actual, expected):
    # Python 3.12 improves float summation; allow rounding differences only.
    if isinstance(actual, dict):
        return isinstance(expected, dict) and actual.keys() == expected.keys() and all(
            equivalent_statistics(value, expected[key]) for key, value in actual.items())
    if isinstance(actual, list):
        return isinstance(expected, list) and len(actual) == len(expected) and all(
            equivalent_statistics(a, b) for a, b in zip(actual, expected))
    if isinstance(actual, float):
        return type(expected) in (int, float) and math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-10)
    return actual == expected


def summarize(directory):
    path = directory / "cohort.json"
    preparation = read(directory / "preparation.json")
    manifest = read(directory / "manifest.json")
    cohort = read(path)
    checked(cohort["manifestSha256"] == preparation["manifestSha256"] == digest(directory / "manifest.json"), "Changed study manifest")
    checked((cohort["browser"], cohort["replication"], cohort["dictionary"]) ==
            (preparation["browser"], preparation["replication"], preparation["dictionary"]), "Mixed cell artifacts")
    result = {"directory": str(directory.resolve()), "cohortSha256": digest(path),
              "manifestSha256": cohort["manifestSha256"], "diagnosticCommit": preparation["diagnosticCommit"],
              "browser": cohort["browser"], "replication": cohort["replication"], "dictionary": cohort["dictionary"],
              "complete": cohort["complete"], "failures": cohort["failures"],
              "attemptedObservations": len(cohort["observations"]), "plannedObservations": len(cohort["planned"]),
              "browserRuntime": preparation.get("browserRuntime"),
              "sourceCommits": {arm: source["commit"] for arm, source in preparation["arms"].items()}}
    if not cohort["complete"]:
        result["interpretation"] = "Failed or incomplete cohort: no speed comparison. All attempted observations remain in the source artifact."
        return result
    checked(preparation["complete"] and not cohort["failures"], "Complete marker conflicts with preparation/failures")
    schedule = DRIVER.build_schedule(manifest, cohort["replication"])
    checked(schedule == cohort["planned"] and len(schedule) == len(cohort["observations"]), "Incomplete declared schedule")
    for expected, actual in zip(schedule, cohort["observations"]):
        checked(all(expected[key] == actual[key] for key in expected) and not actual.get("error"), "Observation order or status changed")
        elapsed = actual["totalImportMs"]
        checked(type(elapsed) in (int, float) and math.isfinite(elapsed) and elapsed > 0, "Invalid complete observation")
    rows = {(entry["block"], entry["arm"]): entry for entry in cohort["observations"] if not entry["warmup"]}
    checked(len(rows) == manifest["blocks"] * 4, "Duplicate or missing measured observation")
    result["armTimingsMs"] = {arm: distribution([rows[(block, arm)]["totalImportMs"] for block in range(manifest["blocks"])]) for arm in "ABCD"}
    result["comparisons"] = {}
    comparisons = {"C/A": ("A", "C"), "D/B": ("B", "D"), "B/A": ("A", "B"), "D/A": ("A", "D")}
    checked(cohort["statistics"].keys() == comparisons.keys(), "Unexpected comparison set")
    for label, (baseline, candidate) in comparisons.items():
        pairs = [(rows[(block, baseline)]["totalImportMs"], rows[(block, candidate)]["totalImportMs"]) for block in range(manifest["blocks"])]
        observed = DRIVER.statistics_for(pairs)
        checked(equivalent_statistics(observed, cohort["statistics"][label]), "Recomputed statistics disagree with frozen driver")
        result["comparisons"][label] = cohort["statistics"][label]
    result["largestReportedParserWasmHeapBytes"] = {
        arm: max(rows[(block, arm)]["executedPath"]["largestParserWasmHeapBytes"] for block in range(manifest["blocks"])) for arm in "ABCD"}
    result["observedVersions"] = sorted({entry["browserVersion"] for entry in cohort["observations"]})
    result["interpretation"] = "Separate cell. C/A and D/B are separate unchanged-source controls; B/A and D/A share baseline A. No control subtraction, pooling, or automatic qualification."
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directories", nargs="+", type=Path, help="Explicit artifact roots, each containing cohort.json")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    checked(not args.output.exists(), "Refusing to overwrite an existing analysis")
    cells = [summarize(directory) for directory in args.directories]
    analysis = {"schemaVersion": 1, "analysisDriverSha256": digest(Path(__file__)),
                "frozenStatisticsDriverSha256": digest(DRIVER_PATH), "cells": cells,
                "limitations": ["Never pool browsers, order replications or attempts.",
                                "Bootstrap intervals are descriptive and do not correct temporal dependence or multiple comparisons.",
                                "Reported parser heaps and untimed RSS snapshots do not measure import peak memory."]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(analysis, indent=2, allow_nan=False) + "\n")
    print("| Browser / order | Comparison | Pairs | Median change | Equal-work change | Faster | Worst pair | Descriptive 95% interval |")
    print("| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |")
    for cell in cells:
        label = cell["browser"] + " / " + cell["replication"]
        if not cell["complete"]:
            print(f"| {label} | Incomplete | — | — | — | — | — | No performance comparison |")
            continue
        for comparison, stats in cell["comparisons"].items():
            low, high = stats["descriptiveBootstrap95Percent"]
            print(f"| {label} | {comparison} | {stats['pairs']} | {stats['medianPairedChangePercent']:+.2f}% | "
                  f"{stats['equalWorkChangePercent']:+.2f}% | {stats['fasterPairs']}/{stats['pairs']} | "
                  f"{stats['worstPairPercent']:+.2f}% | [{low:+.2f}%, {high:+.2f}%] |")


if __name__ == "__main__":
    main()
