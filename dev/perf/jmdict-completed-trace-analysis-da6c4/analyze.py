#!/usr/bin/env python3
"""Analyze one immutable completed trace artifact. No import, build, or timing acquisition."""
import argparse
import collections
import hashlib
import io
import json
import math
import os
import pathlib
import re
import sys
import traceback
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPOSITORY = "ManabiIO/manabitan"
ROLES = ("import", "parser", "compression")
LIMITATIONS = [
    "This job only analyzes the completed source-bound trace. It does not run an import, rebuild a product, or acquire a new timing observation.",
    "Leaf counts are sampled attribution, not elapsed function time. Adjacent sampled wall weights are diagnostic wall allocation, not CPU time, utilization, or a removable-cost estimate.",
    "Raw chunks retain their original trace-array order and all signed deltas. Reconstruction stably orders each profile's chunks by(event timestamp,original event index), then cumulatively reconstructs sample timestamps and stably sorts samples only for adjacent wall attribution.",
    "CallFrame source locations label function declarations, not per-sample executed lines. All tables cover the captured window; no exact clock mapping to the benchmark timed-import interval is asserted.",
    "The interval before the first observed sample and the tail after the last sample are unassigned. Missing terminal endTime is not synthesized. Equal timestamps receive zero adjacent weight.",
    "Inclusive ancestor rows overlap and must not be added. Concurrent worker weights, spans, and sample ranges do not form an import critical path.",
    "Tracing perturbs scheduling and timer/message work. Every elapsed value here is excluded from performance promotion and from all comparison cohorts.",
    "WASM exports identify only exact exported indices. Internal functions remain index-labelled; nearest exported/JS ancestors are dynamic stack context, not an invented internal C symbol.",
    "Source attribution uses bytes from the exact acquired release package and its before/after runtime manifests. The original successful canonical validation is checked for identity, not reacquired."
]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical_digest(value):
    return digest(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())


def write_json(path, value):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def api_json(path):
    require(path.startswith("/repos/" + REPOSITORY + "/actions/"), "Unexpected authenticated API path")
    token = os.environ["GITHUB_TOKEN"]
    request = urllib.request.Request("https://api.github.com" + path, headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "manabitan-frozen-trace-analysis"
    })
    with urllib.request.build_opener(NoRedirect).open(request, timeout=60) as response:
        return json.load(response)


def download_archive(artifact, target):
    url = artifact["archive_download_url"]
    expected = "https://api.github.com/repos/" + REPOSITORY + "/actions/artifacts/" + str(artifact["id"]) + "/zip"
    require(url == expected, "Unexpected authenticated archive endpoint")
    request = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + os.environ["GITHUB_TOKEN"],
        "Accept": "application/vnd.github+json",
        "User-Agent": "manabitan-frozen-trace-analysis"
    })
    try:
        response = urllib.request.build_opener(NoRedirect).open(request, timeout=60)
    except urllib.error.HTTPError as error:
        require(error.code in (301, 302, 303, 307, 308), "Archive endpoint did not return a download redirect")
        location = error.headers.get("Location", "")
        require(urllib.parse.urlsplit(location).scheme == "https", "Archive redirect must use HTTPS")
        # The signed storage request deliberately has no GitHub Authorization header.
        response = urllib.request.urlopen(urllib.request.Request(location, headers={
            "User-Agent": "manabitan-frozen-trace-analysis"
        }), timeout=60)
    target.parent.mkdir(parents=True, exist_ok=True)
    size = 0
    sha = hashlib.sha256()
    with response, target.open("wb") as stream:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            require(size <= artifact["size_in_bytes"], "Archive exceeded the registered byte count")
            sha.update(chunk)
            stream.write(chunk)
    require(size == artifact["size_in_bytes"], "Archive download was truncated")
    require("sha256:" + sha.hexdigest() == artifact["digest"], "Archive download digest mismatch")
    return {"bytes": size, "sha256": sha.hexdigest()}


def checked_zip(source):
    archive = zipfile.ZipFile(source)
    names = set()
    total = 0
    for entry in archive.infolist():
        path = pathlib.PurePosixPath(entry.filename)
        require(entry.filename not in names, "Duplicate ZIP member")
        require(not path.is_absolute() and ".." not in path.parts and "\\" not in entry.filename,
                "Unsafe ZIP member name")
        require(not (entry.flag_bits & 1), "Encrypted ZIP member")
        names.add(entry.filename)
        total += entry.file_size
    require(total <= 512 * 1024 * 1024, "Unexpected uncompressed archive size")
    return archive


def unique_suffix(archive, suffix):
    matches = [name for name in archive.namelist() if name == suffix or name.endswith("/" + suffix)]
    require(len(matches) == 1, "Expected exactly one ZIP member ending in " + suffix)
    return matches[0]


