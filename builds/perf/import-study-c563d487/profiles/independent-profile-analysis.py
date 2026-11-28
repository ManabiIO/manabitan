#!/usr/bin/env python3
"""Read the frozen three-trace cohort; never execute the importer or a benchmark.

The output describes sampling weights, not exact CPU time or speedup. Raw streams
remain in the SHA-bound input traces. Negative deltas are retained, then paired
samples are sorted for the separately reported interval analysis.
"""
import argparse
import hashlib
import json
import re
import statistics
import subprocess
from collections import Counter, defaultdict
from pathlib import Path

COMMIT = "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2"
PACKAGE = "ff1704be8eef0f2546a2fa5e0e0ea438d93a9d4c2222d020c2f94d9dee6ab7b9"
PARSER = "wasm://wasm/0004212e"
CANONICAL = "wasm://wasm/34e657a2"
CHROMIUM_REFERENCE = "https://chromium.googlesource.com/devtools/devtools-frontend/+/9a696c4e723caa3c7e1f78886da353f1f06a79b0/front_end/core/sdk/CPUProfileDataModel.ts"
PARSER_SOURCE = "ext/js/dictionary/wasm/term-bank-parser.c"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def load(path):
    return json.loads(path.read_text())


def receipt(path):
    return {"path": str(path), "bytes": path.stat().st_size, "sha256": digest(path.read_bytes())}


def norm(url):
    return re.sub(r"^chrome-extension://[^/]+/", "", url or "")


def ms(value):
    return round(value / 1000, 3)


def overlap(a, b, start, end):
    return max(0, min(b, end) - max(a, start))


def signed_overlap(a, b, start, end):
    return overlap(a, b, start, end) if b >= a else -overlap(b, a, start, end)


def read_uleb(data, pos):
    value = shift = 0
    while True:
        byte = data[pos]
        pos += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, pos
        shift += 7


def read_string(data, pos):
    size, pos = read_uleb(data, pos)
    return data[pos:pos + size].decode(), pos + size


def wasm_info(path):
    data = path.read_bytes()
    assert data[:8] == b"\x00asm\x01\x00\x00\x00"
    stripped, names, exports, pos = bytearray(data[:8]), {}, {}, 8
    while pos < len(data):
        begin, section = pos, data[pos]
        size, pos = read_uleb(data, pos + 1)
        finish = pos + size
        if section != 0:
            stripped.extend(data[begin:finish])
        elif read_string(data, pos)[0] == "name":
            _, cursor = read_string(data, pos)
            while cursor < finish:
                kind = data[cursor]
                count_bytes, cursor = read_uleb(data, cursor + 1)
                subsection_end = cursor + count_bytes
                if kind == 1:
                    count, cursor = read_uleb(data, cursor)
                    for _ in range(count):
                        index, cursor = read_uleb(data, cursor)
                        names[str(index)], cursor = read_string(data, cursor)
                cursor = subsection_end
        if section == 7:
            count, cursor = read_uleb(data, pos)
            for _ in range(count):
                name, cursor = read_string(data, cursor)
                kind = data[cursor]
                index, cursor = read_uleb(data, cursor + 1)
                if kind == 0:
                    exports[str(index)] = name
        pos = finish
    assert pos == len(data)
    return bytes(stripped), names, exports


def role_for(profile, worker_urls):
    url = worker_urls.get((profile["pid"], profile["tid"]), "")
    for suffix, role in [("term-bank-wasm-parser-worker.js", "parser"), ("zstd-term-content-compression-worker.js", "compression"), ("offscreen-dictionary-worker.js", "offscreen"), ("sw.js", "backend")]:
        if url.endswith(suffix):
            return role
    if any("sqlite3-opfs-async-proxy.js" in n["callFrame"].get("url", "") for n in profile["nodes"].values()):
        return "sqliteProxy"
    return "page" if profile["tid"] == profile["pid"] else "other"


