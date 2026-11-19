#!/usr/bin/env python3
"""Independently validate completed v3 import benchmark reports.

Checks every group, pass and observation. Slow samples remain valid samples;
there is no timing threshold, filtering, GC subtraction or bootstrap here.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
from pathlib import Path


SUM_FIELDS = (
    "elapsedMs", "lookupMs", "rows", "scratchReusedBytes", "scratchReuseMisses",
    "nativeSegments", "directArenaSegments", "validationPasses",
    "fusedParseAttempts", "fusedParseFallbacks", "discardedFusedRows", "discardedFusedParseMs",
)
FUSED_FIELDS = ("fusedParseAttempts", "fusedParseFallbacks", "discardedFusedRows", "discardedFusedParseMs")
CPU_FIELDS = ("userMs", "systemMs", "totalMs")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def finite(value, label: str) -> float:
    require(not isinstance(value, bool) and isinstance(value, (int, float)), f"{label}: non-numeric value")
    require(math.isfinite(value), f"{label}: non-finite value")
    return float(value)


def close(actual, expected: float, label: str) -> None:
    require(math.isclose(finite(actual, label), expected, rel_tol=1e-9, abs_tol=1e-6), f"{label}: {actual} != {expected}")


def check_cpu(cpu, components: list, label: str) -> None:
    if cpu is None:
        require(all(component is None for component in components), f"{label}: missing aggregate with populated components")
        return
    require(all(component is not None for component in components), f"{label}: populated aggregate with missing components")
    for field in CPU_FIELDS:
        value = finite(cpu[field], label + "." + field)
        require(value >= 0, f"{label}: negative CPU time")
        if components:
            close(value, sum(finite(component[field], label) for component in components), label + "." + field)
    close(cpu["totalMs"], cpu["userMs"] + cpu["systemMs"], label + " total=user+system")


def check_pass(sample: dict, reference: dict, rows: int, label: str) -> None:
    groups = sample["groups"]
    require(bool(groups), f"{label}: missing groups")
    require(sample["rows"] == rows, f"{label}: wrong corpus row count")
    require(sample["indexBytes"] == reference["indexBytes"], f"{label}: wrong index byte count")
    close(sample["elapsedMs"], sum(group["elapsedMs"] for group in groups), label + " wall sum")
    close(sample["rows"], sum(group["rows"] for group in groups), label + " row sum")
    for field in FUSED_FIELDS:
        close(sample[field], sum(group[field] for group in groups), label + " " + field)
    for field in FUSED_FIELDS[:3]:
        require(sample[field] == reference[field], f"{label}: activation differs from pre-verification ({field})")
    check_cpu(sample["processCpu"], [group["processCpu"] for group in groups], label + " process CPU")
    check_cpu(sample.get("threadCpu"), [group.get("threadCpu") for group in groups], label + " thread CPU")
    for group_index, group in enumerate(groups):
        group_label = f"{label} group {group_index}"
        start = finite(group["startTimeMs"], group_label)
        end = finite(group["endTimeMs"], group_label)
        require(end >= start, f"{group_label}: reversed interval")
        close(group["elapsedMs"], end - start, group_label + " duration")
        check_cpu(group["processCpu"], [], group_label + " process CPU")
        check_cpu(group.get("threadCpu"), [], group_label + " thread CPU")


def recompute_summary(observations: dict, pair_count: int, cpu_field: str | None) -> dict | None:
    a, b = [], []
    for pair in range(pair_count):
        for arm, values in (("A", a), ("B", b)):
            result = observations[(pair, arm)]["result"]
            if cpu_field is None:
                value = result["elapsedMs"]
            else:
                if result.get(cpu_field) is None:
                    return None
                value = result[cpu_field]["totalMs"]
            require(value > 0, "Non-positive observation duration")
            values.append(value)
    ratios = [right / left for left, right in zip(a, b)]
    return {
        "medianPairedChangePercent": 100 * (statistics.median(ratios) - 1),
        "equalWorkTotalChangePercent": 100 * (sum(b) / sum(a) - 1),
        "fasterPairs": sum(value < 1 for value in ratios),
    }


def validate(filename: Path) -> dict:
    raw = filename.read_bytes()
    report = json.loads(raw)
    require(report.get("complete") is True, "Report is incomplete")
    require(report.get("schemaVersion") == 2 and report.get("protocolVersion") == 3, "Expected schema2/protocol3")
    require(report.get("mode") == "persistent-modules-group-paired-batches", "Unexpected measurement mode")
    pair_count, pass_count = report["pairs"], report["passesPerObservation"]
    require(isinstance(pair_count, int) and pair_count >= 2 and isinstance(pass_count, int) and pass_count >= 1, "Invalid fixed plan")
    initial_order = report["initialOrder"]
    require(initial_order in ("AB", "BA"), "Invalid initial order")
    bank_count, group_size = len(report["inputHashes"]), report["filesPerGroup"]
    require(bank_count > 0 and isinstance(group_size, int) and group_size > 0, "Invalid bank grouping")
    starts = list(range(0, bank_count, group_size))
    expected_keys = {(pair, arm) for pair in range(pair_count) for arm in ("A", "B")}
    keys = [(observation["pair"], observation["arm"]) for observation in report["observations"]]
    require(len(keys) == len(expected_keys) and set(keys) == expected_keys, "Missing or duplicate observations")
    observations = dict(zip(keys, report["observations"]))
    all_groups, digests = [], set()
    for (pair, arm), observation in observations.items():
        label = f"pair {pair} arm {arm}"
        require(observation["complete"] is True, f"{label}: incomplete observation")
        before, after = observation["verificationBefore"], observation["verificationAfter"]
        require(bool(before["digest"]), f"{label}: missing oracle")
        for key in ("digest", "rows", "indexBytes"):
            require(before[key] == after[key], f"{label}: pre/post oracle mismatch ({key})")
        digests.add(before["digest"])
        check_pass(before, before, report["dictionaryRows"], label + " pre-verification")
        check_pass(after, after, report["dictionaryRows"], label + " post-verification")
        require(len(before["groups"]) == len(starts) and len(after["groups"]) == len(starts), f"{label}: verification grouping changed")
        passes = observation["passes"]
        require(len(passes) == pass_count, f"{label}: wrong measured pass count")
        for pass_index, sample in enumerate(passes):
            sample_label = f"{label} pass {pass_index}"
            require(sample["digest"] is None, f"{sample_label}: timed pass unexpectedly has a digest")
            check_pass(sample, before, report["dictionaryRows"], sample_label)
            require(len(sample["groups"]) == len(starts), f"{sample_label}: wrong group count")
            for group_index, group in enumerate(sample["groups"]):
                group_label = f"{sample_label} group {group_index}"
                order = initial_order if (pair + pass_index + group_index) % 2 == 0 else initial_order[::-1]
                sequence = ((pair * pass_count + pass_index) * len(starts) + group_index) * 2 + order.index(arm)
                expected = {
                    "pair": pair, "pass": pass_index, "groupIndex": group_index,
                    "arm": arm, "order": order, "orderPosition": order.index(arm),
                    "measuredSequence": sequence, "firstBankIndex": starts[group_index],
                    "bankCount": min(group_size, bank_count - starts[group_index]),
                    "rows": before["groups"][group_index]["rows"],
                }
                for key, value in expected.items():
                    require(group.get(key) == value, f"{group_label}: wrong {key}")
                for key in FUSED_FIELDS[:3]:
                    require(group[key] == before["groups"][group_index][key], f"{group_label}: activation changed ({key})")
                all_groups.append(group)
        result = observation["result"]
        for key in SUM_FIELDS:
            close(result[key], sum(sample[key] for sample in passes), label + " aggregate " + key)
        close(result["maxWasmHeapBytes"], max(sample["maxWasmHeapBytes"] for sample in passes), label + " maximum WASM heap")
        require(result["digest"] == before["digest"] and result["indexBytes"] == before["indexBytes"], f"{label}: aggregate oracle changed")
        check_cpu(result["processCpu"], [sample["processCpu"] for sample in passes], label + " aggregate process CPU")
        check_cpu(result.get("threadCpu"), [sample.get("threadCpu") for sample in passes], label + " aggregate thread CPU")
        for key in ("sourceRoot", "sourceHashes", "wasmSha256", "flags"):
            require(result[key] == report["arms"][arm][key], f"{label}: arm identity mismatch ({key})")
        for key in ("runnerSha256", "lockSha256", "archiveSha256"):
            require(result[key] == report[key], f"{label}: cohort identity mismatch ({key})")
    require(len(digests) == 1, "Byte oracle differs across observations")
    all_groups.sort(key=lambda group: group["measuredSequence"])
    require([group["measuredSequence"] for group in all_groups] == list(range(pair_count * pass_count * len(starts) * 2)), "Incomplete global group sequence")
    for first, second in zip(all_groups, all_groups[1:]):
        require(second["startTimeMs"] >= first["endTimeMs"], "Measured group intervals overlap or run out of order")
    gaps = []
    for index in range(0, len(all_groups), 2):
        first, second = all_groups[index:index + 2]
        require(first["arm"] + second["arm"] == first["order"], "Adjacent arms violate declared order")
        require(all(first[key] == second[key] for key in ("pair", "pass", "groupIndex", "firstBankIndex", "bankCount", "rows", "order")), "Adjacent arms measured different groups")
        gaps.append(second["startTimeMs"] - first["endTimeMs"])
    for pair in range(pair_count):
        a, b = observations[(pair, "A")], observations[(pair, "B")]
        require(a["explicitGc"] == b["explicitGc"], f"pair {pair}: explicit GC records differ")
        gc = a["explicitGc"]
        require(gc is not None and gc["endTimeMs"] >= gc["startTimeMs"], f"pair {pair}: invalid explicit GC interval")
        pair_groups = [group for group in all_groups if group["pair"] == pair]
        before_end = max(group["endTimeMs"] for observation in (a, b) for group in observation["verificationBefore"]["groups"])
        after_start = min(group["startTimeMs"] for observation in (a, b) for group in observation["verificationAfter"]["groups"])
        require(before_end <= gc["startTimeMs"] <= gc["endTimeMs"] <= pair_groups[0]["startTimeMs"], f"pair {pair}: pre-verification/GC/timing order invalid")
        require(pair_groups[-1]["endTimeMs"] <= after_start, f"pair {pair}: post-verification overlaps timed groups")
    for metric in (None, "processCpu", "threadCpu"):
        expected = recompute_summary(observations, pair_count, metric)
        actual = report["summary"] if metric is None else report["summary"][metric]
        if expected is None:
            require(actual is None, f"{metric}: unavailable counter has a summary")
        else:
            for key, value in expected.items():
                close(actual[key], value, f"summary {metric or 'wall'} {key}")
    return {
        "report": str(filename.resolve()), "reportSha256": hashlib.sha256(raw).hexdigest(),
        "valid": True, "pairs": pair_count, "passesPerArm": pass_count,
        "observations": len(observations), "measuredGroups": len(all_groups),
        "verificationDigest": next(iter(digests)), "runnerSha256": report["runnerSha256"],
        "adjacentGroupGapMs": {"minimum": min(gaps), "median": statistics.median(gaps), "maximum": max(gaps)},
        "note": "Every group and observation was checked. No timing-based exclusions or GC subtraction.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reports", type=Path, nargs="+")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    results = []
    for filename in args.reports:
        try:
            results.append(validate(filename))
        except (ValueError, KeyError, TypeError, OSError, IndexError, ZeroDivisionError) as error:
            results.append({"report": str(filename.resolve()), "valid": False, "error": str(error)})
    output = {"validatorVersion": 1, "validatorSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "reports": results}
    serialized = json.dumps(output, indent=2, allow_nan=False) + "\n"
    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(serialized)
    print(serialized, end="")
    return 0 if all(result["valid"] for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
