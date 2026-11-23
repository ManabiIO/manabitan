#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Run frozen import sources through their unchanged native browser harnesses."""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import random
import re
import shutil
import statistics
import subprocess
import tempfile
import time
import zipfile


ORDERS = (
    "ABC", "CBA", "BAC", "CAB", "BCA", "ACB",
    "ACB", "BCA", "CAB", "BAC", "CBA", "ABC",
)
HARNESS_PATHS = (
    "dev/perf", "test/chromium", "test/e2e", "test/perf", "test/firefox/data",
    "package.json", "package-lock.json", ".github/actions/setup/action.yml",
    "ext/js/core/json.js", "ext/js/core/safe-performance.js",
    "ext/js/dictionary/term-bank-experiments.js", "ext/js/data/anki-util.js",
    "ext/js/media/media-util.js", "ext/js/pages/settings/dictionary-import-controller.js",
)
RUNNER_PATH = "dev/perf/import-runtime-20261123-3aac.py"


def sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def command(args, cwd, log=None):
    print(f"[{cwd}] {' '.join(map(str, args))}", flush=True)
    if log is None:
        return subprocess.run(args, cwd=cwd, check=True, text=True, capture_output=True).stdout.strip()
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("w") as output:
        result = subprocess.run(args, cwd=cwd, stdout=output, stderr=subprocess.STDOUT)
    if result.returncode != 0:
        print(log.read_text()[-20000:], flush=True)
        raise RuntimeError(f"Command failed ({result.returncode}); full log: {log}")
    return ""


def source_identity(root, revision):
    if re.fullmatch("[a-f0-9]{40}", revision) is None:
        raise RuntimeError("Source revisions must be full lowercase commit SHAs")
    actual = command(["git", "rev-parse", f"{revision}^{{commit}}"], root)
    if actual != revision:
        raise RuntimeError("Source revision did not resolve exactly")
    return {"commit": actual, "tree": command(["git", "rev-parse", f"{actual}^{{tree}}"], root)}


def harness_hashes(root):
    files = command(["git", "ls-files", "--", *HARNESS_PATHS], root).splitlines()
    return {name: sha256(root / name) for name in files if name != RUNNER_PATH}


def package_entries(path):
    with zipfile.ZipFile(path) as archive:
        return {item.filename: hashlib.sha256(archive.read(item)).hexdigest()
                for item in archive.infolist() if not item.is_dir()}


def link_or_copy(source, destination):
    try:
        os.link(source, destination)
    except OSError:
        shutil.copy2(source, destination)
    return destination


def compare(base, candidate):
    if len(base) != len(candidate) or not base:
        raise RuntimeError("Paired comparison requires matching nonempty observations")
    changes = [(b / a - 1) * 100 for a, b in zip(base, candidate, strict=True)]
    rng = random.Random(20261123)
    bootstraps = sorted(statistics.median(rng.choices(changes, k=len(changes))) for _ in range(10000))
    return {
        "pairs": len(changes),
        "fasterPairs": sum(value < 0 for value in changes),
        "pairedChangesPercent": changes,
        "pairedMedianPercent": statistics.median(changes),
        "pairedMedianBootstrap95Percent": [bootstraps[249], bootstraps[9749]],
        "intervalMethod": "Descriptive percentile bootstrap; 10000 block-paired resamples, seed 20261123; no multiple-comparison correction",
        "equalWorkPercent": (sum(candidate) / sum(base) - 1) * 100,
        "baselineMedianMs": statistics.median(base),
        "candidateMedianMs": statistics.median(candidate),
    }