def frame_key(frame, role, names, canonical_exports):
    url, function = norm(frame.get("url")), frame.get("functionName", "") or "(anonymous)"
    index = re.fullmatch(r"wasm-function\[(\d+)\]", function)
    if url == PARSER and index:
        function = names[index.group(1)]
    elif url == CANONICAL and index:
        function = canonical_exports.get(index.group(1), function)
    code = frame.get("codeType", "unknown")
    category = ("idle" if function == "(idle)" else "program" if function == "(program)" else
                "gc" if function == "(garbage collector)" else "sqliteProxy" if role == "sqliteProxy" else
                "parserWasm" if url == PARSER else "canonicalWasm" if url == CANONICAL else
                "compressionWasm" if code == "wasm" and url.endswith("zstd.wasm") else
                "otherWasm" if code == "wasm" else "applicationJs" if url.startswith("js/") else
                "vendorJs" if url.startswith("lib/") else "builtinOrUnresolved")
    return (role, category, function, url, frame.get("lineNumber", -1) + 1, frame.get("columnNumber", -1) + 1)


def frame_json(key):
    return dict(zip(["role", "category", "function", "url", "lineOneBased", "columnOneBased"], key))


def union_summary(intervals):
    edges = sorted([(a, 1) for a, b in intervals] + [(b, -1) for a, b in intervals])
    active = peak = total = 0
    previous = edges[0][0] if edges else 0
    for point, delta in edges:
        if active:
            total += point - previous
        active += delta
        peak = max(peak, active)
        previous = point
    return {"unionMs": ms(total), "summedMs": ms(sum(b - a for a, b in intervals)), "maximumConcurrentIntervals": peak}


