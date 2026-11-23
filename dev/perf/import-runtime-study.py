#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Screen or qualify isolated import implementations with frozen benchmark tooling."""

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
    if len(base) != len(candidate) or not base:
        raise RuntimeError("Paired comparison requires matching nonempty observations")
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
        "intervalMethod": "Descriptive percentile bootstrap of paired percentage changes; 10000 resamples, seed 20261122",
        "equalWorkPercent": (sum(candidate) / sum(base) - 1) * 100,
        "baselineMedianMs": statistics.median(base),
        "candidateMedianMs": statistics.median(candidate),
        "meanSavedMs": statistics.mean(a - b for a, b in zip(base, candidate, strict=True)),
    }


def activation_observations(run, label, dictionary, arm):
    phases = run["importDebug"].get("importerPhaseTimings", [])
    banks = [phase["details"] for phase in phases
             if phase.get("phase") == "import-data-banks" and isinstance(phase.get("details"), dict)]
    files = [phase["details"] for phase in phases
             if str(phase.get("phase", "")).startswith("term-file-fast-path:") and isinstance(phase.get("details"), dict)]

    def total(details, key):
        values = [item[key] for item in details if key in item]
        if any(type(value) not in (int, float) or not math.isfinite(value) or value < 0 for value in values):
            raise RuntimeError(f"Invalid activation counter: {key}")
        return sum(values)

    metrics = {
        "compactMetadataGroups": total(banks, "fastPathParserCompactContentMetadataGroups"),
        "compactMetadataDescriptorBytesAvoided": total(banks, "fastPathParserCompactContentMetadataBytesAvoided"),
        "sourceLogicalRangeReads": total(banks, "sourceZipLogicalRangeReadCount"),
        "sourcePhysicalRangeReads": total(banks, "sourceZipPhysicalRangeReadCount"),
        "recentSourceAdoptedBytes": total(files, "dedupRecentSourceAdoptedBytes"),
        "recentSourceCacheBytes": total(files, "dedupRecentSourceCacheBytes"),
        "recentSourceCacheMs": total(files, "dedupRecentSourceCacheMs"),
        "recentSourceHitCount": total(files, "dedupRecentSourceHitCount"),
    }
    if arm == "B" and dictionary == "vndb":
        if label in ("columns", "combined") and (len(banks) != 1 or metrics["compactMetadataGroups"] <= 0 or metrics["compactMetadataDescriptorBytesAvoided"] <= 0):
            raise RuntimeError("Candidate compact metadata path did not execute")
        if label in ("source", "combined") and (len(banks) != 1 or metrics["sourceLogicalRangeReads"] <= 0 or
                                  metrics["sourcePhysicalRangeReads"] <= 0 or
                                  metrics["sourcePhysicalRangeReads"] >= metrics["sourceLogicalRangeReads"] or
                                  not all(key in banks[0] for key in ("sourceZipLogicalRangeReadCount", "sourceZipPhysicalRangeReadCount"))):
            raise RuntimeError("Candidate ZIP reads did not coalesce")
    return metrics


