#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Re-extract startup locations from the frozen published trace; no import run."""
from collections import Counter
import hashlib
import json
from pathlib import Path
import zipfile

HERE = Path(__file__).resolve().parent
ARTIFACT_SHA = "4000809bac65e05a2ac9ede1087b8bb88b13148aa84d5ca5a56a2b4aeb7f4468"
TRACE_SHA = "3f2c3f7c560219286840f777bbedf4988411e9c162f39eb177e0d156dbd02bcb"


def analyze(events):
    origin = 74762565
    profile = next(event for event in events if event["name"] == "Profile" and event.get("tid") == 3714)
    chunks = sorted((event for event in events if event["name"] == "ProfileChunk" and
                     (event["pid"], event.get("id")) == (profile["pid"], profile["id"])),
                    key=lambda event: event["ts"])
    nodes, parents = {}, {}
    for event in chunks:
        for node in event["args"]["data"].get("cpuProfile", {}).get("nodes", []):
            nodes[node["id"]] = node
            if "parent" in node:
                parents[node["id"]] = node["parent"]
            for child in node.get("children", []):
                parents[child] = node["id"]
    cursor = profile["args"]["data"]["startTime"]
    points = []
    for event in chunks:
        data = event["args"]["data"]
        samples = data.get("cpuProfile", {}).get("samples", [])
        deltas = data.get("timeDeltas", [])
        assert len(samples) == len(deltas)
        for index, (identity, delta) in enumerate(zip(samples, deltas)):
            cursor += delta
            frame = nodes[identity].get("callFrame", {})
            ancestors, seen = set(), set()
            current = identity
            while current in nodes and current not in seen:
                seen.add(current)
                ancestors.add(nodes[current].get("callFrame", {}).get("functionName", ""))
                current = parents.get(current)
            points.append({"ms": (cursor - origin) / 1000, "deltaUs": delta,
                           "line": data.get("lines", [None] * len(samples))[index],
                           "name": frame.get("functionName", ""),
                           "url": frame.get("url", "").rsplit("/", 1)[-1],
                           "ancestors": ancestors})
    assert len(points) == 4795
    assert sum(point["deltaUs"] < 0 for point in points) == 131
    assert sum(point["deltaUs"] for point in points if point["deltaUs"] < 0) == -34595
    windows = []
    for name, start, end in [
        ("worker startup", -155.613, -55.956),
        ("source activation", -55.956, -49.307),
        ("archive wait", -49.307, -21.302),
        ("source copy continuations", -21.302, 0),
        ("parser dispatches", 0, 3.989),
    ]:
        selected = [point for point in points if start <= point["ms"] < end]
        own = Counter((point["name"], point["url"], point["line"]) for point in selected)
        ancestors = Counter(name for point in selected for name in point["ancestors"])
        windows.append({"name": name, "startMs": start, "endMs": end,
                        "pointCount": len(selected),
                        "negativeDeltaPoints": sum(point["deltaUs"] < 0 for point in selected),
                        "self": [{"name": key[0], "url": key[1], "line": key[2], "points": value}
                                 for key, value in sorted(own.items(), key=lambda item: (-item[1], item[0][0], item[0][1], str(item[0][2])))],
                        "ancestors": dict(sorted(ancestors.items()))})
    copies = [point for point in points if -21.302 <= point["ms"] < 0 and
              point["url"] == "term-bank-source-pipeline.js" and point["line"] == 176]
    return {
        "kind": "Fresh extraction of already-published diagnostic trace; no new acquisition",
        "baseline": "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2",
        "artifactSha256": ARTIFACT_SHA, "traceSha256": TRACE_SHA,
        "profileId": profile["id"], "originTs": origin,
        "profilePoints": 4795, "negativeDeltaPoints": 131, "negativeDeltaTotalUs": -34595,
        "noTimingClaim": True,
        "limitations": "Windows are source-inferred; no archive-I/O or copy phase marks exist. Negative sample increments and instrumentation prevent treating point windows as ordinary wall or CPU durations.",
        "windows": windows,
        "copyLine176": {"points": len(copies),
                        "firstPointMs": min(point["ms"] for point in copies),
                        "lastPointMs": max(point["ms"] for point in copies)},
    }


def main():
    if not __debug__:
        raise RuntimeError("Do not disable diagnostic audit assertions")
    artifact = (HERE.parent / "original-jmdict-artifact.zip").read_bytes()
    assert hashlib.sha256(artifact).hexdigest() == ARTIFACT_SHA
    with zipfile.ZipFile(__import__("io").BytesIO(artifact)) as archive:
        raw = archive.read("trace/run-1.trace.json")
    assert hashlib.sha256(raw).hexdigest() == TRACE_SHA
    report = analyze(json.loads(raw)["traceEvents"])
    output = HERE / "current-startup-trace.json"
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
