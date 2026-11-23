#!/usr/bin/env python3
"""Exercise qualification rejection gates with explicitly synthetic evidence.

This performs no imports and produces no performance evidence. It copies the
verifier under review, builds small reports shaped like import-benchmark.js,
and mutates one invariant per negative case.
"""

import argparse
import ast
import copy
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path


TRIPLETS = ["ABC", "CBA", "BCA", "ACB", "CAB", "BAC", "BAC", "CAB", "ACB", "BCA", "CBA", "ABC"]
ORDER = [f"{arm}{index}" for index, arms in enumerate(TRIPLETS, 1) for arm in arms]
WARMUPS = "warmup-A1 warmup-B1 warmup-C1 warmup-C2 warmup-B2 warmup-A2".split()
BASELINE = "5e1f8c12f7ff798ba407323aff675cb23b22af02"
CANDIDATE = "b" * 40
BUILD_KEY = "builds/manabitan-chrome.zip"
PRODUCT_PATHS = (
    "js/dictionary/dictionary-importer.js",
    "js/dictionary/dictionary-generation-media-store.js",
)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


def read_qualified_lock(repo):
    lock = json.loads((repo / "test/perf/dictionaries.lock.json").read_text())
    overlay = ast.parse((repo / "dev/perf/qualification-vndb-overlay.py").read_text())
    for node in overlay.body:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = ast.unparse(node.targets[0])
        if target == "lock['dictionaries']['vndb']":
            lock["dictionaries"]["vndb"] = ast.literal_eval(node.value)
            break
    assert "vndb" in lock["dictionaries"], "Could not recover the overlay's pinned VNDB fixture"
    return lock


def validation_for(fixture, dictionary):
    result = {
        "title": fixture["expectedTitle"],
        "revision": fixture["revision"],
        "termRows": fixture["termRows"],
        "contentReadable": True,
        "probeCount": 12,
        "probeTerms": [f"synthetic-probe-{index}" for index in range(12)],
        "outputDigestSha256": "1" * 64,
        "mediaRows": 0,
        "generationMedia": None,
        "packedMediaActivation": None,
        "mediaBeforeRestart": None,
        "mediaAfterRestart": None,
        "restart": {
            "title": fixture["expectedTitle"],
            "revision": fixture["revision"],
            "termRows": fixture["termRows"],
            "contentReadable": True,
            "probeCount": 12,
        },
    }
    if dictionary == "vndb":
        paths = ["img/cc1.webp", "img/cc51193.webp", "img/cc106314.webp", "img/cc163034.webp", "img/cc18737.webp"]
        probes = [{"path": path, "bytes": 100 + index, "sha256": "2" * 64} for index, path in enumerate(paths)]
        result.update({
            "mediaRows": fixture["mediaRows"],
            "generationMedia": {
                "version": 2, "prefix": "img/cc", "suffix": ".webp", "firstId": 1,
                "slotCount": 163034, "count": fixture["mediaRows"], "dataBytes": 100000,
            },
            "packedMediaActivation": {"entries": fixture["mediaRows"], "bytes": 100000},
            "mediaBeforeRestart": probes,
            "mediaAfterRestart": copy.deepcopy(probes),
        })
    return result


def make_evidence(root, lock, dictionary):
    root.mkdir(parents=True)
    (root / "baseline-sha.txt").write_text(BASELINE + "\n")
    (root / "candidate-sha.txt").write_text(CANDIDATE + "\n")
    (root / "observation-order.txt").write_text(" ".join(ORDER) + "\n")
    (root / "warmup-order.txt").write_text(" ".join(WARMUPS) + "\n")
    write_json(root / "qualified-dictionaries.lock.json", lock)
    old_map = {"manifest.json": "3" * 64, **{path: "4" * 64 for path in PRODUCT_PATHS}}
    new_map = {"manifest.json": "3" * 64, **{path: "5" * 64 for path in PRODUCT_PATHS}}
    write_json(root / "baseline-package-entry-sha256.json", old_map)
    write_json(root / "candidate-package-entry-sha256.json", new_map)
    fixture = lock["dictionaries"][dictionary]
    validation = validation_for(fixture, dictionary)
    for name in [*WARMUPS, *ORDER]:
        arm = name[7] if name.startswith("warmup-") else name[0]
        source_sha = CANDIDATE if arm == "B" else BASELINE
        package_sha = ("b" if arm == "B" else "a") * 64
        duration = 777 if name.startswith("warmup-") else (90 if arm == "B" else 100)
        summary = {
            "schemaVersion": 3,
            "dictionary": dictionary,
            "buildTarget": "chrome",
            "fixture": copy.deepcopy(fixture),
            "authoritativeTiming": True,
            "traceEnabled": False,
            "gitSha": source_sha,
            "source": {"gitSha": source_sha, "dirty": True, "sha256": {BUILD_KEY: package_sha}},
            "hostEnvironment": {"synthetic": True},
            "browserVersion": "153.0.8010.12",
            "importFlags": None,
            "runs": [{
                "index": 1,
                "browserVersion": "153.0.8010.12",
                "packageSha256": package_sha,
                "totalImportMs": duration,
                "validation": copy.deepcopy(validation),
            }],
            "timingBoundary": "page file-input change event to post-UI import-complete event; browser monotonic clock",
        }
        write_json(root / name / "summary.json", summary)


