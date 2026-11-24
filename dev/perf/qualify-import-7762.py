#!/usr/bin/env python3
"""Temporary, fixed-protocol comparison of complete release imports.

Copyright (C) 2026 Manabitan authors
SPDX-License-Identifier: GPL-3.0-or-later
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import time
import zipfile


ROOT = Path(__file__).resolve().parents[2]
PROTOCOL_PATH = ROOT / "dev/perf/import-qualification-7762.json"
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
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def command(args, cwd=ROOT, log=None, check=True, timeout=1800):
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


def semantic_receipt(report):
    if report["status"] != "success" or report["skippedVerification"] is not False:
        raise RuntimeError("Import failed or skipped verification")
    validation = report["benchmark"]["validation"]
    if validation["contentReadable"] is not True or validation["restart"]["contentReadable"] is not True:
        raise RuntimeError("Content is not readable before and after restart")
    observations = validation["lookup"]["observations"]
    by_term = {}
    for row in observations:
        identity = {key: row[key] for key in ["term", "sha256", "results", "originalTextLength", "hasExactHeadwordMatch"]}
        if row["term"] in by_term and by_term[row["term"]] != identity:
            raise RuntimeError("Public lookup result changes across passes")
        by_term[row["term"]] = identity
    if len(by_term) != 12 or len(observations) != 72:
        raise RuntimeError("Missing complete lookup cohort")
    return {
        "title": validation["title"], "revision": validation["revision"],
        "termRows": validation["termRows"], "contentReadable": validation["contentReadable"],
        "probeTerms": sorted(validation["probeTerms"]),
        "publicResults": [by_term[key] for key in sorted(by_term)],
        "restart": validation["restart"], "media": validation["media"],
    }


def prepare_arm(name, commit, output, fixture_cache):
    arm = ROOT.parent / f"qualification-{os.environ.get('GITHUB_RUN_ID', 'local')}-{name}"
    if arm.exists():
        raise RuntimeError(f"Refusing to reuse an existing arm: {arm}")
    command(["git", "worktree", "add", "--detach", str(arm), commit])
    # Libraries are generated exactly once by the workflow setup. Never invoke
    # the build CLI here: it would regenerate esbuild output with other paths.
    shutil.copytree(ROOT / "ext/lib", arm / "ext/lib", dirs_exist_ok=True)
    shutil.copyfile(ROOT / "ext/legal-npm.html", arm / "ext/legal-npm.html")
    (arm / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
    (arm / "builds").mkdir(exist_ok=True)
    (arm / "builds/e2e-dictionary-cache").symlink_to(fixture_cache, target_is_directory=True)
    # Restore this arm's own validated native modules after sharing libraries.
    command(["node", "--input-type=module", "-e", PACKAGER, str(arm)], cwd=arm,
            log=output / f"package-{name}.log")
    package = arm / "builds/manabitan-chrome.zip"
    shutil.copyfile(package, output / f"package-{name}.zip")
    members = package_members(package)
    write_json(output / f"package-{name}-members.json", members)
    receipt = {
        "sourceCommit": command(["git", "rev-parse", "HEAD"], cwd=arm).stdout.strip(),
        "sourceTree": command(["git", "rev-parse", "HEAD^{tree}"], cwd=arm).stdout.strip(),
        "packageSha256": sha256(package), "memberCount": len(members),
        "harnessSha256": {name: sha256(arm / name) for name in [
            "package-lock.json", "test/perf/dictionaries.lock.json",
            "dev/perf/benchmark-support.js", "dev/perf/dictionary-fixtures.js",
            "dev/perf/import-benchmark.js", "test/e2e/import-timing.js",
            "test/chromium/extension-two-dictionary-import.e2e.js",
        ]},
        "generatedLibrariesShared": True,
        "nativeModulesRestoredFromOwnManifest": True,
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
    if command(["node", "--version"]).stdout.strip() != "v22.22.0":
        raise RuntimeError("Qualification requires the pinned Node 22.22.0 runtime")
    output = ROOT / "builds/qualification"
    output.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(PROTOCOL_PATH, output / "protocol.json")
    shutil.copyfile(Path(__file__), output / "executed-runner.py")
    shutil.copyfile(ROOT / ".github/workflows/import-qualification-7762.yml", output / "executed-workflow.yml")
    write_json(output / "execution.json", {
        "candidate": args.candidate, "dictionary": args.dictionary, "replica": args.replica,
        "workflowCommit": command(["git", "rev-parse", "HEAD"]).stdout.strip(),
        "protocolSha256": sha256(PROTOCOL_PATH), "runnerSha256": sha256(Path(__file__)),
        "runId": os.environ.get("GITHUB_RUN_ID"), "runAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
    })
    command(["git", "diff", "--exit-code", protocol["base"], candidate["commit"], "--",
             "package.json", "package-lock.json", "dev/perf", "test/chromium",
             "test/e2e", "test/perf", "ext/js/pages/settings/dictionary-import-controller.js"])
    patch = subprocess.check_output(["git", "diff", "--binary", protocol["base"], candidate["commit"]], cwd=ROOT)
    (output / "candidate.patch").write_bytes(patch)
    command(["node", "dev/perf/prepare-dictionaries.js", args.dictionary], log=output / "fixture-prepare.log")
    cache = (ROOT / "builds/e2e-dictionary-cache").resolve()
    fixture_lock = json.loads((ROOT / "test/perf/dictionaries.lock.json").read_text())
    fixture = fixture_lock["dictionaries"][args.dictionary]
    fixture_path = cache / fixture["cacheFile"]
    if sha256(fixture_path) != fixture["sha256"] or fixture_path.stat().st_size != fixture["sizeBytes"]:
        raise RuntimeError("Pinned source archive mismatch")
    write_json(output / "fixture.json", fixture)
    base, base_receipt, base_members = prepare_arm("A", protocol["base"], output, cache)
    treatment, treatment_receipt, treatment_members = prepare_arm("B", candidate["commit"], output, cache)
    if base_receipt["harnessSha256"] != treatment_receipt["harnessSha256"]:
        raise RuntimeError("Harness or fixture changes between arms")
    changed = sorted(name for name in base_members.keys() | treatment_members.keys()
                     if base_members.get(name) != treatment_members.get(name))
    write_json(output / "package-delta.json", changed)
    if changed != sorted(candidate["packagedDelta"]):
        raise RuntimeError(f"Unreviewed packaged delta: {changed}")
    # C is the exact same release ZIP and checkout as A, with a fresh browser
    # profile just like every other observation. It controls run-order drift.
    write_json(output / "package-C-receipt.json", {**base_receipt, "identicalTo": "A"})
    if args.prepare_only:
        return
    arms = {"A": (base, base_receipt), "B": (treatment, treatment_receipt), "C": (base, base_receipt)}
    order = protocol["orders"][args.replica]
    schedule = [{"name": f"warmup-{arm}", "arm": arm, "phase": "warmup", "media": "sample"}
                for arm in protocol["warmups"][args.replica]]
    for index, cohort in enumerate(order):
        schedule.extend({"name": f"cohort-{index}-{arm}", "arm": arm, "phase": "timed", "cohort": index, "media": "sample"}
                        for arm in cohort)
    if args.replica == 0:
        schedule.extend({"name": f"all-media-{arm}", "arm": arm, "phase": "validation", "media": "all"}
                        for arm in ["A", "B"])
    write_json(output / "schedule.json", schedule)
    observations = []
    semantic_by_media = {}
    failures = []
    for item in schedule:
        destination = output / item["name"]
        destination.mkdir()
        arm_root, receipt = arms[item["arm"]]
        record = {**item, "sourceCommit": receipt["sourceCommit"], "packageSha256": receipt["packageSha256"],
                  "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        write_json(destination / "receipt.json", record)
        try:
            command(["node", "dev/perf/host-environment.js"], cwd=arm_root, log=destination / "host-before.json")
            command(["node", "dev/perf/import-benchmark.js", args.dictionary, "--runs", "1", "--no-build",
                     "--build-target", "chrome", "--media-check", item["media"], "--output", str(destination)],
                    cwd=arm_root, log=destination / "run.log")
            report = json.loads((destination / "run-1.json").read_text())
            summary = json.loads((destination / "summary.json").read_text())
            if len(summary["runs"]) != 1:
                raise RuntimeError("Expected exactly one complete import per observation")
            if report["packageSha256"] != receipt["packageSha256"] or report["browserVersion"] != protocol["browserVersion"]:
                raise RuntimeError("Executed package or browser mismatch")
            if summary["gitSha"] != receipt["sourceCommit"] or not summary["authoritativeTiming"]:
                raise RuntimeError("Source lineage or timing mode mismatch")
            semantic = semantic_receipt(report)
            if item["media"] in semantic_by_media and semantic_by_media[item["media"]] != semantic:
                raise RuntimeError("Public lookup, restart, or media result differs across arms or observations")
            semantic_by_media[item["media"]] = semantic
            record.update({"status": "success", "totalImportMs": summary["runs"][0]["totalImportMs"],
                           "workerImportMs": summary["runs"][0]["workerImportMs"]})
            write_json(destination / "semantic-receipt.json", semantic)
        except Exception as error:
            record.update({"status": "failure", "error": str(error)})
            failures.append(item["name"])
        finally:
            command(["node", "dev/perf/host-environment.js"], cwd=arm_root, log=destination / "host-after.json", check=False)
            observations.append(record)
            write_json(output / "observations.json", observations)
            print(json.dumps(record), flush=True)
    pairs = []
    for index in range(len(order)):
        cohort = {row["arm"]: row for row in observations if row.get("cohort") == index}
        if len(cohort) != 3 or any(row["status"] != "success" for row in cohort.values()):
            pairs.append({"cohort": index, "qualified": False})
            continue
        values = {arm: row["totalImportMs"] for arm, row in cohort.items()}
        pairs.append({"cohort": index, "qualified": True, "ms": values,
                      "BvsA": 100 * (values["B"] / values["A"] - 1),
                      "BvsC": 100 * (values["B"] / values["C"] - 1),
                      "CvsA": 100 * (values["C"] / values["A"] - 1)})
    complete = not failures and all(row["qualified"] for row in pairs)
    analysis = {"complete": complete, "failures": failures, "pairs": pairs, "criterion": protocol["criterion"]}
    if complete:
        analysis["medians"] = {key: statistics.median(row[key] for row in pairs) for key in ["BvsA", "BvsC", "CvsA"]}
        analysis["fasterPairs"] = {key: sum(row[key] < 0 for row in pairs) for key in ["BvsA", "BvsC"]}
        thresholds = protocol["thresholds"]
        target = args.dictionary in candidate["targetDictionaries"]
        passes = all(
            analysis["medians"][key] <= -thresholds["targetMinimumReductionPercent"] and
            analysis["fasterPairs"][key] >= thresholds["targetMinimumFasterPairs"]
            for key in ["BvsA", "BvsC"]
        ) if target else all(
            analysis["medians"][key] <= thresholds["nonTargetMaximumRegressionPercent"]
            for key in ["BvsA", "BvsC"]
        )
        analysis["performanceScreen"] = {"role": "target" if target else "non-target", "passes": passes}
    else:
        analysis["performanceScreen"] = {"passes": None, "reason": "Incomplete data cannot qualify"}
    write_json(output / "analysis.json", analysis)
    if not complete:
        raise RuntimeError("Incomplete or failed cohort; all observations retained, none replaced")


if __name__ == "__main__":
    main()
