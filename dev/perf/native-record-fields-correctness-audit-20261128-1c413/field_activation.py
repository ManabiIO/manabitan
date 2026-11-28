#!/usr/bin/env python3
"""Pure post-receipt native-field activation checks; no import or timing acquisition."""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import sys

SAFE_INTEGER = 2 ** 53 - 1
PAGE_BYTES = 65536
INITIAL_MEMORY_BYTES = 2 * PAGE_BYTES
MAXIMUM_MEMORY_BYTES = 1024 * PAGE_BYTES
DICTIONARIES = ("jmdict", "jitendex", "vndb")
EXPECTED_SCHEDULE = {
    "measuredPairs": 24, "controlPairs": 8, "warmupPairs": 2,
    "mediaImports": 2, "memoryImports": 4, "totalReports": 74,
}
EXPECTED_PACKAGE_ENTRIES = [
    "js/dictionary/dictionary-database.js",
    "js/dictionary/term-record-opfs-store.js",
]
RUNTIME_PATHS = {
    "ext/js/dictionary/term-record-fields.js",
    "ext/js/dictionary/term-record-opfs-store.js",
    "ext/js/dictionary/dictionary-database.js",
    "ext/lib/term-record-fields.wasm",
}
ALLOWED_DECLINES = ("eligibility", "memory-bound", "unsupported-compact")
FAILURE_DECLINES = (
    "guard-exception", "native-memory-alias", "memory-growth", "input-copy",
    "native-trap", "native-return", "native-header", "output-copy", "unavailable",
)
ATTEMPT_DECLINES = ("unsupported-compact", "native-trap", "native-return", "native-header", "output-copy")
NATIVE_COUNTERS = {
    "nativeCalls", "nativeRows", "nativeAttempts", "inputCopiedBytes",
    "outputCopiedBytes", "tableBytesRequested", "memoryGrowthBytes",
    "maximumLinearMemoryBytes", "maximumScratchBytes",
}
COMMON_HASHES = {
    "qualification_receipts.py": "4f7b4eee4f8ff71e821c9162e57524460c48f01f409487f638523a3a27aa8f51",
    "protocol.py": "ea0e7c20bbc1273cbe81891c32ecc72658d70ed1bbf1d57cdcfae5b347d493c7",
}
QUALIFIER_SHA256 = "cad1b3fb25766cbd22a1c4260718a0b92353e87276751217ca18dc9eea29c6ef"


class ActivationError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise ActivationError(message)


def same(actual, expected, message):
    require(json.dumps(actual, sort_keys=True, allow_nan=False) ==
            json.dumps(expected, sort_keys=True, allow_nan=False), message)


def integer(value, label, minimum=0):
    require(type(value) is int and minimum <= value <= SAFE_INTEGER,
            label + " must be a nonnegative safe integer with the required lower bound")
    return value


def hex_digest(value, length, label):
    require(type(value) is str and re.fullmatch("[0-9a-f]{" + str(length) + "}", value) is not None,
            label + " must be a complete lowercase hexadecimal digest")
    return value


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def read_json(path):
    def pairs(values):
        result = {}
        for key, value in values:
            require(key not in result, "Duplicate JSON property: " + key)
            result[key] = value
        return result

    def number(value):
        parsed = float(value)
        require(math.isfinite(parsed), "Nonfinite JSON number")
        return parsed

    def invalid(value):
        raise ActivationError("Nonfinite JSON constant: " + value)

    return json.loads(Path(path).read_text(), object_pairs_hook=pairs,
                      parse_float=number, parse_constant=invalid)


def file_identity(path):
    data = Path(path).read_bytes()
    return {"bytes": len(data), "sha256": sha256(data)}


