#!/usr/bin/env python3
"""NEW serial, untimed full-corpus correctness acquisition; no timing comparisons."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys

BASELINE = "a300da36d00df8e353c5679b1528b50a1299b75f"
DICTIONARIES = ("jmdict", "jitendex", "vndb")
EXPECTED_GROUPS = {"jmdict": 12, "jitendex": 22, "vndb": 170}
EXPECTED_RUNTIME_DELTA = {
    "js/dictionary/dictionary-database.js",
    "js/dictionary/term-record-opfs-store.js",
    "js/dictionary/term-record-fields.js",
    "js/dictionary/term-bank-wasm-parser.js",
    "js/dictionary/term-record-prepared-fields.js",
    "js/dictionary/wasm/term-record-fields.c",
    "lib/term-record-fields.wasm",
}
PARSER_KEYS = (
    "fastPathParserFusedAttempts", "fastPathParserFusedFallbacks",
    "fastPathParserSourceTransferredBytes",
    "fastPathParserSourceCrcScannedBytes", "fastPathParserSourceCrcReusedBytes",
    "fastPathParserSourceCrcReusedGlossaryCount",
    "fastPathParserSourceCompressedBytes", "fastPathParserSourceUncompressedBytes",
    "fastPathParserCompactContentMetadataGroups",
    "fastPathParserParallelWorkerCount", "fastPathParserParallelPipelineGroupsPerWorker",
    "fastPathParserParallelGroupCount", "fastPathParserParallelSkipReason",
)


class CorrectnessError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise CorrectnessError(message)


def read_json(path):
    def invalid(value):
        raise CorrectnessError("Nonfinite JSON: " + value)
    return json.loads(Path(path).read_text(), parse_constant=invalid)


def save(path, value):
    Path(path).write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n")


def digest(path):
    with Path(path).open("rb") as stream:
        return {"bytes": os.fstat(stream.fileno()).st_size,
                "sha256": hashlib.file_digest(stream, "sha256").hexdigest()}


def source_receipts(directory):
    result = {}
    for path in sorted(Path(directory).iterdir()):
        if path.is_file():
            result[path.name] = digest(path)
    return result


def emit(value):
    """Preserve compact source/receipt evidence in logs without acquiring any work."""
    print(json.dumps(value, sort_keys=True, allow_nan=False), flush=True)


def runtime_inventory(root):
    root = Path(root)
    require(root.is_dir() and not root.is_symlink(), "Runtime root must be a real directory")
    result = {}

    def visit(directory):
        for path in sorted(directory.iterdir()):
            mode = path.lstat().st_mode
            require(not stat.S_ISLNK(mode), "Runtime tree cannot contain symlinks: " + str(path))
            if stat.S_ISDIR(mode):
                visit(path)
            else:
                require(stat.S_ISREG(mode), "Unsupported runtime tree member: " + str(path))
                result[path.relative_to(root).as_posix()] = digest(path)

    visit(root)
    require(result, "Generated runtime inventory is empty")
    return result


def runtime_delta(a_runtime, b_runtime):
    """One exact byte-level comparison for both preflight and completed imports."""
    changed = sorted(path for path in set(a_runtime) | set(b_runtime)
                     if a_runtime.get(path) != b_runtime.get(path))
    changed_set = set(changed)
    return {
        "passed": changed_set == EXPECTED_RUNTIME_DELTA,
        "expectedChangedPaths": sorted(EXPECTED_RUNTIME_DELTA),
        "actualChangedPaths": changed,
        "unexpectedChangedPaths": sorted(changed_set - EXPECTED_RUNTIME_DELTA),
        "missingExpectedChanges": sorted(EXPECTED_RUNTIME_DELTA - changed_set),
        "changedPathIdentities": {
            path: {"A": a_runtime.get(path), "B": b_runtime.get(path)} for path in changed
        },
        "fileCounts": {"A": len(a_runtime), "B": len(b_runtime)},
    }


def require_runtime_delta(a_runtime, b_runtime, context):
    result = runtime_delta(a_runtime, b_runtime)
    emit({"event": "complete-runtime-delta", "context": context, "comparison": result})
    require(result["passed"], "Complete generated runtime delta differs from the frozen seven entries")
    return result


def prepared_source(root, expected_commit):
    """Read-only prepared-tree inspection; no product module is imported or executed."""
    root = Path(root)

    def git(*arguments):
        return subprocess.check_output(["git", *arguments], cwd=root).decode().strip()

    require(git("rev-parse", "HEAD") == expected_commit, "Prepared checkout commit changed")
    changes = [path for path in git("diff", "--name-only", "HEAD").splitlines() if path]
    require(all(path == "ext/legal-npm.html" for path in changes),
            "Prepared tracked changes exceed the recorded license-page exception")
    modules = root / "node_modules"
    require(modules.is_dir() and not modules.is_symlink(),
            "Each prepared checkout requires its own actual npm ci directory, not a symlink")
    committed = subprocess.check_output(["git", "show", "HEAD:ext/legal-npm.html"], cwd=root)
    runtime = runtime_inventory(root / "ext")
    manifest = read_json(root / "dev/data/dictionary-wasm/manifest.json")
    for target in manifest["targets"]:
        name = target["name"]
        require(isinstance(name, str) and Path(name).name == name and name not in ("", ".", ".."),
                "Invalid native artifact basename")
        artifact = digest(root / "dev/data/dictionary-wasm" / name)
        require(artifact["sha256"] == target["sha256"], "Pinned native artifact checksum differs")
        require(runtime.get("lib/" + name) == artifact, "Generated native artifact differs from pinned input")
    return {
        "commit": expected_commit, "tree": git("rev-parse", "HEAD^{tree}"),
        "runtimeFiles": runtime,
        "setupGeneratedLicense": {
            "path": "ext/legal-npm.html",
            "committed": {"bytes": len(committed), "sha256": hashlib.sha256(committed).hexdigest()},
            "generated": runtime["legal-npm.html"],
            "listedTrackedDelta": "ext/legal-npm.html" in changes,
        },
        "packageLock": digest(root / "package-lock.json"),
        "packageJson": digest(root / "package.json"),
        "independentNodeModulesDirectory": True,
    }


def preflight_runtime(baseline_root, candidate_root, candidate, output):
    sources = {
        "A": prepared_source(baseline_root, BASELINE),
        "B": prepared_source(candidate_root, candidate),
    }
    # Write both complete inventories before the strict comparison can reject them.
    save(Path(output) / "prepared-source-A.json", sources["A"])
    save(Path(output) / "prepared-source-B.json", sources["B"])
    comparison = runtime_delta(sources["A"]["runtimeFiles"], sources["B"]["runtimeFiles"])
    save(Path(output) / "runtime-delta.json", comparison)
    require_runtime_delta(sources["A"]["runtimeFiles"], sources["B"]["runtimeFiles"], "before-smoke-and-import")
    require(sources["A"]["packageLock"] == sources["B"]["packageLock"],
            "Prepared dependency lock differs")
    require(sources["A"]["packageJson"] == sources["B"]["packageJson"],
            "Prepared dependency package manifest differs")
    node = subprocess.check_output(["node", "--version"]).decode().strip()
    require(node == "v22.22.0", "Untimed correctness Node version changed")
    result = {
        "passed": True, "performanceMeasurements": False, "productModulesExecuted": False,
        "baseline": BASELINE, "candidate": candidate, "node": node,
        "comparison": comparison,
        "sourceReceipts": {arm: digest(Path(output) / ("prepared-source-" + arm + ".json"))
                           for arm in ("A", "B")},
    }
    save(Path(output) / "runtime-preflight.json", result)
    emit({"event": "runtime-preflight", "receipt": result})
    return sources


def compact_source(source):
    if not isinstance(source, dict):
        return source
    result = dict(source)
    runtime = result.pop("runtimeFiles", None)
    if runtime is not None:
        encoded = json.dumps(runtime, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
        result["runtimeInventory"] = {
            "files": len(runtime), "canonicalSha256": hashlib.sha256(encoded).hexdigest(),
            "note": "Complete path/byte/SHA inventory remains in source JSON and prepared-source receipts",
        }
    return result


def emit_arm_evidence(directory, arm, dictionary):
    """Emit original receipt contents/digests even if archive transport later fails."""
    directory = Path(directory)
    if not directory.exists():
        emit({"event": "arm-evidence", "dictionary": dictionary, "arm": arm,
              "directoryCreated": False})
        return
    errors = []
    identities = {}
    for path in sorted(directory.glob("*.json")):
        try:
            identities[path.name] = digest(path)
        except Exception as cause:
            errors.append({"path": path.name, "error": repr(cause)})
    emit({"event": "arm-json-inventory", "dictionary": dictionary, "arm": arm,
          "files": identities, "evidenceErrors": errors})
    for name in ("report.json", "failure.json", "cleanup.json", "field-calls.json", "owner-calls.json"):
        path = directory / name
        if not path.exists():
            continue
        try:
            value = read_json(path)
            if isinstance(value, dict):
                value = dict(value)
                for key in ("source", "sourceBefore", "sourceAfter"):
                    if key in value:
                        value[key] = compact_source(value[key])
            emit({"event": "original-arm-receipt", "dictionary": dictionary, "arm": arm,
                  "path": name, "identity": identities.get(name), "receipt": value})
        except Exception as cause:
            emit({"event": "arm-evidence-error", "dictionary": dictionary, "arm": arm,
                  "path": name, "error": repr(cause)})


def command(args, logfile, cwd=None):
    with Path(logfile).open("xb") as output:
        result = subprocess.run(args, stdout=output, stderr=subprocess.STDOUT, cwd=cwd, check=False)
    receipt = {"argv": [str(value) for value in args], "exitCode": result.returncode,
               "log": digest(logfile)}
    save(Path(logfile).with_suffix(".process.json"), receipt)
    emit({"event": "original-process-result", "process": receipt})
    require(result.returncode == 0, "Original correctness process failed; no replacement: " + str(logfile))
    return receipt


def term_files(report):
    files = report["termFiles"]
    paths = [item["path"] for item in files]
    require(len(paths) == len(set(paths)), "Duplicate finalized term file")
    require(files and all(item["termPayload"] is True for item in files), "Missing finalized term payload inventory")
    return sorted(
        (item["path"], item["bytes"], item["normalizedSha256"], item["normalization"])
        for item in files
    )


def fields(calls):
    keys = ("ordinal", "rowCount", "contentOffsetBase", "contentOffsetBaseBits", "bytes", "sha256")
    require([item["ordinal"] for item in calls] == list(range(len(calls))), "Field-call ordinals changed")
    return [{key: item[key] for key in keys} for item in calls]


def group_plan(workers):
    requests = []
    for worker in workers:
        require(worker["failures"] == [], "Production worker reported a failure")
        if worker["entry"] == "term-bank-wasm-parser-worker.js":
            require(worker["ready"] == 1, "Parser worker did not start once")
            for request in worker["parseRequests"]:
                require(request["banks"], "Actual compressed source metadata was not captured")
                requests.append({"banks": request["banks"], "sourceByteLengths": request["sourceByteLengths"]})
    return sorted(requests, key=lambda item: json.dumps(item, sort_keys=True))


def parser_counts(phases):
    matches = [phase["details"] for phase in phases if phase["phase"] == "import-data-banks"]
    require(len(matches) == 1, "Missing unique successful source-import phase")
    values = matches[0]
    require(all(key in values for key in PARSER_KEYS), "Missing parser work counter")
    return {key: values[key] for key in PARSER_KEYS}


def compare_owners(a_dir, b_dir, a_calls, b_calls, a_report, b_report):
    """Recompute the complete enclosing-owner partition and native byte ledger."""
    work_keys = ("nativeCalls", "nativeRows", "nativeAttempts", "wholeNativeCalls",
                 "wholeNativeRows", "wholeNativeAttempts", "inputCopiedBytes",
                 "outputCopiedBytes", "tableBytesRequested", "memoryGrowthBytes")
    plan_keys = ("ordinal", "rowCount", "uniqueCount", "firstId", "contentDictName", "fieldStart", "fieldEnd")
    plans = []
    for directory, calls, report, arm in ((a_dir, a_calls, a_report, "A"), (b_dir, b_calls, b_report, "B")):
        data = read_json(directory / "owner-calls.json")
        owners = data["owners"]
        require(data["schema"] == 1 and data["observerErrors"] == [], "Invalid owner observer receipt")
        require(data["accounting"] == report["ownerAccounting"] and data["accounting"]["passed"] is True,
                "Final owner accounting receipt differs")
        require(owners and report["ownerCalls"] == len(owners), "Missing owner boundary")
        cursor = 0
        totals = {key: 0 for key in work_keys}
        whole_calls = whole_rows = ordinary_calls = ordinary_rows = readiness = committed = 0
        for ordinal, owner in enumerate(owners):
            require(owner["ordinal"] == ordinal and owner["settled"] is True and owner["error"] is None,
                    "Incomplete original owner")
            require(owner["fieldStart"] == cursor and type(owner["fieldEnd"]) is int and owner["fieldEnd"] > cursor,
                    "Owner partition is not contiguous")
            selected = calls[cursor:owner["fieldEnd"]]
            require(len(selected) == owner["fieldEnd"] - cursor and
                    all(call["ownerOrdinal"] == ordinal for call in selected) and
                    sum(call["rowCount"] for call in selected) == owner["rowCount"], "Owner field membership differs")
            cursor = owner["fieldEnd"]
            if arm == "A":
                require(owner["before"] is None and owner["after"] is None and
                        all(call["before"] is None and call["after"] is None and call["wholeAttempt"] is None for call in selected),
                        "Baseline activated the optional owner")
                continue
            before, after = owner["before"], owner["after"]
            def n(value, key):
                return (value.get("native") or {}).get(key, 0)
            changes = {key: n(after, key) - n(before, key) for key in work_keys}
            require(all(type(value) is int and value >= 0 for value in changes.values()), "Owner counter regressed")
            whole_attempts = changes["wholeNativeAttempts"]
            require(whole_attempts in (0, 1), "More than one speculative whole attempt per owner")
            whole = [call for call in selected if (call.get("wholeAttempt") or {}).get("succeeded") is True]
            require(len(whole) <= 1 and (not whole or len(selected) == 1), "Whole success was split or duplicated")
            ordinary = [n(call["after"], "nativeCalls") - n(call["before"], "nativeCalls") for call in selected]
            attempted = [n(call["after"], "nativeAttempts") - n(call["before"], "nativeAttempts") for call in selected]
            require(all(value in (0, 1) for value in ordinary + attempted), "Invalid ordinary field work count")
            if whole_attempts:
                require(type(owner["uniqueCount"]) is int and owner["uniqueCount"] > 0, "Copied whole shape missing")
            inputs = (owner["rowCount"] * 8 + owner["uniqueCount"] * 12) if whole_attempts else 0
            def table(rows):
                slots = 2
                while slots < min(rows, 65535) * 2:
                    slots *= 2
                return slots * 4
            tables = whole_attempts * table(owner["rowCount"])
            outputs = 0
            native_rows = 0
            for call, ordinary_count, attempt_count in zip(selected, ordinary, attempted):
                whole_count = int((call.get("wholeAttempt") or {}).get("succeeded") is True)
                require(ordinary_count + whole_count <= 1, "Field output counted twice")
                require(call["after"]["calls"] == call["before"]["calls"] + 1,
                        "Actual field entry count differs")
                require(call["after"]["javascriptCalls"] - call["before"]["javascriptCalls"] == 1 - ordinary_count - whole_count,
                        "Actual field route differs")
                if whole_count:
                    require(call["wholeAttempt"]["copied"] is True and
                            call["wholeAttempt"]["contentOffsetBase"] == call["contentOffsetBase"] and
                            call["wholeAttempt"]["contentOffsetBaseBits"] == call["contentOffsetBaseBits"], "Whole base witness differs")
                if call["before"]["native"] is None:
                    readiness += 1
                if (call.get("wholeAttempt") or {}).get("copied") is True and not whole_count:
                    require(len(selected) == 1 and ordinary_count == 0 and attempt_count == 0,
                            "Copied unsplit fallback repeated native work")
                    old = (call["before"].get("native") or {}).get("declines", {})
                    new = (call["after"].get("native") or {}).get("declines", {})
                    reasons = [reason for reason in new if new[reason] - old.get(reason, 0) > 0]
                    require(len(reasons) == 1 and new[reasons[0]] - old.get(reasons[0], 0) == 1,
                            "Copied fallback did not commit exactly once")
                    committed += int(reasons[0] == "unsupported-compact")
                if attempt_count:
                    require(type(call["uniqueCount"]) is int and call["uniqueCount"] > 0, "Copied field shape missing")
                    inputs += call["rowCount"] * 8 + call["uniqueCount"] * 12
                    tables += table(call["rowCount"])
                outputs += (ordinary_count + whole_count) * call["bytes"] + whole_count * 8
                native_rows += (ordinary_count + whole_count) * call["rowCount"]
            require(changes["nativeAttempts"] == whole_attempts + sum(attempted) and
                    changes["nativeCalls"] == len(whole) + sum(ordinary) and
                    changes["nativeRows"] == native_rows and
                    changes["wholeNativeCalls"] == len(whole) and
                    changes["wholeNativeRows"] == sum(call["rowCount"] for call in whole), "Owner native accounting differs")
            require(changes["inputCopiedBytes"] == inputs and changes["tableBytesRequested"] == tables and
                    changes["outputCopiedBytes"] == outputs, "Complete owner byte ledger differs")
            require(after["calls"] - before["calls"] == len(selected), "Owner entry accounting differs")
            for key, value in changes.items():
                totals[key] += value
            whole_calls += len(whole)
            whole_rows += sum(call["rowCount"] for call in whole)
            ordinary_calls += sum(ordinary)
            ordinary_rows += sum(call["rowCount"] * count for call, count in zip(selected, ordinary))
        require(cursor == len(calls), "Unowned field output remains")
        plans.append([{key: owner[key] for key in plan_keys} for owner in owners])
        expected = {"passed": True, "ownerCalls": len(owners), "fieldCalls": len(calls), "nativeActivated": arm == "B"}
        if arm == "B":
            require(owners[-1]["after"] == report["fieldMetrics"], "Final owner metrics differ from publication")
            final = report["fieldMetrics"]["native"]
            require(all(totals[key] == final[key] for key in work_keys), "Native work escaped recorded owners")
            for name in ("declines", "wholeAdmissionDeclines", "wholeCopiedDeclines"):
                require(all(type(count) is int and count >= 0 and
                            (count == 0 or reason in ("eligibility", "memory-bound", "unsupported-compact"))
                            for reason, count in final[name].items()), "Unexpected native failure/disable decline")
            require(final["wholeNativeAttempts"] == whole_calls + final["wholeCopiedDeclines"].get("unsupported-compact", 0) and
                    final["nativeAttempts"] == final["nativeCalls"] + final["declines"].get("unsupported-compact", 0) +
                    final["wholeCopiedDeclines"].get("unsupported-compact", 0) - committed,
                    "Overlapping attempt declines do not reconcile")
            require(report["fieldMetrics"]["javascriptCalls"] == readiness + sum(final["declines"].values()),
                    "Readiness/fallback field calls differ")
            require(whole_calls > 0 and whole_rows > 0, "No natural whole-fusion activation")
            expected.update({"wholeNativeCalls": whole_calls, "wholeNativeRows": whole_rows,
                             "ordinaryNativeCalls": ordinary_calls, "ordinaryNativeRows": ordinary_rows,
                             "readinessJavascriptCalls": readiness, "committedWholeAttemptDeclines": committed,
                             "inputCopiedBytes": totals["inputCopiedBytes"], "outputCopiedBytes": totals["outputCopiedBytes"],
                             "tableBytesRequested": totals["tableBytesRequested"]})
        require(data["accounting"] == expected, "Stored owner summary differs from independently recomputed totals")
    require(plans[0] == plans[1], "A/B enclosing owner boundaries differ")
    return {"passed": True, "owners": plans[0], "candidateAccounting": b_report["ownerAccounting"],
            "completeOwnerBytesRecomputed": True}


def compare_pair(a_dir, b_dir, dictionary, fixture, candidate, prepared=None):
    a_dir, b_dir = Path(a_dir), Path(b_dir)
    a, b = read_json(a_dir / "report.json"), read_json(b_dir / "report.json")
    for arm, report, commit in (("A", a, BASELINE), ("B", b, candidate)):
        require(report["passed"] is True and report["arm"] == arm, "Missing successful original arm")
        require(report["newReconstructedDriver"] is True and report["performanceMeasurements"] is False,
                "Wrong acquisition scope")
        require(report["dictionary"] == dictionary and report["source"]["commit"] == commit,
                "Arm source or corpus identity changed")
        require(report["fixture"] == {"sha256": fixture["sha256"], "bytes": fixture["sizeBytes"]},
                "Fixture identity changed")
        require(report["fieldRows"] == fixture["termRows"], "Incomplete term field coverage")
        require(report["parserGroups"] == EXPECTED_GROUPS[dictionary] and report["parserWorkers"] == 3,
                "Current production source grouping was not exercised")
        require(report["sqlite"]["persistentSqlite"] is False and
                report["sqlite"]["usesFallbackStorageOverride"] is False,
                "Undeclared SQLite host boundary")
        cleanup = read_json((a_dir if arm == "A" else b_dir) / "cleanup.json")
        require(cleanup == {"completed": True, "cleanupErrors": []}, "Post-receipt cleanup failed")
    a_runtime, b_runtime = a["source"]["runtimeFiles"], b["source"]["runtimeFiles"]
    runtime_comparison = require_runtime_delta(a_runtime, b_runtime, dictionary + ":completed-pair")
    changed = set(runtime_comparison["actualChangedPaths"])
    if prepared is not None:
        for arm, runtime in (("A", a_runtime), ("B", b_runtime)):
            require(runtime == prepared[arm]["runtimeFiles"],
                    "An arm's generated runtime changed after the read-only preflight: " + arm)
    require(a["source"]["kit"] == b["source"]["kit"], "Arm observer code changed")
    require(a["flags"] == b["flags"], "Arm import flags changed")
    require(a["semantic"] == b["semantic"], "Complete counts or live lookup results differ")
    require(term_files(a) == term_files(b), "A finalized term-content/record/index byte differs")
    a_calls, b_calls = read_json(a_dir / "field-calls.json"), read_json(b_dir / "field-calls.json")
    require(fields(a_calls) == fields(b_calls), "A synchronous complete field buffer differs")
    require(a["fieldMetrics"] is None and a["optionalAssets"] == [], "Baseline activated candidate code")
    metrics = b["fieldMetrics"]
    require(metrics["calls"] == metrics["javascriptCalls"] + metrics["native"]["nativeCalls"],
            "Candidate terminal call counters do not reconcile")
    require(metrics["calls"] == len(b_calls) and metrics["native"]["nativeCalls"] > 0,
            "No actual natural native activation or incomplete accounting")
    require(metrics["native"]["wholeNativeCalls"] > 0 and metrics["native"]["wholeNativeRows"] > 0,
            "No actual whole-fusion activation")
    owner_comparison = compare_owners(a_dir, b_dir, a_calls, b_calls, a, b)
    require(len(b["optionalAssets"]) == 1, "Candidate asset fetch witness is missing")
    a_groups = group_plan(read_json(a_dir / "workers.json"))
    b_groups = group_plan(read_json(b_dir / "workers.json"))
    require(a_groups == b_groups and len(a_groups) == EXPECTED_GROUPS[dictionary],
            "Production source-bank boundaries differ")
    a_counts = parser_counts(read_json(a_dir / "product-work-counts.json"))
    b_counts = parser_counts(read_json(b_dir / "product-work-counts.json"))
    require(a_counts == b_counts, "Parser/CRC/fallback work counters differ")
    require(a_counts["fastPathParserFusedFallbacks"] == 0, "Unexpected fused parser fallback")
    receipts = {}
    for arm, directory in (("A", a_dir), ("B", b_dir)):
        receipts[arm] = {path.name: digest(path) for path in sorted(directory.glob("*.json"))}
    return {
        "passed": True, "dictionary": dictionary, "baseline": BASELINE, "candidate": candidate,
        "performanceMeasurements": False,
        "termRows": fixture["termRows"], "fieldCalls": len(a_calls),
        "completeTermFiles": term_files(a), "parserWorkCounts": a_counts,
        "completeRuntimeDelta": sorted(changed),
        "completeRuntimeComparison": runtime_comparison,
        "sourceGroupsSha256": hashlib.sha256(json.dumps(a_groups, sort_keys=True).encode()).hexdigest(),
        "candidateNativeCoverage": b["nativeCoverage"], "candidateMetrics": metrics,
        "ownerComparison": owner_comparison,
        "receipts": receipts,
        "limitations": [
            "New untimed A-to-B acquisition; no recovered historical receipt is substituted",
            "Nonpersistent real SQLite plus disk OPFS-shaped term sidecars",
            "Natural helper activation observed; no optional-loader readiness await or replacement import",
            "No browser, restart, image decoding, full-media or performance qualification",
        ],
    }


def retire_verified_disk(directory):
    """Remove only this successful arm's own files after a second full raw-byte hash."""
    directory = Path(directory)
    disk = directory / "disk"
    require(disk.is_dir() and not disk.is_symlink(), "Unexpected generated disk root")
    recorded = read_json(directory / "files.json")
    root = disk / "root"
    actual = {}
    for path in sorted(root.rglob("*")):
        require(not path.is_symlink(), "Refusing to retire a symlink")
        if path.is_file():
            actual[path.relative_to(root).as_posix()] = digest(path)
        else:
            require(path.is_dir(), "Unexpected generated disk member")
    expected = {item["path"]: {"bytes": item["bytes"], "sha256": item["sha256"]} for item in recorded}
    require(len(expected) == len(recorded) and actual == expected, "Raw file changed before bounded retirement")
    require(list((disk / "staging").iterdir()) == [], "Unsettled writable remains")
    receipt = {
        "retired": True, "scope": "Only this successful newly generated arm's disk directory",
        "everyRawByteRehashed": True, "rawFilesRetained": False,
        "files": actual, "originalFinalizedInventory": digest(directory / "files.json"),
        "reconstruction": "Pinned fixture and source plus retained new driver; hashes are not a raw archive",
    }
    save(directory / "retired-disk.json", receipt)
    shutil.rmtree(disk)


