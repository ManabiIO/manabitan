#!/usr/bin/env python3
"""Acquire frozen-source import diagnostics, not a candidate speed comparison.

Every ordinary and traced observation uses the same unchanged strict browser
harness. The trace is acquired separately and must never be counted as an
authoritative timing observation. Media verification uses another fresh import.
"""

import argparse
import collections
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import traceback
import zipfile


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def git(source, *arguments):
    return subprocess.check_output(["git", *arguments], cwd=source, text=True).strip()


def emit(label, value):
    print(label + " " + json.dumps(value, sort_keys=True, separators=(",", ":")), flush=True)


def identity(source, expected_source, dictionary):
    source_sha = git(source, "rev-parse", "HEAD")
    status = git(source, "status", "--porcelain")
    if source_sha != expected_source or status:
        raise RuntimeError(f"Product source is not the frozen clean revision: {source_sha} {status}")
    lock_path = source / "test/perf/dictionaries.lock.json"
    fixture = json.loads(lock_path.read_text())["dictionaries"][dictionary]
    fixture_path = source / "builds/e2e-dictionary-cache" / fixture["cacheFile"]
    fixture_sha = digest(fixture_path)
    if fixture_sha != fixture["sha256"] or fixture_path.stat().st_size != fixture["sizeBytes"]:
        raise RuntimeError("Locked dictionary size or SHA-256 mismatch")
    archive_path = source / "builds/manabitan-chrome.zip"
    with zipfile.ZipFile(archive_path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise RuntimeError("Release package contains duplicate names")
        members = {
            item.filename: hashlib.sha256(archive.read(item)).hexdigest()
            for item in archive.infolist() if not item.is_dir()
        }
    source_paths = (
        "package-lock.json", "test/perf/dictionaries.lock.json",
        "dev/perf/import-benchmark.js", "dev/perf/benchmark-support.js",
        "dev/perf/dictionary-fixtures.js", "dev/perf/import-media-validation.js",
        "test/chromium/extension-two-dictionary-import.e2e.js",
        "test/e2e/import-timing.js", "ext/js/dictionary/dictionary-importer.js",
        "ext/js/dictionary/dictionary-database.js",
        "ext/js/dictionary/term-bank-wasm-parser.js",
        "ext/js/dictionary/term-record-opfs-store.js",
        "ext/js/dictionary/term-content-block-store.js",
    )
    source_hashes = {path: digest(source / path) for path in source_paths if (source / path).is_file()}
    source_hashes.update({str(path.relative_to(source)): digest(path)
                          for path in (source / "ext/js/dictionary/wasm").rglob("*.c")})
    native_files = list((source / "ext").rglob("*.wasm"))
    native_hashes = {str(path.relative_to(source)): digest(path) for path in native_files}
    executable_path = pathlib.Path(subprocess.check_output([
        "node", "--input-type=module", "-e",
        "import {chromium} from 'playwright'; process.stdout.write(chromium.executablePath())",
    ], cwd=source, text=True))
    browser_version_output = subprocess.check_output([str(executable_path), "--version"], text=True).strip()
    browser_version = re.search(r"\d+\.\d+\.\d+\.\d+", browser_version_output).group(0)
    node_version = subprocess.check_output(["node", "--version"], text=True).strip()
    if node_version != "v22.22.0" or browser_version != "153.0.8010.12":
        raise RuntimeError(f"Unexpected runtime versions: {node_version} / {browser_version}")
    return {
        "sourceSha": source_sha,
        "sourceTree": git(source, "rev-parse", "HEAD^{tree}"),
        "sourceStatus": status,
        "packageSha256": digest(archive_path),
        "packageMembers": members,
        "sourceHashes": source_hashes,
        "nativeHashes": native_hashes,
        "fixture": fixture,
        "fixtureSha256": fixture_sha,
        "browserVersion": browser_version,
        "browserBinarySha256": digest(executable_path),
        "nodeVersion": node_version,
    }


def summarize_trace(path):
    events = json.loads(path.read_text())["traceEvents"]
    nodes = {}
    chunks = []
    thread_names = {}
    for event in events:
        if event.get("name") == "thread_name":
            thread_names[(event.get("pid"), event.get("tid"))] = event.get("args", {}).get("name")
        data = event.get("args", {}).get("data", {})
        profile = data.get("cpuProfile")
        if profile is None:
            continue
        key = (event.get("pid"), event.get("tid"), str(event.get("id2", event.get("id"))))
        for node in profile.get("nodes", []):
            nodes[(key, node["id"])] = node
        chunks.append((key, profile.get("samples", []), data.get("timeDeltas", [])))
    sampled_time = collections.Counter()
    counts = collections.Counter()
    thread_time = collections.defaultdict(collections.Counter)
    thread_counts = collections.defaultdict(collections.Counter)
    missing_nodes = 0
    missing_deltas = 0
    nonpositive_deltas = 0
    for key, samples, deltas in chunks:
        for index, node_id in enumerate(samples):
            node = nodes.get((key, node_id))
            if node is None:
                missing_nodes += 1
            frame = (node or {}).get("callFrame", {})
            frame_key = (frame.get("functionName", "<unresolved>"), frame.get("url", ""), frame.get("lineNumber"))
            counts[frame_key] += 1
            thread_counts[key[:2]][frame_key] += 1
            if index >= len(deltas):
                missing_deltas += 1
                continue
            delta = deltas[index]
            if delta <= 0:
                nonpositive_deltas += 1
            sampled_time[frame_key] += delta
            thread_time[key[:2]][frame_key] += delta

    def rows(counter, limit, sample_counts=counts):
        return [
            {"function": key[0], "url": key[1], "lineNumber": key[2],
             "sampledMs": round(value / 1000, 3), "samples": sample_counts[key]}
            for key, value in counter.most_common(limit)
        ]

    nonidle = collections.Counter({key: value for key, value in sampled_time.items() if key[0] != "(idle)"})
    return {
        "scope": "Diagnostic aggregate V8 samples across threads; not additive import latency or candidate timings. Blocked Atomics.wait can be attributed to its JavaScript caller and is not proof of busy CPU work.",
        "traceSha256": digest(path),
        "samples": sum(counts.values()),
        "missingNodes": missing_nodes,
        "missingDeltas": missing_deltas,
        "nonpositiveDeltas": nonpositive_deltas,
        "functions": rows(sampled_time, 80),
        "nonidleFunctions": rows(nonidle, 40),
        "threads": [
            {"pid": key[0], "tid": key[1], "name": thread_names.get(key), "functions": rows(value, 12, thread_counts[key])}
            for key, value in thread_time.items()
        ],
    }


def summarize_observation(summary, frozen, trace, media_check):
    if summary["gitSha"] != frozen["sourceSha"] or summary["source"]["dirty"] is not False:
        raise RuntimeError("Observation source identity mismatch")
    if (summary["browserVersion"] != frozen["browserVersion"] or
            summary["fixture"] != frozen["fixture"] or
            summary["traceEnabled"] is not trace or
            summary["authoritativeTiming"] is not (not trace) or
            summary["mediaCheck"] != media_check or
            summary["importFlags"] is not None or len(summary["runs"]) != 1):
        raise RuntimeError("Observation runtime or configuration mismatch")
    row = summary["runs"][0]
    if row["packageSha256"] != frozen["packageSha256"]:
        raise RuntimeError("Observation package identity mismatch")
    validation = row["validation"]
    debug = row["importDebug"]
    phases = []
    for phase in debug.get("importerPhaseTimings", []):
        compact = {key: phase[key] for key in ("phase", "elapsedMs") if key in phase}
        details = phase.get("details", {})
        compact["counters"] = {
            key: value for key, value in details.items()
            if re.search(r"Ms$|WorkerCount|Source.*Bytes|[Rr]ows|[Bb]ytes|[Ff]allback|[Ss]kipReason|[Gg]roupCount|[Ss]egmentCount|Native.*Count", key)
            and (value is None or isinstance(value, (str, int, float, bool)))
        }
        phases.append(compact)
    lookup = validation["lookup"]
    lookup_projection = [{key: item[key] for key in ("pass", "term", "results", "sha256")} for item in lookup["observations"]]
    return {
        "sourceSha": frozen["sourceSha"],
        "packageSha256": frozen["packageSha256"],
        "dictionary": summary["dictionary"],
        "traceEnabled": trace,
        "authoritativeTiming": not trace,
        "scope": "Single baseline diagnostic; no improvement or comparative performance estimate",
        "browserVersion": summary["browserVersion"],
        "host": summary["hostEnvironment"],
        "totalImportMs": row["totalImportMs"],
        "workerImportMs": row["workerImportMs"],
        "stepTimingSummary": row["stepTimingSummary"],
        "step4Breakdown": row["step4Breakdown"],
        "localPhases": debug.get("localPhaseTimings", []),
        "importerPhases": phases,
        "validation": {
            key: value for key, value in validation.items() if key != "lookup"
        },
        "normalizedStorage": normalize_storage(validation["storage"]),
        "lookupObservationCount": len(lookup_projection),
        "lookupReceiptSha256": hashlib.sha256(json.dumps(lookup_projection, sort_keys=True).encode()).hexdigest(),
        "lookupReceipts": lookup_projection,
    }


def normalize_storage(storage):
    """Preserve all exact sizes while normalizing only known random basenames."""
    if storage.get("kind") != "OPFS logical file sizes after restart and verification":
        raise RuntimeError("Unexpected storage receipt kind")
    seen = set()
    files = []
    for item in storage["files"]:
        path = item["path"]
        size = item["bytes"]
        if path in seen or type(size) is not int or size < 0:
            raise RuntimeError("Duplicate storage path or invalid byte count")
        seen.add(path)
        if path.startswith("manabitan/sqlite-sahpool-v1/.opaque/"):
            if re.fullmatch(r"manabitan/sqlite-sahpool-v1/\.opaque/[a-z0-9]+", path) is None:
                raise RuntimeError("Unrecognized SQLite opaque basename")
            path = "manabitan/sqlite-sahpool-v1/.opaque/{opaque}"
        elif path.startswith("manabitan-dictionary-media-v1/"):
            if re.fullmatch(r"manabitan-dictionary-media-v1/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.bin", path) is None:
                raise RuntimeError("Unrecognized media generation basename")
            path = "manabitan-dictionary-media-v1/{generation}.bin"
        files.append({"path": path, "bytes": size})
    if type(storage["bytes"]) is not int or storage["bytes"] != sum(item["bytes"] for item in files):
        raise RuntimeError("Storage total does not equal the complete inventory")
    return {"kind": storage["kind"], "bytes": storage["bytes"],
            "files": sorted(files, key=lambda item: (item["path"], item["bytes"]))}


def acquire(source, output, dictionary, label, trace, media_check, frozen):
    target = output / label
    command = ["node", "dev/perf/import-benchmark.js", dictionary, "--runs", "1", "--no-build",
               "--build-target", "chrome", "--media-check", media_check, "--output", str(target)]
    if trace:
        command.append("--trace")
    before = identity(source, frozen["sourceSha"], dictionary)
    if before != frozen:
        raise RuntimeError("Frozen source, runtime, fixture or package changed before observation")
    with (output / (label + ".log")).open("wb") as log:
        result = subprocess.run(command, cwd=source, stdout=log, stderr=subprocess.STDOUT, timeout=1800)
    if result.returncode:
        print((output / (label + ".log")).read_text(errors="replace")[-16000:], flush=True)
        raise RuntimeError(f"Import failed: {label}; original log retained")
    if identity(source, frozen["sourceSha"], dictionary) != frozen:
        raise RuntimeError("Frozen source, runtime, fixture or package changed during observation")
    summary = json.loads((target / "summary.json").read_text())
    receipt = summarize_observation(summary, frozen, trace, media_check)
    write_json(output / (label + "-receipt.json"), receipt)
    emit("IMPORT_RECEIPT", {"observation": label, **receipt})
    if trace:
        hotspots = summarize_trace(target / "run-1.trace.json")
        write_json(output / "cpu-hotspots.json", hotspots)
        emit("IMPORT_CPU_HOTSPOTS", hotspots)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=pathlib.Path, required=True)
    parser.add_argument("--expected-source", required=True)
    parser.add_argument("--dictionary", choices=("jmdict", "jitendex", "vndb"), required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-f0-9]{40}", args.expected_source):
        parser.error("Expected source must be a complete commit SHA")
    source = args.source.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    write_json(output / "plan.json", {
        "sourceSha": args.expected_source,
        "dictionary": args.dictionary,
        "schedule": ["ordinary", "trace"] + ([] if args.dictionary == "jmdict" else ["all-media"]),
        "failurePolicy": "Stop on first failure; keep every original observation and log",
        "comparison": False,
        "productOrHarnessOverlay": False,
    })
    try:
        frozen = identity(source, args.expected_source, args.dictionary)
        write_json(output / "identity.json", frozen)
        emit("IMPORT_IDENTITY", {key: value for key, value in frozen.items() if key != "packageMembers"})
        receipts = [acquire(source, output, args.dictionary, "ordinary", False, "sample", frozen)]
        receipts.append(acquire(source, output, args.dictionary, "trace", True, "sample", frozen))
        if args.dictionary != "jmdict":
            receipts.append(acquire(source, output, args.dictionary, "all-media", False, "all", frozen))
        first = receipts[0]
        for receipt in receipts[1:]:
            if receipt["lookupReceipts"] != first["lookupReceipts"]:
                raise RuntimeError("Persisted lookup results differ between baseline observations")
            if receipt["normalizedStorage"] != first["normalizedStorage"]:
                raise RuntimeError("Baseline observations differ in exact normalized storage inventory")
            for field in ("restart", "termRows", "title", "revision"):
                if receipt["validation"][field] != first["validation"][field]:
                    raise RuntimeError(f"Baseline observations differ in {field}")
        write_json(output / "complete.json", {"status": "passed", "observations": len(receipts), "comparison": False})
        emit("IMPORT_DIAGNOSTIC_COMPLETE", {"status": "passed", "dictionary": args.dictionary, "observations": len(receipts)})
    except Exception as error:
        write_json(output / "failure.json", {"error": str(error), "traceback": traceback.format_exc()})
        emit("IMPORT_DIAGNOSTIC_FAILURE", {"dictionary": args.dictionary, "error": str(error)})
        raise


if __name__ == "__main__":
    main()