def parse_profiles(trace):
    events = trace["traceEvents"]
    names = {(event["pid"], event["tid"]): event.get("args", {}).get("name")
             for event in events if event.get("name") == "thread_name"}
    profiles = {}
    for event in events:
        if event.get("name") != "Profile":
            continue
        key = (event["pid"], event["id"])
        require(key not in profiles, "Duplicate profile identity")
        profiles[key] = {
            "pid": key[0], "profileId": key[1], "tid": event["tid"],
            "threadName": names.get((key[0], event["tid"])),
            "startTimeUs": event["args"]["data"]["startTime"], "endTimeUs": None,
            "nodes": {}, "samples": [], "rawDeltas": [], "rawChunks": [], "chunkMergeOrder": []
        }
    for event_index, event in enumerate(events):
        if event.get("name") != "ProfileChunk":
            continue
        key = (event["pid"], event["id"])
        require(key in profiles, "Profile chunk has no owning Profile")
        timestamp = event.get("ts")
        require(type(timestamp) in (int, float) and math.isfinite(timestamp), "Missing or invalid ProfileChunk timestamp")
        profiles[key]["rawChunks"].append({
            "eventIndex": event_index, "timestampUs": timestamp, "emitterTid": event["tid"],
            "data": event["args"]["data"]
        })
    for profile in profiles.values():
        chunks = sorted(profile["rawChunks"], key=lambda item: (item["timestampUs"], item["eventIndex"]))
        profile["chunkMergeOrder"] = [item["eventIndex"] for item in chunks]
        for item in chunks:
            data = item["data"]
            cpu = data.get("cpuProfile", {})
            for node in cpu.get("nodes", []):
                old = profile["nodes"].get(node["id"])
                require(old is None or old == node, "Conflicting CPU profile node")
                profile["nodes"][node["id"]] = node
            samples, deltas = cpu.get("samples", []), data.get("timeDeltas", [])
            require(len(samples) == len(deltas), "Sample/delta count mismatch")
            require(all(type(delta) is int for delta in deltas), "Non-integral raw sample delta")
            profile["samples"].extend(samples)
            profile["rawDeltas"].extend(deltas)
            if "endTime" in data:
                require(profile["endTimeUs"] is None, "Duplicate CPU profile end")
                profile["endTimeUs"] = data["endTime"]
    for profile in profiles.values():
        nodes = profile["nodes"]
        parent = {}
        for node_id, node in nodes.items():
            if "parent" in node:
                require(node["parent"] in nodes, "Missing parent node")
                require(node_id not in parent or parent[node_id] == node["parent"], "Conflicting explicit parent")
                parent[node_id] = node["parent"]
            for child in node.get("children", []):
                require(child in nodes, "Missing child node")
                require(child not in parent or parent[child] == node_id, "Conflicting child parent")
                parent[child] = node_id
        for node_id, node in nodes.items():
            if "parent" in node:
                require(parent[node_id] == node["parent"], "Conflicting explicit parent")
        chains = {}
        for node_id in nodes:
            chain, seen, current = [], set(), node_id
            while current is not None:
                require(current not in seen, "Cycle in CPU profile parents")
                seen.add(current)
                chain.append(current)
                current = parent.get(current)
            chains[node_id] = chain
        require(all(node_id in nodes for node_id in profile["samples"]), "Sample references missing node")
        urls = {node.get("callFrame", {}).get("url", "") for node in nodes.values()}
        matches = [
            any(url.endswith("/term-bank-wasm-parser-worker.js") for url in urls),
            any(url.endswith("/zstd-term-content-compression-worker.js") for url in urls),
            any(url.endswith("/dictionary-database.js") for url in urls)
        ]
        require(sum(matches) <= 1, "Ambiguous profile role")
        profile["role"] = next((role for role, match in zip(("parser", "compression", "import"), matches) if match), "other")
        profile["chains"] = chains
    return list(profiles.values())


def weighted_samples(profile):
    absolute = profile["startTimeUs"]
    samples = []
    for order, (node_id, delta) in enumerate(zip(profile["samples"], profile["rawDeltas"])):
        absolute += delta
        samples.append({"order": order, "nodeId": node_id, "timestampUs": absolute, "rawDeltaUs": delta})
    samples.sort(key=lambda value: (value["timestampUs"], value["order"]))
    for index, sample in enumerate(samples):
        sample["adjacentWallUs"] = samples[index + 1]["timestampUs"] - sample["timestampUs"] if index + 1 < len(samples) else 0
    return samples