def validate_policy(study, dictionary, fixtures):
    require(type(study) is dict and type(study.get("schemaVersion")) is int and study["schemaVersion"] == 1, "Unexpected study schema")
    require(study.get("acquisitionEnabled") is True,
            "Study remains disabled; this reader cannot authorize acquisition")
    same(study.get("schedule"), EXPECTED_SCHEDULE, "Frozen 74-report schedule changed")
    same(study.get("expectedPackageEntries"), EXPECTED_PACKAGE_ENTRIES,
         "Packaging-equivalent control boundary changed")
    for arm in ("upstream", "control", "candidate"):
        require(type(study.get(arm)) is dict, "Missing immutable source identity: " + arm)
        for key in ("commit", "tree"):
            hex_digest(study[arm].get(key), 40, arm + "." + key)
    runtime = study.get("runtimeSha256")
    require(type(runtime) is dict and set(runtime) == RUNTIME_PATHS, "Missing complete field runtime identities")
    for path, value in runtime.items():
        hex_digest(value, 64, "Runtime " + path)
    activation = study.get("activation")
    require(type(activation) is dict and activation.get("sealed") is True,
            "Per-corpus eligibility/coverage is unsealed")
    policies = activation.get("perCorpus")
    require(type(policies) is dict and set(policies) == set(DICTIONARIES),
            "Incomplete frozen corpus eligibility inventory")
    require(all(type(policies[name]) is dict for name in DICTIONARIES),
            "Every corpus needs actual source-bound proof before launch")
    for name in DICTIONARIES:
        validate_corpus_policy(policies[name], fixtures[name], runtime)
    return policies[dictionary]


def validate_corpus_policy(policy, fixture, runtime):
    require(set(policy) == {
        "fixtureSha256", "termRows", "expectedCalls", "minimumNativeCalls",
        "minimumNativeRows", "maximumReadinessJavascriptCalls", "allowedDeclineMaximums", "proof",
    }, "Unexpected per-corpus activation policy fields")
    same(policy["fixtureSha256"], fixture["sha256"], "Sealed fixture hash changed")
    same(policy["termRows"], fixture["termRows"], "Sealed complete term-row count changed")
    rows = integer(policy["termRows"], "termRows", 1)
    calls = integer(policy["expectedCalls"], "expectedCalls", 1)
    require(integer(policy["minimumNativeCalls"], "minimumNativeCalls", 1) <= calls,
            "Minimum native calls exceed total calls")
    require(integer(policy["minimumNativeRows"], "minimumNativeRows", 1) <= rows,
            "Minimum native rows exceed total term rows")
    require(integer(policy["maximumReadinessJavascriptCalls"], "maximumReadinessJavascriptCalls") < calls,
            "Readiness allowance cannot admit zero native calls")
    limits = policy["allowedDeclineMaximums"]
    require(type(limits) is dict and set(limits) == set(ALLOWED_DECLINES),
            "Every allowed fallback requires an explicit sealed maximum")
    for reason, maximum in limits.items():
        require(integer(maximum, "decline maximum " + reason) <= calls,
                "Decline allowance exceeds calls")
    proof = policy["proof"]
    require(type(proof) is dict and set(proof) == {
        "runId", "attempt", "headSha", "artifactId", "artifactSha256",
        "comparisonSha256", "candidateReportSha256", "fieldCallsSha256",
        "completeTermByteParity", "runtimeSha256",
    }, "Missing exact current-corpus proof identities")
    integer(proof["runId"], "proof.runId", 1)
    integer(proof["artifactId"], "proof.artifactId", 1)
    require(type(proof["attempt"]) is int and proof["attempt"] == 1, "Proof must identify its original attempt")
    hex_digest(proof["headSha"], 40, "proof.headSha")
    for key in ("artifactSha256", "comparisonSha256", "candidateReportSha256", "fieldCallsSha256"):
        hex_digest(proof[key], 64, "proof." + key)
    require(proof["completeTermByteParity"] is True, "Complete current field/final-term parity is not established")
    same(proof["runtimeSha256"], runtime, "Corpus proof belongs to different runtime bytes")
    return policy