def read_summary(output, dictionary, fixture, revision, package_hash, media_check):
    summary = json.loads((output / "summary.json").read_text())
    if (summary.get("schemaVersion") != 3 or summary.get("dictionary") != dictionary or
            summary.get("fixture") != fixture or summary.get("buildTarget") != "chrome" or
            summary.get("mediaCheck") != media_check or summary.get("authoritativeTiming") is not True or
            summary.get("traceEnabled") is not False or summary.get("importFlags") is not None or
            not isinstance(summary.get("runs"), list) or len(summary["runs"]) != 1):
        raise RuntimeError("Benchmark summary differs from the frozen protocol")
    run = summary["runs"][0]
    if summary["gitSha"] != revision or run["packageSha256"] != package_hash:
        raise RuntimeError("Observation source/package differs from the frozen arm")
    if not isinstance(summary.get("browserVersion"), str) or not summary["browserVersion"] or run.get("browserVersion") != summary["browserVersion"]:
        raise RuntimeError("Missing or inconsistent browser identity")
    # import-benchmark.js already requires the complete schema-v3 lookup,
    # restart, storage and source-media receipts before writing this summary.
    return summary, run


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--dictionary", choices=("jmdict", "jitendex", "vndb"), required=True)
    parser.add_argument("--label", choices=("row", "cache", "columns", "source", "combined"), required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--screen", action="store_true", help="Use the fixed six-block exploratory screen; default is independent twelve-block qualification")
    parser.add_argument("--source-pr-url", default=None)
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
    orders = list(ORDERS[:6] if args.screen else ORDERS)
    stage = "screening" if args.screen else "qualification"
    fixture = json.loads((root / "test/perf/dictionaries.lock.json").read_text())["dictionaries"][args.dictionary]
    protocol = {
        "schemaVersion": 1,
        "dictionary": args.dictionary,
        "candidateLabel": args.label,
        "stage": stage,
        "plannedBlocks": len(orders),
        "independentQualificationRequired": args.screen,
        "sourcePrUrl": args.source_pr_url,
        "codeValidation": "Separate frozen source PR CI: all JavaScript, all four TypeScript configurations, full unit/options, pinned native artifacts, all-target builds and browser E2E. No benchmark overlay is applied to those jobs.",
        "toolingSha": tooling_sha,
        "productRevisions": revisions,
        "orders": orders,
        "node": command(["node", "--version"], root),
        "toolingFiles": tooling_hashes,
        "warmupsExcluded": 0,
        "timingMediaCheck": "sample",
        "diagnosticMediaCheck": "all",
        "comparisonPairs": {"candidate": "B/A", "candidateVsSecondBaseline": "B/C", "control": "C/A"},
        "notes": f"Fresh profiles; post-UI completion; no tracing or sampling during import. All observations retained. Fixed {len(orders)} blocks; no retries or tail exclusions. Six-block screens are exploratory and cannot substitute for a later independent twelve-block qualification.",
        "activationNotes": "Compact counters use import-data-banks only, avoiding duplicate per-file totals; descriptor bytes avoided are not net allocations. Cache adoption is observed once per term-file-fast-path phase without a predeclared direction gate.",
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
    expected_storage = None
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
                    package_arm = "A" if arm == "C" else arm
                    summary, run = read_summary(output, args.dictionary, fixture, revisions[arm], package_hashes[package_arm], "sample")
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
                    storage_bytes = validation["storage"]["bytes"]
                    if expected_storage is None:
                        if arm != "A":
                            raise RuntimeError("First storage receipt must come from baseline A")
                        expected_storage = storage_bytes
                    if storage_bytes != expected_storage:
                        raise RuntimeError("Logical storage bytes differ from the first baseline receipt")
                    activation = activation_observations(run, args.label, args.dictionary, arm)
                    entry.update(
                        status="success", totalImportMs=timing,
                        activation=activation,
                        storageBytes=storage_bytes,
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
        if any(len(values[arm]) != len(orders) for arm in "ABC"):
            raise RuntimeError("The fixed paired cohort is incomplete")
        write_json(evidence / "analysis.json", {
            "dictionary": args.dictionary,
            "candidateLabel": args.label,
            "stage": stage,
            "screeningOnly": args.screen,
            "independentQualificationRequired": args.screen,
            "intervalCaveat": "Bootstrap bounds are descriptive and unstable for six pairs; a favorable screen is not qualification.",
            "browserVersion": browser_version,
            "candidate": compare(values["A"], values["B"]),
            "candidateVsSecondBaseline": compare(values["C"], values["B"]),
            "identicalProductControl": compare(values["A"], values["C"]),
            "allTimingsMs": values,
            "storageBytes": {arm: [item["storageBytes"] for item in observations if item["arm"] == arm] for arm in "ABC"},
            "lookupWarmMedianMs": {arm: [item["lookupWarmMedianMs"] for item in observations if item["arm"] == arm] for arm in "ABC"},
            "activation": {arm: [item["activation"] for item in observations if item["arm"] == arm] for arm in "ABC"},
        })
    # Exhaustive media verification is deliberately separate from timed cohorts.
    diagnostic_media = None
    for arm in ("A", "B"):
        output = evidence / f"diagnostic-{arm}"
        command([
            "node", "dev/perf/import-benchmark.js", args.dictionary,
            "--runs", "1", "--no-build", "--build-target", "chrome",
            "--media-check", "all", "--output", str(output),
        ], arm_roots[arm], output / "command.log")
        summary, run = read_summary(output, args.dictionary, fixture, revisions[arm], package_hashes[arm], "all")
        if browser_version is not None and summary["browserVersion"] != browser_version:
            raise RuntimeError("Browser version changed before exhaustive verification")
        browser_version = summary["browserVersion"]
        lookup_identity = [(row["pass"], row["term"], row["results"], row["sha256"]) for row in run["validation"]["lookup"]["observations"]]
        if expected_lookup is not None and lookup_identity != expected_lookup:
            raise RuntimeError("Diagnostic lookup responses differ from the timed cohort")
        expected_lookup = lookup_identity
        media = run["validation"]["media"]
        media_identity = (media["files"], media["bytes"], media["sha256"])
        if diagnostic_media is not None and media_identity != diagnostic_media:
            raise RuntimeError("Exhaustive persisted media differ across arms")
        diagnostic_media = media_identity
        storage_bytes = run["validation"]["storage"]["bytes"]
        if expected_storage is None:
            if arm != "A":
                raise RuntimeError("First storage receipt must come from baseline A")
            expected_storage = storage_bytes
        if storage_bytes != expected_storage:
            raise RuntimeError("Diagnostic logical storage bytes differ from the first baseline receipt")
        activation_observations(run, args.label, args.dictionary, arm)
    # Source can be reconstructed from recorded SHAs; upload reports, not worktrees.
    for arm in ("A", "B"):
        command(["git", "worktree", "remove", "--force", str(roots / arm)], root)
    roots.rmdir()


if __name__ == "__main__":
    main()
