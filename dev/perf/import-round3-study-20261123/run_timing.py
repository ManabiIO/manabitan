#!/usr/bin/env python3
"""Two predetermined eight-pair timing replications, independent of memory."""

import json
import os
import statistics

from common import begin_observation, configuration, finish_observation, prepare, receipt_hashes, run, save
from readback import verify_cross_arm


def fixed_schedule(replication):
    schedule = [("warmup", 0, arm) for arm in ("AB" if replication == 1 else "BA")]
    for pair in range(2):
        schedule += [("control-before", pair, "A"), ("control-before", pair, "A")]
    for pair in range(8):
        order = "AB" if (pair + replication) % 2 == 1 else "BA"
        schedule += [("candidate", pair, arm) for arm in order]
    for pair in range(2):
        schedule += [("control-after", pair, "A"), ("control-after", pair, "A")]
    return schedule


def main():
    dictionary, replication, config = configuration()
    name = os.environ["PERF_CANDIDATE"]
    specification = config["timing"][name]
    schedule = fixed_schedule(replication)
    state = prepare("timing", name, specification["arms"], specification["packageRules"], schedule, {
        "boundary": "file-input change to post-UI import completion; restart/readback outside timing",
        "scope": "Two fixed counterbalanced replications; eight adjacent candidate pairs and four baseline A/A pairs each; no retries or outlier removal",
        "layoutRules": specification["layoutRules"],
    })
    observations = []
    for index, (kind, pair, arm) in enumerate(schedule):
        output, root, command = begin_observation(state, index, arm, f"{index:02d}-{kind}-{pair}-{arm}")
        print(f"{dictionary} {name} replication {replication}: {index + 1}/{len(schedule)} {kind} {arm}", flush=True)
        run(command, root, output / "run.log")
        result = finish_observation(state, output, arm)
        observation = {"index": index, "kind": kind, "pair": pair, "arm": arm,
                       "totalImportMs": result["totalImportMs"], "validation": result["validation"],
                       "sourceCommit": state["arms"][arm], "packageSha256": result["packageSha256"],
                       "receiptHashes": receipt_hashes(output)}
        save(output / "observation.json", observation)
        observations.append(observation)
    save(state["evidence"] / "observations.json", observations)
    save(state["evidence"] / "readback-comparison.json",
         verify_cross_arm(observations, {"A": 17, "B": 9}, specification["layoutRules"]))
    results = {}
    for kind in ("candidate", "control-before", "control-after"):
        pairs = []
        selected = [item for item in observations if item["kind"] == kind]
        for pair in sorted({item["pair"] for item in selected}):
            two = [item for item in selected if item["pair"] == pair]
            if kind == "candidate":
                a = next(item["totalImportMs"] for item in two if item["arm"] == "A")
                b = next(item["totalImportMs"] for item in two if item["arm"] == "B")
            else:
                a, b = [item["totalImportMs"] for item in two]
            pairs.append({"pair": pair, "baselineMs": a, "comparisonMs": b,
                          "changePercent": 100 * (b / a - 1)})
        results[kind] = {"pairs": pairs,
                         "medianChangePercent": statistics.median(item["changePercent"] for item in pairs),
                         "fasterPairs": sum(item["comparisonMs"] < item["baselineMs"] for item in pairs)}
    save(state["evidence"] / "results.json", results)
    print(json.dumps(results, indent=2), flush=True)


if __name__ == "__main__":
    main()
