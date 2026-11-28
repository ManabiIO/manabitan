#!/usr/bin/env python3
"""Analyze the frozen native canonical component cohort without dropping observations."""

import argparse
import hashlib
import json
import math
import random
import statistics
import sys
from pathlib import Path


SEED = 0x0F1F2026
RESAMPLES = 20000
METRICS = (
    "firstCallMs",
    "remainingFirstPassMs",
    "firstPassSumMs",
    "secondPassSumMs",
    "secondPassFirstCallMs",
)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def load_json(path):
    data = path.read_bytes()
    return json.loads(data), sha256(data)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def percentile(sorted_values, fraction):
    index = (len(sorted_values) - 1) * fraction
    lower = math.floor(index)
    upper = math.ceil(index)
    return sorted_values[lower] + (sorted_values[upper] - sorted_values[lower]) * (index - lower)


def summarize(pairs):
    """The interval describes resampling complete adjacent pairs, not individual calls."""
    changes = [100 * (pair["secondMs"] / pair["firstMs"] - 1) for pair in pairs]
    rng = random.Random(SEED)
    samples = sorted(
        statistics.median(changes[rng.randrange(len(changes))] for _ in changes)
        for _ in range(RESAMPLES)
    )
    return {
        "pairs": len(pairs),
        "pairedMedianPercent": statistics.median(changes),
        "equalWorkPercent": 100 * (
            sum(pair["secondMs"] for pair in pairs) / sum(pair["firstMs"] for pair in pairs) - 1
        ),
        "pairedMedianDeltaMs": statistics.median(pair["secondMs"] - pair["firstMs"] for pair in pairs),
        "descriptive95PercentileInterval": [percentile(samples, 0.025), percentile(samples, 0.975)],
        "secondFasterPairs": sum(value < 0 for value in changes),
        "equalPairs": sum(value == 0 for value in changes),
        "smallestPercent": min(changes),
        "largestPercent": max(changes),
        "observations": [
            dict(pair, changePercent=change, deltaMs=pair["secondMs"] - pair["firstMs"])
            for pair, change in zip(pairs, changes, strict=True)
        ],
    }


def call_metrics(calls):
    elapsed = {(call["pass"], call["group"]): call["elapsedMs"] for call in calls}
    return {
        "firstCallMs": elapsed[1, 1],
        "remainingFirstPassMs": sum(elapsed[1, group] for group in range(2, 13)),
        "firstPassSumMs": sum(elapsed[1, group] for group in range(1, 13)),
        "secondPassSumMs": sum(elapsed[2, group] for group in range(1, 13)),
        "secondPassFirstCallMs": elapsed[2, 1],
    }


def check_protocol(protocol):
    require(protocol["schemaVersion"] == 1, "Unsupported protocol schema")
    require(protocol["metrics"] == list(METRICS), "Prespecified metrics differ")
    require(protocol["passes"] == 2 and protocol["callsPerPass"] == 12 and protocol["callsPerObservation"] == 24, "Prespecified pass/call counts differ")
    require(protocol["analysis"]["bootstrapReplicates"] == RESAMPLES and protocol["analysis"]["bootstrapSeed"] == SEED, "Prespecified bootstrap differs")
    require(protocol["analysis"]["intervalPercentiles"] == [2.5, 97.5], "Prespecified interval differs")
    schedule = protocol["schedule"]
    require(len(schedule) == 36, "Protocol must prescribe all36 observations")
    require(len({item["id"] for item in schedule}) == 36, "Repeated protocol observation ID")
    comparison = 0
    control = 0
    for block in range(6):
        for offset, kind, arms in ((0, "comparison", ("A", "B")), (2, "comparison", ("B", "A")), (4, "control", ("A", "A"))):
            pair = schedule[block * 6 + offset:block * 6 + offset + 2]
            require([item["kind"] for item in pair] == [kind, kind], "Protocol kind order differs")
            require([item["arm"] for item in pair] == list(arms), "Protocol arm order differs")
            require([item["position"] for item in pair] == [0, 1], "Protocol position order differs")
            require(pair[0]["pair"] == pair[1]["pair"], "Adjacent entries do not form a pair")
            if kind == "comparison":
                comparison += 1
                require(pair[0]["pair"] == comparison, "Comparison pair numbering differs")
            else:
                control += 1
                require(pair[0]["pair"] == control, "Control pair numbering differs")
    return schedule


