#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""In-memory negative controls for the independent analysis verifier.

Original packets and product sources are never mutated. Original ZIP member
verification stays enabled; selected JSON reads are changed only in memory to
exercise deeper identity, selection, raw-clock, correctness and statistics gates.
"""

import copy
import importlib.util
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("independent_audit", ROOT / "audit-import-study.py")
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)
PACKET = ROOT / "browser/screen/monotonic-sequence-jmdict"
READ = AUDIT.read
FIRST = "block-01-1-A"
SUMMARY = f"{FIRST}/summary.json"
RAW = f"{FIRST}/run-1.json"
TOTAL = next(i for i, p in enumerate(READ(PACKET / RAW)["phases"]) if p["name"] == "JMdict: total import")
RESULTS = []


def set_value(path, value):
    def change(data):
        parent = data
        for key in path[:-1]:
            parent = parent[key]
        parent[path[-1]] = value
    return change


def remove(path):
    def change(data):
        parent = data
        for key in path[:-1]:
            parent = parent[key]
        del parent[path[-1]]
    return change


def control(name, modifications, expected):
    def changed_read(path):
        data = READ(path)
        relative = path.relative_to(PACKET).as_posix() if path.is_relative_to(PACKET) else None
        if relative in modifications:
            data = copy.deepcopy(data)
            modifications[relative](data)
        return data
    AUDIT.read = changed_read
    try:
        AUDIT.audit(PACKET)
    except AssertionError as error:
        message = str(error)
        if expected not in message:
            raise AssertionError(f"{name}: wrong rejection: {message}") from error
        RESULTS.append({"name": name, "status": "rejected-as-expected", "reason": message})
    else:
        raise AssertionError(f"{name}: altered evidence incorrectly accepted")
    finally:
        AUDIT.read = READ


def both_validation(path, value):
    return {SUMMARY: set_value(["runs", 0, "validation", *path], value),
            RAW: set_value(["benchmark", "validation", *path], value)}


control("unregistered-run", {"protocol.json": set_value(["github", "GITHUB_RUN_ID"], "999999")}, "Unregistered workflow run")
control("source-tree", {"protocol.json": set_value(["sourceIdentities", "A", "tree"], "0" * 40)}, "Protocol source identities")
control("runner-identity", {"protocol.json": set_value(["runnerSha256"], "0" * 64)}, "Frozen runner differs")
control("frozen-harness-omission", {"protocol.json": remove(["unchangedHarnessSha256", "test/e2e/import-timing.js"])}, "Full frozen harness differs")
control("fixture-lock-digest", {"protocol.json": set_value(["fixture", "sha256"], "0" * 64)}, "Fixture differs from frozen")
control("diagnostic-arm-omission", {"protocol.json": set_value(["diagnosticArms"], ["A"])}, "Prespecified cohort selection")
control("attempt-omission", {"observations.json": remove([0])}, "Observation tuple omission")
control("arm-relabel", {"observations.json": set_value([0, "arm"], "B")}, "Observation tuple omission")
control("cohort-relabel", {"observations.json": set_value([0, "cohort"], "exhaustive-diagnostic")}, "Observation tuple omission")
control("position-relabel", {"observations.json": set_value([0, "position"], 2)}, "Observation tuple omission")
control("summary-path-traversal", {"observations.json": set_value([0, "summary"], "../outside/summary.json")}, "Observation file alias/traversal")
control("raw-report-alias", {SUMMARY: set_value(["runs", 0, "reportJsonPath"], "/tmp/block-01-2-B/run-1.json")}, "Report path alias/traversal")
control("emitted-harness-omission", {SUMMARY: remove(["source", "sha256", "test/e2e/import-timing.js"])}, "Missing/additional/changed emitted provenance")
control("changed-package-member", {"package-B.json": set_value(["entries", "js/core/json.js"], "0" * 64)}, "Release package delta")
control("wrong-packaged-native-bytes", {"package-B.json": set_value(["entries", "lib/term-bank-parser.wasm"], "0" * 64)}, "Packaged runtime differs")
control("raw-profile-enabled", {RAW: set_value(["benchmark", "phaseProfiling"], True)}, "Raw benchmark configuration")
control("raw-skip-verification", {RAW: set_value(["skippedVerification"], True)}, "Failed/skipped raw report")
control("raw-clock-changed", {RAW: set_value(["phases", TOTAL, "data", "browserTiming", "completedAtMs"], 5000)}, "Summary duration differs from raw clocks")
control("raw-stale-import-sequence", {RAW: set_value(["phases", TOTAL, "data", "browserTiming", "sequence"], 0)}, "browser timing invalid")
control("restart-count", both_validation(["restart", "termRows"], 0), "Restart inventory/content differs")
probes = READ(PACKET / SUMMARY)["runs"][0]["validation"]["probeTerms"]
control("duplicate-probe", both_validation(["probeTerms", 1], probes[0]), "Invalid distinct probes")
control("duplicate-lookup", both_validation(["lookup", "observations", 1, "term"], probes[0]), "Missing/duplicate/reordered lookup")
control("storage-total", both_validation(["storage", "bytes"], 1), "Storage inventory sum/uniqueness")
control("missing-phase-counters", {f"{FIRST}/phase-counters.json": remove([0])}, "Copied phase counters differ")
for field, value in [
    ("pairs", 5), ("fasterPairs", 0), ("pairedChangesPercent", [0] * 6),
    ("pairedMedianPercent", 100), ("pairedMedianBootstrap95Percent", [-100, 100]),
    ("intervalMethod", "altered"), ("equalWorkPercent", 100),
    ("baselineMedianMs", 1), ("candidateMedianMs", 1),
]:
    control(f"analysis-{field}", {"analysis.json": set_value(["candidate", field], value)}, "Analysis differs from independent raw-clock statistics")
control("analysis-raw-timing", {"analysis.json": set_value(["allTimingsMs", "A", 0], 1)}, "Analysis differs from independent raw-clock statistics")
control("analysis-screen-status", {"analysis.json": set_value(["screeningOnly"], False)}, "Analysis differs from independent raw-clock statistics")

for text, label in [(' {"x":1,"x":2}', "Duplicate JSON key"), ('{"x":NaN}', "Non-finite JSON constant")]:
    try:
        AUDIT.decode(text)
    except AssertionError as error:
        assert label in str(error)
        RESULTS.append({"name": label, "status": "rejected-as-expected", "reason": str(error)})
    else:
        raise AssertionError(label + " unexpectedly accepted")

result = {"status": "passed", "auditSha256": AUDIT.file_digest(ROOT / "audit-import-study.py"),
          "controlCount": len(RESULTS), "method": __doc__.strip(), "results": RESULTS}
(ROOT / "audits/v2-negative-controls.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({key: result[key] for key in ("status", "auditSha256", "controlCount")}, indent=2))