def timed_schedule(initial):
    require(initial in ("AB", "BA"), "Initial order must be AB or BA")
    opposite = initial[::-1]
    result = []
    for pair, order in enumerate((initial, opposite), 1):
        for arm in order:
            result.append({"id": f"warmup-{pair}-{arm}", "kind": "warmup", "pair": pair, "arm": arm})
    for pair in range(1, 25):
        for arm in initial if pair % 2 else opposite:
            result.append({"id": f"pair-{pair:02d}-{arm}", "kind": "candidate", "pair": pair, "arm": arm})
        if pair % 3 == 0:
            control_pair = pair // 3
            order = "AC" if (control_pair + (initial == "BA")) % 2 else "CA"
            for arm in order:
                result.append({"id": f"control-{control_pair:02d}-{arm}", "kind": "control", "pair": control_pair, "arm": arm})
    require(len(result) == 68, "Internal timing schedule is incomplete")
    return result


def extract_activation(report, fixture):
    require(type(report) is dict and type(report.get("phases")) is list, "Missing raw report phases")
    phases = [phase for phase in report["phases"] if type(phase) is dict and
              type(phase.get("data")) is dict and phase["data"].get("kind") == "dictionary-import"]
    require(len(phases) == 1, "Expected exactly one actual complete dictionary import")
    data = phases[0]["data"]
    same(data.get("dictionary"), fixture["label"], "Raw imported dictionary differs")
    history = data.get("importDebugHistory")
    require(type(history) is list and all(type(item) is dict for item in history), "Invalid raw import history")
    finalizations = []
    for entry in history:
        timings = entry.get("importerPhaseTimings", [])
        require(type(timings) is list and all(type(item) is dict for item in timings), "Invalid importer phase timings")
        finalizations.extend(item for item in timings if item.get("phase") == "bulk-finalization")
    require(len(finalizations) == 1, "Expected exactly one actual bulk-finalization")
    details = finalizations[0].get("details")
    require(type(details) is dict and details.get("ok") is True, "Bulk finalization did not succeed")
    return details.get("termRecordFields")


