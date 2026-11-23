#!/usr/bin/env python3
"""Fixed private-buffer ABBA/BAAB import-window memory observations."""
import json

from common import begin_observation, configuration, finish_observation, prepare, receipt_hashes, save
from import_window import derive_import_window, window_plan
from readback import verify_cross_arm


def fixed_schedule(replication):
    if type(replication) is not int or replication not in (1, 2):
        raise ValueError("Unexpected replication")
    return list("ABBA" if replication == 1 else "BAAB")


def main():
    from chromium_memory import SIBLING_RECOVERY_RULE, run_with_sampling

    dictionary, replication, config = configuration()
    specification = config["privateMemory"]
    schedule = fixed_schedule(replication)
    if set(specification["arms"]) != {"A", "B"} or specification["layoutRules"] != [
            {"baseline": "A", "candidate": "B", "allowReferenceLayoutChange": False}]:
        raise ValueError("Private-memory study requires two arms and exact physical layout")
    state = prepare("memory", "private-budget", specification["arms"], specification["packageRules"], schedule, {
        **window_plan(), "layoutRules": specification["layoutRules"],
        "timingCaveat": "All elapsed times are excluded; the quick harness cannot detect external memory sampling.",
    })
    observations = []
    for index, arm in enumerate(schedule):
        output, root, command = begin_observation(state, index, arm, f"memory-{index:02d}-{arm}")
        print(f"{dictionary} replication {replication}: import-window memory {index + 1}/4 arm {arm}", flush=True)
        memory = run_with_sampling(command, root, output / "run.log", output / "chromium-memory.json")
        observation = {"index": index, "arm": arm, "authoritativeTiming": False, "memory": memory,
                       "sourceCommit": state["arms"][arm], "packageSha256": state["packages"][arm],
                       "validation": None, "failure": None, "importWindow": None, "windowFailure": None}
        try:
            if memory["schemaVersion"] != 3 or memory["observerRule"] != SIBLING_RECOVERY_RULE:
                raise ValueError("Unexpected process-memory observer identity")
            result = finish_observation(state, output, arm)
            observation["validation"] = result["validation"]
        except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
            observation["failure"] = {"type": type(error).__name__, "message": str(error)}
        else:
            try:
                raw = json.loads((output / "chromium-memory.json").read_text())
                if memory != {key: value for key, value in raw.items() if key != "samples"}:
                    raise ValueError("Original memory receipt differs from returned summary")
                report = json.loads((output / "run-1.json").read_text())
                scoped = derive_import_window(raw, report, result, state["fixture"])
                save(output / "import-window.json", scoped)
                observation["importWindow"] = scoped
            except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
                observation["windowFailure"] = {"type": type(error).__name__, "message": str(error)}
        observation["receiptHashes"] = receipt_hashes(output)
        save(output / "observation.json", observation)
        observations.append(observation)
    save(state["evidence"] / "observations.json", observations)
    failures = [f"observation-{item['index']}-unqualified" for item in observations
                if item["failure"] is not None or item["windowFailure"] is not None or
                item["importWindow"] is None or not item["importWindow"]["qualifiedForImportWindowPss"]]
    comparison = {"authoritativeTiming": False, "scopeRule": window_plan()["scopeRule"],
                  "qualifiedMemoryMeasurement": False, "qualificationFailures": failures,
                  "qualifiedCrossArmReadback": False,
                  "schedule": schedule, "pairs": [],
                  "wholeLifecycleQualifiedObservationCount": sum(item["memory"]["qualifiedForWholeTreePss"] for item in observations),
                  "wholeLifecycleQualificationFailures": [{"index": item["index"], "arm": item["arm"],
                                                            "failures": item["memory"]["qualificationFailures"]}
                                                           for item in observations if not item["memory"]["qualifiedForWholeTreePss"]]}
    if all(item["failure"] is None for item in observations):
        try:
            save(state["evidence"] / "readback-comparison.json",
                 verify_cross_arm(observations, {"A": 2, "B": 2}, specification["layoutRules"]))
            comparison["qualifiedCrossArmReadback"] = True
        except (ValueError, KeyError, TypeError) as error:
            failures.append("cross-arm-readback: " + str(error))
    if not failures:
        for start in (0, 2):
            pair = {item["arm"]: item for item in observations[start:start + 2]}
            metrics = {}
            for key in ("maxSampledPssKiB", "maxSampledPrivateKiB"):
                a, b = (pair[arm]["importWindow"][key] for arm in ("A", "B"))
                metrics[key] = {"baseline": a, "candidate": b, "changePercent": 100 * (b / a - 1) if a else None}
            comparison["pairs"].append({"indices": [start, start + 1], "metrics": metrics})
        comparison["qualifiedMemoryMeasurement"] = True
    save(state["evidence"] / "import-window-comparison.json", comparison)
    print(json.dumps(comparison, indent=2), flush=True)
    if failures:
        raise RuntimeError("Prospective import-window memory study remains unqualified: " + "; ".join(failures))


if __name__ == "__main__":
    main()
