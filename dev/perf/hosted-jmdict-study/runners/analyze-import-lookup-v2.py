#!/usr/bin/env python3
"""Analyze complete persistent-module import screens without dropping samples.

Example:
  python analyze-import-lookup-v2.py control.json --out control-analysis.json

Every statistical sample is one complete, fixed-pass observation pair. Timing
values are normalized to one complete corpus. Bootstrap intervals resample pairs,
never individual groups or passes. GC overlap is diagnostic and is not subtracted.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import statistics
from pathlib import Path


BOOTSTRAP_SEED = 20261119
METRICS = ("wallMs", "processCpuMs", "threadCpuMs")
PHASES = ("parseBankMs", "copyJsonMs", "gcOverlapMs")


def number(value, label: str, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label}: expected a numeric value")
    result = float(value)
    if not math.isfinite(result) or result < 0 or (positive and result == 0):
        raise ValueError(f"{label}: invalid duration or count {value!r}")
    return result


def check_close(actual: float, expected: float, label: str) -> None:
    if not math.isclose(actual, expected, rel_tol=1e-9, abs_tol=1e-6):
        raise ValueError(f"{label}: aggregate {actual} differs from raw sum {expected}")


def series_stats(values: list[float]) -> dict:
    mean = statistics.fmean(values)
    sd = statistics.stdev(values) if len(values) > 1 else 0.0
    return {
        "n": len(values),
        "mean": mean,
        "median": statistics.median(values),
        "sampleStandardDeviation": sd,
        "coefficientOfVariationPercent": 100 * sd / mean if mean != 0 else None,
        "minimum": min(values),
        "maximum": max(values),
    }


def percentile(sorted_values: list[float], probability: float) -> float:
    position = (len(sorted_values) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    fraction = position - lower
    return sorted_values[lower] * (1 - fraction) + sorted_values[upper] * fraction


def bootstrap_log_ratio(log_ratios: list[float], resamples: int) -> dict:
    # Restart the fixed seed for each metric/report, so equal-sized cohorts use
    # the same pair-index resamples. Individual passes are never pseudo-replicates.
    rng = random.Random(BOOTSTRAP_SEED)
    count = len(log_ratios)
    samples = [
        sum(log_ratios[rng.randrange(count)] for _ in range(count)) / count
        for _ in range(resamples)
    ]
    samples.sort()
    estimate = statistics.fmean(log_ratios)
    interval = [percentile(samples, 0.025), percentile(samples, 0.975)]
    return {
        "method": "paired percentile bootstrap of mean log(B/A)",
        "seed": BOOTSTRAP_SEED,
        "resamples": resamples,
        "sampleUnit": "complete fixed-pass observation pair",
        "meanPairedLogRatio": estimate,
        "meanPairedLogRatio95PercentInterval": interval,
        "geometricMeanPairedChangePercent": 100 * math.expm1(estimate),
        "geometricMeanPairedChangePercent95PercentInterval": [
            100 * math.expm1(value) for value in interval
        ],
    }


def extract_observation(observation: dict, order: int, pass_count: int, dictionary_rows: int) -> dict:
    pair = observation["pair"]
    arm = observation["arm"]
    label = f"pair {pair} arm {arm}"
    if observation.get("complete") is not True:
        raise ValueError(f"{label}: observation is incomplete; no partial subset will be analyzed")
    passes = observation["passes"]
    if len(passes) != pass_count:
        raise ValueError(f"{label}: expected exactly {pass_count} measured passes")
    before = observation["verificationBefore"]
    after = observation["verificationAfter"]
    if not before.get("digest") or any(before[key] != after[key] for key in ("digest", "indexBytes", "rows")):
        raise ValueError(f"{label}: before/after byte oracle differs")
    if before["rows"] != dictionary_rows:
        raise ValueError(f"{label}: verification row count differs from the declared corpus")
    pass_rows = []
    observed_gc_indexes = set()
    for index, sample in enumerate(passes):
        sample_label = f"{label} pass {index}"
        if sample["rows"] != dictionary_rows or sample["indexBytes"] != before["indexBytes"]:
            raise ValueError(f"{sample_label}: measured output dimensions differ from verification")
        for field in ("fusedParseAttempts", "fusedParseFallbacks", "discardedFusedRows"):
            if sample[field] != before[field]:
                raise ValueError(f"{sample_label}: {field} differs from pre-verification")
        groups = sample["groups"]
        if not groups:
            raise ValueError(f"{sample_label}: no group measurements")
        wall = number(sample["elapsedMs"], sample_label + " wall", positive=True)
        process_cpu = number(sample["processCpu"]["totalMs"], sample_label + " process CPU", positive=True)
        thread_cpu = sample.get("threadCpu")
        thread_cpu = None if thread_cpu is None else number(thread_cpu["totalMs"], sample_label + " thread CPU", positive=True)
        check_close(wall, sum(number(group["elapsedMs"], sample_label) for group in groups), sample_label + " wall")
        check_close(process_cpu, sum(number(group["processCpu"]["totalMs"], sample_label) for group in groups), sample_label + " process CPU")
        if thread_cpu is not None:
            if any(group.get("threadCpu") is None for group in groups):
                raise ValueError(f"{sample_label}: missing group thread CPU behind a populated total")
            check_close(thread_cpu, sum(number(group["threadCpu"]["totalMs"], sample_label) for group in groups), sample_label + " thread CPU")
        phases = {}
        for field in PHASES:
            values = [group.get(field) if field == "gcOverlapMs" else group.get("profile", {}).get(field) for group in groups]
            phases[field] = None if any(value is None for value in values) else sum(number(value, sample_label + " " + field) for value in values)
        for group in groups:
            observed_gc_indexes.update(group.get("gcEventIndexes", []))
        pass_rows.append({"pass": index, "wallMs": wall, "processCpuMs": process_cpu, "threadCpuMs": thread_cpu, **phases})
    per_corpus = {}
    for field in (*METRICS, *PHASES):
        values = [sample[field] for sample in pass_rows]
        per_corpus[field] = None if any(value is None for value in values) else statistics.fmean(values)
    result = observation["result"]
    if result["rows"] != dictionary_rows * pass_count:
        raise ValueError(f"{label}: aggregate measured row count differs from all passes")
    for field, actual in (("wallMs", result["elapsedMs"]), ("processCpuMs", result["processCpu"]["totalMs"])):
        check_close(number(actual, label), per_corpus[field] * pass_count, label + " " + field)
    if result.get("threadCpu") is not None:
        if per_corpus["threadCpuMs"] is None:
            raise ValueError(f"{label}: incomplete thread CPU behind a populated aggregate")
        check_close(number(result["threadCpu"]["totalMs"], label), per_corpus["threadCpuMs"] * pass_count, label + " thread CPU")
    return {
        "chronologicalIndex": order,
        "pair": pair,
        "arm": arm,
        "measuredPasses": pass_count,
        "perCorpus": per_corpus,
        "passes": pass_rows,
        "measuredGcEventIndexes": sorted(observed_gc_indexes),
        "explicitGcOutsideTimingMs": number(observation["explicitGc"]["endTimeMs"], label) - number(observation["explicitGc"]["startTimeMs"], label),
        "verificationDigest": before["digest"],
        "fusedAttemptsPerPass": before["fusedParseAttempts"],
        "fusedFallbacksPerPass": before["fusedParseFallbacks"],
        "discardedFusedRowsPerPass": before["discardedFusedRows"],
        "hostCapturedAtBefore": observation.get("hostEnvironmentBefore", {}).get("capturedAtIso"),
        "hostCapturedAtAfter": observation.get("hostEnvironmentAfter", {}).get("capturedAtIso"),
    }


def analyze_report(filename: Path, resamples: int) -> dict:
    raw = filename.read_bytes()
    report = json.loads(raw)
    if report.get("complete") is not True or report.get("schemaVersion") != 2:
        raise ValueError(f"{filename}: requires a complete schema-v2 report")
    pair_count = report["pairs"]
    pass_count = report["passesPerObservation"]
    if not isinstance(pair_count, int) or pair_count < 2 or not isinstance(pass_count, int) or pass_count < 1:
        raise ValueError(f"{filename}: invalid fixed pair/pass count")
    observations = [extract_observation(value, index, pass_count, report["dictionaryRows"]) for index, value in enumerate(report["observations"])]
    expected = {(pair, arm) for pair in range(pair_count) for arm in ("A", "B")}
    keys = [(value["pair"], value["arm"]) for value in observations]
    if len(keys) != len(expected) or set(keys) != expected:
        raise ValueError(f"{filename}: missing or duplicate observations; no subset will be selected")
    if len({value["verificationDigest"] for value in observations}) != 1:
        raise ValueError(f"{filename}: full output oracle differs between observations")
    arm_a, arm_b = report["arms"]["A"], report["arms"]["B"]
    is_aa = all(arm_a[key] == arm_b[key] for key in ("sourceHashes", "wasmSha256", "flags"))
    by_pair = {(value["pair"], value["arm"]): value for value in observations}
    summaries = {}
    for metric in METRICS:
        a = [by_pair[(pair, "A")]["perCorpus"][metric] for pair in range(pair_count)]
        b = [by_pair[(pair, "B")]["perCorpus"][metric] for pair in range(pair_count)]
        if any(value is None for value in a + b):
            summaries[metric] = {"available": False, "reason": "One or more complete observations lack this counter; no subset was analyzed"}
            continue
        ratios = [right / left for left, right in zip(a, b)]
        changes = [100 * (ratio - 1) for ratio in ratios]
        savings = [left - right for left, right in zip(a, b)]
        summaries[metric] = {
            "available": True,
            "medianPairedChangePercent": statistics.median(changes),
            "equalWorkTotalChangePercent": 100 * (sum(b) / sum(a) - 1),
            "medianAbsoluteAaDeviationPercent": statistics.median(abs(value) for value in changes) if is_aa else None,
            "fasterPairs": sum(value < 0 for value in changes),
            "slowerPairs": sum(value > 0 for value in changes),
            "tiedPairs": sum(value == 0 for value in changes),
            "absoluteSavingsMsPerCorpus": {
                "signConvention": "A minus B; positive means B saved time",
                **{key: value for key, value in series_stats(savings).items() if key != "coefficientOfVariationPercent"},
            },
            "armsMsPerCorpus": {"A": series_stats(a), "B": series_stats(b)},
            "pairs": [{"pair": pair, "aMsPerCorpus": a[pair], "bMsPerCorpus": b[pair], "changePercent": changes[pair], "absoluteSavingsMsPerCorpus": savings[pair]} for pair in range(pair_count)],
            "bootstrap": bootstrap_log_ratio([math.log(value) for value in ratios], resamples),
        }
    phases = {}
    for field in PHASES:
        phases[field] = {}
        for arm in ("A", "B"):
            selected = [value["perCorpus"][field] for value in observations if value["arm"] == arm]
            phases[field][arm] = None if any(value is None for value in selected) else {
                "msPerCorpus": series_stats(selected),
                "totalMsAcrossMeasuredPasses": sum(selected) * pass_count,
            }
    control_gate = None
    if is_aa:
        thread = summaries["threadCpuMs"]
        control_gate = {"medianAbsolutePairedThreadCpuThresholdPercent": 3.0, "perArmThreadCpuCvThresholdPercent": 8.0, "passed": None}
        if thread["available"]:
            control_gate["passed"] = thread["medianAbsoluteAaDeviationPercent"] <= 3 and all(thread["armsMsPerCorpus"][arm]["coefficientOfVariationPercent"] <= 8 for arm in ("A", "B"))
    limitations = [
        "Every observation is included. No outliers are removed and no GC duration is subtracted.",
        "Per-arm CV is sample standard deviation divided by mean across complete observation averages, not individual passes.",
        "The bootstrap resamples matched observation pairs; it does not turn groups or repeated passes into independent samples.",
        "The interval describes these observed pairs. Few pairs and serial host drift limit how broadly it can be interpreted.",
        "parseBankMs and copyJsonMs are parser wall-phase diagnostics; they are not additive CPU measurements.",
    ]
    if control_gate is not None and control_gate["passed"] is False:
        limitations.append("The unchanged-code control exceeds the predeclared noise limits. This setup cannot establish a small candidate improvement from these observations.")
    return {
        "report": str(filename.resolve()),
        "reportSha256": hashlib.sha256(raw).hexdigest(),
        "comparisonKind": "A/A" if is_aa else "A/B",
        "dictionary": report["dictionary"],
        "dictionaryRows": report["dictionaryRows"],
        "pairs": pair_count,
        "passesPerObservation": pass_count,
        "sourceRoots": {arm: report["arms"][arm]["sourceRoot"] for arm in ("A", "B")},
        "runtime": report.get("runtime"),
        "hostEnvironmentBefore": report.get("hostEnvironmentBefore"),
        "hostEnvironmentAfter": report.get("hostEnvironmentAfter"),
        "metrics": summaries,
        "controlQualification": control_gate,
        "phaseDiagnostics": phases,
        "gcEventsAllPhases": len(report.get("gcEvents", [])),
        "gcEventsOverlappingMeasuredGroups": len({index for value in observations for index in value["measuredGcEventIndexes"]}),
        "observations": observations,
        "interpretation": limitations,
    }


def print_summary(report: dict) -> None:
    print(f"{report['comparisonKind']} {report['dictionary']}: {report['pairs']} pairs x {report['passesPerObservation']} passes")
    print(f"Report: {report['report']}")
    print("All observations, milliseconds per complete corpus:")
    print(" order pair arm       wall    process     thread  native-parse       copy  GC-overlap")
    for observation in report["observations"]:
        values = observation["perCorpus"]
        cells = ["n/a" if values[key] is None else f"{values[key]:.3f}" for key in (*METRICS, *PHASES)]
        print(f"{observation['chronologicalIndex']:6d} {observation['pair']:4d} {observation['arm']:>3} " + " ".join(f"{cell:>10}" for cell in cells))
    for metric, summary in report["metrics"].items():
        if not summary["available"]:
            print(f"{metric}: unavailable")
            continue
        interval = summary["bootstrap"]["geometricMeanPairedChangePercent95PercentInterval"]
        print(f"{metric}: paired median {summary['medianPairedChangePercent']:+.3f}%, equal-work {summary['equalWorkTotalChangePercent']:+.3f}%, mean savings {summary['absoluteSavingsMsPerCorpus']['mean']:+.3f} ms/corpus; bootstrap change 95% [{interval[0]:+.3f}%, {interval[1]:+.3f}%]")
        print(f"  A CV {summary['armsMsPerCorpus']['A']['coefficientOfVariationPercent']:.3f}%; B CV {summary['armsMsPerCorpus']['B']['coefficientOfVariationPercent']:.3f}%; median absolute A/A deviation {summary['medianAbsoluteAaDeviationPercent']}")
    if report["controlQualification"] is not None:
        print(f"Predeclared A/A control gate: {report['controlQualification']['passed']}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reports", type=Path, nargs="+")
    parser.add_argument("--out", type=Path, help="Save complete JSON analysis and print all observations plus a concise summary")
    parser.add_argument("--bootstrap-resamples", type=int, default=10000)
    args = parser.parse_args()
    if args.bootstrap_resamples < 1:
        parser.error("--bootstrap-resamples must be positive")
    output = {
        "analysisVersion": 1,
        "analysisScriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "bootstrapSeed": BOOTSTRAP_SEED,
        "reports": [analyze_report(filename, args.bootstrap_resamples) for filename in args.reports],
    }
    serialized = json.dumps(output, indent=2, allow_nan=False) + "\n"
    if args.out is None:
        print(serialized, end="")
    else:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(serialized)
        for report in output["reports"]:
            print_summary(report)
        print(f"Saved complete analysis: {args.out.resolve()}")


if __name__ == "__main__":
    main()