def analyze(protocol_path, source_path, snapshots_path, output, variant):
    result = {
        "schemaVersion": 1,
        "variant": variant,
        "status": "invalid",
        "scope": (
            "Native scan calls on captured JMdict arenas in one pinned Chromium component cohort. "
            "Sums include only the disjoint native call intervals, not restoration, verification, parsing, "
            "compression, persistence, worker transport or UI completion. No full-import or whole-process-memory claim. "
            "The second pass is reported separately and is not assumed to be a proven steady state."
        ),
        "statistics": {
            "negativePercentMeans": "second arm faster; candidate over baseline for comparisons",
            "bootstrapResamples": RESAMPLES,
            "bootstrapSeed": SEED,
            "bootstrapUnit": "complete adjacent pair",
            "interval": "Descriptive percentile interval of resampled paired medians; not a promotion gate",
            "excludedObservations": [],
        },
        "errors": [],
        "observationAudit": [],
        "metrics": None,
    }
    try:
        protocol, protocol_hash = load_json(protocol_path)
        sources, source_hash = load_json(source_path)
        snapshots, snapshot_hash = load_json(snapshots_path)
        result["identities"] = {
            "protocolSha256": protocol_hash,
            "sourceInventorySha256": source_hash,
            "snapshotInventorySha256": snapshot_hash,
            "analyzerSha256": sha256(Path(__file__).read_bytes()),
        }
        schedule = check_protocol(protocol)
        require(variant in protocol["variants"], "Unknown frozen variant")
        require(protocol["snapshotInventorySha256"] == snapshot_hash, "Snapshot inventory differs from protocol")
        require(len(sources["files"]) > 0, "Source inventory is empty")
        seen_sources = set()
        for source in sources["files"]:
            relative = Path(source["path"])
            require(not relative.is_absolute() and ".." not in relative.parts, "Nonlocal source-inventory path")
            require(source["path"] not in seen_sources, "Duplicate source-inventory entry")
            seen_sources.add(source["path"])
            data = (source_path.parent / relative).read_bytes()
            require(len(data) == source["bytes"] and sha256(data) == source["sha256"], f"Changed source: {relative}")
        groups = snapshots["groups"]
        require(snapshots["complete"] is True, "Snapshot acquisition is incomplete")
        require([group["group"] for group in groups] == list(range(1, 13)), "Snapshot groups are incomplete or reordered")
        acquisition, acquisition_hash = load_json(output / "acquisition.json")
        result["identities"]["acquisitionSha256"] = acquisition_hash
        require(acquisition["schemaVersion"] == 1 and acquisition["variant"] == variant, "Controller acquisition binding differs")
        require(acquisition["protocolSha256"] == protocol_hash and acquisition["sourceInventorySha256"] == source_hash and acquisition["snapshotInventorySha256"] == snapshot_hash, "Controller source identities differ")
        require(acquisition["complete"] is True and acquisition["allSucceeded"] is True and acquisition["finalIdentityCheck"] == "passed", "Controller completion or final source recheck failed")
        require([item["id"] for item in acquisition["observations"]] == [item["id"] for item in schedule], "Controller acquisition order differs")
        for item in acquisition["observations"]:
            require(item["status"] == "success" and item["calls"] == 24, "Controller reports an incomplete observation")
            require(item["processOutcome"]["code"] == 0 and item["processOutcome"]["signal"] is None and item["processOutcome"]["timedOut"] is False, "Observation process did not exit cleanly")
        require(protocol["worker"]["crossOriginIsolated"] is True, "Prespecified isolated-worker policy differs")
        by_group = {group["group"]: group for group in groups}
        expected_ids = {entry["id"] for entry in schedule}
        observed_paths = list((output / "observations").glob("*.json"))
        actual_ids = {path.stem for path in observed_paths}
        if actual_ids != expected_ids:
            result["errors"].append(f"Observation file set differs: missing={sorted(expected_ids - actual_ids)}, unexpected={sorted(actual_ids - expected_ids)}")
        observations = []
        browser_identities = set()
        for expected in schedule:
            observation_path = output / "observations" / f"{expected['id']}.json"
            audit = {"id": expected["id"], "status": "invalid"}
            result["observationAudit"].append(audit)
            try:
                observation, digest = load_json(observation_path)
                audit["sha256"] = digest
                require(observation["schemaVersion"] == 1, "Unsupported observation schema")
                require(observation["status"] == "success", "Observation did not complete successfully")
                require(observation["variant"] == variant, "Wrong variant")
                require(observation["observation"] == expected, "Observed schedule entry differs")
                require(observation["protocolSha256"] == protocol_hash, "Protocol identity changed")
                require(observation["sourceInventorySha256"] == source_hash, "Source inventory identity changed")
                require(observation["snapshotInventorySha256"] == snapshot_hash, "Snapshot identity changed")
                module = protocol["baseline"] if expected["arm"] == "A" else protocol["variants"][variant]
                require(observation["module"]["id"] == module["id"], "Wrong module identity")
                require(observation["module"]["sha256"] == module["sha256"], "Wrong module bytes")
                browser = observation["browser"]
                require(browser["version"] == protocol["browser"]["version"], "Wrong browser version")
                require(len(browser["executableSha256"]) == 64 and all(c in "0123456789abcdef" for c in browser["executableSha256"]), "Invalid browser executable hash")
                require(browser["executableSha256"] == protocol["browser"]["executableSha256"], "Browser executable differs from protocol")
                browser_identities.add((browser["version"], browser["executableSha256"]))
                require(observation["worker"]["crossOriginIsolated"] is True, "Worker is not isolated as prescribed")
                calls = observation["calls"]
                require(len(calls) == 24, "Incomplete call count")
                require([(call["pass"], call["group"]) for call in calls] == [(p, g) for p in (1, 2) for g in range(1, 13)], "Calls missing, duplicated or reordered")
                for call in calls:
                    group = by_group[call["group"]]
                    require(call["rowCount"] == group["rowCount"], "Native input row count differs")
                    require(call["uniqueRows"] == group["uniqueRows"], "Native unique count differs")
                    require(call["expectedReturn"] == group["expectedReturn"] and call["returnValue"] == group["expectedReturn"], "Native status differs")
                    require(call["fullMemoryEqual"] is True, "Complete arena comparison failed")
                    require(call["actualAfterSha256"] == group["afterSha256"] and call["expectedAfterSha256"] == group["afterSha256"], "Output arena digest differs")
                    require(is_number(call["elapsedMs"]) and call["elapsedMs"] > 0, "Nonpositive or invalid elapsed interval")
                observations.append((expected, call_metrics(calls)))
                audit["status"] = "valid"
            except (KeyError, ValueError, TypeError, OSError) as error:
                audit["error"] = str(error)
                result["errors"].append(f"{expected['id']}: {error}")
        require(len(browser_identities) == 1, "Browser executable changed within cohort")
        require(len(observations) == 36 and not result["errors"], "Incomplete or invalid cohort; no aggregate qualifies")
        metrics = {}
        for metric in METRICS:
            comparisons = []
            controls = []
            for offset in range(0, len(observations), 2):
                first, second = observations[offset:offset + 2]
                metadata = first[0]
                if metadata["kind"] == "comparison":
                    baseline, candidate = (first, second) if metadata["arm"] == "A" else (second, first)
                    comparisons.append({
                        "pair": metadata["pair"],
                        "order": first[0]["arm"] + second[0]["arm"],
                        "firstId": baseline[0]["id"], "secondId": candidate[0]["id"],
                        "firstMs": baseline[1][metric], "secondMs": candidate[1][metric],
                    })
                else:
                    controls.append({
                        "pair": metadata["pair"], "order": "AA",
                        "firstId": first[0]["id"], "secondId": second[0]["id"],
                        "firstMs": first[1][metric], "secondMs": second[1][metric],
                    })
            require(len(comparisons) == 12 and len(controls) == 6, "Pair counts differ")
            metrics[metric] = {"candidateOverBaseline": summarize(comparisons), "secondControlOverFirst": summarize(controls)}
        result["metrics"] = metrics
        result["browser"] = dict(zip(("version", "executableSha256"), next(iter(browser_identities)), strict=True))
        result["status"] = "valid-component-cohort"
    except (KeyError, ValueError, TypeError, OSError) as error:
        result["errors"].append(str(error))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--protocol", type=Path, required=True)
    parser.add_argument("--source-inventory", type=Path, required=True)
    parser.add_argument("--snapshots", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--variant", required=True)
    args = parser.parse_args()
    require(sys.flags.optimize == 0, "Optimized Python execution is not permitted")
    result = analyze(args.protocol.resolve(), args.source_inventory.resolve(), args.snapshots.resolve(), args.output.resolve(), args.variant)
    args.output.mkdir(parents=True, exist_ok=True)
    report = args.output / "analysis.json"
    require(not report.exists(), "Analysis destination already exists; preserve original analysis")
    report.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"status": result["status"], "errors": result["errors"], "report": str(report)}))
    return 0 if result["status"] == "valid-component-cohort" else 1


if __name__ == "__main__":
    raise SystemExit(main())