def validate_metrics(metrics, arm, policy):
    require(arm in ("A", "B", "C"), "Unknown report arm")
    if arm != "B":
        require(metrics is None, "Inactive control published candidate field-session counters")
        return {"metrics": None, "nativeActivated": False, "readinessJavascriptCalls": 0}
    require(type(metrics) is dict and set(metrics) == {"calls", "javascriptCalls", "native"},
            "Candidate field-session counter shape changed")
    calls = integer(metrics["calls"], "calls", 1)
    javascript = integer(metrics["javascriptCalls"], "javascriptCalls")
    require(calls == policy["expectedCalls"], "Actual encoder call count differs from sealed complete corpus")
    native = metrics["native"]
    require(type(native) is dict and set(native) == NATIVE_COUNTERS | {"declines"},
            "Candidate completed without native readiness or counter shape changed")
    for key in NATIVE_COUNTERS:
        integer(native[key], key)
    declines = native["declines"]
    require(type(declines) is dict and set(declines) <= set(ALLOWED_DECLINES + FAILURE_DECLINES),
            "Unknown native decline reason")
    for reason, count in declines.items():
        integer(count, "decline " + reason)
    for reason in FAILURE_DECLINES:
        require(declines.get(reason, 0) == 0, "Native failure/disabled-state decline: " + reason)
    for reason in ALLOWED_DECLINES:
        require(declines.get(reason, 0) <= policy["allowedDeclineMaximums"][reason],
                "Native eligibility/fallback count exceeds sealed maximum: " + reason)
    native_calls = native["nativeCalls"]
    native_rows = native["nativeRows"]
    require(native_calls > 0 and native_rows > 0, "Every candidate observation must naturally activate native fields")
    require(calls == native_calls + javascript, "calls must equal nativeCalls plus javascriptCalls")
    require(policy["minimumNativeCalls"] <= native_calls <= calls, "Native call coverage misses sealed policy")
    require(policy["minimumNativeRows"] <= native_rows <= policy["termRows"], "Native row coverage misses sealed policy")
    require(native_rows >= native_calls, "A successful native call cannot have zero rows")
    attempts = native["nativeAttempts"]
    require(attempts == native_calls + sum(declines.get(reason, 0) for reason in ATTEMPT_DECLINES),
            "Native attempts and terminal outcomes do not reconcile")
    decline_count = sum(declines.values())
    readiness = javascript - decline_count
    require(0 <= readiness <= policy["maximumReadinessJavascriptCalls"],
            "JavaScript calls do not reconcile with sealed readiness and declared declines")
    require(attempts <= calls - readiness, "Native attempts exceed ready calls")
    input_bytes = native["inputCopiedBytes"]
    output_bytes = native["outputCopiedBytes"]
    table_bytes = native["tableBytesRequested"]
    # Every successful call copies two count*4 columns and nonempty unique refs.
    # Unique refs may span more than this call's rows; no uniqueCount<=rowCount assumption.
    require(input_bytes % 4 == 0 and
            8 * native_rows + 12 * native_calls <= input_bytes <= attempts * (MAXIMUM_MEMORY_BYTES - INITIAL_MEMORY_BYTES),
            "Native input-copy byte accounting is impossible")
    # Exact compact output has 16 header bytes, >=1 int32 score, and 8 bytes/row.
    require(output_bytes % 4 == 0 and
            8 * native_rows + 20 * native_calls <= output_bytes <= 12 * native_rows - 4 * native_calls,
            "Native compact output-copy byte accounting is impossible")
    require(table_bytes % 4 == 0 and 8 * attempts <= table_bytes <= 524288 * attempts,
            "Native score-table byte accounting is impossible")
    growth = native["memoryGrowthBytes"]
    maximum = native["maximumLinearMemoryBytes"]
    scratch = native["maximumScratchBytes"]
    require(growth % PAGE_BYTES == 0 and maximum == INITIAL_MEMORY_BYTES + growth and
            INITIAL_MEMORY_BYTES < maximum <= MAXIMUM_MEMORY_BYTES,
            "Native private memory growth/peak counters do not reconcile")
    require(scratch > 0 and scratch % 2 == 0 and scratch <= maximum - INITIAL_MEMORY_BYTES,
            "Native scratch accounting exceeds private memory")
    return {
        "metrics": metrics, "nativeActivated": True, "readinessJavascriptCalls": readiness,
        "declaredFallbackCalls": decline_count, "nativeCallFraction": native_calls / calls,
        "nativeRowFraction": native_rows / policy["termRows"],
    }


