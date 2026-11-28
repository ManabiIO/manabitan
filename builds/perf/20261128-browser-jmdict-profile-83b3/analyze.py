#!/usr/bin/env python3
"""Read one frozen, already-completed browser trace. Never launches a browser."""

import argparse
from collections import Counter, defaultdict
import hashlib
import io
import json
import math
from pathlib import Path, PurePosixPath
import re
import statistics
import subprocess
from urllib.parse import urlsplit
import zipfile

BASE = "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2"
TREE = "d99ea4d04658f7ec1c76acdc5f3684594212a471"
OUTER_HASH = "b0dc59b4ffe9ff0d85a0a752255537431b24475c7ba15626f2342f1dc40ef775"
PACKAGE_HASH = "8f21192b9e4a15261fd188604c1f0d3245b095e35f529948926c0a5366b0dd22"
TRACE_HASH = "3beac18db05dad6198e2b40695b8e9c3eb0bf94622b57b413be41a5056a5351e"
FIXTURE_HASH = "3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f"
FIXTURE_LOCK_HASH = "60aa981791f3b60ca17588212aea5bd3536fb8f59288855e5accd019c6e4cf89"
PACKAGE_LOCK_HASH = "01e065503317a90b43a5bc60cd9f874238762c75a13c8115a9c484a626960a96"
PROOF_HASH = "263ca8e77c4932c41db6a3f2c96f89697e32c91b19041a3d99c2e37e01438a69"
MEMBERS = {
    "baseline-profile/run-1.json", "baseline-profile/summary.json",
    "baseline-profile/run-1.trace.json", "baseline-profile/run-1.html",
    "cpu-profile-instrumentation.json", "fixtures.log", "cpu-profile.log",
    "frozen-browser-identity.json", "frozen-registered-plan.json",
    "frozen-source-identities.json", "observer-source.json", "package-A.zip", "package-B.zip",
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def strict_json(data):
    def pairs(values):
        result = {}
        for key, value in values:
            if key in result:
                raise ValueError(f"Duplicate JSON key: {key}")
            result[key] = value
        return result

    return json.loads(data, object_pairs_hook=pairs, parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))


def save(path, value):
    with path.open("x", encoding="utf-8") as file:
        json.dump(value, file, ensure_ascii=False, indent=2, allow_nan=False)
        file.write("\n")


def safe_zip(archive, allow_directories=False):
    names = []
    all_names = []
    for item in archive.infolist():
        path = PurePosixPath(item.filename)
        assert not path.is_absolute() and ".." not in path.parts and "\\" not in item.filename
        assert str(path) == item.filename.rstrip("/") and str(path) != "."
        mode = (item.external_attr >> 16) & 0o170000
        assert mode in (0, 0o040000, 0o100000), "Non-regular ZIP member"
        all_names.append(str(path))
        if item.is_dir():
            assert allow_directories and item.file_size == 0 and mode in (0, 0o040000)
            continue
        assert mode != 0o040000
        names.append(item.filename)
    assert len(all_names) == len(set(all_names)), "Duplicate ZIP members"
    return names


def uleb(data, position):
    value = shift = 0
    while True:
        byte = data[position]
        position += 1
        value |= (byte & 127) << shift
        if not byte & 128:
            return value, position
        shift += 7
        assert shift < 64


def wasm_bodies(data):
    assert data[:8] == b"\0asm\1\0\0\0"
    position = 8
    bodies = []
    while position < len(data):
        section = data[position]
        size, start = uleb(data, position + 1)
        end = start + size
        assert end <= len(data)
        if section == 2:
            # The exact parser imports nothing. The exact canonical scanner
            # imports only env.memory, with an initial size of two pages.
            # Neither module imports functions, so code-body indices equal
            # function indices. Reject other layouts instead of shifting IDs.
            imports, cursor = uleb(data, start)
            assert imports == 0 or data[start:end] == bytes.fromhex("0103656e76066d656d6f7279020002"), "Unexpected native import layout"
            if imports == 0:
                assert cursor == end
        if section == 10:
            count, cursor = uleb(data, start)
            for index in range(count):
                body_size, body_start = uleb(data, cursor)
                cursor = body_start + body_size
                assert cursor <= end
                bodies.append({"index": index, "start": body_start, "end": cursor})
            assert cursor == end
        position = end
    assert bodies
    return bodies


