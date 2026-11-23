#!/usr/bin/env python3
# Copyright (C) 2026 Manabitan authors
# SPDX-License-Identifier: GPL-3.0-or-later
"""Frozen-source, three-arm browser import screen; never a promotion verdict."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import statistics
import subprocess
import tempfile
import time
import zipfile


ROOT = Path(__file__).resolve().parents[2]
ORDERS = ("ABC", "CBA", "BCA", "ACB", "CAB", "BAC")
HARNESS_FILES = (
    "test/chromium/extension-two-dictionary-import.e2e.js",
    "dev/perf/import-benchmark.js",
    "dev/perf/benchmark-support.js",
    "dev/perf/dictionary-fixtures.js",
    "dev/perf/import-media-validation.js",
    "test/perf/dictionaries.lock.json",
    "package-lock.json",
)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def command(args, cwd, log):
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("a") as output:
        output.write(json.dumps({"argv": list(map(str, args)), "cwd": str(cwd)}) + "\n")
        output.flush()
        result = subprocess.run(list(map(str, args)), cwd=cwd, stdout=output, stderr=subprocess.STDOUT)
    if result.returncode:
        raise RuntimeError(f"Command failed ({result.returncode}); retained log: {log}")


def git_value(root, *args):
    return subprocess.check_output(["git", *args], cwd=root, text=True).strip()


def package_entries(path):
    with zipfile.ZipFile(path) as archive:
        return {
            entry.filename: hashlib.sha256(archive.read(entry)).hexdigest()
            for entry in archive.infolist() if not entry.is_dir()
        }


def host_snapshot():
    return {
        "epochSeconds": time.time(),
        "loadAverage": list(os.getloadavg()),
        "meminfo": Path("/proc/meminfo").read_text() if Path("/proc/meminfo").exists() else None,
    }


def semantic_signature(validation):
    # Complete production lookup responses are hashed by the existing harness.
    # These are twelve sampled terms, not exhaustive lexical-content equality.
    return {
        "title": validation["title"],
        "revision": validation["revision"],
        "termRows": validation["termRows"],
        "probeTerms": validation["probeTerms"],
        "lookupResults": [
            {key: observation[key] for key in ("pass", "term", "results", "sha256")}
            for observation in validation["lookup"]["observations"]
        ],
        "restart": validation["restart"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--dictionary", choices=("jmdict", "jitendex", "vndb"), required=True)
    parser.add_argument("--label", required=True)
    options = parser.parse_args()
    for sha in (options.baseline, options.candidate):
        if re.fullmatch(r"[a-f0-9]{40}", sha) is None:
            parser.error("Both source references must be frozen full commit SHAs")
    if re.fullmatch(r"[a-z0-9-]+", options.label) is None:
        parser.error("Label must contain only lowercase letters, digits and hyphens")

    evidence = ROOT / "builds/import-screen-20261123" / options.label / options.dictionary
    evidence.mkdir(parents=True, exist_ok=False)
    work = Path(tempfile.mkdtemp(prefix="manabitan-import-screen-", dir=os.environ.get("RUNNER_TEMP")))
    state = {
        "schemaVersion": 1,
        "status": "running",
        "baseline": options.baseline,
        "candidate": options.candidate,
        "dictionary": options.dictionary,
        "label": options.label,
        "orders": list(ORDERS),
        "limits": "Exploratory six-block screen with two identical baseline controls; not cross-device qualification. All tails and failures retained. No peak-memory claim. Lookup content is sampled; media diagnostics are exhaustive.",
        "observations": [],
    }
    write_json(evidence / "protocol.json", state)
    shutil.copyfile(__file__, evidence / "runner.py")
    workflow = ROOT / ".github/workflows/import-screen-20261123.yml"
    if workflow.exists():
        shutil.copyfile(workflow, evidence / "workflow.yml")
    try:
        command(["git", "fetch", "--no-tags", "origin", options.baseline, options.candidate], ROOT, evidence / "setup.log")
        command(["node", "dev/perf/prepare-dictionaries.js", options.dictionary], ROOT, evidence / "setup.log")
        fixture = json.loads((ROOT / "test/perf/dictionaries.lock.json").read_text())["dictionaries"][options.dictionary]
        source_archive = ROOT / "builds/e2e-dictionary-cache" / fixture["cacheFile"]
        if source_archive.stat().st_size != fixture["sizeBytes"] or digest(source_archive) != fixture["sha256"]:
            raise RuntimeError("Source archive does not match the current fixture lock")
        state["fixture"] = fixture
        state["runnerSha256"] = digest(Path(__file__))
        state["studyCommit"] = git_value(ROOT, "rev-parse", "HEAD")
        state["node"] = subprocess.check_output(["node", "--version"], text=True).strip()
        arms = {}
        identities = {}
        for arm, sha in (("A", options.baseline), ("B", options.candidate), ("C", options.baseline)):
            tree = work / arm
            command(["git", "worktree", "add", "--detach", tree, sha], ROOT, evidence / "setup.log")
            if git_value(tree, "rev-parse", "HEAD") != sha:
                raise RuntimeError("Checked-out source does not match the frozen commit")
            for filename in HARNESS_FILES:
                if digest(ROOT / filename) != digest(tree / filename):
                    raise RuntimeError(f"Source/harness mismatch in {arm}: {filename}")
            command(["npm", "ci", "--offline", "--no-audit", "--no-fund"], tree, evidence / f"build-{arm}.log")
            cache = tree / "builds/e2e-dictionary-cache"
            cache.mkdir(parents=True, exist_ok=True)
            try:
                os.link(source_archive, cache / fixture["cacheFile"])
            except OSError:
                shutil.copyfile(source_archive, cache / fixture["cacheFile"])
            command(["npm", "run", "build:libs"], tree, evidence / f"build-{arm}.log")
            command(["npm", "run", "license-report:html"], tree, evidence / f"build-{arm}.log")
            command(["node", "dev/bin/build.js", "--target", "chrome"], tree, evidence / f"build-{arm}.log")
            package = tree / "builds/manabitan-chrome.zip"
            entries = package_entries(package)
            write_json(evidence / f"package-{arm}-entries.json", entries)
            identities[arm] = {
                "commit": sha,
                "tree": git_value(tree, "rev-parse", "HEAD^{tree}"),
                "packageSha256": digest(package),
                "entries": entries,
                "harness": {filename: digest(tree / filename) for filename in HARNESS_FILES},
            }
            arms[arm] = tree
        if identities["A"]["entries"] != identities["C"]["entries"]:
            raise RuntimeError("The baseline controls do not contain identical packaged bytes")
        changed = sorted(
            name for name in set(identities["A"]["entries"]) | set(identities["B"]["entries"])
            if identities["A"]["entries"].get(name) != identities["B"]["entries"].get(name)
        )
        if not changed:
            raise RuntimeError("Candidate package is identical to the baseline")
        state["packageChanges"] = changed
        state["identities"] = identities
        write_json(evidence / "identities.json", identities)

        canonical = None
        browser_version = None
        media_signatures = {}

        def observe(arm, label, media_mode, block=None):
            nonlocal canonical, browser_version
            tree = arms[arm]
            output = evidence / label
            before = host_snapshot()
            print(f"[{options.label}/{options.dictionary}] {label} ({arm}, media={media_mode})", flush=True)
            command([
                "node", "dev/perf/import-benchmark.js", options.dictionary,
                "--runs", "1", "--build-target", "chrome", "--no-build",
                "--media-check", media_mode, "--output", output,
            ], tree, evidence / f"{label}.log")
            summary = json.loads((output / "summary.json").read_text())
            result = summary["runs"][0]
            validation = result["validation"]
            if summary["gitSha"] != identities[arm]["commit"] or result["packageSha256"] != identities[arm]["packageSha256"]:
                raise RuntimeError(f"Source/package identity changed in {label}")
            if browser_version is None:
                browser_version = result["browserVersion"]
            if not browser_version or result["browserVersion"] != browser_version:
                raise RuntimeError(f"Browser identity changed in {label}")
            current = semantic_signature(validation)
            if canonical is None:
                canonical = current
                write_json(evidence / "expected-lookup-signature.json", canonical)
            if current != canonical:
                write_json(evidence / f"{label}-mismatched-lookup-signature.json", current)
                raise RuntimeError(f"Sampled production lookup results differ in {label}")
            media = validation["media"]
            if media_mode in media_signatures and media != media_signatures[media_mode]:
                raise RuntimeError(f"Persisted media differs in {label}")
            media_signatures[media_mode] = media
            observation = {
                "arm": arm, "label": label, "block": block, "mediaMode": media_mode,
                "timed": block is not None,
                "totalImportMs": result["totalImportMs"],
                "workerImportMs": result["workerImportMs"],
                "browserVersion": result["browserVersion"],
                "storageBytes": validation["storage"]["bytes"],
                "outputDigestSha256": validation["outputDigestSha256"],
                "before": before, "after": host_snapshot(),
            }
            state["observations"].append(observation)
            write_json(evidence / "progress.json", state)
            return observation

        for arm in "ABC":
            observe(arm, f"warmup-{arm}", "sample")
        blocks = []
        for number, order in enumerate(ORDERS, 1):
            values = {}
            for arm in order:
                values[arm] = observe(arm, f"block-{number}-{arm}", "sample", number)
            blocks.append(values)
        # Run costly full media reads after timing, once for each product version.
        observe("A", "diagnostic-A", "all")
        observe("B", "diagnostic-B", "all")
        comparisons = {}
        for numerator, denominator in (("B", "A"), ("B", "C"), ("C", "A")):
            ratios = [100 * (block[numerator]["totalImportMs"] / block[denominator]["totalImportMs"] - 1) for block in blocks]
            comparisons[f"{numerator}/{denominator}"] = {
                "pairedPercentChanges": ratios,
                "medianPairedPercentChange": statistics.median(ratios),
                "equalWorkPercentChange": 100 * (sum(block[numerator]["totalImportMs"] for block in blocks) / sum(block[denominator]["totalImportMs"] for block in blocks) - 1),
                "fasterPairs": sum(value < 0 for value in ratios),
                "worstPercentChange": max(ratios),
            }
        state["comparisons"] = comparisons
        state["status"] = "complete"
        state["media"] = media_signatures
        state["outputDigestVariants"] = sorted({row["outputDigestSha256"] for row in state["observations"]})
        state["storageByteVariants"] = sorted({row["storageBytes"] for row in state["observations"]})
        write_json(evidence / "summary.json", state)
        print(json.dumps({"status": "complete", "comparisons": comparisons}), flush=True)
    except BaseException as error:
        state["status"] = "failed"
        state["failure"] = repr(error)
        write_json(evidence / "summary.json", state)
        raise


if __name__ == "__main__":
    main()