def main():
    require(sys.version_info >= (3, 11), "Python 3.11 or later is required")
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline-root", required=True, type=Path)
    parser.add_argument("--candidate-root", required=True, type=Path)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--fixtures", type=Path)
    parser.add_argument("--preflight-only", action="store_true")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    require(len(args.candidate) == 40 and all(value in "0123456789abcdef" for value in args.candidate),
            "Candidate must be an immutable commit SHA")
    output = args.output.resolve()
    require(not output.exists(), "Output must be fresh")
    output.mkdir(parents=False)
    kit = Path(__file__).resolve().parent
    baseline_root = args.baseline_root.resolve(strict=True)
    candidate_root = args.candidate_root.resolve(strict=True)
    require(args.preflight_only or args.fixtures is not None, "--fixtures is required for correctness acquisition")
    fixture_root = None if args.fixtures is None else args.fixtures.resolve(strict=True)
    plan = {
        "schema": 1, "identity": "NEW a300 whole-fusion untimed correctness acquisition",
        "baseline": BASELINE, "candidate": args.candidate,
        "dictionaryOrder": list(DICTIONARIES), "armOrder": ["A", "B"],
        "freshProcessPerArm": True, "performanceMeasurements": False,
        "optionalReadinessWait": False, "replacementObservations": False,
        "readOnlyPreflightOnly": args.preflight_only,
        "source": source_receipts(kit),
    }
    save(output / "plan.json", plan)
    source_copy = output / "harness-source"
    source_copy.mkdir()
    for path in kit.iterdir():
        if path.is_file():
            shutil.copyfile(path, source_copy / path.name)
    completed = []
    try:
        prepared = preflight_runtime(baseline_root, candidate_root, args.candidate, output)
        if args.preflight_only:
            save(output / "report.json", {"passed": True, "plan": plan, "readOnlyPreflightOnly": True})
            return
        lock_a = read_json(baseline_root / "test/perf/dictionaries.lock.json")
        lock_b = read_json(candidate_root / "test/perf/dictionaries.lock.json")
        require(lock_a == lock_b, "Pinned dictionary fixture lock changed")
        for arm, root in (("A", baseline_root), ("B", candidate_root)):
            try:
                command(["node", str(kit / "test-opfs.mjs"), str(root), str(output / ("smoke-" + arm))],
                        output / ("smoke-" + arm + ".log"))
            finally:
                emit_arm_evidence(output / ("smoke-" + arm), arm, "adapter-smoke")
            require(read_json(output / ("smoke-" + arm) / "report.json")["passed"] is True,
                    "Actual-I/O/production-worker smoke failed")
        for dictionary in DICTIONARIES:
            cell = output / dictionary
            cell.mkdir()
            fixture = lock_a["dictionaries"][dictionary]
            archive = fixture_root / fixture["cacheFile"]
            require(digest(archive) == {"bytes": fixture["sizeBytes"], "sha256": fixture["sha256"]},
                    "Pinned fixture is missing or changed")
            for arm, root, commit in (("A", baseline_root, BASELINE), ("B", candidate_root, args.candidate)):
                try:
                    command(["node", str(kit / "run.mjs"), str(root), dictionary, str(archive),
                             str(cell / arm), arm, commit], cell / (arm + ".log"))
                finally:
                    emit_arm_evidence(cell / arm, arm, dictionary)
            receipt = compare_pair(cell / "A", cell / "B", dictionary, fixture, args.candidate, prepared)
            save(cell / "comparison.json", receipt)
            # Both original arms must agree before either generated raw sink is retired.
            retire_verified_disk(cell / "A")
            retire_verified_disk(cell / "B")
            completed.append(receipt)
        save(output / "report.json", {"passed": True, "plan": plan, "comparisons": completed,
                                     "performanceMeasurements": False})
        print(json.dumps({"passed": True, "baseline": BASELINE, "candidate": args.candidate,
                          "performanceMeasurements": False,
                          "comparisons": [{"dictionary": item["dictionary"], "termRows": item["termRows"],
                                           "fieldCalls": item["fieldCalls"], "native": item["candidateNativeCoverage"]}
                                          for item in completed]}, sort_keys=True))
    except BaseException as cause:
        failure = {
            "passed": False, "plan": plan, "completed": completed,
            "error": repr(cause), "remainingCorporaNotRun": True,
            "replacementObservations": False,
        }
        save(output / "failure.json", failure)
        emit({"event": "original-correctness-failure", "receipt": failure,
              "identity": digest(output / "failure.json")})
        raise


if __name__ == "__main__":
    main()
