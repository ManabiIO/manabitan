#!/usr/bin/env python3
"""Prospective, package-bound complete-import comparison for study 81585d.

Adapted from qualify-import-ca365.py. Existing strict receipt and process-memory
helpers remain unchanged. Raw observations are retained; invalid or incomplete
cohorts never produce comparative timing statistics.

Copyright (C) 2026 Manabitan authors
SPDX-License-Identifier: GPL-3.0-or-later
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import random
import re
import shutil
import statistics
import subprocess
import sys
import time
import zipfile


ROOT = Path(__file__).resolve().parents[2]
PROTOCOL_PATH = ROOT / "dev/perf/import-qualification-81585d.json"
WORKFLOW_PATH = ROOT / ".github/workflows/import-qualification-81585d.yml"
MEMORY_HELPERS = "dev/perf/import-memory-20261125-a7f7"
PROVENANCE_PATHS = (
    "package-lock.json", "test/perf/dictionaries.lock.json",
    "dev/perf/benchmark-support.js", "dev/perf/dictionary-fixtures.js",
    "dev/perf/import-benchmark.js", "test/chromium/import-flags-ab-benchmark.js",
    "test/chromium/extension-two-dictionary-import.e2e.js", "test/e2e/import-timing.js",
    "ext/js/pages/settings/dictionary-import-controller.js",
    "builds/manabitan-chrome-dev.zip", "builds/manabitan-chrome.zip",
)
PACKAGER = r"""
import fs from 'node:fs'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
const root = process.argv[1]
const {build, getBuildPlan} = await import(pathToFileURL(path.join(root, 'dev/bin/build.js')))
const {ManifestUtil} = await import(pathToFileURL(path.join(root, 'dev/manifest-util.js')))
const {copyDictionaryWasm} = await import(pathToFileURL(path.join(root, 'dev/dictionary-wasm.js')))
copyDictionaryWasm(path.join(root, 'ext/lib'), root)
const manifest = path.join(root, 'ext/manifest.json')
const original = fs.existsSync(manifest) ? fs.readFileSync(manifest) : null
const util = new ManifestUtil()
const plan = getBuildPlan(['--target', 'chrome'], util)
try {
    await build(path.join(root, 'builds'), path.join(root, 'ext'), util,
        plan.variantNames, manifest, false, false, plan.yomitanVersion)
} finally {
    if (original === null) { fs.rmSync(manifest, {force: true}) } else { fs.writeFileSync(manifest, original) }
}
"""


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n")


def command(args, cwd=None, log=None, check=True, timeout=1800):
    if cwd is None:
        cwd = ROOT
    if log is None:
        result = subprocess.run(args, cwd=cwd, check=False, capture_output=True,
                                text=True, timeout=timeout)
        if check and result.returncode:
            raise RuntimeError(f"Command failed: {args}\n{result.stdout}\n{result.stderr}")
        return result
    with log.open("w") as output:
        result = subprocess.run(args, cwd=cwd, check=False, stdout=output,
                                stderr=subprocess.STDOUT, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f"Command failed: {args}; see {log}")
    return result


def package_members(path):
    with zipfile.ZipFile(path) as archive:
        names = [entry.filename for entry in archive.infolist() if not entry.is_dir()]
        if len(names) != len(set(names)):
            raise RuntimeError("Duplicate package members")
        return {name: hashlib.sha256(archive.read(name)).hexdigest() for name in sorted(names)}


def require_package_delta(base, treatment, expected):
    if base.keys() != treatment.keys():
        raise RuntimeError("Package member inventory differs between arms")
    changed = sorted(name for name in base if base[name] != treatment[name])
    if not changed or changed != sorted(expected):
        raise RuntimeError(f"Unexpected packaged delta: {changed}")
    return changed


def make_schedule(protocol, replica):
    order = protocol["orders"][replica]
    if sorted(order) != sorted(["ABC", "ACB", "BAC", "BCA", "CAB", "CBA"]):
        raise RuntimeError("Expected each of the six balanced ABC permutations exactly once")
    warmup = protocol["warmups"][replica]
    if sorted(warmup) != list("ABC"):
        raise RuntimeError("Expected one warmup per arm")
    schedule = [{"name": f"warmup-{arm}", "arm": arm, "phase": "warmup", "media": "sample"}
                for arm in warmup]
    for index, cohort in enumerate(order):
        schedule.extend({"name": f"cohort-{index}-{arm}", "arm": arm, "phase": "timed",
                         "cohort": index, "media": "sample"} for arm in cohort)
    schedule.extend({"name": f"all-media-{arm}", "arm": arm, "phase": "validation", "media": "all"}
                    for arm in ("AB" if replica == 0 else "BA"))
    return schedule


def paired_analysis(observations, schedule, criterion):
    complete = len(observations) == len(schedule) and all(
        row.get("status") == "success" and row["name"] == item["name"]
        for row, item in zip(observations, schedule)
    )
    result = {"complete": complete, "criterion": criterion,
              "failures": [row["name"] for row in observations if row.get("status") != "success"],
              "scheduledObservations": len(schedule), "completedObservations": len(observations)}
    if not complete:
        result["reason"] = "Incomplete or invalid cohort: comparative timing statistics withheld"
        return result
    blocks = []
    for index in range(6):
        cohort = {row["arm"]: row["totalImportMs"] for row in observations if row.get("cohort") == index}
        if set(cohort) != set("ABC"):
            raise RuntimeError("Missing complete ABC block")
        blocks.append(cohort)
    result["blocks"] = blocks
    result["comparisons"] = {}
    for key, numerator, denominator in (("BvsA", "B", "A"), ("BvsC", "B", "C"), ("CvsA", "C", "A")):
        ratios = [block[numerator] / block[denominator] for block in blocks]
        rng = random.Random(897)
        samples = sorted(statistics.median(rng.choices(ratios, k=len(ratios))) for _ in range(10000))
        result["comparisons"][key] = {
            "pairedChangePercent": [100 * (ratio - 1) for ratio in ratios],
            "medianPairedChangePercent": 100 * (statistics.median(ratios) - 1),
            "equalWorkChangePercent": 100 * (sum(block[numerator] for block in blocks) /
                                             sum(block[denominator] for block in blocks) - 1),
            "worstPairChangePercent": 100 * (max(ratios) - 1),
            "descriptiveBootstrap95Percent": [100 * (samples[index] - 1) for index in (249, 9749)],
            "fasterPairs": sum(ratio < 1 for ratio in ratios),
        }
    return result


def required_same_paths(base):
    paths = {
        "package.json", "package-lock.json", ".github/actions/setup/action.yml",
        "dev/build-libs.js", "dev/bin/build.js", "dev/manifest-util.js", "dev/dictionary-wasm.js",
        "dev/data/manifest-variants.json", "test/perf/dictionaries.lock.json",
        "ext/js/pages/settings/dictionary-import-controller.js",
    }
    listed = command(["git", "ls-tree", "-r", "--name-only", base,
                      "dev/lib", "dev/perf", "test/chromium", "test/e2e"]).stdout.splitlines()
    paths.update(path for path in listed if path.endswith((".js", ".mjs", ".html")))
    paths.update(f"{MEMORY_HELPERS}/{name}" for name in
                 ("qualification_receipts.py", "protocol.py", "chromium_memory.py", "audit_memory.py"))
    return sorted(paths)


def prepare_arm(name, commit, output, fixture_cache, frozen_hashes):
    arm = ROOT.parent / f"qualification-{os.environ.get('GITHUB_RUN_ID', 'local')}-{name}"
    if arm.exists():
        raise RuntimeError(f"Refusing to reuse existing source checkout: {arm}")
    command(["git", "worktree", "add", "--detach", str(arm), commit],
            log=output / f"worktree-{name}.log")
    for path, digest in frozen_hashes.items():
        if not (arm / path).is_file() or sha256(arm / path) != digest:
            raise RuntimeError(f"Frozen harness/dependency differs or is missing: {name} {path}")
    # Generate common third-party bundles once, at the workflow checkout.
    # Copy the complete library tree, then restore this arm's own native modules
    # using the unchanged manifest validator before packaging the release.
    shutil.copytree(ROOT / "ext/lib", arm / "ext/lib", dirs_exist_ok=True)
    shutil.copyfile(ROOT / "ext/legal-npm.html", arm / "ext/legal-npm.html")
    # A real directory follows the repository's node_modules/ ignore rule;
    # a directory symlink would otherwise appear as an untracked source change.
    shutil.copytree(ROOT / "node_modules", arm / "node_modules", copy_function=os.link, symlinks=True)
    (arm / "builds").mkdir(exist_ok=True)
    (arm / "builds/e2e-dictionary-cache").symlink_to(fixture_cache, target_is_directory=True)
    command(["node", "--input-type=module", "-e", PACKAGER, str(arm)], cwd=arm,
            log=output / f"package-{name}.log")
    if command(["git", "status", "--porcelain"], cwd=arm).stdout:
        raise RuntimeError(f"Unexpected tracked or untracked source changes after packaging: {name}")
    package = arm / "builds/manabitan-chrome.zip"
    shutil.copyfile(package, output / f"package-{name}.zip")
    members = package_members(package)
    write_json(output / f"package-{name}-members.json", members)
    receipt = {
        "sourceCommit": command(["git", "rev-parse", "HEAD"], cwd=arm).stdout.strip(),
        "sourceTree": command(["git", "rev-parse", "HEAD^{tree}"], cwd=arm).stdout.strip(),
        "packageSha256": sha256(package), "memberCount": len(members),
        "harnessSha256": {path: sha256(arm / path) for path in frozen_hashes},
        "sourceHashes": {path: sha256(arm / path) if (arm / path).is_file() else None for path in PROVENANCE_PATHS},
        "generatedLibrariesShared": True, "nativeModulesRestoredFromOwnManifest": True,
        "dependencyDirectory": "Hardlinks to the single locked dependency installation; no directory symlink",
    }
    write_json(output / f"package-{name}-receipt.json", receipt)
    return arm, receipt, members


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("candidate")
    parser.add_argument("dictionary", choices=["jmdict", "jitendex", "vndb"])
    parser.add_argument("replica", type=int, choices=[0, 1])
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    protocol = json.loads(PROTOCOL_PATH.read_text())
    candidate = protocol["candidates"][args.candidate]
    for value in (protocol["base"], candidate["commit"]):
        if not isinstance(value, str) or re.fullmatch(r"[a-f0-9]{40}", value) is None:
            raise RuntimeError("Source identities must be frozen full lowercase commit hashes")
    if command(["node", "--version"]).stdout.strip() != protocol["nodeVersion"]:
        raise RuntimeError("Qualification requires the frozen Node runtime")
    os.environ["MANABITAN_E2E_STRICT_RUNTIME"] = "1"
    os.environ["MANABITAN_CHROMIUM_ALLOW_HEADED_FALLBACK"] = "0"
    output = ROOT / "builds/qualification"
    output.mkdir(parents=True, exist_ok=False)
    shutil.copyfile(PROTOCOL_PATH, output / "protocol.json")
    shutil.copyfile(Path(__file__), output / "executed-runner.py")
    shutil.copyfile(WORKFLOW_PATH, output / "executed-workflow.yml")
    schedule = make_schedule(protocol, args.replica)
    write_json(output / "schedule.json", schedule)
    write_json(output / "execution.json", {
        "candidate": args.candidate, "dictionary": args.dictionary, "replica": args.replica,
        "workflowCommit": command(["git", "rev-parse", "HEAD"]).stdout.strip(),
        "workflowTree": command(["git", "rev-parse", "HEAD^{tree}"]).stdout.strip(),
        "protocolSha256": sha256(PROTOCOL_PATH), "runnerSha256": sha256(Path(__file__)),
        "workflowSha256": sha256(WORKFLOW_PATH), "runId": os.environ.get("GITHUB_RUN_ID"),
        "runAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
    })
    # Workflow source must be baseline product plus isolated qualification files.
    command(["git", "diff", "--exit-code", protocol["base"], "HEAD", "--",
             "ext", "dev/lib", "dev/data", "dev/build-libs.js", "package.json", "package-lock.json",
             ".github/actions/setup/action.yml", "test/perf/dictionaries.lock.json"])
    changed_source = command(["git", "diff", "--name-only", protocol["base"], candidate["commit"]]).stdout.splitlines()
    if sorted(changed_source) != sorted(candidate["sourceDelta"]):
        raise RuntimeError(f"Unreviewed source delta: {changed_source}")
    patch = subprocess.check_output(["git", "diff", "--binary", protocol["base"], candidate["commit"]], cwd=ROOT)
    (output / "candidate.patch").write_bytes(patch)
    frozen_hashes = {path: sha256(ROOT / path) for path in required_same_paths(protocol["base"])}
    write_json(output / "frozen-harness.json", frozen_hashes)
    browser_binary = Path(command([
        "node", "--input-type=module", "-e",
        "import {chromium} from 'playwright'; process.stdout.write(chromium.executablePath())",
    ]).stdout)
    browser_text = command([str(browser_binary), "--version"]).stdout.strip()
    if re.search(r"\d+(?:\.\d+){3}", browser_text).group() != protocol["browserVersion"]:
        raise RuntimeError("Browser does not match the frozen lockfile runtime")
    write_json(output / "browser-identity.json", {
        "executable": str(browser_binary), "sha256": sha256(browser_binary), "versionOutput": browser_text,
    })
    command(["node", "dev/perf/prepare-dictionaries.js", args.dictionary], log=output / "fixture-prepare.log")
    cache = (ROOT / "builds/e2e-dictionary-cache").resolve()
    fixture = json.loads((ROOT / "test/perf/dictionaries.lock.json").read_text())["dictionaries"][args.dictionary]
    fixture_path = cache / fixture["cacheFile"]
    if sha256(fixture_path) != fixture["sha256"] or fixture_path.stat().st_size != fixture["sizeBytes"]:
        raise RuntimeError("Pinned source archive mismatch")
    write_json(output / "fixture.json", fixture)
    base, base_receipt, base_members = prepare_arm("A", protocol["base"], output, cache, frozen_hashes)
    treatment, treatment_receipt, treatment_members = prepare_arm("B", candidate["commit"], output, cache, frozen_hashes)
    changed = require_package_delta(base_members, treatment_members, candidate["packagedDelta"])
    write_json(output / "package-delta.json", changed)
    for path, expected in candidate.get("packagedSha256", {}).items():
        if path not in changed or treatment_members.get(path) != expected:
            raise RuntimeError(f"Reviewed candidate package hash differs: {path}")
    write_json(output / "package-C-receipt.json", {**base_receipt, "identicalTo": "A"})
    if args.prepare_only:
        return
    sys.path.insert(0, str(ROOT / MEMORY_HELPERS))
    from qualification_receipts import validate_import_summary, require_matching_receipts
    arms = {"A": (base, base_receipt), "B": (treatment, treatment_receipt), "C": (base, base_receipt)}
    reference = None
    full_reference = None
    observations = []

    def validate(destination, label, media="sample", overlay=None):
        arm_root, identity = arms[label]
        if sha256(arm_root / "builds/manabitan-chrome.zip") != identity["packageSha256"]:
            raise RuntimeError("Product package changed during the frozen cohort")
        summary = json.loads((destination / "summary.json").read_text())
        report = json.loads((destination / "run-1.json").read_text())
        hashes = identity["sourceHashes"].copy()
        if overlay is not None:
            hashes["test/chromium/extension-two-dictionary-import.e2e.js"] = hashlib.sha256(overlay.encode()).hexdigest()
        receipt = validate_import_summary(
            summary, report, dictionary=args.dictionary, fixture=fixture,
            source_sha=identity["sourceCommit"], package_sha256=identity["packageSha256"],
            browser_version=protocol["browserVersion"], import_flags=None, source_hashes=hashes,
            source_dirty=overlay is not None, media_check=media,
            vndb_sah_allocation_units=protocol["vndbSahAllocationUnits"],
        )
        dictionaries = summary["runs"][0]["step4Breakdown"]["dictionaries"]
        if len(dictionaries) != 1:
            raise RuntimeError("Expected exactly one dictionary import")
        for key, expected in protocol["parserPolicy"][args.dictionary].items():
            if dictionaries[0].get(key) != expected:
                raise RuntimeError(f"Production parser policy changed: {key}")
        write_json(destination / "canonical-receipt.json", receipt)
        return summary, receipt

    for item in schedule:
        destination = output / item["name"]
        destination.mkdir()
        arm_root, identity = arms[item["arm"]]
        record = {**item, "sourceCommit": identity["sourceCommit"], "packageSha256": identity["packageSha256"],
                  "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        write_json(destination / "receipt.json", record)
        try:
            command(["node", "dev/perf/host-environment.js"], cwd=arm_root, log=destination / "host-before.json")
            if sha256(arm_root / "builds/manabitan-chrome.zip") != identity["packageSha256"]:
                raise RuntimeError("Package changed before observation")
            command(["node", "dev/perf/import-benchmark.js", args.dictionary, "--runs", "1", "--no-build",
                     "--build-target", "chrome", "--media-check", item["media"], "--output", str(destination)],
                    cwd=arm_root, log=destination / "run.log")
            summary, receipt = validate(destination, item["arm"], item["media"])
            if reference is None:
                reference = receipt
            else:
                require_matching_receipts(reference, receipt, compare_media=item["media"] == "sample")
            if item["media"] == "all":
                if full_reference is None:
                    full_reference = receipt
                else:
                    require_matching_receipts(full_reference, receipt)
            record.update({"status": "success", "totalImportMs": summary["runs"][0]["totalImportMs"],
                           "workerImportMs": summary["runs"][0]["workerImportMs"]})
        except Exception as error:
            record.update({"status": "failure", "error": str(error)})
        finally:
            command(["node", "dev/perf/host-environment.js"], cwd=arm_root, log=destination / "host-after.json", check=False)
            observations.append(record)
            write_json(destination / "receipt.json", record)
            write_json(output / "observations.json", observations)
            print(json.dumps(record, allow_nan=False), flush=True)
        if record["status"] != "success":
            break

    analysis = paired_analysis(observations, schedule, protocol["criterion"])
    analysis["memoryStatus"] = "not-acquired"
    write_json(output / "analysis.json", analysis)
    if not analysis["complete"]:
        raise RuntimeError("Incomplete/invalid cohort; observations retained and comparative timing withheld")
    thresholds = protocol["thresholds"]
    target = args.dictionary in candidate["targetDictionaries"]
    comparisons = [analysis["comparisons"][name] for name in ("BvsA", "BvsC")]
    passes = all(row["medianPairedChangePercent"] <= -thresholds["targetMinimumReductionPercent"] and
                 row["equalWorkChangePercent"] <= 0 and
                 row["fasterPairs"] >= thresholds["targetMinimumFasterPairs"] for row in comparisons) if target else all(
                     row["medianPairedChangePercent"] <= thresholds["nonTargetMaximumRegressionPercent"] for row in comparisons)
    analysis["performanceScreen"] = {"role": "target" if target else "non-target", "passes": passes}
    write_json(output / "analysis.json", analysis)

    # These four prospectively fixed observations instrument the process tree
    # only after every uninstrumented timing and full-media observation ended.
    from chromium_memory import run_with_sampling, summarize_import_window
    from protocol import memory_overlay, memory_comparison, schedule as memory_schedule
    from audit_memory import audit_cell
    memory_root = output / "memory"
    memory_root.mkdir()
    replication = args.replica + 1
    memory_plan = memory_schedule(replication)
    harness_path = "test/chromium/extension-two-dictionary-import.e2e.js"
    original_harness = (base / harness_path).read_text()
    overlay = memory_overlay(original_harness)
    (memory_root / "harness-original.js").write_text(original_harness)
    (memory_root / "harness-instrumented.js").write_text(overlay)
    write_json(memory_root / "plan.json", {
        "schedule": memory_plan, "replication": replication, "dictionary": args.dictionary,
        "authoritativeTiming": False, "overlaySha256": hashlib.sha256(overlay.encode()).hexdigest(),
        "packageReceipts": {"A": base_receipt, "B": treatment_receipt},
    })
    memory_observations = []
    semantic_failures = []
    try:
        for arm_root in (base, treatment):
            if (arm_root / harness_path).read_text() != original_harness:
                raise RuntimeError("Memory overlay input differs between arms")
            (arm_root / harness_path).write_text(overlay)
        for item in memory_plan:
            label = item["arm"]
            arm_root, identity = arms[label]
            destination = memory_root / item["name"]
            destination.mkdir()
            cmd = ["node", "dev/perf/import-benchmark.js", args.dictionary, "--runs", "1", "--no-build",
                   "--build-target", "chrome", "--media-check", "sample", "--output", str(destination)]
            if sha256(arm_root / "builds/manabitan-chrome.zip") != identity["packageSha256"]:
                raise RuntimeError("Product package changed before memory observation")
            try:
                sampled = run_with_sampling(cmd, arm_root, destination / "run.log",
                                            destination / "memory.json", destination / "markers.jsonl")
            except Exception as error:
                write_json(destination / "sampling-failure.json", {"type": type(error).__name__, "message": str(error), "retried": False})
                raw_path = destination / "memory.json"
                if raw_path.exists():
                    raw_path.rename(destination / "memory-incomplete.json")
                marker_path = destination / "markers.jsonl"
                if not marker_path.exists():
                    marker_path.write_text("")
                try:
                    markers = [json.loads(line) for line in marker_path.read_text().splitlines() if line]
                except json.JSONDecodeError:
                    markers = []
                raw = summarize_import_window([], markers, -1)
                write_json(raw_path, raw)
                sampled = {key: value for key, value in raw.items() if key != "samples"}
            memory_observations.append({**item, **sampled})
            write_json(memory_root / "observations.json", memory_observations)
            try:
                _, receipt = validate(destination, label, overlay=overlay)
                require_matching_receipts(reference, receipt)
            except Exception as error:
                semantic_failures.append({"name": item["name"], "error": str(error)})
            write_json(memory_root / "semantic-failures.json", semantic_failures)
    finally:
        for label in ("A", "B"):
            arm_root, identity = arms[label]
            (arm_root / harness_path).write_text(original_harness)
            if sha256(arm_root / "builds/manabitan-chrome.zip") != identity["packageSha256"]:
                raise RuntimeError("Product package changed during memory acquisition")
            if command(["git", "status", "--porcelain"], cwd=arm_root).stdout:
                raise RuntimeError("Unexpected source changes after memory harness restoration")
    memory_result = memory_comparison(memory_observations, args.dictionary, replication, memory_schedule)
    write_json(memory_root / "memory-comparison.json", memory_result)
    audit_error = None
    try:
        write_json(memory_root / "memory-audit.json", audit_cell(memory_root))
    except Exception as error:
        audit_error = {"type": type(error).__name__, "message": str(error)}
        write_json(memory_root / "memory-audit-failure.json", audit_error)
    memory_passed = memory_result["passesProspectiveMemoryScreen"] and not semantic_failures and audit_error is None
    analysis["memoryStatus"] = "passed" if memory_passed else "failed"
    analysis["memoryPassed"] = memory_passed
    analysis["interpretation"] = "Prospective descriptive comparison; both independent hosts and all dictionaries must be reviewed. Memory timing is never pooled with ordinary imports."
    write_json(output / "analysis.json", analysis)
    if not memory_passed:
        raise RuntimeError("Ordinary timing retained, but separate memory/semantic qualification failed")


if __name__ == "__main__":
    main()

