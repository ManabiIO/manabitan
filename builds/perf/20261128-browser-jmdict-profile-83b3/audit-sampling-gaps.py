#!/usr/bin/env python3
"""Retrospective endpoint audit of the exact published Node profiles; no acquisition."""

import argparse
import hashlib
import json
from pathlib import Path


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    manifest_bytes = (args.archive_root / "MANIFEST.json.txt").read_bytes()
    assert sha(manifest_bytes) == "b2a440fd3e265f16f0a508cc072a569fcc5da55ad6f0ddacee6f78d157133e48"
    manifest = json.loads(manifest_bytes)
    inputs = [row for row in manifest["files"] if row["path"].endswith(".cpuprofile")]
    assert len(inputs) == 13
    rows = []
    for entry in inputs:
        raw = (args.archive_root / entry["path"]).read_bytes()
        assert len(raw) == entry["bytes"] and sha(raw) == entry["sha256"]
        profile = json.loads(raw)
        samples, deltas = profile["samples"], profile["timeDeltas"]
        assert len(samples) == len(deltas) and len(samples) > 1
        assert all(isinstance(value, int) and value >= 0 for value in deltas)
        nodes = {node["id"]: node for node in profile["nodes"]}
        assert all(sample in nodes for sample in samples)
        first = nodes[samples[0]]["callFrame"]
        assert first["functionName"] == "post" and "inspector" in first["url"]
        post_indices = [index for index, sample in enumerate(samples)
                        if nodes[sample]["callFrame"]["functionName"] == "post"
                        and "inspector" in nodes[sample]["callFrame"]["url"]]
        terminal = profile["endTime"] - profile["startTime"] - sum(deltas)
        assert terminal >= 0
        row = {"path": entry["path"], "sha256": entry["sha256"], "bytes": len(raw),
               "sampleCount": len(samples), "firstSampleFrame": first,
               "initialUnassignedGapUs": deltas[0], "observedSampleSpanUs": sum(deltas[1:]),
               "terminalUnassignedGapUs": terminal,
               "startToEndUs": profile["endTime"] - profile["startTime"],
               "inspectorPostSampleIndices": post_indices,
               "oldPrecedingDeltaInspectorPostWeightUs": sum(deltas[index] for index in post_indices)}
        assert row["startToEndUs"] == row["initialUnassignedGapUs"] + row["observedSampleSpanUs"] + row["terminalUnassignedGapUs"]
        rows.append(row)
    groups = {}
    keys = ["initialUnassignedGapUs", "observedSampleSpanUs", "terminalUnassignedGapUs", "startToEndUs", "oldPrecedingDeltaInspectorPostWeightUs"]
    for name, predicate in [("initialization", lambda row: "initialization" in row["path"]),
                            ("workerGroups", lambda row: "group-" in row["path"])]:
        selected = [row for row in rows if predicate(row)]
        groups[name] = {"profiles": len(selected), **{key: sum(row[key] for row in selected) for key in keys}}
    assert groups["workerGroups"]["profiles"] == 12
    assert groups["workerGroups"]["initialUnassignedGapUs"] == 184826
    assert groups["workerGroups"]["observedSampleSpanUs"] == 901080
    assert groups["workerGroups"]["terminalUnassignedGapUs"] == 2943
    assert groups["initialization"]["profiles"] == 1
    assert groups["initialization"]["initialUnassignedGapUs"] == 31921
    assert groups["initialization"]["terminalUnassignedGapUs"] == 282
    result = {"schemaVersion": 1, "complete": True, "acquisitionPerformed": False,
              "sourceManifestSha256": sha(manifest_bytes), "auditScriptSha256": sha(Path(__file__).read_bytes()),
              "protocol": "https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/js_protocol.json",
              "interpretation": "The first timeDelta spans startTime to the first sample, whose observed stack is inspector/post. Keep it as an unassigned initial sampling gap; do not label it measured startup CPU, stop cost, or product CPU from this sample. Keep the terminal gap unassigned. Existing preceding-delta tables are unchanged descriptive sampled-stack weights, not measured CPU time.",
              "profiles": rows, "groups": groups}
    assert not args.output.exists()
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"complete": True, "groups": groups, "outputSha256": sha(args.output.read_bytes())}))


if __name__ == "__main__":
    main()
