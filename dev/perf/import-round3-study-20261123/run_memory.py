#!/usr/bin/env python3
"""Two reversed four-arm blocks; all sampled-run elapsed times are excluded."""

import json

from common import begin_observation, configuration, finish_observation, prepare, receipt_hashes, save
from readback import verify_cross_arm


def fixed_schedule(replication):
    return list("ABCDDCBA" if replication == 1 else "CDABBADC")


def main():
    from chromium_memory import SIBLING_RECOVERY_RULE, run_with_sampling

    dictionary, replication, config = configuration()
    specification = config["memory"]
    schedule = fixed_schedule(replication)
    state = prepare("memory", "four-arm", specification["arms"], specification["packageRules"], schedule, {
        "observerRule": SIBLING_RECOVERY_RULE,
        "scope": "Separate Chromium process PSS/private diagnostics; two reversed four-arm blocks per replication",
        "layoutRules": specification["layoutRules"],
        "timingCaveat": "The quick harness cannot detect external sampling; its timing labels do not apply. Every elapsed time is excluded from performance results.",
    })
    observations = []
    for index, arm in enumerate(schedule):
        output, root, command = begin_observation(state, index, arm, f"memory-{index:02d}-{arm}")
        print(f"{dictionary} replication {replication}: memory {index + 1}/{len(schedule)} arm {arm}", flush=True)
        memory = run_with_sampling(command, root, output / "run.log", output / "chromium-memory.json")
        observation = {"index": index, "arm": arm, "authoritativeTiming": False, "memory": memory,
                       "sourceCommit": state["arms"][arm], "packageSha256": state["packages"][arm],
                       "validation": None, "failure": None}
        try:
            if memory["schemaVersion"] != 3 or memory["observerRule"] != SIBLING_RECOVERY_RULE:
                raise ValueError("Unexpected process-memory observer identity")
            observation["validation"] = finish_observation(state, output, arm)["validation"]
        except (OSError, ValueError, KeyError, TypeError) as error:
            observation["failure"] = {"type": type(error).__name__, "message": str(error)}
        observation["receiptHashes"] = receipt_hashes(output)
        save(output / "observation.json", observation)
        observations.append(observation)
    save(state["evidence"] / "observations.json", observations)
    failures = [f"observation-{item['index']}-unqualified" for item in observations
                if item["failure"] is not None or not item["memory"]["qualifiedForWholeTreePss"]]
    comparison = {"authoritativeTiming": False, "qualifiedMemoryMeasurement": False,
                  "qualificationFailures": failures, "schedule": schedule, "blocks": []}
    if not failures:
        try:
            save(state["evidence"] / "readback-comparison.json",
                 verify_cross_arm(observations, {arm: 2 for arm in "ABCD"}, specification["layoutRules"]))
        except (ValueError, KeyError, TypeError) as error:
            failures.append("cross-arm-readback: " + str(error))
    if not failures:
        for start in (0, 4):
            block = {item["arm"]: item for item in observations[start:start + 4]}
            contrasts = {}
            for a_arm, b_arm in (("A", "B"), ("B", "C"), ("B", "D"), ("A", "C"), ("A", "D")):
                metrics = {}
                for key in ("maxSampledPssKiB", "maxSampledPrivateKiB"):
                    a, b = (block[arm]["memory"][key] for arm in (a_arm, b_arm))
                    metrics[key] = {"baseline": a, "candidate": b,
                                    "changePercent": 100 * (b / a - 1) if a else None}
                contrasts[a_arm + "-" + b_arm] = metrics
            comparison["blocks"].append({"indices": list(range(start, start + 4)), "contrasts": contrasts})
        comparison["qualifiedMemoryMeasurement"] = True
    save(state["evidence"] / "memory-comparison.json", comparison)
    print(json.dumps(comparison, indent=2), flush=True)
    if failures:
        raise RuntimeError("Memory study remains unqualified: " + "; ".join(failures))


if __name__ == "__main__":
    main()