def read_summary(output, dictionary, fixture, source, package_hash, hashes, media_check):
    summary = json.loads((output / "summary.json").read_text())
    if (summary.get("schemaVersion") != 3 or summary.get("dictionary") != dictionary or
            summary.get("fixture") != fixture or summary.get("buildTarget") != "chrome" or
            summary.get("mediaCheck") != media_check or summary.get("authoritativeTiming") is not True or
            summary.get("traceEnabled") is not False or summary.get("importFlags") is not None or
            not isinstance(summary.get("runs"), list) or len(summary["runs"]) != 1):
        raise RuntimeError("Benchmark summary differs from the frozen protocol")
    run = summary["runs"][0]
    provenance = summary.get("source", {})
    if (summary.get("gitSha") != source["commit"] or provenance.get("gitSha") != source["commit"] or
            provenance.get("dirty") is not False or run.get("packageSha256") != package_hash or
            provenance.get("sha256", {}).get("builds/manabitan-chrome.zip") != package_hash):
        raise RuntimeError("Observation source/package differs from the clean frozen arm")
    for name, digest in provenance["sha256"].items():
        if name in hashes and digest != hashes[name]:
            raise RuntimeError(f"Observation harness differs from frozen input: {name}")
    browser = summary.get("browserVersion")
    if not isinstance(browser, str) or not browser or run.get("browserVersion") != browser:
        raise RuntimeError("Missing or inconsistent browser identity")
    if summary.get("hostEnvironment", {}).get("nodeVersion") != "v22.22.0":
        raise RuntimeError("Observation did not use the pinned Node version")
    duration = run.get("totalImportMs")
    if type(duration) not in (int, float) or not math.isfinite(duration) or duration <= 0:
        raise RuntimeError("Invalid complete-import timing")
    # The unchanged schema-v3 harness validates full inventory, restart, strict
    # OPFS, 72 production lookup receipts and source-equal media before this file.
    return summary, run


def receipt_identity(run):
    validation = run["validation"]
    lookup = [[row["pass"], row["term"], row["results"], row["sha256"]]
              for row in validation["lookup"]["observations"]]
    media = validation["media"]
    return {
        "lookup": sorted(lookup),
        "media": {name: media[name] for name in ("mode", "totalFiles", "totalBytes", "files", "bytes", "sha256")},
        "storageBytes": validation["storage"]["bytes"],
    }