def frame(node):
    raw = node["callFrame"]
    return {
        "function": raw.get("functionName", ""), "url": raw.get("url", ""),
        "line": raw.get("lineNumber", -1), "column": raw.get("columnNumber", -1),
        "scriptId": str(raw.get("scriptId", "")), "codeType": raw.get("codeType", ""),
    }


def package_path(url):
    parsed = urlsplit(url)
    return parsed.path.lstrip("/") if parsed.scheme == "chrome-extension" else None


def role_for(nodes, thread_name):
    paths = {package_path(node["callFrame"].get("url", "")) for node in nodes.values()}
    roles = []
    for path, role in [
        ("js/dictionary/term-bank-wasm-parser-worker.js", "parser-worker"),
        ("js/dictionary/zstd-term-content-compression-worker.js", "codec-worker"),
        ("js/background/offscreen-dictionary-worker.js", "dictionary-import-worker"),
        ("lib/sqlite/sqlite3-opfs-async-proxy.js", "sqlite-async-proxy"),
    ]:
        if path in paths:
            roles.append(role)
    if len(roles) == 1:
        return roles[0]
    if len(roles) > 1:
        return "ambiguous:" + ",".join(roles)
    if thread_name == "CrRendererMain":
        return "renderer-settings"
    if thread_name == "ServiceWorker thread":
        return "background-service-worker"
    return "unclassified"


def category(f, package_entries):
    name, url = f["function"], f["url"]
    if name == "(idle)":
        return "idle"
    if name == "(garbage collector)":
        return "garbage-collector"
    if name in ("(root)", "(program)"):
        return "runtime-unattributed"
    if name == "Atomics.wait" or (package_path(url) == "lib/sqlite/sqlite3-opfs-async-proxy.js" and name == "f" and f["line"] == 453):
        return "wait-capable-proxy-occupancy-not-cpu"
    if name.startswith(("js-to-wasm:", "wasm-to-js:")):
        return "v8-bridge-unmapped"
    if "__playwright" in url or "/dev/perf/" in url or name.startswith("__pw"):
        return "instrumentation"
    path = package_path(url)
    if url.startswith("wasm://") or f["codeType"].lower() == "wasm" or (path and path.endswith(".wasm")):
        return "wasm-sampled-stack"
    if path in package_entries:
        return "packaged-javascript-sampled-stack"
    return "runtime-or-unmapped"


def union_duration(intervals):
    total = 0
    left = right = None
    for start, end in sorted(intervals):
        if left is None:
            left, right = start, end
        elif start <= right:
            right = max(right, end)
        else:
            total += right - left
            left, right = start, end
    return total + (0 if left is None else right - left)


