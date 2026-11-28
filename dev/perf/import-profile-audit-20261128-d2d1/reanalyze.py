import argparse, gzip, hashlib, json, pathlib
from collections import Counter, defaultdict
arguments = argparse.ArgumentParser()
arguments.add_argument('--trace', required=True)
arguments.add_argument('--output', required=True)
args = arguments.parse_args()
trace_path = pathlib.Path(args.trace)
trace_bytes = trace_path.read_bytes()
if trace_path.suffix == '.gz':
    trace_bytes = gzip.decompress(trace_bytes)
assert hashlib.sha256(trace_bytes).hexdigest() == 'ecf3a46f476bfe5f8a94f863b5b37d9f8886762f229364bbe6f65ccdd013826b'
trace = json.loads(trace_bytes)
events = trace if isinstance(trace, list) else trace["traceEvents"]
groups = defaultdict(lambda: {"nodes": {}, "samples": [], "deltas": [], "profileEvents": [], "collectorTids": set(), "sampledThreadId": None})
event_counts = Counter()
for event in events:
    event_counts[event.get("name")] += 1
    if event.get("name") not in ("Profile", "ProfileChunk"):
        continue
    data = event.get("args", {}).get("data", {})
    key = (event.get("pid"), str(event.get("id", event.get("id2", ""))))
    group = groups[key]
    group["collectorTids"].add(event.get("tid"))
    if event.get("name") == "Profile":
        assert group["sampledThreadId"] is None, key
        group["sampledThreadId"] = event.get("tid")
        group["profileEvents"].append(data)
    profile = data.get("cpuProfile", {})
    for node in profile.get("nodes", []):
        old = group["nodes"].get(node["id"])
        if old is None:
            group["nodes"][node["id"]] = node
        else:
            children = list(dict.fromkeys(old.get("children", []) + node.get("children", [])))
            old.update(node)
            if children:
                old["children"] = children
    group["samples"].extend(profile.get("samples", []))
    group["deltas"].extend(data.get("timeDeltas", profile.get("timeDeltas", [])))
summaries = []
for key, group in groups.items():
    samples, deltas, nodes = group["samples"], group["deltas"], group["nodes"]
    if not samples:
        continue
    assert len(samples) == len(deltas), (key, len(samples), len(deltas))
    self_us = Counter()
    raw_signed_us = Counter()
    hits = Counter(samples)
    inclusive_us = Counter()
    timestamps = []
    timestamp = 0
    for delta in deltas:
        timestamp += delta
        timestamps.append(timestamp)
    order = sorted(range(len(samples)), key=lambda index: (timestamps[index], index))
    intervals = [(samples[left], timestamps[right] - timestamps[left]) for left, right in zip(order, order[1:])]
    intervals.append((samples[order[-1]], 0))
    for node_id, delta in zip(samples, deltas):
        raw_signed_us[node_id] += delta
    parents = {}
    for node_id, node in nodes.items():
        for child in node.get("children", []):
            assert child not in parents or parents[child] == node_id, (key, child)
            parents[child] = node_id
        if "parent" in node:
            assert node_id not in parents or parents[node_id] == node["parent"], (key, node_id)
            parents[node_id] = node["parent"]
    for node_id, delta in intervals:
        assert node_id in nodes, (key, node_id)
        assert delta >= 0, (key, node_id, delta)
        self_us[node_id] += delta
        seen = set()
        cursor = node_id
        while cursor is not None:
            assert cursor not in seen, (key, cursor)
            seen.add(cursor)
            inclusive_us[cursor] += delta
            cursor = parents.get(cursor)
    rows = []
    for node_id in nodes:
        frame = nodes[node_id].get("callFrame", {})
        parent = nodes.get(parents.get(node_id), {}).get("callFrame", {})
        rows.append({"nodeId": node_id, "function": frame.get("functionName"), "url": frame.get("url"),
                     "lineNumber": frame.get("lineNumber"), "selfMs": self_us[node_id] / 1000,
                     "inclusiveMs": inclusive_us[node_id] / 1000, "rawSignedDeltaMs": raw_signed_us[node_id] / 1000, "sampleCount": hits[node_id], "parentFunction": parent.get("functionName"),
                     "parentUrl": parent.get("url")})
    rows.sort(key=lambda row: row["selfMs"], reverse=True)
    summaries.append({"pid": key[0], "tid": group["sampledThreadId"], "profileId": key[1], "collectorTids": sorted(group["collectorTids"]),
                      "samples": len(samples), "sampledMs": sum(delta for _, delta in intervals) / 1000,
                      "negativeDeltaCount": sum(delta < 0 for delta in deltas), "negativeDeltaSumUs": sum(delta for delta in deltas if delta < 0),
                      "reorderedSampleCount": sum(before != after for before, after in enumerate(order)),
                      "profileEvents": group["profileEvents"], "functions": rows})
output = {"kind": "existing-profile-attribution-audit", "authoritativeTiming": False,
          "source": "1f1f9ff00b8a33df338d3640e6e14498465fe631", "runId": 46100048089,
          "artifactId": 15244699610, "artifactSha256": "a5b5205577d59e80533f1e2b313c561b091c5194c7dc9afc4ed9efa110cc9148", "tracePath": "trace/run-1.trace.json",
          "traceSha256": hashlib.sha256(trace_bytes).hexdigest(), "eventCount": len(events),
          "eventNames": event_counts, "profiles": summaries,
          "method": "Join Profile/ProfileChunk by process and profile ID; use Profile thread ID as the sampled thread and retain all collector thread IDs. Accumulate raw per-profile deltas to sample timestamps, stable-sort timestamp/sample pairs, assign each observed interval to its preceding sample. Last sample gets zero because no following observation is available. Keep all negative original deltas in rawSignedDeltaMs and all sample counts. No missing-program reassignment or inferred trailing interval.",
          "limits": "Reanalysis of one existing profiled baseline import. Interval attribution estimates sampled stacks, not exact CPU execution. Samples overlap across threads and are not additive wall time or a controlled speed comparison."}
output_path = pathlib.Path(args.output)
output_path.parent.mkdir(parents=True, exist_ok=True)
output_path.write_text(json.dumps(output, indent=2) + "\n")
print("PROFILE_AUDIT_METADATA " + json.dumps({key: value for key, value in output.items() if key not in ("profiles", "eventNames")}, sort_keys=True))
for summary in summaries:
    compact = dict(summary)
    compact["functions"] = [row for row in summary["functions"] if row["selfMs"] > 1 and not (row["function"] or "").startswith("(")][:16]
    print("PROFILE_AUDIT_FUNCTIONS " + json.dumps(compact, sort_keys=True))
assert summaries, "Trace contained no CPU samples"