def load_common(repository):
    directory = Path(repository) / "dev/perf/import-memory-20261125-a7f7"
    require(sha256((Path(repository) / "dev/perf/import-qualification-20261125-a7f7.py").read_bytes()) == QUALIFIER_SHA256,
            "Unchanged common qualifier source differs")
    result = {}
    for name, expected in COMMON_HASHES.items():
        path = directory / name
        require(sha256(path.read_bytes()) == expected, "Pinned pure common module differs: " + name)
        module_name = "native_fields_activation_" + path.stem
        spec = importlib.util.spec_from_file_location(module_name, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        result[path.stem] = module
    return result


def audit(study, evidence, dictionary, initial, repository, modules=None):
    """Read already acquired reports only; all missing or failed reports remain failures."""
    require(dictionary in DICTIONARIES, "Unknown dictionary")
    evidence, repository = Path(evidence), Path(repository)
    fixtures = read_json(repository / "test/perf/dictionaries.lock.json")["dictionaries"]
    fixture = fixtures[dictionary]
    policy = validate_policy(study, dictionary, fixtures)
    modules = load_common(repository) if modules is None else modules
    receipts, protocol = modules["qualification_receipts"], modules["protocol"]
    plan = read_json(evidence / "registered-plan.json")
    sequence = timed_schedule(initial)
    memory = protocol.schedule(1 if initial == "AB" else 2)
    same(plan["baseline"], study["control"]["commit"], "Plan uses another inactive control")
    same(plan["candidate"], study["candidate"]["commit"], "Plan uses another candidate")
    same(plan["dictionary"], dictionary, "Plan dictionary differs")
    same(plan["initialOrder"], initial, "Plan initial order differs")
    same(plan["pairs"], 24, "Plan measured pair count differs")
    same(plan["flags"], {}, "Production import flags changed")
    same(plan["schedule"], sequence, "Original registered timing schedule differs")
    same(plan["memorySchedule"], memory, "Original registered memory schedule differs")
    same(plan["expectedPackageEntries"], EXPECTED_PACKAGE_ENTRIES, "Original package boundary differs")
    same(plan["expectedWorkers"], None, "Frozen production-default worker assertion changed")
    allocation = {"unitBytes": 4096, "rangeUnits": [37, 37], "origin": "explicit"} if dictionary == "vndb" else None
    same(plan["vndbSahAllocationPolicy"], allocation, "Frozen SQLite allocation gate changed")
    identities = read_json(evidence / "source-identities.json")
    changed_entries = identities["changedPackageEntries"]
    require(type(changed_entries) is list and len(changed_entries) == len(set(changed_entries)),
            "Actual package changes are not a distinct list")
    same(sorted(changed_entries), EXPECTED_PACKAGE_ENTRIES, "Actual package boundary differs")
    for path, expected in study["runtimeSha256"].items():
        package_path = path.removeprefix("ext/")
        same(identities["arms"]["B"]["entries"][package_path], expected, "Candidate field runtime package hash differs")
        if package_path not in EXPECTED_PACKAGE_ENTRIES:
            same(identities["arms"]["A"]["entries"][package_path], expected, "Inert control shared helper/asset differs")
    for arm, source_name in (("A", "control"), ("B", "candidate")):
        identity = identities["arms"][arm]
        same(identity["sha"], study[source_name]["commit"], "Arm commit differs")
        same(identity["tree"], study[source_name]["tree"], "Arm tree differs")
        hex_digest(identity["packageSha256"], 64, "Arm package SHA")
        same(identity["fixtureLockSha256"], sha256((repository / "test/perf/dictionaries.lock.json").read_bytes()),
             "Arm fixture lock differs")
        for path in receipts.SOURCE_HASH_FIELDS:
            if path == "builds/manabitan-chrome.zip":
                same(identity["sourceHashes"][path], identity["packageSha256"], "Package provenance differs")
            else:
                same(identity["sourceHashes"][path], sha256((repository / path).read_bytes()),
                     "Unchanged source provenance differs: " + path)
    browser = read_json(evidence / "browser-identity.json")
    require(type(browser["version"]) is str and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+", browser["version"]),
            "Invalid original browser version")
    harness_path = "test/chromium/extension-two-dictionary-import.e2e.js"
    original_harness = (repository / harness_path).read_text()
    overlay = protocol.memory_overlay(original_harness)
    same((evidence / "memory/harness-original.js").read_text(), original_harness, "Memory original harness differs")
    same((evidence / "memory/harness-instrumented.js").read_text(), overlay, "Memory marker overlay differs")
    observations = [{"path": item["id"], "kind": item["kind"], "arm": item["arm"],
                     "pair": item["pair"], "mediaCheck": "sample", "memory": False} for item in sequence]
    observations.extend({"path": "exhaustive-media-" + arm, "kind": "exhaustive-media",
                         "arm": arm, "pair": None, "mediaCheck": "all", "memory": False} for arm in initial)
    observations.extend({"path": "memory/" + item["name"], "kind": "memory", "arm": item["arm"],
                         "pair": item["pair"], "mediaCheck": "sample", "memory": True} for item in memory)
    require(len(observations) == 74 and Counter(item["arm"] for item in observations)["B"] == 29,
            "Complete 74-report/29-candidate inventory changed")
    results, failures = [], []
    reference, media_reference = None, None
    for item in observations:
        folder = evidence / item["path"]
        row = dict(item)
        errors = []
        try:
            raw = read_json(folder / "run-1.json")
            summary = read_json(folder / "summary.json")
            row["rawReport"] = file_identity(folder / "run-1.json")
            row["summary"] = file_identity(folder / "summary.json")
            arm = "B" if item["arm"] == "B" else "A"
            identity = identities["arms"][arm]
            hashes = dict(identity["sourceHashes"])
            if item["memory"]:
                hashes[harness_path] = sha256(overlay.encode())
            try:
                receipt = receipts.validate_import_summary(
                    summary, raw, dictionary=dictionary, fixture=fixture,
                    source_sha=identity["sha"], package_sha256=identity["packageSha256"],
                    browser_version=browser["version"], import_flags=None, source_hashes=hashes,
                    source_dirty=item["memory"], media_check=item["mediaCheck"],
                    vndb_sah_allocation_units=[37, 37] if dictionary == "vndb" else None,
                )
                same(receipt, read_json(folder / "canonical-receipt.json"), "Canonical semantic receipt differs")
                if reference is None:
                    reference = receipt
                else:
                    receipts.require_matching_receipts(reference, receipt, compare_media=item["mediaCheck"] != "all")
                if item["mediaCheck"] == "all":
                    if media_reference is None:
                        media_reference = receipt
                    else:
                        receipts.require_matching_receipts(media_reference, receipt)
                row["semanticReceiptValid"] = True
            except Exception as cause:
                row["semanticReceiptValid"] = False
                errors.append({"stage": "common-semantic-receipt", "type": type(cause).__name__, "error": str(cause)})
            try:
                row["reportedMetrics"] = extract_activation(raw, fixture)
                row["activation"] = validate_metrics(row["reportedMetrics"], item["arm"], policy)
            except Exception as cause:
                errors.append({"stage": "field-activation", "type": type(cause).__name__, "error": str(cause)})
        except Exception as cause:
            errors.append({"stage": "original-report-read", "type": type(cause).__name__, "error": str(cause)})
        row["passed"] = not errors
        row["failures"] = errors
        results.append(row)
        if errors:
            failures.append({"path": item["path"], "arm": item["arm"], "errors": errors})
    return {
        "schemaVersion": 1, "passed": not failures, "dictionary": dictionary, "initialOrder": initial,
        "control": study["control"], "candidate": study["candidate"], "runtimeSha256": study["runtimeSha256"],
        "expectedReports": 74, "expectedCandidateReports": 29,
        "registeredReportCounts": dict(Counter(item["arm"] for item in observations)),
        "observations": results, "failures": failures, "sealedPolicy": policy,
        "sourceFiles": {name: file_identity(evidence / name) for name in
                        ("registered-plan.json", "source-identities.json", "browser-identity.json")},
        "scope": "Only original raw/summary/semantic receipts and final session counters; no browser/import/WASM execution",
        "limits": [
            "No speed, memory or full qualification decision is made by this activation checker",
            "Artifact/run/API and complete archive package bindings are independently audited",
            "Readiness and declared fallback calls remain included; no observation is dropped or reacquired",
            "Sealed corpus proof identities are provenance requirements, not an independent re-audit of those archives",
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--study", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--dictionary", choices=DICTIONARIES, required=True)
    parser.add_argument("--initial-order", choices=("AB", "BA"), required=True)
    parser.add_argument("--repository", type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    require(not args.output.exists(), "Activation output must be new and cannot replace original evidence")
    try:
        result = audit(read_json(args.study), args.evidence, args.dictionary, args.initial_order, args.repository)
    except Exception as cause:
        result = {"schemaVersion": 1, "passed": False, "observations": [],
                  "failure": {"type": type(cause).__name__, "error": str(cause)},
                  "scope": "No acquisition; disabled/unsealed or incomplete original evidence fails closed"}
    result["studyFile"] = file_identity(args.study)
    result["checkerFile"] = file_identity(Path(__file__))
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True, allow_nan=False) + "\n")
    print(json.dumps(result, sort_keys=True, allow_nan=False))
    if not result["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
