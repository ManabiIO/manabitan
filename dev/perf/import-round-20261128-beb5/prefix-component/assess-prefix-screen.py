#!/usr/bin/env python3
"""Read frozen prefix-screen receipts without changing their observations."""

import argparse
import json
from pathlib import Path
import statistics


parser = argparse.ArgumentParser()
parser.add_argument("reports", nargs="+", type=Path)
parser.add_argument("--out", type=Path)
args = parser.parse_args()
results = []
for path in args.reports:
    data = json.loads(path.read_text())
    assert data["complete"], f"Incomplete report: {path}"
    identities = data["sources"]
    assert identities["baseline"]["hashes"] == identities["control"]["hashes"]
    assert identities["baseline"]["hashes"]["ext/lib/term-bank-parser.wasm"] == "8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee"
    assert identities["candidate"]["hashes"]["ext/lib/term-bank-parser.wasm"] == "9972fb2df890f77fe43b3401b464c0ff1c36c4b89784b47268e3888bd7979d23"
    for dictionary in data["dictionaries"]:
        pairs = data["pairs"]
        totals = {kind: [{"baseline": 0.0, "alternate": 0.0} for _ in range(pairs)] for kind in ("treatment", "control")}
        diagnostics = {arm: {"rows": 0, "glossaryWitnesses": 0, "contentWitnesses": 0,
            "fusedFallbacks": 0, "crcReusedBytes": 0, "maxHeapBytes": 0, "floatScoreGroups": 0}
            for arm in ("baseline", "candidate", "control")}
        for group in dictionary["groups"]:
            reference = group["verification"]["baseline"]
            for arm, value in group["verification"].items():
                assert value["digest"] == reference["digest"]
                profile = value["profile"]
                out = diagnostics[arm]
                out["rows"] += value["rows"]
                out["glossaryWitnesses"] += profile.get("validatedGlossaryReuseCount", 0)
                out["contentWitnesses"] += profile.get("recentContentDedupHitCount", 0)
                out["fusedFallbacks"] += profile.get("fusedParseFallbacks", 0)
                out["crcReusedBytes"] += profile.get("sourceCrcReusedBytes", 0)
                out["maxHeapBytes"] = max(out["maxHeapBytes"], profile.get("maxWasmHeapBytes", 0))
                out["floatScoreGroups"] += value["scoreType"] == "Float64Array"
            seen = set()
            for observation in group["observations"]:
                kind = observation["comparison"]
                pair = observation["pair"]
                assert (kind, pair) not in seen
                seen.add((kind, pair))
                alternate = "candidate" if kind == "treatment" else "control"
                assert set(observation["arms"]) == {"baseline", alternate}
                assert observation["order"] == (["baseline", alternate] if pair % 2 == 0 else [alternate, "baseline"])
                for arm, value in observation["arms"].items():
                    assert value["digest"] == reference["digest"]
                    assert value["rows"] == reference["rows"]
                    assert value["scoreType"] == reference["scoreType"]
                    assert value["sequenceType"] == reference["sequenceType"]
                    totals[kind][pair]["baseline" if arm == "baseline" else "alternate"] += value["totalMs"]
            assert seen == {(kind, pair) for kind in ("treatment", "control") for pair in range(pairs)}
        comparisons = {}
        for kind, observations in totals.items():
            ratios = [(pair["alternate"] / pair["baseline"] - 1) * 100 for pair in observations]
            comparisons[kind] = {
                "baselineMedianMs": statistics.median(pair["baseline"] for pair in observations),
                "alternateMedianMs": statistics.median(pair["alternate"] for pair in observations),
                "pairedPercentChanges": ratios,
                "medianPairedPercentChange": statistics.median(ratios),
                "equalWorkPercentChange": (sum(pair["alternate"] for pair in observations) / sum(pair["baseline"] for pair in observations) - 1) * 100,
                "alternateFasterPairs": sum(ratio < 0 for ratio in ratios),
                "pairTotals": observations,
            }
        results.append({"report": str(path), "dictionary": dictionary["dictionary"],
            "synthetic": data.get("synthetic", False), "experiments": data.get("experiments", {}),
            "groups": len(dictionary["groups"]), "rows": dictionary["rows"],
            "comparisons": comparisons, "diagnostics": diagnostics})
report = {"complete": True, "scope": "Descriptive full-work sums by pair index across sequential production-shaped groups. Each group is repeatedly replayed before the next group. These are component observations, not complete import runs or independent browser hosts. No pair is discarded.", "results": results}
encoded = json.dumps(report, indent=2) + "\n"
if args.out:
    args.out.write_text(encoded)
print(encoded)