def wasm_exports(data):
    require(data[:8] == b"\0asm\x01\0\0\0", "Invalid WASM magic/version")
    def u32(pos, end):
        value = 0
        for shift in range(0, 35, 7):
            require(pos < end, "Truncated WASM integer")
            byte = data[pos]
            pos += 1
            value |= (byte & 127) << shift
            if not (byte & 128):
                require(value <= 0xffffffff, "WASM integer overflow")
                return value, pos
        raise ValueError("Invalid WASM integer")
    result, sections, cursor = {}, [], 8
    while cursor < len(data):
        section = data[cursor]
        size, begin = u32(cursor + 1, len(data))
        end = begin + size
        require(end <= len(data), "Truncated WASM section")
        sections.append({"id": section, "offset": cursor, "bytes": end - cursor})
        if section == 7:
            count, pos = u32(begin, end)
            for _ in range(count):
                length, pos = u32(pos, end)
                require(pos + length + 1 <= end, "Truncated WASM export")
                name = data[pos:pos + length].decode("utf-8")
                pos += length
                kind = data[pos]
                index, pos = u32(pos + 1, end)
                if kind == 0:
                    result.setdefault(index, []).append(name)
            require(pos == end, "Trailing WASM export bytes")
        cursor = end
    return result, sections


class SourceMap:
    def __init__(self, package, runtime):
        self.package = package
        self.runtime = runtime
        self.sources = {}
        self.source_lines = {}
        self.modules = {}
        for path in ["lib/term-bank-parser.wasm", "lib/term-content-canonical-scan-v1.wasm", "lib/zstd.wasm"]:
            data = self.read(path)
            exports, sections = wasm_exports(data)
            self.modules[path] = {"sha256": digest(data), "bytes": len(data),
                                  "functionExports": exports, "sections": sections}

    def read(self, path):
        if path not in self.sources:
            member = unique_suffix(self.package, path)
            data = self.package.read(member)  # zipfile also verifies the member CRC.
            expected = self.runtime.get("ext/" + path)
            require(expected is not None and digest(data) == expected, "Packaged source differs from acquired runtime: " + path)
            self.sources[path] = {"sha256": expected, "bytes": len(data), "member": member, "data": data}
        return self.sources[path]["data"]

    def path(self, frame):
        url = frame.get("url", "")
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "chrome-extension":
            return None
        path = urllib.parse.unquote(parsed.path).lstrip("/")
        if "ext/" + path not in self.runtime:
            return None
        self.read(path)
        return path

    def frame(self, node):
        frame = node.get("callFrame", {})
        path = self.path(frame)
        result = {"function": frame.get("functionName", ""), "url": path or frame.get("url", ""),
                  "line": frame.get("lineNumber", -1) + 1, "column": frame.get("columnNumber", -1) + 1}
        if path:
            result["sourceSha256"] = self.sources[path]["sha256"]
            if path.endswith(".js"):
                if path not in self.source_lines:
                    self.source_lines[path] = self.read(path).decode("utf-8").splitlines()
                lines = self.source_lines[path]
                line = result["line"]
                if 0 < line <= len(lines):
                    result["functionDeclarationSourceLine"] = lines[line - 1].strip()[:240]
        return result

    def native_context(self, profile, chain):
        nodes = profile["nodes"]
        leaf = nodes[chain[0]].get("callFrame", {})
        match = re.fullmatch(r"wasm-function\[(\d+)\]", leaf.get("functionName", ""))
        if not match:
            return None
        js = []
        for node_id in chain:
            frame = nodes[node_id].get("callFrame", {})
            path = self.path(frame)
            if path and path.endswith(".js"):
                js.append((node_id, path))
        url = leaf.get("url", "")
        module, reason = None, None
        if urllib.parse.urlsplit(url).path.endswith("/lib/zstd.wasm"):
            module, reason = "lib/zstd.wasm", "direct sampled WASM source URL"
        elif any(path.endswith("/term-content-canonical-scan.js") for _, path in js):
            module, reason = "lib/term-content-canonical-scan-v1.wasm", "canonical scan JS ancestor and its source-bound module path"
        elif profile["role"] == "parser" and any(path.endswith(("/term-bank-wasm-parser.js", "/term-bank-wasm-parser-worker.js")) for _, path in js):
            module, reason = "lib/term-bank-parser.wasm", "parser role plus parser JS ancestor and its source-bound module path"
        context = {"functionIndex": int(match.group(1)), "module": module, "mappingEvidence": reason,
                   "nearestJsAncestor": self.frame(nodes[js[0][0]]) if js else None}
        if module:
            info = self.modules[module]
            exports = info["functionExports"]
            context["moduleSha256"] = info["sha256"]
            context["exactExportNames"] = exports.get(context["functionIndex"], [])
            context["nearestExportedAncestor"] = None
            for node_id in chain:
                ancestor = nodes[node_id].get("callFrame", {})
                if ancestor.get("url", "") != url:
                    continue
                item = re.fullmatch(r"wasm-function\[(\d+)\]", ancestor.get("functionName", ""))
                if item and int(item.group(1)) in exports:
                    context["nearestExportedAncestor"] = {"functionIndex": int(item.group(1)),
                                                          "exportNames": exports[int(item.group(1))]}
                    break
        return context


