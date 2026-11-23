#!/usr/bin/env python3
"""Fail closed on missing observations, source mismatches, or changed results."""

import json
import math
import random
import statistics
import sys
from pathlib import Path

evidence = Path(sys.argv[1])
dictionary = sys.argv[2]
baseline = (evidence / "baseline-sha.txt").read_text().strip()
candidate = (evidence / "candidate-sha.txt").read_text().strip()
order = (evidence / "observation-order.txt").read_text().split()
triplet_orders = ["ABC", "CBA", "BCA", "ACB", "CAB", "BAC", "BAC", "CAB", "ACB", "BCA", "CBA", "ABC"]
expected_order = [f"{arm}{index}" for index, arms in enumerate(triplet_orders, 1) for arm in arms]
assert order == expected_order, "The predeclared observation schedule changed"
warmups = (evidence / "warmup-order.txt").read_text().split()
assert warmups == "warmup-A1 warmup-B1 warmup-C1 warmup-C2 warmup-B2 warmup-A2".split()
observations = []
reference_validation = None
expected_fixture = json.loads((evidence / "qualified-dictionaries.lock.json").read_text())["dictionaries"][dictionary]
expected_browser = None
package_hashes = {}
for name in [*warmups, *order]:
    summary = json.loads((evidence / name / "summary.json").read_text())
    arm = name[7] if name.startswith("warmup-") else name[0]
    expected_sha = candidate if arm == "B" else baseline
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
    assert isinstance(browser, str) and browser.strip(), (name, "browser identity missing")
    if expected_browser is None:
        expected_browser = browser
    assert fixture == expected_fixture and browser == expected_browser
    assert run["packageSha256"] == summary["source"]["sha256"]["builds/manabitan-chrome.zip"], (name, "package provenance mismatch")
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

assert package_hashes["A"] == package_hashes["C"], "Identical-code control package differs"
triplets = []
for index in range(0, len(observations), 3):
    triplet = {item["arm"]: item["milliseconds"] for item in observations[index:index + 3]}
    assert set(triplet) == {"A", "B", "C"}
    triplets.append(triplet)


def comparison(numerator, denominator):
    changes = [100 * (item[numerator] / item[denominator] - 1) for item in triplets]
    rng = random.Random(20261122)
    medians = sorted(statistics.median(rng.choices(changes, k=len(changes))) for _ in range(10000))
    return {
        "pairedChangesPercent": changes,
        "medianPairedChangePercent": statistics.median(changes),
        "equalWorkChangePercent": 100 * (
            sum(item[numerator] for item in triplets) / sum(item[denominator] for item in triplets) - 1
        ),
        "fasterPairs": sum(change < 0 for change in changes),
        "descriptivePairedMedianInterval95Percent": [medians[249], medians[9749]],
    }

old_map = json.loads((evidence / "baseline-package-entry-sha256.json").read_text())
new_map = json.loads((evidence / "candidate-package-entry-sha256.json").read_text())
changed_entries = sorted(key for key in old_map.keys() | new_map.keys() if old_map.get(key) != new_map.get(key))
allowed_entries = {
    "js/dictionary/dictionary-importer.js",
    "js/dictionary/dictionary-generation-media-store.js",
}
assert set(changed_entries) == allowed_entries, ("Unexpected product package differences", changed_entries)

result = {
    "dictionary": dictionary,
    "baselineSha": baseline,
    "candidateSha": candidate,
    "browser": expected_browser,
    "fixture": expected_fixture,
    "timingBoundary": "file-input change to post-UI import-complete event",
    "warmups": len(warmups),
    "measuredImports": len(observations),
    "tripletCount": len(triplets),
    "armMediansMs": {arm: statistics.median(item[arm] for item in triplets) for arm in "ABC"},
    "candidateVersusA": comparison("B", "A"),
    "candidateVersusC": comparison("B", "C"),
    "identicalCodeControl": comparison("C", "A"),
    "observations": observations,
    "packageHashes": package_hashes,
    "changedPackageEntries": changed_entries,
    "identicalSampledContentAndMedia": True,
    "validation": reference_validation,
    "limitation": "One Chromium host per dictionary; all observations and tails retained. A/C controls are reported separately without subtraction. Descriptive intervals are not cross-device guarantees. Sampled browser persistence checks, not exhaustive stored-byte equality or peak-memory measurement.",
}
(evidence / "comparison.json").write_text(json.dumps(result, indent=2) + "\n")
print("IMPORT_COMPARISON_RESULT " + json.dumps(result, separators=(",", ":")))