def analyze(args):
    out = args.output
    out.mkdir(parents=True, exist_ok=True)
    assert not (out / "analysis.json").exists() and not (out / "raw").exists(), "Use a fresh output directory"
    raw_output = out / "raw"
    raw_output.mkdir()
    root = args.baseline_root.resolve()
    git = lambda *values: subprocess.check_output(["git", *values], cwd=root, text=True).strip()
    assert git("rev-parse", "HEAD") == BASE and git("rev-parse", "HEAD^{tree}") == TREE
    assert git("status", "--porcelain", "--untracked-files=no") == ""
    outer = args.artifact.read_bytes()
    assert len(outer) == 34013156 and sha(outer) == OUTER_HASH
    binding = {"schemaVersion": 1, "complete": False, "artifactId": 15248139923,
               "sourcePr": 973, "runId": 46104197268, "jobId": 140853159231,
               "artifactBytes": len(outer), "artifactSha256": sha(outer), "baseline": BASE,
               "baselineTree": TREE, "baselineRoot": str(root), "authoritativeTiming": False,
               "comparativeTiming": False, "newBrowserAcquisition": False, "members": []}
    with zipfile.ZipFile(io.BytesIO(outer)) as archive:
        assert set(safe_zip(archive)) == MEMBERS
        raw = {}
        for name in sorted(MEMBERS):
            data = archive.read(name)
            binding["members"].append({"path": name, "bytes": len(data), "sha256": sha(data), "retainedRaw": not name.startswith("package-")})
            if not name.startswith("package-"):
                target = raw_output / name
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open("xb") as file:
                    file.write(data)
                raw[name] = data
        identities = strict_json(raw["frozen-source-identities.json"])
        a = identities["arms"]["A"]
        assert a["sha"] == BASE and a["tree"] == TREE and a["packageSha256"] == PACKAGE_HASH
        assert a["fixtureLockSha256"] == FIXTURE_LOCK_HASH and a["lockSha256"] == PACKAGE_LOCK_HASH
        package_bytes = archive.read("package-A.zip")
        assert len(package_bytes) == 16805714 and sha(package_bytes) == PACKAGE_HASH
        package_entries = {}
        binaries = {}
        with zipfile.ZipFile(io.BytesIO(package_bytes)) as package:
            for name in safe_zip(package, allow_directories=True):
                data = package.read(name)
                local = root / "ext" / name
                digest = sha(data)
                assert digest == a["entries"][name] and local.is_file() and sha(local.read_bytes()) == digest, name
                package_entries[name] = {"bytes": len(data), "sha256": digest, "localBaselineMatches": True}
                if name.endswith(".wasm"):
                    binaries[name] = data
            assert len(package_entries) == 554 and set(package_entries) == set(a["entries"])
            proxy_lines = package.read("lib/sqlite/sqlite3-opfs-async-proxy.js").decode().splitlines()
            assert "const waitLoop = async function f()" in proxy_lines[453]
            assert any("Atomics.wait(" in line for line in proxy_lines[453:485])
        binding["baselinePackage"] = {"sha256": PACKAGE_HASH, "bytes": len(package_bytes), "fileMemberCount": 554, "directoryMemberCount": 65, "allFrozenEntriesMatch": True, "allLocalBaselineEntriesMatch": True, "entries": package_entries}
    instrumentation = strict_json(raw["cpu-profile-instrumentation.json"])
    observer = strict_json(raw["observer-source.json"])
    plan = strict_json(raw["frozen-registered-plan.json"])
    browser = strict_json(raw["frozen-browser-identity.json"])
    report = strict_json(raw["baseline-profile/run-1.json"])
    summary = strict_json(raw["baseline-profile/summary.json"])
    assert instrumentation["baselineOnly"] and not instrumentation["authoritativeTiming"] and not instrumentation["memoryQualification"]
    assert instrumentation["sourceSha"] == BASE and instrumentation["packageSha256"] == PACKAGE_HASH and instrumentation["harnessOverlay"] is None
    assert instrumentation["captureCompleted"] and instrumentation["traceSha256"] == TRACE_HASH
    assert observer["productPackages"]["A"] == PACKAGE_HASH and not observer["authoritativeTiming"]
    assert plan["baseline"] == BASE and plan["dictionary"] == "jmdict"
    assert summary["gitSha"] == BASE and summary["source"]["gitSha"] == BASE and not summary["source"]["dirty"]
    assert report["status"] == "success" and report["failureReason"] == "" and not report["skippedVerification"]
    assert report["packageSha256"] == PACKAGE_HASH and browser["version"] == report["browserVersion"] == summary["browserVersion"] == "153.0.8010.12"
    assert summary["traceEnabled"] and not summary["authoritativeTiming"] and summary["importFlags"] is None and summary["mediaCheck"] == "all"
    assert report["benchmark"]["productionImportDefaults"] and report["benchmark"]["pinnedDictionaries"]
    fixture = summary["fixture"]
    assert fixture["sha256"] == FIXTURE_HASH and fixture["sizeBytes"] == 15645766 and fixture["termRows"] == 528299
    validation = report["benchmark"]["validation"]
    assert validation["termRows"] == 528299 and validation["contentReadable"] and validation["probeCount"] == 12
    assert validation["media"]["mode"] == "all" and validation["media"]["totalFiles"] == 0
    source_hashes = a["sourceHashes"]
    assert source_hashes == summary["source"]["sha256"]
    for name, digest in source_hashes.items():
        if name.startswith("builds/"):
            assert name in ("builds/manabitan-chrome.zip", "builds/manabitan-chrome-dev.zip")
            assert digest == (PACKAGE_HASH if name.endswith("manabitan-chrome.zip") else None)
        else:
            assert sha((root / name).read_bytes()) == digest, name
    for name, digest in instrumentation["sourceHashes"].items():
        assert digest == source_hashes[name]
    assert sha((root / "package-lock.json").read_bytes()) == PACKAGE_LOCK_HASH
    assert sha((root / "test/perf/dictionaries.lock.json").read_bytes()) == FIXTURE_LOCK_HASH
    assert sha(raw["baseline-profile/run-1.trace.json"]) == TRACE_HASH
    binding["harnessSourceHashes"] = source_hashes
    binding["fixture"] = fixture
    binding["browser"] = browser
    binding["baselineReceipt"] = {"status": report["status"], "rows": validation["termRows"], "probeCount": validation["probeCount"], "outputDigestSha256": validation["outputDigestSha256"], "media": validation["media"], "scope": "Original diagnostic's successful restart/lookup receipt, not a new performance qualification"}
    proof_bytes = args.native_proof.read_bytes()
    assert sha(proof_bytes) == PROOF_HASH
    (out / "native-symbol-proof.json").write_bytes(proof_bytes)
    proof = strict_json(proof_bytes)
    assert proof["complete"]
    targets = []
    for target in proof["targets"]:
        name = "lib/" + target["name"]
        assert target["releaseExactMatch"] and target["allNoncustomSectionsEqual"]
        assert all(section["equal"] and section["releaseSha256"] == section["namesSha256"] for section in target["noncustomSections"])
        assert sha(binaries[name]) == target["pinned"]["sha256"]
        targets.append({"path": name, "sha256": sha(binaries[name]), "bodies": wasm_bodies(binaries[name]), "names": target["functionNames"]})
    events = strict_json(raw["baseline-profile/run-1.trace.json"])["traceEvents"]
    thread_names = {(event["pid"], event["tid"]): event["args"]["name"] for event in events if event.get("name") == "thread_name"}
    profiles = {}
    for order, event in enumerate(events):
        if event.get("name") not in ("Profile", "ProfileChunk"):
            continue
        key = (event["pid"], event["id"])
        item = profiles.setdefault(key, {"head": None, "chunks": []})
        if event["name"] == "Profile":
            assert item["head"] is None, "Duplicate profile head"
            item["head"] = event
        else:
            item["chunks"].append((order, event))
    assert len(profiles) == 11 and all(item["head"] is not None for item in profiles.values())
    numeric_by_url = defaultdict(set)
    for item in profiles.values():
        nodes, samples, deltas = {}, [], []
        # Original event order is retained. Signed deltas then produce timestamps;
        # timestamp/sample pairs are stably sorted below, as in DevTools.
        for order, event in item["chunks"]:
            data = event["args"]["data"]
            partial = data.get("cpuProfile", {})
            for node in partial.get("nodes", []):
                if node["id"] in nodes:
                    assert nodes[node["id"]] == node
                nodes[node["id"]] = node
                f = frame(node)
                match = re.fullmatch(r"wasm-function\[(\d+)\]", f["function"])
                if match and f["url"].startswith("wasm://"):
                    numeric_by_url[f["url"]].add((int(match.group(1)), f["line"], f["column"]))
            part_samples = partial.get("samples", [])
            part_deltas = data.get("timeDeltas", [])
            assert len(part_samples) == len(part_deltas)
            samples.extend(part_samples)
            deltas.extend(part_deltas)
        assert samples and len(samples) == len(deltas) and all(sample in nodes for sample in samples)
        assert all(isinstance(delta, (int, float)) and math.isfinite(delta) for delta in deltas)
        item.update(nodes=nodes, samples=samples, deltas=deltas)
    module_map = {}
    for url, frames in numeric_by_url.items():
        matches = []
        for target in targets:
            if all(line == 0 and index < len(target["bodies"]) and target["bodies"][index]["start"] <= column < target["bodies"][index]["end"] for index, line, column in frames):
                matches.append(target)
        if len(matches) == 1:
            module_map[url] = matches[0]
    binding["nativeMapping"] = {"proofSha256": PROOF_HASH, "rule": "Unique proven packaged module matching every numeric frame's function index and code-body column range; no index-only mapping", "mappedModules": {url: {"path": target["path"], "sha256": target["sha256"], "numericFrameLocations": len(numeric_by_url[url])} for url, target in module_map.items()}, "unmappedNumericModuleUrls": sorted(set(numeric_by_url) - set(module_map))}
    result_profiles = []
    aggregate = {}
    raw_samples = 0
    for (pid, profile_id), item in profiles.items():
        head, nodes = item["head"], item["nodes"]
        owner = head["tid"]
        clock = head["ts"]
        ordered = []
        for index, (sample, delta) in enumerate(zip(item["samples"], item["deltas"])):
            clock += delta
            ordered.append((clock, index, sample))
        ordered.sort(key=lambda value: (value[0], value[1]))
        role = role_for(nodes, thread_names.get((pid, owner), ""))
        totals = Counter()
        counts = Counter()
        rows = {}
        gaps = []
        for index, (timestamp, original_index, node_id) in enumerate(ordered):
            weight = ordered[index + 1][0] - timestamp if index + 1 < len(ordered) else 0
            assert weight >= 0
            gaps.append(weight)
            f = frame(nodes[node_id])
            kind = category(f, package_entries)
            totals[kind] += weight
            counts[kind] += 1
            match = re.fullmatch(r"wasm-function\[(\d+)\]", f["function"])
            if match and f["url"] in module_map:
                target = module_map[f["url"]]
                native_index = int(match.group(1))
                f["nativeFunctionIndex"] = native_index
                f["nativeFunctionName"] = target["names"][str(native_index)] if isinstance(target["names"], dict) else target["names"][native_index]
                f["nativeModule"] = target["path"]
                f["nativeModuleSha256"] = target["sha256"]
                f["nativeBodyRange"] = target["bodies"][native_index]
            key = (f["function"], f["url"], f["line"], f["column"], kind)
            row = rows.setdefault(key, {**f, "category": kind, "samples": 0, "observedForwardIntervalUs": 0})
            row["samples"] += 1
            row["observedForwardIntervalUs"] += weight
            all_row = aggregate.setdefault(key, {**f, "category": kind, "samples": 0, "observedForwardIntervalUs": 0, "profiles": set(), "roles": set()})
            all_row["samples"] += 1
            all_row["observedForwardIntervalUs"] += weight
            all_row["profiles"].add(f"{pid}/{profile_id}")
            all_row["roles"].add(role)
        span = ordered[-1][0] - ordered[0][0]
        assert sum(totals.values()) == span
        intervals = [(event["ts"], event["ts"] + event["dur"]) for event in events if event.get("name") == "RunTask" and event.get("ph") == "X" and event.get("pid") == pid and event.get("tid") == owner and event.get("dur", 0) >= 0]
        result_profiles.append({"pid": pid, "profileId": profile_id, "ownerTid": owner, "ownerThreadName": thread_names.get((pid, owner)), "role": role,
            "emitterTids": sorted({event["tid"] for _, event in item["chunks"]}), "chunkCount": len(item["chunks"]), "nodeCount": len(nodes), "sampleCount": len(ordered),
            "profileHeadTs": head["ts"], "rawProfileStartTime": head["args"]["data"].get("startTime"), "firstSampleTs": ordered[0][0], "lastSampleTs": ordered[-1][0],
            "unassignedInitialGapUs": ordered[0][0] - head["ts"], "terminalSampleUnweighted": True, "negativeRawDeltaCount": sum(delta < 0 for delta in item["deltas"]),
            "sumRawDeltasUs": sum(item["deltas"]), "observedSampleSpanUs": span, "maximumObservedIntervalUs": max(gaps), "medianObservedIntervalUs": statistics.median(gaps[:-1]),
            "categoryIntervalsUs": dict(totals), "categorySampleCounts": dict(counts), "frames": sorted(rows.values(), key=lambda value: value["observedForwardIntervalUs"], reverse=True),
            "taskIntervals": {"count": len(intervals), "summedDurationUs": sum(end - start for start, end in intervals), "unionDurationUs": union_duration(intervals), "boundary": "Observed RunTask wall intervals on the actual owner thread; not CPU time and not added across threads"}})
        raw_samples += len(ordered)
    assert raw_samples == instrumentation["cpuSampleCount"] == 37824
    chunks_with_profile = sum("cpuProfile" in event["args"]["data"] for item in profiles.values() for _, event in item["chunks"])
    assert chunks_with_profile == instrumentation["cpuProfileEventCount"] == 444
    for row in aggregate.values():
        row["profiles"] = sorted(row["profiles"])
        row["roles"] = sorted(row["roles"])
    assert git("status", "--porcelain", "--untracked-files=no") == ""
    binding["complete"] = True
    binding["analyzerSha256"] = sha(Path(__file__).read_bytes())
    save(out / "bindings.json", binding)
    result = {"schemaVersion": 1, "complete": True, "sourceArtifact": {"id": 15248139923, "sha256": OUTER_HASH, "sourcePr": 973, "runId": 46104197268},
        "sourceSha": BASE, "packageSha256": PACKAGE_HASH, "traceSha256": TRACE_HASH, "analyzerSha256": binding["analyzerSha256"],
        "newAcquisition": False, "authoritativeTiming": False, "comparativeTiming": False, "memoryQualification": False,
        "method": "Join ProfileChunk by(pid,profile id), owner TID from Profile head. Accumulate signed timeDeltas from head.ts, stably sort timestamp/sample pairs, attribute only observed intervals forward from each sample to the next. Leave initial gap and final sample duration unassigned; do not invent a final mean interval or perform DevTools program-node gap repair. These are sampled-stack occupancy estimates, not on-CPU measurements or wall-time savings.",
        "primaryReferences": ["https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/models/trace/handlers/SamplesHandler.ts", "https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/models/cpu_profile/CPUProfileDataModel.ts", "https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/js_protocol.json"],
        "coverage": {"traceEvents": len(events), "profileHeads": len(profiles), "profileChunks": sum(len(item["chunks"]) for item in profiles.values()), "chunksWithCpuProfile": chunks_with_profile,
            "rawSamples": raw_samples, "ownerThreads": len({(pid, item["head"]["tid"]) for (pid, _), item in profiles.items()}), "emitterThreads": len({(event["pid"], event["tid"]) for item in profiles.values() for _, event in item["chunks"]}),
            "roles": dict(Counter(item["role"] for item in result_profiles)), "orphanProfiles": 0, "negativeDeltasPreservedAndSorted": sum(sum(delta < 0 for delta in item["deltas"]) for item in profiles.values())},
        "waitBoundary": "The pinned sqlite3-opfs-async-proxy.js f frame at line454 includes Atomics.wait. Its self intervals are wait-capable occupancy and are not charged as CPU work. Other sampled frames can also include scheduling or native waits; no sampled interval here establishes exact CPU consumption.",
        "profileScope": instrumentation["captureBoundary"], "nativeMapping": binding["nativeMapping"],
        "profiles": result_profiles, "aggregateFrames": sorted(aggregate.values(), key=lambda value: value["observedForwardIntervalUs"], reverse=True),
        "originalDiagnosticTimingOnly": {"timing": summary["timing"], "workerTiming": summary["workerTiming"], "boundary": summary["timingBoundary"], "authoritativeTiming": False},
        "originalHost": summary["hostEnvironment"], "unmodifiedOriginalReceipt": "raw/baseline-profile/run-1.json"}
    save(out / "analysis.json", result)
    concise = {key: result[key] for key in ["complete", "sourceSha", "packageSha256", "traceSha256", "newAcquisition", "authoritativeTiming", "coverage"]}
    concise["profiles"] = [{key: item[key] for key in ["profileId", "ownerTid", "role", "sampleCount", "observedSampleSpanUs", "unassignedInitialGapUs", "negativeRawDeltaCount", "categoryIntervalsUs"]} for item in result_profiles]
    concise["largestSampledFramesExcludingWaitIdleAndInstrumentation"] = [{key: row[key] for key in ["function", "url", "category", "samples", "observedForwardIntervalUs", "roles"]} | ({"nativeFunctionName": row["nativeFunctionName"]} if "nativeFunctionName" in row else {}) for row in result["aggregateFrames"] if row["category"] not in ["idle", "wait-capable-proxy-occupancy-not-cpu", "instrumentation", "runtime-unattributed"]][:20]
    save(out / "summary.json", concise)
    print(json.dumps(concise, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact", required=True, type=Path)
    parser.add_argument("--baseline-root", required=True, type=Path)
    parser.add_argument("--native-proof", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args()
    try:
        analyze(arguments)
    except Exception as error:
        failure = {"complete": False, "newAcquisition": False, "type": type(error).__name__, "message": str(error)[:4096]}
        if arguments.output.exists() and not (arguments.output / "analysis-failure.json").exists():
            save(arguments.output / "analysis-failure.json", failure)
        print(json.dumps(failure))
        raise
