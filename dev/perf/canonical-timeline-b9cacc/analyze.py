#!/usr/bin/env python3
"""Validate one marks-only JMdict observation and bound next-group overlap."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import pathlib
import re
import sys

from instrument import BASE, PRODUCT_PATHS, RUNTIME, SOURCES

PHASE = "canonical-lookahead-diagnostic-b9cacc"
FIXTURE = {
    "label": "JMdict", "cacheFile": "JMdict.zip", "release": "2026-11-22",
    "url": "https://github.com/yomidevs/jmdict-yomitan/releases/download/2026-11-22/JMdict_english.zip",
    "sha256": "3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f",
    "sizeBytes": 15645766, "expectedTitle": "JMdict [2026-11-22]",
    "revision": "JMdict.2026-11-22", "termRows": 528299, "mediaFiles": 0, "mediaBytes": 0,
}
PROBES = ["ヽ", "タカリ", "アケイシャ", "エープリル・フール", "理にかなう", "インターロック回路",
          "緊急電話", "若しもの事", "タワレコ", "全国信連協会", "ニルスのふしぎな旅", "アテン"]
OUTPUT_DIGEST = "e88726c0d84ad9f6e9b7cf4455783fee169a41bf0cbfe3252386cec59791117d"
LIMITATIONS = [
    "Instrumented one-run diagnostic. No performance improvement, regression, or confidence interval is inferred.",
    "A window begins after the current record promise was obtained, not after every record I/O dispatch. Known synchronous record validation and encoding are removed, but other CPU work, microtasks, OS descheduling, and instrumentation remain.",
    "Canonical counter time excludes the existing exact-compare counter; it is not a thread CPU measurement. Whole preparation span includes waits.",
    "The proposed preparation has not run. Its contention, failure-drain behavior, extra live metadata, arena growth, and source lifetime could reduce or eliminate this ceiling.",
    "Group readiness is observed in the storage/import worker, immediately before the existing result-slot resolve. It is not parser-worker completion time.",
    "Content completion is observed in the already-existing completion handler. Record completion is observed after the already-existing record-store await. Neither marker adds a promise handler.",
    "Standard row-count, content probes, restart, and lookup checks are retained; they do not prove byte equality of every stored record.",
]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def finite(value: object, name: str, minimum: float = 0) -> float:
    require(type(value) in (int, float) and math.isfinite(value) and value >= minimum,
            f"Invalid {name}: {value!r}")
    return float(value)


def integer(value: object, name: str, minimum: int = 0) -> int:
    require(type(value) is int and value >= minimum, f"Invalid {name}: {value!r}")
    return value


def digest(value: object, name: str) -> str:
    require(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None,
            f"Invalid {name}")
    return value


def validate_acquisition(summary: dict, manifest: dict, receipt: dict) -> dict:
    require(summary.get("schemaVersion") == 3, "Unsupported benchmark summary")
    require(summary.get("dictionary") == "jmdict" and summary.get("fixture") == FIXTURE, "Fixture identity drift")
    require(summary.get("buildTarget") == "chrome", "Expected Chrome release package")
    require(summary.get("authoritativeTiming") is False, "Instrumented timing must not be authoritative")
    require(summary.get("diagnosticScope") == manifest.get("scope") and isinstance(manifest.get("scope"), str),
            "Missing diagnostic-scope declaration")
    require(summary.get("traceEnabled") is False, "This is the marks-only diagnostic, not a CPU trace")
    require(summary.get("importFlags") is None, "Production import defaults were overridden")
    require(summary.get("mediaCheck") == "sample", "Unexpected media verification mode")
    require(summary.get("gitSha") == BASE and summary["source"].get("gitSha") == BASE, "Benchmark source HEAD drift")
    require(summary["source"].get("dirty") is True, "Expected explicitly instrumented source")
    require(manifest.get("baseline") == BASE and receipt.get("baseline") == BASE, "Instrumentation baseline drift")
    require(receipt.get("sourceVerified") is True, "Missing successful source verification")
    require(set(manifest.get("files", {})) == set(SOURCES), "Unexpected instrumentation source set")
    for path, expected in SOURCES.items():
        entry = manifest["files"][path]
        require(entry.get("beforeSha256") == expected, f"Baseline file drift: {path}")
        digest(entry.get("afterSha256"), path)
        if path in PRODUCT_PATHS:
            require(entry.get("inverseByteProof") is True and integer(entry.get("markerCount"), path) > 0,
                    f"Missing exact removable-marker proof: {path}")
    require(manifest.get("runtime", {}).get("path") == RUNTIME, "Unexpected instrumentation runtime")
    digest(manifest["runtime"].get("sha256"), RUNTIME)
    source_hashes = summary["source"]["sha256"]
    for path, expected in manifest["unchangedInputs"].items():
        if path in source_hashes:
            require(source_hashes[path] == expected, f"Benchmark input hash drift: {path}")
    require(source_hashes.get("dev/perf/import-benchmark.js") == manifest["files"]["dev/perf/import-benchmark.js"]["afterSha256"],
            "Benchmark did not use the non-authoritative acquisition wrapper")
    package = receipt.get("package", {})
    package_hash = digest(package.get("sha256"), "verified package")
    require(source_hashes.get("builds/manabitan-chrome.zip") == package_hash, "Benchmark package receipt mismatch")
    entries = package.get("entries", {})
    for path in (*PRODUCT_PATHS, RUNTIME):
        expected = manifest["runtime"]["sha256"] if path == RUNTIME else manifest["files"][path]["afterSha256"]
        require(entries.get(path.removeprefix("ext/")) == expected, f"Packaged diagnostic mismatch: {path}")
    runs = summary.get("runs", [])
    require(len(runs) == 1, "Exactly one diagnostic observation is permitted")
    run = runs[0]
    require(run.get("index") == 1 and run.get("packageSha256") == package_hash, "Run/package identity mismatch")
    require(run.get("tracePath") is None, "Unexpected simultaneous trace acquisition")
    debug = run["importDebug"]
    require(debug.get("hasResult") is True and debug.get("errorCount") == 0 and debug.get("addSettingsErrorCount") == 0,
            "Import reported an error")
    require(debug.get("usesFallbackStorage") is False, "Fallback storage is not the intended diagnostic path")
    validation = run["validation"]
    for observed in (validation, validation.get("restart", {})):
        for key, expected in {"title": FIXTURE["expectedTitle"], "revision": FIXTURE["revision"],
                              "termRows": FIXTURE["termRows"], "contentReadable": True, "probeCount": 12}.items():
            require(observed.get(key) == expected, f"Import/restart validation failed: {key}")
    require(validation.get("probeTerms") == PROBES, "Probe identity/order changed")
    require(validation.get("outputDigestSha256") == OUTPUT_DIGEST, "Known exact-9e10 probe output digest changed")
    require(validation["restart"].get("mediaFiles") == 0, "Unexpected restart media")
    media = validation.get("media", {})
    require(media.get("mode") == "sample" and all(media.get(k) == 0 for k in ("totalFiles", "totalBytes", "files", "bytes")),
            "Unexpected media receipt")
    require(media.get("sha256") == hashlib.sha256(b"").hexdigest(), "Empty media digest changed")
    observations = validation.get("lookup", {}).get("observations", [])
    require(len(observations) == 72, "Expected 72 post-restart lookup observations")
    seen = set()
    hashes = {}
    for observation in observations:
        key = (observation.get("pass"), observation.get("term"))
        require(key[0] in range(6) and key[1] in PROBES and key not in seen, "Duplicate or invalid lookup observation")
        seen.add(key)
        require(observation.get("hasExactHeadwordMatch") is True and integer(observation.get("results"), "lookup results", 1) > 0,
                "Lookup verification failed")
        finite(observation.get("elapsedMs"), "lookup elapsed")
        value = digest(observation.get("sha256"), "lookup output")
        require(hashes.setdefault(key[1], value) == value, "Lookup output changed across passes")
    return run


def union_length(intervals: list[tuple[float, float]], start: float, end: float) -> float:
    clipped = sorted((max(start, a), min(end, b)) for a, b in intervals if b > start and a < end)
    total = 0.0
    last = start
    for a, b in clipped:
        if b > max(a, last):
            total += b - max(a, last)
            last = b
    return total


def paired_cpu_spans(events: list[dict], prefix: str) -> list[tuple[float, float]]:
    result = []
    active = None
    for event in events:
        if event["event"] == prefix + "-start":
            require(active is None, f"Nested or duplicate {prefix} start")
            active = event
        elif event["event"] == prefix + "-end":
            require(active is not None, f"Unmatched {prefix} end")
            require(event["atMs"] >= active["atMs"], f"Reversed {prefix} interval")
            if prefix == "record-validation":
                require(event["details"].get("runStart") == active["details"].get("runStart"), "Record run identity changed")
            else:
                require(event["details"].get("rows") == active["details"].get("rows"), "Record encoding row count changed")
            result.append((active["atMs"], event["atMs"]))
            active = None
    require(active is None, f"Unmatched {prefix} start")
    return result


def analyze_timeline(data: dict, expected_rows: int, aggregate: dict | None = None) -> dict:
    require(data.get("schemaVersion") == 1 and data.get("authoritativeTiming") is False, "Unsupported/authoritative timeline")
    require(data.get("recorderErrors") == 0 and data.get("droppedEvents") == 0 and data.get("unboundEvents") == {},
            "Recorder lost or could not associate events")
    finite(data.get("timeOriginMs"), "worker time origin")
    require(len(data.get("runs", [])) == 1, "Expected one parallel pipeline")
    pipeline = data["runs"][0]
    require(pipeline.get("run") == 0, "Unexpected pipeline identity")
    count = integer(pipeline.get("groupCount"), "group count", 2)
    workers = integer(pipeline.get("workerCount"), "worker count", 1)
    started_at = finite(pipeline.get("startedAtMs"), "pipeline start")
    descriptors = {}
    for group in data.get("groups", []):
        index = integer(group.get("group"), "group index")
        require(group.get("run") == 0 and index < count and index not in descriptors, "Invalid/duplicate group descriptor")
        integer(group.get("rowCount"), "group rows", 1)
        integer(group.get("uniqueCount"), "canonical unique count", 1)
        require(group["uniqueCount"] <= group["rowCount"], "Unique count exceeds rows")
        require(group.get("mediaRows") == 0, "Media-dependent chunks are outside this lookahead scope")
        integer(group.get("sourceBytes"), "source bytes", 1)
        integer(group.get("ownedContentBytes"), "owned content bytes")
        require(type(group.get("borrowsWorkerMemory")) is bool, "Missing borrowed-source ownership description")
        finite(group.get("resultFinishedAtMs"), "result arrival")
        descriptors[index] = group
    require(set(descriptors) == set(range(count)), "Incomplete group descriptors")
    require(sum(g["rowCount"] for g in descriptors.values()) == expected_rows, "Timeline row count mismatch")
    by_group = {i: [] for i in range(count)}
    last = started_at
    allowed = {"group-ready", "sink-enter", "sink-exit", "dedup-start", "dedup-end", "canonical-start", "canonical-end",
               "content-storage-ready", "metadata-published", "lookahead-gate", "content-done", "join-done", "record-start", "record-done",
               "record-validation-start", "record-validation-end", "record-encode-start", "record-encode-end"}
    for sequence, event in enumerate(data.get("events", [])):
        require(event.get("sequence") == sequence and event.get("run") == 0 and event.get("group") in by_group,
                "Invalid event sequence/group")
        require(event.get("event") in allowed and isinstance(event.get("details"), dict), "Unknown/malformed event")
        timestamp = finite(event.get("atMs"), "event time")
        require(timestamp >= last, "Worker clock/events are not monotonic")
        last = timestamp
        by_group[event["group"]].append(event)
    observed = []
    cpu_spans = []
    for index in range(count):
        events = by_group[index]
        singles = {}
        for event in events:
            if event["event"].startswith(("record-validation-", "record-encode-")):
                continue
            require(event["event"] not in singles, f"Duplicate group event: {index}/{event['event']}")
            singles[event["event"]] = event
        required = ["group-ready", "sink-enter", "dedup-start", "canonical-start", "canonical-end", "dedup-end", "record-start", "record-done", "sink-exit"]
        require(all(name in singles for name in required), f"Missing essential group events: {index}")
        require([singles[n]["sequence"] for n in required] == sorted(singles[n]["sequence"] for n in required),
                f"Invalid group lifecycle order: {index}")
        require(descriptors[index]["resultFinishedAtMs"] <= singles["group-ready"]["atMs"], "Ready marker precedes result arrival")
        if index:
            require(observed[-1]["timesMs"]["sink-exit"] <= singles["sink-enter"]["atMs"], "Ordered sinks overlap")
        canonical = finite(singles["canonical-end"]["details"].get("canonicalMs"), "canonical counter")
        exact = finite(singles["canonical-end"]["details"].get("exactMs"), "exact compare counter")
        pending = integer(singles["canonical-end"]["details"].get("pendingCount"), "pending content count")
        canonical_wall = singles["canonical-end"]["atMs"] - singles["canonical-start"]["atMs"]
        require(canonical + exact <= canonical_wall + 1, "Canonical counters exceed observed span")
        published = singles.get("metadata-published")
        early = published is not None and published["details"].get("early") is True
        if pending > 0:
            require(published is not None and "content-storage-ready" in singles, "Missing publication/storage marks")
            require(type(published["details"].get("early")) is bool, "Missing early-storage classification")
            require(singles["content-storage-ready"]["details"].get("early") is early, "Inconsistent early-storage classification")
            sequence = ["dedup-end", "content-storage-ready", "metadata-published", "record-start"]
            require([singles[n]["sequence"] for n in sequence] == sorted(singles[n]["sequence"] for n in sequence),
                    "Storage/publication/record order changed")
        else:
            require(published is None and "content-storage-ready" not in singles, "Unexpected storage for zero pending content")
        if early:
            require(all(n in singles for n in ("lookahead-gate", "content-done", "join-done")), "Missing early-content join marks")
            for chain in (("record-start", "lookahead-gate", "content-done", "join-done", "sink-exit"),
                          ("lookahead-gate", "record-done", "join-done")):
                require([singles[n]["sequence"] for n in chain] == sorted(singles[n]["sequence"] for n in chain), "Invalid early join lifecycle")
        else:
            require(not any(n in singles for n in ("lookahead-gate", "content-done", "join-done")), "Unexpected speculative-eligibility gate")
        spans = paired_cpu_spans(events, "record-validation") + paired_cpu_spans(events, "record-encode")
        require(len(spans) >= 2, "Missing record CPU observations")
        require(all(singles["record-start"]["atMs"] <= a <= b <= singles["record-done"]["atMs"] for a, b in spans),
                "Record CPU spans escape the record operation")
        cpu_spans.extend(spans)
        observed.append({**descriptors[index], "earlyContentJoin": early, "pendingContentCount": pending,
                         "timesMs": {name: event["atMs"] for name, event in singles.items()},
                         "canonicalCounterMs": canonical, "exactCompareCounterMs": exact,
                         "canonicalSpanMs": canonical_wall,
                         "preparationSpanMs": singles["dedup-end"]["atMs"] - singles["dedup-start"]["atMs"],
                         "recordCpuSpansMs": spans})
    if aggregate is not None:
        for key, expected in {"rows": expected_rows, "parserParallelGroupCount": count, "parserParallelWorkerCount": workers,
                              "dedupNativeFallbackCount": 0, "parserFusedFallbacks": 0}.items():
            require(aggregate.get(key) == expected, f"Ordinary aggregate/timeline disagreement: {key}")
    pairs = []
    for current, following in zip(observed, observed[1:]):
        row = {"currentGroup": current["group"], "nextGroup": following["group"],
               "eligible": current["earlyContentJoin"], "nextReadyAtMs": following["timesMs"]["group-ready"],
               "nextCanonicalCounterMs": following["canonicalCounterMs"], "nextPreparationSpanMs": following["preparationSpanMs"]}
        if current["earlyContentJoin"]:
            start = max(current["timesMs"]["lookahead-gate"], row["nextReadyAtMs"])
            end = current["timesMs"]["join-done"]
            apparent = max(0.0, end - start)
            occupied = union_length(cpu_spans, start, end) if apparent else 0.0
            residual = max(0.0, apparent - occupied)
            row.update({"gateAtMs": current["timesMs"]["lookahead-gate"], "joinAtMs": end,
                        "windowStartAtMs": start, "apparentWindowMs": apparent, "knownRecordCpuMs": occupied,
                        "residualWindowCeilingMs": residual,
                        "canonicalWorkOverlapCeilingMs": min(residual, following["canonicalCounterMs"]),
                        "wholePreparationOverlapCeilingMs": min(residual, following["preparationSpanMs"])})
        else:
            row.update({"reason": "Current group has no early content/record join", "apparentWindowMs": 0.0,
                        "knownRecordCpuMs": 0.0, "residualWindowCeilingMs": 0.0,
                        "canonicalWorkOverlapCeilingMs": 0.0, "wholePreparationOverlapCeilingMs": 0.0})
        pairs.append(row)
    totals = {key: sum(row[key] for row in pairs) for key in (
        "apparentWindowMs", "knownRecordCpuMs", "residualWindowCeilingMs",
        "canonicalWorkOverlapCeilingMs", "wholePreparationOverlapCeilingMs")}
    totals.update({"groupCount": count, "workerCount": workers, "eligiblePairCount": sum(p["eligible"] for p in pairs),
                   "readyWithinWindowPairCount": sum(p["apparentWindowMs"] > 0 for p in pairs),
                   "allCanonicalCounterMs": sum(g["canonicalCounterMs"] for g in observed),
                   "firstGroupCanonicalCounterMsExcluded": observed[0]["canonicalCounterMs"]})
    return {"schemaVersion": 1, "authoritativeTiming": False, "limits": LIMITATIONS,
            "totals": totals, "pairs": pairs, "groups": observed}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--summary", required=True, type=pathlib.Path)
    parser.add_argument("--instrumentation-dir", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()
    summary = json.loads(args.summary.read_text())
    manifest = json.loads((args.instrumentation_dir / "instrumentation.json").read_text())
    receipt = json.loads((args.instrumentation_dir / "verified-source-package.json").read_text())
    run = validate_acquisition(summary, manifest, receipt)
    phases = run["importDebug"]["importerPhaseTimings"]
    diagnostic = [p["details"] for p in phases if p.get("phase") == PHASE]
    require(len(diagnostic) == 1, "Expected exactly one diagnostic phase")
    aggregates = [p["details"] for p in phases if p.get("phase", "").startswith("term-file-fast-path:")]
    require(len(aggregates) == 1, "Expected one native term-bank aggregate")
    data = diagnostic[0]
    result = analyze_timeline(data, FIXTURE["termRows"], aggregates[0])
    result["identity"] = {"baseline": BASE, "fixture": FIXTURE, "packageSha256": receipt["package"]["sha256"],
                          "summarySha256": hashlib.sha256(args.summary.read_bytes()).hexdigest(),
                          "instrumentation": manifest, "browserVersion": summary["browserVersion"],
                          "hostEnvironment": summary["hostEnvironment"], "workerTimeOriginMs": data["timeOriginMs"]}
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "raw-events.json").write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    (args.output / "overlap-ceilings.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({"authoritativeTiming": False, "scope": "Diagnostic overlap ceilings; not a speedup prediction", **result["totals"]}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"canonical-timeline analysis rejected: {error}", file=sys.stderr)
        raise
