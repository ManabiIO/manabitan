#!/usr/bin/env python3
"""Fail closed on missing observations, source mismatches, or changed results."""

import json
import math
import statistics
import sys
from pathlib import Path

evidence = Path(sys.argv[1])
dictionary = sys.argv[2]
baseline = (evidence / "baseline-sha.txt").read_text().strip()
candidate = (evidence / "candidate-sha.txt").read_text().strip()
order = (evidence / "observation-order.txt").read_text().split()
expected_order = "A1 B1 B2 A2 B3 A3 A4 B4 A5 B5 B6 A6 B7 A7 A8 B8".split()
assert order == expected_order, "The predeclared observation schedule changed"
observations = []
reference_validation = None
expected_fixture = None
expected_browser = None
package_hashes = {}
for name in ["warmup-A", "warmup-B", *order]:
    summary = json.loads((evidence / name / "summary.json").read_text())
    arm = name[-1] if name.startswith("warmup-") else name[0]
    expected_sha = baseline if arm == "A" else candidate
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
    if not name.startswith("warmup-"):
        observations.append({"name": name, "arm": arm, "milliseconds": duration})

paired_changes = []
for i in range(0, len(observations), 2):
    pair = {item["arm"]: item for item in observations[i:i + 2]}
    assert set(pair) == {"A", "B"}
    paired_changes.append(100 * (pair["B"]["milliseconds"] / pair["A"]["milliseconds"] - 1))

old_map = json.loads((evidence / "baseline-package-entry-sha256.json").read_text())
new_map = json.loads((evidence / "candidate-package-entry-sha256.json").read_text())
changed_entries = sorted(key for key in old_map.keys() | new_map.keys() if old_map.get(key) != new_map.get(key))
allowed_entries = {
    "js/dictionary/wasm/term-bank-parser.c",
    "js/dictionary/term-bank-wasm-parser.js",
    "lib/term-bank-parser.wasm",
}
assert set(changed_entries) <= allowed_entries, ("Unexpected product package differences", changed_entries)
assert "lib/term-bank-parser.wasm" in changed_entries

result = {
    "dictionary": dictionary,
    "baselineSha": baseline,
    "candidateSha": candidate,
    "browser": expected_browser,
    "fixture": expected_fixture,
    "timingBoundary": "file-input change to post-UI import-complete event",
    "warmups": 2,
    "measuredImports": len(observations),
    "pairCount": len(paired_changes),
    "baselineMedianMs": statistics.median(item["milliseconds"] for item in observations if item["arm"] == "A"),
    "candidateMedianMs": statistics.median(item["milliseconds"] for item in observations if item["arm"] == "B"),
    "medianPairedChangePercent": statistics.median(paired_changes),
    "pairedChangesPercent": paired_changes,
    "observations": observations,
    "packageHashes": package_hashes,
    "changedPackageEntries": changed_entries,
    "identicalSampledContentAndMedia": True,
    "validation": reference_validation,
    "limitation": "One Chromium host; sampled browser persistence checks, not exhaustive stored-byte equality or peak-memory measurement",
}
(evidence / "comparison.json").write_text(json.dumps(result, indent=2) + "\n")
print("IMPORT_COMPARISON_RESULT " + json.dumps(result, separators=(",", ":")))