def analyze_observation(directory, names, canonical_exports):
    filenames = ["run-1.json", "run-1.trace.json", "diagnostic-counters.json", "identity-before.json", "identity-after.json", "package-entries.json"]
    inputs = [receipt(directory / name) for name in filenames]
    report, trace = load(directory / filenames[0]), load(directory / filenames[1])
    before, after, entries = (load(directory / name) for name in filenames[3:])
    assert before["gitSha"] == after["gitSha"] == COMMIT and before["gitStatus"] == after["gitStatus"] == ""
    assert before["sha256"] == after["sha256"] and report["packageSha256"] == after["packageSha256"] == PACKAGE
    data, events = report["phases"][-1]["data"], trace["traceEvents"]
    timing = data["browserTiming"]
    assert timing["trigger"] == "file-input-change" and timing["errorCount"] == 0
    changes = [e for e in events if e.get("name") == "EventDispatch" and e.get("args", {}).get("data", {}).get("type") == "change"]
    assert len(changes) == 1
    start = changes[0]["ts"]
    end = start + (timing["completedAtMs"] - timing["startedAtMs"]) * 1000
    trace_end = max(e.get("ts", 0) + e.get("dur", 0) for e in events)
    worker_urls, grouped = {}, {}
    for order, event in enumerate(events):
        event_data = event.get("args", {}).get("data", {})
        if event.get("name") == "TracingSessionIdForWorker":
            worker_urls[event["pid"], event_data["workerThreadId"]] = norm(event_data["url"])
        if event.get("name") not in ("Profile", "ProfileChunk"):
            continue
        key = (event["pid"], event["id"])
        p = grouped.setdefault(key, {"pid": key[0], "id": key[1], "chunks": [], "nodes": {}})
        if event["name"] == "Profile":
            assert "start" not in p
            p.update(start=event_data["startTime"], tid=event["tid"], traceStart=event["ts"])
        else:
            p["chunks"].append((event["ts"], order, event))
    aggregate, profiles, intervals, category_intervals = defaultdict(Counter), [], defaultdict(list), defaultdict(list)
    for p in grouped.values():
        samples, deltas, chunk_tids, explicit_end = [], [], set(), None
        for _, _, event in sorted(p["chunks"]):
            chunk_tids.add(event["tid"])
            d = event["args"]["data"]
            explicit_end = d.get("endTime", explicit_end)
            cp = d.get("cpuProfile", {})
            assert len(cp.get("samples", [])) == len(d.get("timeDeltas", []))
            for node in cp.get("nodes", []):
                assert node["id"] not in p["nodes"] or p["nodes"][node["id"]] == node
                p["nodes"][node["id"]] = node
            samples.extend(cp.get("samples", []))
            deltas.extend(d.get("timeDeltas", []))
        assert len(samples) == len(deltas) and samples
        assert all(s in p["nodes"] for s in samples)
        assert all(n.get("parent", 1) in p["nodes"] for n in p["nodes"].values())
        role = role_for(p, worker_urls)
        keys = {node_id: frame_key(n["callFrame"], role, names, canonical_exports) for node_id, n in p["nodes"].items()}
        rows, stamp = [], p["start"]
        for index, (sample, delta) in enumerate(zip(samples, deltas)):
            prior, stamp = stamp, stamp + delta
            rows.append((stamp, index, sample))
            m = aggregate[keys[sample]]
            m["rawSignedWholeTraceUs"] += delta
            m["rawSignedImportUsIncludingFirst"] += signed_overlap(prior, stamp, start, end)
            if index > 0 and start <= stamp < end:
                m["samplePointsInWindowAfterFirst"] += 1
        ordered = sorted(rows)
        assert ordered[0][1] == 0  # Validated property of this frozen cohort.
        per_category, weighted_total, long_count = Counter(), 0, 0
        for previous, current in zip(ordered, ordered[1:]):
            a, b = max(previous[0], start), min(current[0], end)
            if b <= a:
                continue
            key, weight = keys[current[2]], b - a
            m = aggregate[key]
            m["sortedTrailingSampleUs"] += weight
            m["intervalCount"] += 1
            m["maxIntervalUs"] = max(m["maxIntervalUs"], weight)
            m["cappedAt1msSensitivityUs"] += min(weight, 1000)
            aggregate[keys[previous[2]]]["sortedLeadingSampleSensitivityUs"] += weight
            if weight > 1000:
                m["intervalsOver1ms"] += 1
                m["weightFromIntervalsOver1msUs"] += weight
                long_count += 1
            per_category[key[1]] += weight
            weighted_total += weight
            category_intervals[key[1]].append((a, b))
            if key[1] not in ("idle", "program", "sqliteProxy"):
                intervals[role].append((a, b))
        first_end, _, first_sample = rows[0]
        first_overlap = overlap(p["start"], first_end, start, end)
        expected_coverage = overlap(p["start"], ordered[-1][0], start, end)
        assert abs(weighted_total + first_overlap - expected_coverage) < 0.001
        calls = [e for e in events if e.get("name") == "FunctionCall" and e.get("pid") == p["pid"] and e.get("tid") == p["tid"] and overlap(e["ts"], e["ts"] + e.get("dur", 0), p["start"], first_end)]
        call = max(calls, key=lambda e: overlap(e["ts"], e["ts"] + e.get("dur", 0), p["start"], first_end), default=None)
        profiles.append({"pid": p["pid"], "id": p["id"], "ownerTid": p["tid"], "role": role, "chunkTids": sorted(chunk_tids),
            "samples": len(samples), "nodes": len(p["nodes"]), "chunks": len(p["chunks"]),
            "negativeDeltaCount": sum(d < 0 for d in deltas), "negativeDeltaSumUs": sum(d for d in deltas if d < 0),
            "minimumRawDeltaUs": min(deltas), "reorderedPositions": sum(index != row[1] for index, row in enumerate(ordered)),
            "equalTimestampPairs": sum(a[0] == b[0] for a, b in zip(ordered, ordered[1:])),
            "rawSampleDeltaTimestampTriplesSha256": digest(json.dumps([[s, d, r[0]] for s, d, r in zip(samples, deltas, rows)], separators=(",", ":")).encode()),
            "sortedOriginalIndicesSha256": digest(json.dumps([r[1] for r in ordered], separators=(",", ":")).encode()),
            "rawDeltaSumUs": sum(deltas), "startTraceOffsetUs": p["traceStart"] - p["start"], "explicitProfileEndUs": explicit_end,
            "startAfterInputMs": ms(p["start"] - start), "lastSampleAfterInputMs": ms(ordered[-1][0] - start),
            "uncoveredBrowserTailMs": ms(max(0, end - ordered[-1][0])), "observedImportCoverageMs": ms(expected_coverage),
            "nonFirstSortedWeightMs": ms(weighted_total), "intervalsOver1ms": long_count,
            "categoriesMs": {k: ms(v) for k, v in sorted(per_category.items())},
            "firstInterval": {"rawDeltaUs": deltas[0], "startUs": p["start"], "endUs": first_end,
                "importOverlapMs": ms(first_overlap), "frame": frame_json(keys[first_sample]),
                "overlappingFunctionCall": None if call is None else {"tsUs": call["ts"], "durationMs": ms(call.get("dur", 0)), "threadDurationMs": ms(call.get("tdur", 0)), "data": call["args"].get("data", {})}}})
    phase = data["importDebug"]
    fast_paths = [p for p in phase["importerPhaseTimings"] if p["phase"].startswith("term-file-fast-path:")]
    assert len(fast_paths) == 1 and fast_paths[0]["details"]["rows"] == 528299
    diagnostic = load(directory / "diagnostic-counters.json")
    bulk = [p for p in phase["importerPhaseTimings"] if p["phase"] == "bulk-finalization"]
    assert diagnostic["disjointTermFileFastPaths"] == fast_paths
    assert diagnostic["bulkFinalization"] == bulk and diagnostic["pagePhases"] == phase["localPhaseTimings"]
    selected = ["rows", "batchedFileCount", "chunkCount", "parserParallelWorkerCount", "parserParallelGroupCount", "parserParallelWorkerWallMs", "parserParseBankMs", "parserSourceInflateMs", "parserResultCopyMs", "parserResultDeliveryMs", "parserOrderedSinkWaitMs", "parserChunkDispatchMs", "dedupCanonicalScanMs", "dedupExactCompareMs", "contentCompressMs", "contentMetadataMs", "contentMetadataIndexPublishMs", "dedupRecentSourceCacheMs", "termRecordFieldEncodeMs", "termRecordValidationMs", "termRecordWriteMs", "parserValidatedGlossaryReuseCount", "parserRecentContentDedupHitCount", "parserCopyJsonMs"]
    result = {"observation": directory.name, "inputs": inputs, "browserVersion": report["browserVersion"],
        "identityChecks": "clean commit; before/after source maps equal; report/after package hash equal",
        "clock": {"domain": trace["metadata"].get("clock-domain"), "inputChangeTsUs": start, "inputDispatchDurationMs": ms(changes[0]["dur"]), "derivedBrowserEndUs": round(end, 3), "traceLastEventUs": trace_end, "uncoveredBrowserTailMs": ms(max(0, end - trace_end)), "browserImportMs": ms(end - start)},
        "profiles": profiles, "diagnosticCounterSummaryReconciled": True,
        "observedNonidleRoleIntervalUnions": {k: union_summary(v) for k, v in sorted(intervals.items())},
        "categoryObservedIntervals": {k: {**union_summary(v), "firstAfterInputMs": ms(min(a for a, b in v) - start), "lastAfterInputMs": ms(max(b for a, b in v) - start)} for k, v in sorted(category_intervals.items())},
        "phaseReport": {"local": phase["localPhaseTimings"], "importer": [{k: v for k, v in p.items() if k != "details"} for p in phase["importerPhaseTimings"]],
            "fastPath": {k: fast_paths[0]["details"].get(k) for k in selected}, "bulkFinalization": bulk[0]}}
    return result, aggregate, entries


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-dir", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--repo", type=Path)
    parser.add_argument("--named-wasm", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    root = args.evidence_dir.resolve()
    repo = args.repo or root.parents[1] / "manabitan"
    named = args.named_wasm or root.parent / "baseline-jmdict-profile/term-bank-parser-names.wasm"
    output = args.output or root / "independent-profile-analysis.json"
    assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip() == COMMIT
    assert subprocess.check_output(["git", "status", "--porcelain"], cwd=repo, text=True).strip() == ""
    wasm = repo / "dev/data/dictionary-wasm/term-bank-parser.wasm"
    canonical = repo / "dev/data/dictionary-wasm/term-content-canonical-scan-v1.wasm"
    stripped, _, _ = wasm_info(wasm)
    named_stripped, names, _ = wasm_info(named)
    _, _, canonical_exports = wasm_info(canonical)
    assert stripped == named_stripped and names and canonical_exports["4"] == "scan_canonical"
    existing_names = load(root.parent / "baseline-jmdict-profile/hotspots.json")["names"]
    assert names == existing_names
    observations, aggregates, packages = [], [], []
    for number in range(1, 4):
        result, aggregate, entries = analyze_observation(root / f"hosted/observation-{number}", names, canonical_exports)
        observations.append(result)
        aggregates.append(aggregate)
        packages.append(entries)
    assert all(p == packages[0] for p in packages)
    assert packages[0]["lib/term-bank-parser.wasm"]["sha256"] == digest(wasm.read_bytes())
    assert packages[0]["lib/term-content-canonical-scan-v1.wasm"]["sha256"] == digest(canonical.read_bytes())
    download = load(root / "download-receipt.json")
    assert digest((root / "hosted.zip").read_bytes()) == download["sha256"]
    keys = sorted(set().union(*(set(a) for a in aggregates)))
    metrics = ["sortedTrailingSampleUs", "samplePointsInWindowAfterFirst", "intervalCount", "maxIntervalUs", "intervalsOver1ms", "weightFromIntervalsOver1msUs", "cappedAt1msSensitivityUs", "sortedLeadingSampleSensitivityUs", "rawSignedImportUsIncludingFirst", "rawSignedWholeTraceUs"]
    table = []
    for key in keys:
        row = frame_json(key)
        for metric in metrics:
            values = [a.get(key, {}).get(metric, 0) for a in aggregates]
            row[metric[:-2] + "Ms" if metric.endswith("Us") else metric] = [ms(v) for v in values] if metric.endswith("Us") else values
        table.append(row)
    table.sort(key=lambda r: -statistics.median(r["sortedTrailingSampleMs"]))
    categories = sorted({key[1] for key in keys})
    totals = {category: {metric[:-2] + "Ms" if metric.endswith("Us") else metric: [ms(sum(m.get(metric, 0) for k, m in a.items() if k[1] == category)) if metric.endswith("Us") else sum(m.get(metric, 0) for k, m in a.items() if k[1] == category) for a in aggregates] for metric in metrics if metric != "maxIntervalUs"} for category in categories}
    sources = {}
    for row in table:
        rel = "ext/" + row["url"]
        if row["url"].startswith(("js/", "lib/")) and (repo / rel).is_file():
            sources.setdefault(rel, receipt(repo / rel))
            entry = packages[0].get(row["url"])
            sources[rel]["matchesPackagedEntry"] = entry is not None and entry["sha256"] == sources[rel]["sha256"]
    for rel in [PARSER_SOURCE, "ext/js/dictionary/wasm/term-content-canonical-scan-v1.c", "test/e2e/import-timing.js", "test/chromium/extension-two-dictionary-import.e2e.js"]:
        sources.setdefault(rel, receipt(repo / rel))
    source_anchors = {}
    parser_text = (repo / PARSER_SOURCE).read_text()
    for function in names.values():
        match = re.search(r"(?m)^(?:static\s+)?(?:inline\s+)?[a-zA-Z_][^\n;{}=]*\b" + re.escape(function) + r"\s*\(", parser_text)
        if match:
            source_anchors[function] = {"path": PARSER_SOURCE, "declarationLine": parser_text[:match.start()].count("\n") + 1}
    source_anchors["scan_canonical"] = {"path": "ext/js/dictionary/wasm/term-content-canonical-scan-v1.c", "declarationLine": 62, "binding": "WASM export section maps function index 4"}
    critical = []
    for observation in observations:
        phases, interval_sets = observation["phaseReport"], observation["categoryObservedIntervals"]
        worker_ms = next(p["elapsedMs"] for p in phases["local"] if p["phase"] == "worker-import-dictionary")
        critical.append({"observation": observation["observation"], "browserImportMs": observation["clock"]["browserImportMs"],
            "workerImportMs": round(worker_ms, 3), "browserMinusWorkerMs": round(observation["clock"]["browserImportMs"] - worker_ms, 3),
            "parserWorkerWallMs": phases["fastPath"]["parserParallelWorkerWallMs"],
            "parserNativeSummedSamplingWeightMs": interval_sets["parserWasm"]["summedMs"],
            "parserNativeIntervalUnionMs": interval_sets["parserWasm"]["unionMs"],
            "lastParserNativeSampleAfterInputMs": interval_sets["parserWasm"]["lastAfterInputMs"],
            "lastCompressionNativeSampleAfterInputMs": interval_sets["compressionWasm"]["lastAfterInputMs"],
            "compressionLastSampleAfterParserLastSampleMs": round(interval_sets["compressionWasm"]["lastAfterInputMs"] - interval_sets["parserWasm"]["lastAfterInputMs"], 3),
            "bulkFinalizationMs": phases["bulkFinalization"]["elapsedMs"]})
    result = {"schemaVersion": 1, "status": "complete_descriptive_sampling_audit", "sourceCommit": COMMIT, "packageZipSha256": PACKAGE,
        "artifactDownloadReceipt": download, "analysisScript": receipt(Path(__file__).resolve()),
        "method": {"profileKey": ["pid", "id"], "owner": "Profile.tid, never ProfileChunk.tid", "chunkOrder": "trace timestamp then original event index",
            "timestamps": "Profile.args.data.startTime + cumulative signed timeDeltas; retain raw pairs and stable-sort paired samples by timestamp",
            "rawPreservation": "Original traces remain immutable and SHA-bound. Per-profile SHA binds compact JSON [nodeId, rawDeltaUs, cumulativeTimestampUs] triples; raw signed metrics include every delta including first.",
            "scope": "Unique file-input change EventDispatch through browserTiming duration, intersected with observed sample coverage. Capture listener starts within input dispatch, so trace boundary is approximate by at most that dispatch duration.",
            "traceStopsEarly": "Frozen harness stops on worker importDictionary console marker at lines 4142–4156; post-worker/UI tail is outside capture, not assigned fabricated samples.",
            "primaryWeights": "Each interval between sorted sample timestamps is assigned to its ending sample; first start-to-sample interval is reported separately. No tail extrapolation or program-sample repair.",
            "sensitivities": "Also assign the same intervals to their starting sample, and cap each primary interval at 1ms in a separately labeled sensitivity. Original uncapped and raw signed accounting remains present.",
            "counts": "samplePointsInWindowAfterFirst counts recorded points after the raw first sample, independently of duration weighting.",
            "allFunctionTable": "Complete frame accounting is a columns/rows matrix; top ranking lists are navigation only. Rows preserve every observed frame, including pre-import-only frames and zero recurring weights.",
            "limitations": ["Sampling weights are elapsed attribution, not exact CPU time.", "Parallel worker sums overlap; they cannot be added into full-import wall time.", "Blocking SQLite proxy samples are not established CPU consumption.", "First interval coincidence suggests activation attribution but does not quantify profiler overhead.", "Function-level samples can include inlined helpers and do not identify a removable suboperation."],
            "chromiumReference": {"url": CHROMIUM_REFERENCE, "revision": "9a696c4e723caa3c7e1f78886da353f1f06a79b0", "blob": "5690197ff0e32ed8d611e4277e1cfbdcee40aa78", "use": "Fixed methodological reference for cumulative timestamps and sorting paired samples; not asserted to be the exact Chrome 153 revision; this script does not copy all DevTools normalization behavior."}},
        "symbolBinding": {"parser": receipt(wasm), "namedParser": receipt(named), "noncustomSectionsEqual": True, "noncustomSectionsSha256": digest(stripped), "parserTraceUrl": PARSER, "parserNames": names, "canonical": receipt(canonical), "canonicalTraceUrl": CANONICAL, "canonicalExportNames": canonical_exports},
        "observations": observations, "categoryTotals": totals,
        "criticalPathEvidence": {"observations": critical, "interpretation": "Parser native intervals overlap across three workers. Compression samples continue after the last parser-native sample in every trace; ordered sink waits and nested phase durations therefore cannot be counted as independent removable CPU. Last sampled events are descriptive bounds, not exact task-completion timestamps. The separate full-import report covers the uncaptured UI tail."},
        "rankings": {"nativeParser": [r for r in table if r["category"] == "parserWasm"], "applicationJs": [r for r in table if r["category"] == "applicationJs"][:30], "otherWasm": [r for r in table if r["category"] in ("canonicalWasm", "compressionWasm", "otherWasm")][:15], "vendorAndBuiltins": [r for r in table if r["category"] in ("vendorJs", "builtinOrUnresolved")][:15], "initialHandlers": [r for r in table if r["function"] in ("_onMessage", "_onMessageWrapper")], "omittedFunctionCount": len(table) - len({(r['role'],r['category'],r['function'],r['url'],r['lineOneBased'],r['columnOneBased']) for r in table if r["category"] == "parserWasm"})},
        "sources": sources, "nativeSourceAnchors": source_anchors,
        "sourceScopeNotes": [
            {"source": PARSER_SOURCE, "line": 910, "note": "parse_composite_span_impl is the shared structured JSON grammar and hint validator; function samples cannot isolate its inlined string scan or hint work."},
            {"source": PARSER_SOURCE, "line": 3253, "note": "The fused entry point contains key interning, recent content matching, and encoding orchestration; its self samples cannot be labeled wholly as one of these suboperations."},
            {"source": "ext/js/dictionary/term-bank-wasm-parser-worker.js", "line": 130, "note": "The inferred parseTermBankWithWasmColumnChunks frame at this worker location is the result callback. Lines 143–182 copy or retain owned/shared content and account resultCopyMs; it is not the same frame as the exported parser entry point."},
            {"source": "ext/lib/sqlite/sqlite3-opfs-async-proxy.js", "line": 465, "note": "The repeatedly sampled f loop contains Atomics.wait; sampling weight is not proof of CPU consumption. The existing proxy work is independently owned."},
            {"source": "ext/js/dictionary/dictionary-database.js", "line": 6795, "note": "Recent publication source caching and registration are recurring JS work, but cache policy is fixed and a prior synchronous publication proof did not establish full-import gain."},
            {"source": "ext/js/dictionary/term-record-opfs-store.js", "line": 5840, "note": "Record-field encoding recurs; the current score restoration experiment is already owned elsewhere."}],
        "conclusions": ["The glossary composite validator and fused parser/encoder recur in all three traces; the pending prefix-selector and separately owned structured parser work already address that frontier.", "No additional distinct algorithmic candidate is established by these function-level samples.", "The 31/32/38ms bulk finalization phases do not reproduce the earlier 479ms outlier.", "Inflate, CRC, compression and overlapping worker waits are real observed categories, but do not justify admission/threshold/worker/compression tuning or a full-import gain forecast."]}
    # Keep the full frame accounting in the file: top lists are navigation aids,
    # not exclusions from raw data or sensitivity calculations.
    result["rankings"].pop("omittedFunctionCount")
    columns = list(table[0])
    assert all(list(row) == columns for row in table)
    rows_text = ",\n".join("      " + json.dumps([row[c] for c in columns], separators=(",", ":")) for row in table)
    # One compact matrix row per line keeps complete accounting reviewable
    # without repeating ten verbose metric names for all 719 source frames.
    output.write_text(json.dumps(result, indent=2)[:-2] + ",\n  \"allFunctionAccounting\": {\n    \"columns\": " + json.dumps(columns) + ",\n    \"rows\": [\n" + rows_text + "\n    ]\n  }\n}\n")
    assert load(output)["allFunctionAccounting"]["columns"] == columns
    print(json.dumps({"output": str(output), "sha256": digest(output.read_bytes()), "observations": len(observations), "profiles": sum(len(o["profiles"]) for o in observations), "functionRows": len(table), "noncustomSectionsEqual": True}))


if __name__ == "__main__":
    main()