def mutate_summaries(root, names, change):
    for name in names:
        path = root / name / "summary.json"
        summary = json.loads(path.read_text())
        change(summary)
        write_json(path, summary)


def fixture_mismatch(root):
    # Change every report equally: comparing reports only with each other must
    # not be mistaken for comparing them with the independently saved lock.
    mutate_summaries(root, [*WARMUPS, *ORDER], lambda s: s["fixture"].update(sha256="0" * 64))


def control_package_mismatch(root):
    def change(summary):
        summary["runs"][0]["packageSha256"] = "c" * 64
        summary["source"]["sha256"][BUILD_KEY] = "c" * 64
    mutate_summaries(root, [name for name in [*WARMUPS, *ORDER] if (name[7] if name.startswith("warmup-") else name[0]) == "C"], change)


def output_mismatch(root):
    mutate_summaries(root, ["B1"], lambda s: s["runs"][0]["validation"].update(outputDigestSha256="9" * 64))


def wrong_product_entry(root):
    path = root / "candidate-package-entry-sha256.json"
    value = json.loads(path.read_text())
    value["js/data/term-bank-parser.wasm"] = "6" * 64
    write_json(path, value)


def package_provenance_mismatch(root):
    mutate_summaries(root, ["B1"], lambda s: s["source"]["sha256"].update({BUILD_KEY: "6" * 64}))


def missing_browser(root):
    def change(summary):
        summary["browserVersion"] = ""
        summary["runs"][0]["browserVersion"] = ""
    mutate_summaries(root, [*WARMUPS, *ORDER], change)


def wrong_source_sha(root):
    mutate_summaries(root, ["B1"], lambda s: s.update(gitSha=BASELINE))


def missing_observation(root):
    (root / "B12" / "summary.json").unlink()


def wrong_schedule(root):
    order = ORDER.copy()
    order[0], order[1] = order[1], order[0]
    (root / "observation-order.txt").write_text(" ".join(order) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    original = args.repo / "dev/perf/verify-import-comparison.py"
    verifier = args.output / "verifier-under-test.py"
    shutil.copyfile(original, verifier)
    lock = read_qualified_lock(args.repo)
    cases = [(f"valid-{dictionary}", dictionary, None) for dictionary in ["jmdict", "jitendex", "vndb"]]
    cases += [(name, "vndb", mutation) for name, mutation in [
        ("fixture-mismatch", fixture_mismatch),
        ("control-package-mismatch", control_package_mismatch),
        ("output-mismatch", output_mismatch),
        ("wrong-product-entry", wrong_product_entry),
        ("package-provenance-mismatch", package_provenance_mismatch),
        ("missing-browser", missing_browser),
        ("wrong-source-sha", wrong_source_sha),
        ("missing-observation", missing_observation),
        ("wrong-schedule", wrong_schedule),
    ]]
    results = []
    for name, dictionary, mutation in cases:
        root = args.output / name
        make_evidence(root, lock, dictionary)
        if mutation is not None:
            mutation(root)
        process = subprocess.run([sys.executable, str(verifier), str(root), dictionary], capture_output=True, text=True, timeout=30)
        (root / "verifier.stdout.txt").write_text(process.stdout)
        (root / "verifier.stderr.txt").write_text(process.stderr)
        should_pass = mutation is None
        passed = (process.returncode == 0) == should_pass
        output_oracle = None
        if should_pass and process.returncode == 0:
            comparison = json.loads((root / "comparison.json").read_text())
            output_oracle = (
                comparison["warmups"] == 6 and comparison["measuredImports"] == 36 and
                comparison["tripletCount"] == 12 and comparison["armMediansMs"] == {"A": 100, "B": 90, "C": 100} and
                abs(comparison["candidateVersusA"]["equalWorkChangePercent"] + 10) < 1e-10 and
                comparison["identicalCodeControl"]["equalWorkChangePercent"] == 0 and
                [row["name"] for row in comparison["observations"]] == ORDER
            )
            passed = passed and output_oracle
        result = {"name": name, "dictionary": dictionary, "expected": "accept" if should_pass else "reject", "returncode": process.returncode, "passed": passed, "outputOracle": output_oracle, "error": process.stderr.strip().splitlines()[-1] if process.stderr.strip() else None}
        results.append(result)
        print(json.dumps(result), flush=True)
    report = {
        "syntheticOnly": True,
        "realImportsRun": 0,
        "verifierPath": str(original),
        "verifierSha256": hashlib.sha256(verifier.read_bytes()).hexdigest(),
        "allPassed": all(result["passed"] for result in results),
        "cases": results,
    }
    write_json(args.output / "test-result.json", report)
    return 0 if report["allPassed"] else 1


if __name__ == "__main__":
    sys.exit(main())
