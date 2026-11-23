#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Compare isolated import implementations with identical benchmark tooling."""

import argparse
import hashlib
import json
import math
from pathlib import Path
import random
import shutil
import statistics
import subprocess
import time


ORDERS = (
    "ABC", "CBA", "BAC", "CAB", "BCA", "ACB",
    "ACB", "BCA", "CAB", "BAC", "CBA", "ABC",
)
PRODUCT_PREFIXES = ("ext/", "dev/data/dictionary-wasm/")


def sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def command(args, cwd, log=None):
    print(f"[{cwd}] {' '.join(map(str, args))}", flush=True)
    if log is None:
        return subprocess.run(args, cwd=cwd, check=True, text=True, capture_output=True).stdout.strip()
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("w") as output:
        result = subprocess.run(args, cwd=cwd, stdout=output, stderr=subprocess.STDOUT)
    if result.returncode != 0:
        print(log.read_text()[-20000:], flush=True)
        raise RuntimeError(f"Command failed ({result.returncode}); complete log: {log}")
    return ""


def package_entries(path):
    import zipfile
    with zipfile.ZipFile(path) as archive:
        return {
            item.filename: hashlib.sha256(archive.read(item)).hexdigest()
            for item in archive.infolist() if not item.is_dir()
        }


def compare(base, candidate):
    ratios = [b / a for a, b in zip(base, candidate, strict=True)]
    changes = [(ratio - 1) * 100 for ratio in ratios]
    rng = random.Random(20261122)
    bootstraps = sorted(
        statistics.median([rng.choice(changes) for _ in changes])
        for _ in range(10000)
    )
    return {
        "pairs": len(ratios),
        "fasterPairs": sum(ratio < 1 for ratio in ratios),
        "pairedChangesPercent": changes,
        "pairedMedianPercent": statistics.median(changes),
        "pairedMedianBootstrap95Percent": [bootstraps[249], bootstraps[9749]],
        "equalWorkPercent": (sum(candidate) / sum(base) - 1) * 100,
        "baselineMedianMs": statistics.median(base),
        "candidateMedianMs": statistics.median(candidate),
        "meanSavedMs": statistics.mean(a - b for a, b in zip(base, candidate, strict=True)),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--dictionary", choices=("jmdict", "jitendex", "vndb"), required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--reverse", action="store_true")
    parser.add_argument("--diagnostic-only", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    evidence = args.output.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    roots = evidence / "worktrees"
    roots.mkdir(exist_ok=True)
    refs = {"A": args.baseline, "B": args.candidate}
    revisions = {
        arm: command(["git", "rev-parse", f"{ref}^{{commit}}"], root)
        for arm, ref in refs.items()
    }
    revisions["C"] = revisions["A"]
    tooling_sha = command(["git", "rev-parse", "HEAD"], root)
    tooling_files = command(["git", "ls-files", "dev/perf", "test"], root).splitlines()
    for name in tooling_files:
        if name.startswith(PRODUCT_PREFIXES):
            raise RuntimeError(f"Product file in tooling overlay: {name}")
    tooling_hashes = {name: sha256(root / name) for name in tooling_files}
    orders = list(ORDERS)
    if args.reverse:
        orders = [order[::-1] for order in reversed(orders)]
    protocol = {
        "schemaVersion": 1,
        "dictionary": args.dictionary,
        "toolingSha": tooling_sha,
        "productRevisions": revisions,
        "orders": orders,
        "node": command(["node", "--version"], root),
        "toolingFiles": tooling_hashes,
        "warmupsExcluded": 0,
        "timingMediaCheck": "sample",
        "diagnosticMediaCheck": "all",
        "comparisonPairs": {"candidate": "B/A", "candidateVsSecondBaseline": "B/C", "control": "C/A"},
        "notes": "Fresh profiles; post-UI completion; no tracing or sampling during import. All observations retained. Fixed twelve blocks; no retries or tail exclusions.",
    }
    write_json(evidence / "protocol.json", protocol)
    command(["node", "dev/perf/prepare-dictionaries.js", "--all"], root, evidence / "prepare-dictionaries.log")
    source_cache = root / "builds/e2e-dictionary-cache"
    manifests = {}
    package_hashes = {}
    for arm in ("A", "B"):
        target = roots / arm
        command(["git", "worktree", "add", "--detach", str(target), revisions[arm]], root, evidence / f"prepare-{arm}.log")
        if (target / "package-lock.json").read_bytes() != (root / "package-lock.json").read_bytes():
            raise RuntimeError(f"Different dependency lock for {arm}")
        for name in tooling_files:
            destination = target / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(root / name, destination)
        (target / "node_modules").symlink_to(root / "node_modules", target_is_directory=True)
        (target / "builds").mkdir(exist_ok=True)
        (target / "builds/e2e-dictionary-cache").symlink_to(source_cache, target_is_directory=True)
        command(["npm", "run", "build:libs"], target, evidence / f"libraries-{arm}.log")
        command(["npm", "run", "build", "--", "--target", "chrome"], target, evidence / f"build-{arm}.log")
        package = target / "builds/manabitan-chrome.zip"
        manifests[arm] = package_entries(package)
        package_hashes[arm] = sha256(package)
        write_json(evidence / f"package-{arm}.json", {
            "source": revisions[arm], "archiveSha256": package_hashes[arm], "entries": manifests[arm],
        })
        for name, expected in tooling_hashes.items():
            if sha256(target / name) != expected:
                raise RuntimeError(f"Tooling changed while building {arm}: {name}")
    write_json(evidence / "package-differences.json", {
        arm: [name for name in sorted(set(manifests["A"]) | set(manifests[arm]))
              if manifests["A"].get(name) != manifests[arm].get(name)]
        for arm in ("B",)
    })
    arm_roots = {arm: roots / ("A" if arm == "C" else arm) for arm in "ABC"}
    observations = []
    expected_lookup = None
    expected_media = None
    browser_version = None
    if not args.diagnostic_only:
        for block, order in enumerate(orders, start=1):
            for position, arm in enumerate(order, start=1):
                output = evidence / f"block-{block:02d}-{position}-{arm}"
                output.mkdir(exist_ok=True)
                host = command(["node", str(root / "dev/perf/host-environment.js")], root)
                (output / "host-before.json").write_text(host + "\n")
                entry = {"block": block, "position": position, "arm": arm, "source": revisions[arm], "status": "running"}
                observations.append(entry)
                write_json(evidence / "observations.json", observations)
                started = time.monotonic()
                try:
                    command([
                        "node", "dev/perf/import-benchmark.js", args.dictionary,
                        "--runs", "1", "--no-build", "--build-target", "chrome",
                        "--media-check", "sample", "--output", str(output),
                    ], arm_roots[arm], output / "command.log")
                    summary = json.loads((output / "summary.json").read_text())
                    run = summary["runs"][0]
                    package_arm = "A" if arm == "C" else arm
                    if summary["gitSha"] != revisions[arm] or run["packageSha256"] != package_hashes[package_arm]:
                        raise RuntimeError("Observation source/package differs from the frozen arm")
                    if not isinstance(summary.get("browserVersion"), str) or not summary["browserVersion"]:
                        raise RuntimeError("Missing browser identity")
                    if browser_version is None:
                        browser_version = summary["browserVersion"]
                    if summary["browserVersion"] != browser_version:
                        raise RuntimeError("Browser version changed during the study")
                    timing = run["totalImportMs"]
                    if not isinstance(timing, (int, float)) or not math.isfinite(timing) or timing <= 0:
                        raise RuntimeError("Invalid complete-import timing")
                    validation = run["validation"]
                    lookup_rows = validation["lookup"]["observations"]
                    lookup_identity = [(row["pass"], row["term"], row["results"], row["sha256"]) for row in lookup_rows]
                    media = validation["media"]
                    media_identity = (media["files"], media["bytes"], media["sha256"])
                    if expected_lookup is None:
                        expected_lookup, expected_media = lookup_identity, media_identity
                    if lookup_identity != expected_lookup:
                        raise RuntimeError("Production lookup responses differ across observations")
                    if media_identity != expected_media:
                        raise RuntimeError("Persisted source media differ across observations")
                    owned_reservations = [
                        phase.get("details", {}).get("contentOwnedReservationCount")
                        for phase in run["importDebug"].get("importerPhaseTimings", [])
                        if isinstance(phase.get("details"), dict) and "contentOwnedReservationCount" in phase["details"]
                    ]
                    if arm == "B" and args.dictionary in ("jitendex", "vndb") and not any(
                        isinstance(count, (int, float)) and count > 0 for count in owned_reservations
                    ):
                        raise RuntimeError("Candidate owned-reservation path did not execute")
                    entry.update(
                        status="success", totalImportMs=timing,
                        ownedReservationCounts=owned_reservations,
                        storageBytes=validation["storage"]["bytes"],
                        lookupFirstPassMs=[row["elapsedMs"] for row in lookup_rows if row["pass"] == 0],
                        lookupWarmMedianMs=statistics.median(row["elapsedMs"] for row in lookup_rows if row["pass"] > 0),
                        summary=str(output.relative_to(evidence) / "summary.json"),
                    )
                except Exception as error:
                    entry.update(status="failed", error=str(error))
                    raise
                finally:
                    entry["commandElapsedSeconds"] = time.monotonic() - started
                    write_json(evidence / "observations.json", observations)
                print(json.dumps(entry), flush=True)
        values = {arm: [item["totalImportMs"] for item in observations if item["arm"] == arm] for arm in "ABC"}
        write_json(evidence / "analysis.json", {
            "dictionary": args.dictionary,
            "browserVersion": browser_version,
            "candidate": compare(values["A"], values["B"]),
            "candidateVsSecondBaseline": compare(values["C"], values["B"]),
            "identicalProductControl": compare(values["A"], values["C"]),
            "allTimingsMs": values,
            "storageBytes": {arm: [item["storageBytes"] for item in observations if item["arm"] == arm] for arm in "ABC"},
            "lookupWarmMedianMs": {arm: [item["lookupWarmMedianMs"] for item in observations if item["arm"] == arm] for arm in "ABC"},
        })
    # Exhaustive media verification is deliberately separate from timed cohorts.
    for arm in ("A", "B"):
        output = evidence / f"diagnostic-{arm}"
        command([
            "node", "dev/perf/import-benchmark.js", args.dictionary,
            "--runs", "1", "--no-build", "--build-target", "chrome",
            "--media-check", "all", "--output", str(output),
        ], arm_roots[arm], output / "command.log")
    # Source can be reconstructed from recorded SHAs; upload reports, not worktrees.
    for arm in ("A", "B"):
        command(["git", "worktree", "remove", "--force", str(roots / arm)], root)
    roots.rmdir()


if __name__ == "__main__":
    main()