def add_row(table, frame, wall):
    key = json.dumps(frame, sort_keys=True, separators=(",", ":"))
    row = table.setdefault(key, {"frame": frame, "samples": 0, "adjacentWallUs": 0})
    row["samples"] += 1
    row["adjacentWallUs"] += wall


def sorted_rows(table):
    return sorted(table.values(), key=lambda row: (-row["samples"], -row["adjacentWallUs"], json.dumps(row["frame"], sort_keys=True)))


def percentile(values, fraction):
    if not values:
        return None
    values = sorted(values)
    pos = (len(values) - 1) * fraction
    low = math.floor(pos)
    high = math.ceil(pos)
    return values[low] + (values[high] - values[low]) * (pos - low)


def summarize_profile(profile, sources, bin_origin):
    weighted = weighted_samples(profile)
    leaves, native, inclusive, bins = {}, {}, {}, collections.defaultdict(collections.Counter)
    nodes = profile["nodes"]
    non_idle_times = []
    contexts, frames = {}, {}
    for node_id in nodes:
        frames[node_id] = sources.frame(nodes[node_id])
    for sample in weighted:
        node_id, wall = sample["nodeId"], sample["adjacentWallUs"]
        chain = profile["chains"][node_id]
        frame = frames[node_id]
        add_row(leaves, frame, wall)
        seen = set()
        for ancestor in chain:
            key = json.dumps(frames[ancestor], sort_keys=True, separators=(",", ":"))
            if key not in seen:
                add_row(inclusive, frames[ancestor], wall)
                seen.add(key)
        if node_id not in contexts:
            contexts[node_id] = sources.native_context(profile, chain)
        context = contexts[node_id]
        if context:
            add_row(native, {"leaf": frame, "context": context}, wall)
        function = frame["function"]
        category = "idle" if function == "(idle)" else "gc" if function == "(garbage collector)" else "wasm" if context else "javascript" if frame.get("sourceSha256") else "runtime-or-other"
        bins[(sample["timestampUs"] - bin_origin) // 50000][category] += 1
        if function not in ("(idle)", "(root)"):
            non_idle_times.append(sample["timestampUs"])
    gaps = [sample["adjacentWallUs"] for sample in weighted[:-1]]
    first = weighted[0]["timestampUs"] if weighted else None
    last = weighted[-1]["timestampUs"] if weighted else None
    meta = {key: profile[key] for key in ["pid", "profileId", "tid", "threadName", "role", "startTimeUs", "endTimeUs"]}
    meta.update({
        "sampleCount": len(weighted), "nodeCount": len(nodes),
        "rawChunkCount": len(profile["rawChunks"]), "chunkMergeOrder": profile["chunkMergeOrder"],
        "chunksWereReordered": profile["chunkMergeOrder"] != [item["eventIndex"] for item in profile["rawChunks"]],
        "negativeRawDeltaCount": sum(value < 0 for value in profile["rawDeltas"]),
        "negativeRawDeltaMinUs": min([0] + profile["rawDeltas"]),
        "firstObservedSampleUs": first, "lastObservedSampleUs": last,
        "firstSampleMinusStartUs": first - profile["startTimeUs"] if first is not None else None,
        "explicitEndMinusLastSampleUs": profile["endTimeUs"] - last if profile["endTimeUs"] is not None and last is not None else None,
        "observedSampleSpanUs": last - first if first is not None else 0,
        "adjacentWallSumUs": sum(sample["adjacentWallUs"] for sample in weighted),
        "adjacentGapP50Us": percentile(gaps, .5), "adjacentGapP95Us": percentile(gaps, .95),
        "adjacentGapMaxUs": max(gaps, default=0),
        "firstNonIdleSampleUs": min(non_idle_times) if non_idle_times else None,
        "lastNonIdleSampleUs": max(non_idle_times) if non_idle_times else None,
        "leafRows": sorted_rows(leaves), "wasmContextRows": sorted_rows(native),
        "inclusiveRows": sorted_rows(inclusive),
        "sampleCountBins": [{"offsetUs": index * 50000, "counts": dict(counts)} for index, counts in sorted(bins.items())]
    })
    require(meta["adjacentWallSumUs"] == meta["observedSampleSpanUs"], "Adjacent wall allocation does not cover observed span")
    return meta, weighted


def aggregate_profiles(profiles):
    result = {}
    for role in sorted({profile["role"] for profile in profiles}):
        selected = [profile for profile in profiles if profile["role"] == role]
        item = {"profileCount": len(selected), "sampleCount": sum(profile["sampleCount"] for profile in selected)}
        for label in ("leafRows", "wasmContextRows", "inclusiveRows"):
            rows = {}
            for profile in selected:
                for row in profile[label]:
                    key = json.dumps(row["frame"], sort_keys=True, separators=(",", ":"))
                    target = rows.setdefault(key, {"frame": row["frame"], "samples": 0, "adjacentWallUs": 0})
                    target["samples"] += row["samples"]
                    target["adjacentWallUs"] += row["adjacentWallUs"]
            item[label] = sorted_rows(rows)
        result[role] = item
    return result


def timeline_evidence(trace, report, summary, run_log, harness, original_plan):
    # Report wall-clock/host timestamps are not automatically the profiler clock.
    # Retain original fields and trace marks; do not crop samples on an assumed conversion.
    phases = []
    for phase in report.get("phases", []):
        item = {key: value for key, value in phase.items()
                if isinstance(value, (str, int, float, bool, type(None))) and key != "details"}
        data = phase.get("data", {})
        if isinstance(data, dict):
            item["dataKeys"] = list(data)
            for key in ("browserTiming", "stepTimingSummary", "step4Breakdown"):
                if key in data:
                    item[key] = data[key]
            debug = data.get("importDebug", {})
            if isinstance(debug, dict):
                item["importDebugScalars"] = {key: value for key, value in debug.items()
                                              if isinstance(value, (str, int, float, bool, type(None)))}
        phases.append(item)
    mark_names = {
        "TimeStamp", "ConsoleTime", "ConsoleTimeStamp", "TracingStartedInBrowser",
        "TracingStartedInPage", "TracingStartedInWorker", "TracingSessionIdForWorker",
        "RecordClockSyncMarker", "clock_sync", "navigationStart"
    }
    marks = [dict(eventIndex=index, **event) for index, event in enumerate(trace["traceEvents"])
             if "user_timing" in event.get("cat", "") or event.get("name") in mark_names]
    marks.sort(key=lambda event: (event.get("ts", 0), event["eventIndex"]))
    times = [event["ts"] for event in trace["traceEvents"]
             if event.get("ph") != "M" and type(event.get("ts")) in (int, float) and event["ts"] > 0]
    source_anchors = {
        "tracingStart": "await importTraceSession.send('Tracing.start', {",
        "workerCompletionMarker": "const expectedTraceLogFragment = ",
        "stopFromWorkerCompletion": "await stopBrowserTraceToFile(traceSession, importTracePath);",
        "awaitedTraceStop": "await importWorkerTraceStopPromise;",
        "firstExplicitBenchmarkStateRead": "const state = await evalSendMessage(page, 'benchmarkDictionaryState');",
        "firstExplicitBenchmarkProbeLoop": "for (const term of probeTerms) {"
    }
    locations = {}
    previous = -1
    for name, text in source_anchors.items():
        position = harness.find(text, previous + 1)
        require(position >= 0, "Frozen trace-boundary source anchor missing: " + name)
        locations[name] = {"line": harness.count("\n", 0, position) + 1, "anchor": text}
        previous = position
    log_matches = [line for line in run_log.splitlines()
                   if ("wrote" in line and "trace" in line) or "trace completion marker was not observed" in line]
    return {
        "timedImportClockWindowEstablished": False,
        "interpretation": "These are all captured-window samples. No host/browser timing conversion or exact timed-import crop is assumed. The frozen harness awaits trace stop before its explicit benchmark state/probe validation, but work inside import/finalization and asynchronous trace-stop delivery remain part of the captured window.",
        "originalTraceBoundaryDescription": original_plan["acquisition"]["traceBoundary"],
        "sourceOrderedBoundaryAnchors": locations,
        "workerTraceStopLogObserved": any("wrote worker import browser trace:" in line for line in log_matches),
        "visibleCompletionFallbackLogObserved": any("visible-completion fallback" in line for line in log_matches),
        "terminalLogMatches": log_matches,
        "traceEventTimestampMinUs": min(times) if times else None,
        "traceEventTimestampMaxUs": max(times) if times else None,
        "phaseSummaries": phases,
        "summaryRunScalars": {key: value for key, value in summary["runs"][0].items()
                             if isinstance(value, (str, int, float, bool, type(None)))},
        "traceTimestampAndUserTimingEvents": marks
    }


def analyze(plan, output):
    acquisition = plan["acquisition"]
    run = api_json("/repos/" + REPOSITORY + "/actions/runs/" + str(acquisition["runId"]))
    job = api_json("/repos/" + REPOSITORY + "/actions/jobs/" + str(acquisition["jobId"]))
    artifact = api_json("/repos/" + REPOSITORY + "/actions/artifacts/" + str(acquisition["artifactId"]))
    write_json(output / "acquisition-api.json", {"run": run, "job": job, "artifact": artifact})
    require(run["id"] == acquisition["runId"] and run["head_sha"] == acquisition["headSha"] and
            run["run_attempt"] == 1 and run["status"] == "completed" and run["conclusion"] == "success", "Frozen acquisition run mismatch")
    require(job["id"] == acquisition["jobId"] and job["run_id"] == run["id"] and job["conclusion"] == "success",
            "Frozen acquisition job mismatch")
    require(artifact["id"] == acquisition["artifactId"] and artifact["name"] == acquisition["artifactName"] and
            artifact["size_in_bytes"] == acquisition["artifactBytes"] and not artifact["expired"] and
            artifact["digest"] == "sha256:" + acquisition["artifactSha256"] and
            artifact["workflow_run"]["id"] == run["id"] and artifact["workflow_run"]["head_sha"] == run["head_sha"],
            "Frozen artifact metadata mismatch")
    archive_path = output.parent / "download" / "acquired-trace.zip"
    archive_receipt = download_archive(artifact, archive_path)
    with checked_zip(archive_path) as archive:
        write_json(output / "artifact-members.json", [{"name": member.filename, "bytes": member.file_size, "crc32": member.CRC}
                                                     for member in archive.infolist()])
        trace_member = unique_suffix(archive, "builds/perf/jmdict-current-trace-dcfc-da6c4/run-1.trace.json")
        prefix = trace_member.rsplit("/", 1)[0] + "/"
        raw = {name: archive.read(prefix + name) for name in [
            "before-receipt.json", "after-receipt.json", "coverage-receipt.json",
            "run-1.trace.json", "run-1.json", "summary.json",
            "control-plan.json", "control-receipt.py", "control-jmdict-current-trace-da6c4.yml", "run.log"
        ]}
        for name, expected in plan["acquiredFileSha256"].items():
            require(digest(raw[name]) == expected, "Frozen acquired file mismatch: " + name)
        original_plan = json.loads(raw["control-plan.json"])
        receipts = [json.loads(raw[name]) for name in ["before-receipt.json", "after-receipt.json", "coverage-receipt.json"]]
        before, after, coverage = receipts
        for expected_stage, receipt in zip(("before", "after", "coverage"), receipts):
            require(receipt["complete"] is True and receipt["stage"] == expected_stage, "Incomplete acquisition receipt")
            for key, expected in plan["expectedReceipt"].items():
                require(receipt[key] == expected, "Acquisition receipt identity mismatch: " + key)
            for label in ("tracked", "runtime"):
                require(canonical_digest(receipt[label]) == receipt[label + "ManifestSha256"], "Invalid acquired source manifest hash")
        for receipt in (after, coverage):
            for key in ("tracked", "runtime", "controlSha256"):
                require(receipt[key] == before[key], "Acquisition source changed: " + key)
        for path, expected in original_plan["sourceSha256"].items():
            require(before["tracked"][path] == expected, "Original plan/source manifest mismatch")
        require(original_plan["productSource"] == plan["productSource"] and original_plan["productTree"] == plan["productTree"], "Product plan mismatch")
        require(coverage["traceSha256"] == digest(raw["run-1.trace.json"]) and
                coverage["reportSha256"] == digest(raw["run-1.json"]) and
                coverage["summarySha256"] == digest(raw["summary.json"]), "Coverage report digest mismatch")
        report, summary = json.loads(raw["run-1.json"]), json.loads(raw["summary.json"])
        require(report["status"] == "success" and report["launchMode"] == "headless" and report["browserFlavor"] == "chromium" and
                report["skippedVerification"] is False and summary["traceEnabled"] is True and summary["authoritativeTiming"] is False and
                summary["importFlags"] is None and summary["gitSha"] == plan["productSource"] and len(summary["runs"]) == 1,
                "Acquired diagnostic request mismatch")
        require(coverage["validation"] == report["benchmark"]["validation"] == summary["runs"][0]["validation"],
                "Acquired correctness receipt mismatch")
        require(coverage["canonicalValidationSha256"] == plan["canonicalValidationSha256"], "Original canonical validation identity mismatch")
        harness_path = "test/chromium/extension-two-dictionary-import.e2e.js"
        harness_url = "https://raw.githubusercontent.com/" + REPOSITORY + "/" + plan["productSource"] + "/" + harness_path
        with urllib.request.urlopen(harness_url, timeout=60) as response:
            harness_bytes = response.read(2 * 1024 * 1024 + 1)
        require(len(harness_bytes) <= 2 * 1024 * 1024 and
                digest(harness_bytes) == original_plan["sourceSha256"][harness_path] == plan["boundaryHarnessSha256"],
                "Frozen trace-boundary harness source mismatch")
        (output / "original-trace-boundary-harness.js").write_bytes(harness_bytes)
        trace = json.loads(raw["run-1.trace.json"])
        timeline = timeline_evidence(trace, report, summary, raw["run.log"].decode("utf-8"),
                                     harness_bytes.decode("utf-8"), original_plan)
        timeline["boundaryHarnessSha256"] = digest(harness_bytes)
        timeline["acquiredRunLogSha256"] = digest(raw["run.log"])
        write_json(output / "timeline-and-phase-evidence.json", timeline)
        write_json(output / "original-report-phases.json", report.get("phases", []))
        package_member = unique_suffix(archive, "builds/manabitan-chrome.zip")
        package_bytes = archive.read(package_member)
        require(digest(package_bytes) == before["packageSha256"], "Acquired release package mismatch")
        with checked_zip(io.BytesIO(package_bytes)) as package:
            sources = SourceMap(package, before["runtime"])
            profiles = parse_profiles(trace)
            counts = collections.Counter(profile["role"] for profile in profiles)
            require(dict(counts) == coverage["profileRoleCounts"] == plan["expectedRoleCounts"], "Profile role coverage mismatch")
            expected = {(item["pid"], item["profileId"]): item for item in coverage["profiles"]}
            require(len(expected) == len(profiles), "Profile identity count mismatch")
            results = []
            origin = min(profile["startTimeUs"] for profile in profiles)
            for profile in profiles:
                item, weighted = summarize_profile(profile, sources, origin)
                prior = expected[(profile["pid"], profile["profileId"])]
                for key in ("pid", "profileId", "tid", "threadName", "role", "sampleCount", "nodeCount", "negativeRawDeltaCount", "startTimeUs", "endTimeUs"):
                    require(item[key] == prior[key], "Profile reconstruction differs from acquisition: " + key)
                require(item["sampleCount"] > 0, "Empty acquired profile")
                identity = str(profile["pid"]) + "-" + str(profile["profileId"])
                write_json(output / "profiles" / (identity + ".raw.json"),
                           {key: value for key, value in profile.items() if key != "chains"})
                write_json(output / "profiles" / (identity + ".chronological.json"), weighted)
                results.append(item)
            source_receipts = {path: {key: value for key, value in info.items() if key != "data"}
                               for path, info in sources.sources.items()}
            analysis = {
                "schemaVersion": 1, "complete": True, "scope": plan["scope"], "limitations": LIMITATIONS,
                "acquisition": acquisition, "archiveDownload": archive_receipt,
                "productSource": plan["productSource"], "productTree": plan["productTree"],
                "packageSha256": before["packageSha256"], "traceSha256": coverage["traceSha256"],
                "canonicalValidationSha256": coverage["canonicalValidationSha256"],
                "browserVersion": report["browserVersion"], "hostEnvironment": report["hostEnvironment"],
                "binOriginUs": origin, "binWidthUs": 50000, "profiles": results,
                "roles": aggregate_profiles(results), "sourceFiles": source_receipts, "wasmModules": sources.modules,
                "timelineAndPhaseEvidence": timeline
            }
        for name in ("before-receipt.json", "after-receipt.json", "coverage-receipt.json", "control-plan.json"):
            (output / name).write_bytes(raw[name])
    return analysis


def print_tables(analysis):
    print("FROZEN_TRACE_ANALYSIS " + json.dumps({key: analysis[key] for key in (
        "complete", "productSource", "productTree", "packageSha256", "traceSha256", "canonicalValidationSha256", "browserVersion"
    )}, separators=(",", ":")))
    for limitation in LIMITATIONS:
        print("LIMITATION " + limitation)
    timeline = analysis["timelineAndPhaseEvidence"]
    print("TRACE_WINDOW " + json.dumps({key: value for key, value in timeline.items()
                                      if key not in ("phaseSummaries", "traceTimestampAndUserTimingEvents")}, separators=(",", ":")))
    for phase in timeline["phaseSummaries"]:
        line = json.dumps(phase, separators=(",", ":"))
        print("ORIGINAL_REPORTED_PHASE " + line[:12000] + (" [truncated in log; full phase evidence retained]" if len(line) > 12000 else ""))
    marks = timeline["traceTimestampAndUserTimingEvents"]
    print("TRACE_MARK_COUNT " + str(len(marks)))
    for mark in marks[:100]:
        line = json.dumps(mark, separators=(",", ":"))
        print("TRACE_MARK " + line[:2000] + (" [truncated in log; full event retained]" if len(line) > 2000 else ""))
    if len(marks) > 100:
        print("TRACE_MARKS_MORE " + str(len(marks) - 100) + " events retained in timeline-and-phase-evidence.json")
    print("PROFILE\tROLE\tSAMPLES\tNEGATIVE_DELTAS\tOBSERVED_SPAN_MS\tMEDIAN_ADJACENT_GAP_US\tMAX_ADJACENT_GAP_US")
    for item in analysis["profiles"]:
        print(f'{item["pid"]}/{item["profileId"]}\t{item["role"]}\t{item["sampleCount"]}\t{item["negativeRawDeltaCount"]}\t'
              f'{item["observedSampleSpanUs"] / 1000:.3f}\t{item["adjacentGapP50Us"]}\t{item["adjacentGapMaxUs"]}')
    for role in ROLES:
        group = analysis["roles"][role]
        print("\nROLE " + role + ": leaf samples and adjacent sampled wall allocation; no CPU-time or saving claim.")
        print("SAMPLES\tPERCENT_OF_ROLE_SAMPLES\tADJACENT_WALL_MS\tFUNCTION\tFUNCTION_DECLARATION_SOURCE")
        for row in group["leafRows"][:35]:
            frame = row["frame"]
            print(f'{row["samples"]}\t{100 * row["samples"] / group["sampleCount"]:.3f}\t{row["adjacentWallUs"] / 1000:.3f}\t'
                  f'{frame["function"]}\t{frame["url"]}:{frame["line"]}')
        print("WASM DYNAMIC STACK CONTEXT: exact exports or unnamed internal indices; contexts can share an owner.")
        for row in group["wasmContextRows"][:25]:
            frame, context = row["frame"]["leaf"], row["frame"]["context"]
            owner = context.get("nearestExportedAncestor")
            js = context.get("nearestJsAncestor")
            print("WASM_CONTEXT " + json.dumps({
                "samples": row["samples"], "adjacentWallMs": row["adjacentWallUs"] / 1000,
                "leaf": frame["function"], "module": context["module"], "exports": context.get("exactExportNames"),
                "nearestExportedAncestor": owner,
                "nearestJsAncestor": {key: js.get(key) for key in ("function", "url", "line", "functionDeclarationSourceLine")} if js else None
            }, separators=(",", ":")))
        print("INCLUSIVE ANCESTORS: overlapping sample counts, not additive.")
        for row in group["inclusiveRows"][:12]:
            frame = row["frame"]
            print(f'INCLUSIVE\t{row["samples"]}\t{row["adjacentWallUs"] / 1000:.3f}\t{frame["function"]}\t{frame["url"]}:{frame["line"]}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()
    output = args.output
    output.mkdir(parents=True, exist_ok=False)
    receipt = {"complete": False, "scope": __doc__, "analysisGithubSha": os.environ.get("GITHUB_SHA"),
               "analysisRunId": os.environ.get("GITHUB_RUN_ID"), "analysisRunAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
               "pythonVersion": sys.version, "limitations": LIMITATIONS}
    try:
        plan = json.loads(args.plan.read_text())
        own = pathlib.Path(__file__).resolve()
        require(os.environ.get("GITHUB_REPOSITORY") == REPOSITORY and
                re.fullmatch(r"[0-9a-f]{40}", os.environ.get("GITHUB_SHA", "")), "Unexpected analysis invocation")
        require(digest(own.read_bytes()) == plan["analysisScriptSha256"], "Analysis script differs from frozen plan")
        receipt["analysisControlSha256"] = {}
        for name in ("analyze.py", "test_analyze.py", "plan.json", "workflow.yml"):
            path = own.with_name(name)
            receipt["analysisControlSha256"][name] = digest(path.read_bytes())
            (output / ("analysis-control-" + name)).write_bytes(path.read_bytes())
        require(receipt["analysisControlSha256"]["test_analyze.py"] == plan["analysisTestsSha256"], "Analysis tests differ from frozen plan")
        analysis = analyze(plan, output)
        write_json(output / "analysis.json", analysis)
        print_tables(analysis)
        receipt.update({"complete": True, "analysisSha256": digest((output / "analysis.json").read_bytes()),
                        "acquisition": plan["acquisition"], "productSource": plan["productSource"]})
    except BaseException as error:
        receipt["failure"] = {"type": type(error).__name__, "message": str(error)}
        traceback.print_exc()
        raise
    finally:
        write_json(output / "analysis-receipt.json", receipt)
        print("FROZEN_TRACE_ANALYSIS_RECEIPT " + json.dumps(receipt, separators=(",", ":")))


if __name__ == "__main__":
    main()