def phase_observations(run):
    # Preserve phase scopes instead of adding overlapping worker/wall counters.
    return [{"phase": phase["phase"], "elapsedMs": phase.get("elapsedMs"),
             "details": phase.get("details")}
            for phase in run["importDebug"].get("importerPhaseTimings", [])
            if phase.get("phase") in ("import-data-banks", "bulk-finalization") or
            str(phase.get("phase", "")).startswith("term-file-fast-path:")]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--dictionary", choices=("jmdict", "jitendex", "vndb"), required=True)
    parser.add_argument("--stage", choices=("screen", "qualification", "baseline", "diagnostic"), required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--reverse", action="store_true")
    parser.add_argument("--expected-differences", required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    evidence = args.output.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    if (evidence / "state.json").exists() or (evidence / "observations.json").exists():
        raise RuntimeError("Use a fresh evidence directory; existing cohorts must not be overwritten")
    state = {"status": "preparing", "stage": args.stage, "dictionary": args.dictionary}
    write_json(evidence / "state.json", state)
    try:
        run_study(args, root, evidence, state)
    except Exception as error:
        state.update(status="failed", error=str(error))
        write_json(evidence / "state.json", state)
        raise


def run_study(args, root, evidence, state):
    node = command(["node", "--version"], root)
    if node != "v22.22.0":
        raise RuntimeError("The study requires Node v22.22.0")
    baseline_only = args.stage == "baseline"
    identities = {"A": source_identity(root, args.baseline)}
    if not baseline_only:
        identities["B"] = source_identity(root, args.candidate)
        if args.candidate == args.baseline:
            raise RuntimeError("Candidate and baseline must differ; use baseline stage for a snapshot")
        command(["git", "merge-base", "--is-ancestor", args.baseline, args.candidate], root)
    identities["C"] = identities["A"]
    orders = list(ORDERS[:6] if args.stage == "screen" else ORDERS) if args.stage in ("screen", "qualification") else []
    if args.reverse:
        orders = [order[::-1] for order in reversed(orders)]
    expected_differences = json.loads(args.expected_differences)
    if not isinstance(expected_differences, list) or not expected_differences or expected_differences != sorted(set(expected_differences)):
        raise ValueError("Freeze a sorted unique packaged difference list")
    tooling_hashes = harness_hashes(root)
    fixtures = json.loads((root / "test/perf/dictionaries.lock.json").read_text())["dictionaries"]
    fixture = fixtures[args.dictionary]
    # The unchanged E2E setup verifies these three caches and reads their probe
    # terms even when it imports only one selected dictionary. Preload that
    # exact setup set, plus VNDB when selected, before any observations.
    cache_ids = ["jmdict", "jmnedict", "jitendex"] + (["vndb"] if args.dictionary == "vndb" else [])
    protocol = {
        "schemaVersion": 1, "stage": args.stage, "dictionary": args.dictionary,
        "sourceIdentities": identities, "toolingCommit": command(["git", "rev-parse", "HEAD"], root),
        "runnerSha256": sha256(Path(__file__)), "nodeVersion": node, "fixture": fixture,
        "setupCacheDictionaryIds": cache_ids,
        "dependencyPreparation": "Real node_modules directory per arm; hardlinked files with copy fallback and preserved internal symlinks",
        "unchangedHarnessSha256": tooling_hashes, "harnessOverlay": None,
        "orders": orders, "plannedBlocks": len(orders), "warmupsExcluded": 3 if orders else 0,
        "reversedSchedule": args.reverse, "expectedPackageDifferences": expected_differences,
        "baselineSnapshotRuns": 3 if baseline_only else 0,
        "diagnosticArms": ["A"] if baseline_only else ["A", "B"],
        "timingMediaCheck": "sample", "diagnosticMediaCheck": "all",
        "timingBoundary": "Native harness: file-input change to post-UI import completion; browser monotonic clock",
        "identicalProductControl": "C uses the exact A worktree, release archive and package-entry bytes",
        "comparisonPairs": {"candidate": "B/A", "candidateVsSecondBaseline": "B/C", "control": "C/A"},
        "codeValidation": "Separate frozen source PR CI; this study does not replace unit, native rebuild, type or all-target build checks",
        "notes": "Fresh browser profiles. Production defaults. No tracing, screenshots, phase profiling or process sampling. One excluded warmup per arm. No retries, tail exclusions or optional stopping. All attempted observations retained. Separate diagnostics are excluded from cohort comparisons. Phase and worker counters overlap and are never added as a wall-time budget.",
        "inferenceLimits": "A screen is exploratory and requires a later independent qualification; never pool stages. Baseline and diagnostic stages make no performance claims. Qualification reports descriptive intervals and identical-product drift; passing correctness does not establish a speedup.",
        "github": {name: os.environ.get(name) for name in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SHA", "GITHUB_REF", "GITHUB_WORKFLOW")},
    }
    write_json(evidence / "protocol.json", protocol)
    work_root = Path(tempfile.mkdtemp(prefix="import-runtime-3aac-", dir=os.environ.get("RUNNER_TEMP")))
    (root / "builds/e2e-dictionary-cache").mkdir(parents=True, exist_ok=True)
    arm_roots = {}
    packages = {}
    for arm in (["A"] if baseline_only else ["A", "B"]):
        target = work_root / arm
        command(["git", "worktree", "add", "--detach", str(target), identities[arm]["commit"]], root)
        arm_roots[arm] = target
        hashes = harness_hashes(target)
        if hashes != tooling_hashes:
            changed = sorted(name for name in set(hashes) | set(tooling_hashes) if hashes.get(name) != tooling_hashes.get(name))
            raise RuntimeError(f"Native harness/lock differs in {arm}; no overlay allowed: {changed}")
        # The repository ignores node_modules/ directories, not a symlink at
        # that path. Keep the complete clean-source gate without exceptions.
        shutil.copytree(root / "node_modules", target / "node_modules",
                        symlinks=True, copy_function=link_or_copy)
        (target / "builds").mkdir(exist_ok=True)
        (target / "builds/e2e-dictionary-cache").symlink_to(root / "builds/e2e-dictionary-cache", target_is_directory=True)
        command(["npm", "run", "build:libs"], target, evidence / f"libraries-{arm}.log")
        command(["npm", "run", "build", "--", "--target", "chrome"], target, evidence / f"build-{arm}.log")
        status = command(["git", "status", "--porcelain"], target)
        (evidence / f"source-status-{arm}.txt").write_text(status + "\n")
        if status or harness_hashes(target) != hashes:
            raise RuntimeError(f"Build modified tracked source/harness in {arm}")
        package = target / "builds/manabitan-chrome.zip"
        packages[arm] = {"source": identities[arm], "archiveSha256": sha256(package), "entries": package_entries(package)}
        write_json(evidence / f"package-{arm}.json", packages[arm])
    arm_roots["C"] = arm_roots["A"]
    packages["C"] = packages["A"]
    write_json(evidence / "package-C.json", {**packages["A"], "identicalArchiveFromArm": "A"})
    if not baseline_only:
        command(["git", "diff", "--stat", args.baseline, args.candidate], root, evidence / "source-differences.txt")
        a, b = packages["A"]["entries"], packages["B"]["entries"]
        differences = [name for name in sorted(set(a) | set(b)) if a.get(name) != b.get(name)]
        write_json(evidence / "package-differences.json", differences)
        if differences != expected_differences:
            raise RuntimeError(f"Packaged differences do not match the frozen plan: {differences}")
    command(["node", "dev/perf/prepare-dictionaries.js", *cache_ids], arm_roots["A"], evidence / "prepare-dictionaries.log")
    checked_fixtures = {}
    for dictionary_id in cache_ids:
        spec = fixtures[dictionary_id]
        fixture_path = root / "builds/e2e-dictionary-cache" / spec["cacheFile"]
        size, digest = fixture_path.stat().st_size, sha256(fixture_path)
        if size != spec["sizeBytes"] or digest != spec["sha256"]:
            raise RuntimeError(f"Prepared fixture differs from the exact lock: {dictionary_id}")
        checked_fixtures[dictionary_id] = {"sizeBytes": size, "sha256": digest, "fixture": spec}
    write_json(evidence / "fixture.json", checked_fixtures[args.dictionary])
    write_json(evidence / "setup-fixtures.json", checked_fixtures)
    state.update(status="running", buildComplete=True)
    write_json(evidence / "state.json", state)
    observations = []
    expected = {}
    browser_version = None

    def observe(name, arm, media_check, cohort, block=None, position=None):
        nonlocal browser_version
        target, package = arm_roots[arm], packages[arm]
        output = evidence / name
        output.mkdir()
        entry = {"name": name, "arm": arm, "cohort": cohort, "block": block, "position": position,
                 "source": identities[arm], "status": "running", "mediaCheck": media_check}
        observations.append(entry)
        write_json(evidence / "observations.json", observations)
        started = time.monotonic()
        try:
            command(["node", "dev/perf/host-environment.js"], target, output / "host-before.json")
            command(["node", "dev/perf/import-benchmark.js", args.dictionary, "--runs", "1", "--no-build",
                     "--build-target", "chrome", "--media-check", media_check, "--output", str(output)], target, output / "command.log")
            summary, run = read_summary(output, args.dictionary, fixture, identities[arm], package["archiveSha256"], tooling_hashes, media_check)
            if browser_version is not None and summary["browserVersion"] != browser_version:
                raise RuntimeError("Browser version changed during the study")
            browser_version = summary["browserVersion"]
            receipt = receipt_identity(run)
            for key in ("lookup", "storageBytes"):
                if key in expected and receipt[key] != expected[key]:
                    raise RuntimeError(f"Correctness receipt differs across arms/observations: {key}")
                expected[key] = receipt[key]
            media_key = f"media-{media_check}"
            if media_key in expected and receipt["media"] != expected[media_key]:
                raise RuntimeError("Persisted source media receipt differs across arms/observations")
            expected[media_key] = receipt["media"]
            write_json(output / "phase-counters.json", phase_observations(run))
            entry.update(status="success", totalImportMs=run["totalImportMs"], storageBytes=receipt["storageBytes"],
                         summary=f"{name}/summary.json", phaseCounters=f"{name}/phase-counters.json")
        except Exception as error:
            entry.update(status="failed", error=str(error))
            raise
        finally:
            entry["commandElapsedSeconds"] = time.monotonic() - started
            write_json(evidence / "observations.json", observations)
            command(["node", "dev/perf/host-environment.js"], target, output / "host-after.json")
        print(json.dumps(entry), flush=True)

    if baseline_only:
        for index in range(1, 4):
            observe(f"baseline-{index:02d}-A", "A", "sample", "baseline-diagnostic")
    if orders:
        for arm in ("CBA" if args.reverse else "ABC"):
            observe(f"warmup-{arm}", arm, "sample", "excluded-warmup")
    for block, order in enumerate(orders, start=1):
        for position, arm in enumerate(order, start=1):
            observe(f"block-{block:02d}-{position}-{arm}", arm, "sample", "timed", block, position)
    # Verification remains outside the timed cohort, even when every run already
    # validates inventory, restart, lookup results and a deterministic media sample.
    for arm in protocol["diagnosticArms"]:
        observe(f"diagnostic-{arm}", arm, "all", "exhaustive-diagnostic")
    write_json(evidence / "correctness.json", {"status": "passed", "identicalReceipts": expected})
    for arm in protocol["diagnosticArms"]:
        target = arm_roots[arm]
        if harness_hashes(target) != tooling_hashes or sha256(target / "builds/manabitan-chrome.zip") != packages[arm]["archiveSha256"]:
            raise RuntimeError(f"Frozen source/package changed during observations: {arm}")
        if command(["git", "status", "--porcelain"], target):
            raise RuntimeError(f"Source checkout changed during observations: {arm}")
    if orders:
        values = {arm: [item["totalImportMs"] for item in observations if item["cohort"] == "timed" and item["arm"] == arm] for arm in "ABC"}
        if any(len(values[arm]) != len(orders) for arm in "ABC"):
            raise RuntimeError("The prespecified paired cohort is incomplete")
        write_json(evidence / "analysis.json", {
            "status": "complete", "stage": args.stage, "dictionary": args.dictionary, "browserVersion": browser_version,
            "screeningOnly": args.stage == "screen", "independentQualificationRequired": args.stage == "screen",
            "intervalCaveat": "Intervals are descriptive; six-pair screens are exploratory. Assess candidate comparisons together with identical-product drift. Do not pool independent stages.",
            "candidate": compare(values["A"], values["B"]),
            "candidateVsSecondBaseline": compare(values["C"], values["B"]),
            "identicalProductControl": compare(values["A"], values["C"]), "allTimingsMs": values,
        })
    state.update(status="success", browserVersion=browser_version, timedObservations=3 * len(orders),
                 attemptedObservations=len(observations), exhaustiveDiagnostics=len(protocol["diagnosticArms"]),
                 performanceClaim="none; inspect paired evidence and control drift" if orders else "none; diagnostic snapshot only")
    write_json(evidence / "state.json", state)
    for arm in protocol["diagnosticArms"]:
        command(["git", "worktree", "remove", "--force", str(arm_roots[arm])], root)
    work_root.rmdir()


if __name__ == "__main__":
    main()
