#!/usr/bin/env python3
"""Verify the frozen startup overlap screen, including unchanged-code controls."""

import json
import math
import statistics
import sys
from pathlib import Path

evidence = Path(sys.argv[1])
dictionary = sys.argv[2]
baseline = (evidence / "baseline-sha.txt").read_text().strip()
candidate = (evidence / "candidate-sha.txt").read_text().strip()
qualification_path = evidence / "qualification-sha.txt"
qualification = qualification_path.read_text().strip() if qualification_path.exists() else candidate
assert candidate == qualification, "Candidate product source differs from qualification HEAD"
assert candidate != baseline, "Candidate source must differ from the baseline"
order = (evidence / "observation-order.txt").read_text().split()
expected_order = "C1 D1 D2 C2 A1 B1 B2 A2 B3 A3 A4 B4 C3 D3 D4 C4".split()
assert order == expected_order, "The predeclared observation schedule changed"
observations = []
reference_validation = None
expected_fixture = None
expected_browser = None
package_hashes = {}
for name in ["warmup-A", "warmup-B", *order]:
    summary = json.loads((evidence / name / "summary.json").read_text())
    arm = name[-1] if name.startswith("warmup-") else name[0]
    expected_sha = qualification if arm == "B" else baseline
    assert summary["dictionary"] == dictionary
    assert summary["gitSha"] == expected_sha, (name, "source SHA")
    assert summary["buildTarget"] == "chrome"
    assert summary["authoritativeTiming"] is True and summary["traceEnabled"] is False
    assert summary["importFlags"] is None
    assert len(summary["runs"]) == 1
    run = summary["runs"][0]
    duration = run["totalImportMs"]
    assert isinstance(duration, (int, float)) and math.isfinite(duration) and duration > 0
    fixture = summary["fixture"]
    browser = summary["browserVersion"]
    if expected_fixture is None:
        expected_fixture, expected_browser = fixture, browser
    assert fixture == expected_fixture and browser == expected_browser
    package_hashes.setdefault(arm, run["packageSha256"])
    assert package_hashes[arm] == run["packageSha256"], (name, "package changed")
    validation = run["validation"]
    assert validation["contentReadable"] is True and validation["probeCount"] == 12
    assert validation["termRows"] == fixture["termRows"]
    assert validation["restart"]["contentReadable"] is True
    assert validation["restart"]["termRows"] == fixture["termRows"]
    if dictionary == "vndb":
        assert validation["mediaRows"] == fixture["mediaRows"]
        assert 0 < validation["generationMedia"]["count"] <= fixture["mediaRows"]
        assert validation["packedMediaActivation"]["entries"] == validation["generationMedia"]["count"]
        assert validation["mediaBeforeRestart"] == validation["mediaAfterRestart"]
        assert len(validation["mediaBeforeRestart"]) == 5
        assert "img/cc18737.webp" in [entry["path"] for entry in validation["mediaBeforeRestart"]]
    if reference_validation is None:
        reference_validation = validation
    assert validation == reference_validation, (name, "stored content or media changed across sources")
    raw = json.loads((evidence / name / "run-1.json").read_text())
    imports = [phase["data"] for phase in raw["phases"] if (phase.get("data") or {}).get("kind") == "dictionary-import"]
    assert len(imports) == 1, (name, "Expected one complete import")
    finalization = [phase for phase in imports[0]["importDebug"]["importerPhaseTimings"] if phase["phase"] == "bulk-finalization"]
    assert len(finalization) == 1 and finalization[0]["details"]["ok"] is True
    if not name.startswith("warmup-"):
        observations.append({"name": name, "arm": arm, "milliseconds": duration,
                             "bulkFinalizationMs": finalization[0]["elapsedMs"]})

paired_changes = []
control_changes = []
for i in range(0, len(observations), 2):
    pair = {item["arm"]: item for item in observations[i:i + 2]}
    if set(pair) == {"A", "B"}:
        assert pair["A"]["name"][1:] == pair["B"]["name"][1:]
        paired_changes.append(100 * (pair["B"]["milliseconds"] / pair["A"]["milliseconds"] - 1))
    else:
        assert set(pair) == {"C", "D"}
        assert pair["C"]["name"][1:] == pair["D"]["name"][1:]
        control_changes.append(100 * (pair["D"]["milliseconds"] / pair["C"]["milliseconds"] - 1))
assert len(paired_changes) == len(control_changes) == 4
assert package_hashes["A"] == package_hashes["C"] == package_hashes["D"], "Unchanged-code control packages differ"

old_map = json.loads((evidence / "baseline-package-entry-sha256.json").read_text())
new_map = json.loads((evidence / "candidate-package-entry-sha256.json").read_text())
changed_entries = sorted(key for key in old_map.keys() | new_map.keys() if old_map.get(key) != new_map.get(key))
allowed_entries = {
    "js/dictionary/term-bank-wasm-parser.js",
}
assert set(changed_entries) == allowed_entries, ("Unexpected product package differences", changed_entries)
assert "lib/term-bank-parser.wasm" in old_map, "Parser WASM is missing"
assert old_map["lib/term-bank-parser.wasm"] == new_map["lib/term-bank-parser.wasm"]

result = {
    "dictionary": dictionary,
    "comparisonKind": "exploratory-startup-overlap-screen-with-bracketing-controls",
    "baselineSha": baseline,
    "candidateSha": candidate,
    "qualificationSha": qualification,
    "productSourceShas": {"A": baseline, "B": candidate, "C": baseline, "D": baseline},
    "checkoutShas": {"A": baseline, "B": qualification, "C": baseline, "D": baseline},
    "browser": expected_browser,
    "fixture": expected_fixture,
    "timingBoundary": "file-input change to post-UI import-complete event",
    "warmups": 2,
    "measuredImports": len(observations),
    "pairCount": len(paired_changes),
    "unchangedCodeControlPairCount": len(control_changes),
    "baselineMedianMs": statistics.median(item["milliseconds"] for item in observations if item["arm"] == "A"),
    "candidateMedianMs": statistics.median(item["milliseconds"] for item in observations if item["arm"] == "B"),
    "medianPairedChangePercent": statistics.median(paired_changes),
    "pairedChangesPercent": paired_changes,
    "medianControlChangePercent": statistics.median(control_changes),
    "controlChangesPercent": control_changes,
    "observations": observations,
    "packageHashes": package_hashes,
    "changedPackageEntries": changed_entries,
    "identicalSampledContentAndMedia": True,
    "validation": reference_validation,
    "limitation": "Exploratory four-pair screen on one Chromium host per dictionary; requires independent confirmation before a speed claim. Sampled persistence checks, not exhaustive stored-byte equality or peak-memory measurement.",
}
(evidence / "comparison.json").write_text(json.dumps(result, indent=2) + "\n")
print("IMPORT_COMPARISON_RESULT " + json.dumps(result, separators=(",", ":")))
