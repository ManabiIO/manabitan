#!/usr/bin/env python3
"""Read native checksum activation from the original timed browser observations."""

import argparse
import json
import pathlib


def activation(report):
    phases = [phase for phase in report["phases"]
              if isinstance(phase.get("data"), dict) and phase["data"].get("kind") == "dictionary-import"]
    if len(phases) != 1:
        raise ValueError("Expected one actual complete-import phase")
    history = phases[0]["data"]["importDebugHistory"]
    if not isinstance(history, list) or any(not isinstance(entry, dict) for entry in history):
        raise ValueError("Invalid import debug history")
    finalizations = []
    for entry in history:
        timings = entry.get("importerPhaseTimings", [])
        if not isinstance(timings, list) or any(not isinstance(timing, dict) for timing in timings):
            raise ValueError("Invalid importer phase timings")
        finalizations.extend(timing for timing in timings if timing.get("phase") == "bulk-finalization")
    if len(finalizations) != 1 or not isinstance(finalizations[0].get("details"), dict) or finalizations[0]["details"].get("ok") is not True:
        raise ValueError("Expected one successful bulk-finalization from the actual import")
    return finalizations[0]["details"].get("termRecordLookupChecksum")


def validate_metrics(metrics, arm):
    if metrics is None:
        if arm == "B":
            raise ValueError("Candidate import did not report its checksum path")
        return None
    if not isinstance(metrics, dict) or set(metrics) != {"nativeCalls", "nativeBytes", "javascriptCalls"}:
        raise ValueError("Unexpected checksum metric fields")
    if any(type(value) is not int or value < 0 or value > 2 ** 53 - 1 for value in metrics.values()):
        raise ValueError("Checksum counts/bytes must be nonnegative safe integers")
    if arm != "B":
        if metrics["nativeCalls"] != 0 or metrics["nativeBytes"] != 0:
            raise ValueError("Inactive asset-only control executed native checksums")
        return metrics
    if metrics["nativeCalls"] <= 0 or metrics["nativeBytes"] <= 0:
        raise ValueError("Candidate completed via fallback only; qualifying path was not exercised")
    total = metrics["nativeCalls"] + metrics["javascriptCalls"]
    if total % 3 != 0:
        raise ValueError("Each persisted lookup chunk must report all three checksum calls")
    return {**metrics, "nativeCallFraction": metrics["nativeCalls"] / total, "lookupChunks": total // 3}


def audit(evidence):
    plan = json.loads((evidence / "registered-plan.json").read_text())
    if plan["pairs"] != 12 or len(plan["schedule"]) != 36 or len(plan["memorySchedule"]) != 4:
        raise ValueError("The frozen twelve-pair/control/media/memory plan is incomplete")
    observations = [{"path": item["id"], "kind": item["kind"], "arm": item["arm"]}
                    for item in plan["schedule"]]
    observations.extend({"path": f"exhaustive-media-{arm}", "kind": "exhaustive-media", "arm": arm} for arm in "AB")
    observations.extend({"path": f"memory/{item['name']}", "kind": "memory", "arm": item["arm"]}
                        for item in plan["memorySchedule"])
    results = []
    failures = []
    for observation in observations:
        try:
            report = json.loads((evidence / observation["path"] / "run-1.json").read_text())
            metrics = validate_metrics(activation(report), observation["arm"])
            results.append({**observation, "metrics": metrics})
        except (KeyError, TypeError, ValueError, OSError) as error:
            failures.append({**observation, "error": str(error)})
    return {
        "scope": "Post-timing reads of counters from each original browser import; no diagnostic rerun substitutes for a timed observation",
        "baseline": plan["baseline"], "candidate": plan["candidate"], "dictionary": plan["dictionary"],
        "initialOrder": plan["initialOrder"], "pairs": plan["pairs"],
        "observations": results, "failures": failures, "passed": not failures,
        "qualification": "Every B observation must execute native hashing; all JS fallbacks are reported and retained, never excluded or retried",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=pathlib.Path, required=True)
    args = parser.parse_args()
    try:
        result = audit(args.evidence)
    except (KeyError, TypeError, ValueError, OSError) as error:
        result = {"passed": False, "failure": str(error), "observations": []}
    args.evidence.mkdir(parents=True, exist_ok=True)
    (args.evidence / "checksum-activation.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps(result, sort_keys=True))
    if not result["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
