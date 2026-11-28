#!/usr/bin/env python3
"""Run one fixed VNDB memory-coverage follow-up without repeating latency work."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
INPUTS = Path(__file__).with_name("media-memory-coverage-4a779")
HARNESS = "test/chromium/extension-two-dictionary-import.e2e.js"
PROVENANCE_PATHS = (
    "package-lock.json", "test/perf/dictionaries.lock.json", "dev/perf/benchmark-support.js",
    "dev/perf/dictionary-fixtures.js", "dev/perf/import-benchmark.js", "test/chromium/import-flags-ab-benchmark.js",
    HARNESS, "test/e2e/import-timing.js", "ext/js/pages/settings/dictionary-import-controller.js",
    "builds/manabitan-chrome-dev.zip", "builds/manabitan-chrome.zip",
)


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def git(*command, cwd=ROOT):
    return subprocess.check_output(["git", *command], cwd=cwd, text=True).strip()


def run(command, cwd, log):
    with log.open("xb") as output:
        completed = subprocess.run(command, cwd=cwd, stdout=output, stderr=subprocess.STDOUT)
    if completed.returncode:
        raise RuntimeError(f"Command failed ({completed.returncode}); see {log}")


def package_entries(path):
    import zipfile
    with zipfile.ZipFile(path) as package:
        names = [item.filename for item in package.infolist()]
        if len(names) != len(set(names)):
            raise RuntimeError(f"Duplicate package member names: {path}")
        return {item.filename: hashlib.sha256(package.read(item)).hexdigest()
                for item in package.infolist() if not item.is_dir()}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def values_for_key(value, key):
    if isinstance(value, dict):
        if key in value:
            yield value[key]
        for nested in value.values():
            yield from values_for_key(nested, key)
    elif isinstance(value, list):
        for nested in value:
            yield from values_for_key(nested, key)


def main(evidence):
    evidence.mkdir(parents=True, exist_ok=False)
    plan = json.loads((INPUTS / "plan.json").read_text())
    write_json(evidence / "registered-plan.json", plan)
    require(plan["observations"] == 4 and plan["flags"] == {} and plan["vndbSahAllocationUnits"] == [37, 37], "Fixed follow-up scope differs")
    require(os.environ.get("GITHUB_RUN_ATTEMPT") == "1", "Workflow reruns are not authorized for this one-cohort follow-up")
    work = evidence.parent / (evidence.name + "-sources")
    work.mkdir(exist_ok=False)
    os.environ["MANABITAN_E2E_STRICT_RUNTIME"] = "1"
    os.environ["MANABITAN_CHROMIUM_ALLOW_HEADED_FALLBACK"] = "0"

    require(subprocess.check_output(["node", "--version"], text=True).strip() == plan["nodeVersion"], "Node version differs")
    changed = set(git("diff", "--name-only", plan["candidate"], "HEAD").splitlines())
    require(changed == set(plan["allowedDiagnosticFiles"]), "Follow-up commit has unexpected source changes")
    diagnostic_identity = {"head": git("rev-parse", "HEAD"), "tree": git("rev-parse", "HEAD^{tree}"),
                           "runId": os.environ.get("GITHUB_RUN_ID"), "runAttempt": 1,
                           "files": {path: digest(ROOT / path) for path in plan["allowedDiagnosticFiles"]}}
    write_json(evidence / "diagnostic-identities.json", diagnostic_identity)
    for relative, expected in plan["requiredSameSha256"].items():
        require(digest(ROOT / relative) == expected, f"Frozen source differs: {relative}")
    for filename, expected in plan["referenceFileSha256"].items():
        require(digest(INPUTS / filename) == expected, f"Prior reference differs: {filename}")
        shutil.copyfile(INPUTS / filename, evidence / filename)
    prior_receipt = json.loads((INPUTS / "prior-canonical-receipt.json").read_text())
    prior_identities = json.loads((INPUTS / "prior-source-identities.json").read_text())["arms"]

    # These are the unchanged helpers used by the original complete-import qualifier.
    sys.path.insert(0, str(ROOT / "dev/perf/import-memory-20261125-a7f7"))
    from chromium_memory import run_with_sampling, summarize_import_window
    from protocol import memory_overlay, memory_comparison, schedule as memory_schedule
    from audit_memory import audit_cell
    from qualification_receipts import validate_import_summary, require_matching_receipts

    memory_plan = memory_schedule(1)
    require(memory_plan == plan["memorySchedule"], "Frozen four-observation schedule differs")
    fixture = json.loads((ROOT / "test/perf/dictionaries.lock.json").read_text())["dictionaries"]["vndb"]
    require(fixture["sha256"] == plan["fixtureSha256"], "Fixture lock differs")
    browser_binary = Path(subprocess.check_output([
        "node", "--input-type=module", "-e", "import {chromium} from 'playwright'; process.stdout.write(chromium.executablePath())",
    ], cwd=ROOT, text=True))
    browser_text = subprocess.check_output([str(browser_binary), "--version"], text=True).strip()
    browser_match = re.search(r"\d+\.\d+\.\d+\.\d+", browser_text)
    require(browser_match is not None, "Browser version is unavailable")
    browser_version = browser_match.group(0)
    browser_identity = {"executable": str(browser_binary), "sha256": digest(browser_binary),
                        "versionOutput": browser_text, "version": browser_version}
    write_json(evidence / "browser-identity.json", browser_identity)
    require(browser_version == plan["browserVersion"] and browser_identity["sha256"] == plan["browserSha256"], "Full Chromium identity differs")
    run(["node", "dev/perf/prepare-dictionaries.js", "vndb"], ROOT, evidence / "fixtures.log")
    archive = ROOT / "builds/e2e-dictionary-cache" / fixture["cacheFile"]
    require(archive.stat().st_size == fixture["sizeBytes"] and digest(archive) == plan["fixtureSha256"], "Fixture bytes differ")

    # Same independent exact-revision build and package preparation as the original qualifier.
    sources, identities = {}, {}
    for arm, sha in (("A", plan["baseline"]), ("B", plan["candidate"])):
        target = work / arm
        run(["git", "worktree", "add", "--detach", str(target), sha], ROOT, evidence / f"worktree-{arm}.log")
        for relative, expected in plan["requiredSameSha256"].items():
            require(digest(target / relative) == expected, f"Arm {arm} frozen source differs: {relative}")
        if arm == "B":
            for item in plan["candidateProductAndTests"]:
                require(digest(target / item["path"]) == item["sha256"], f"Candidate bytes differ: {item['path']}")
                require(git("hash-object", item["path"], cwd=target) == item["gitBlob"], f"Candidate blob differs: {item['path']}")
        shutil.copytree(ROOT / "node_modules", target / "node_modules", copy_function=os.link, symlinks=True)
        (target / "builds").mkdir(exist_ok=True)
        (target / "builds/e2e-dictionary-cache").symlink_to(ROOT / "builds/e2e-dictionary-cache", target_is_directory=True)
        run(["npm", "run", "build:libs"], target, evidence / f"libs-{arm}.log")
        run(["npm", "run", "license-report:html"], target, evidence / f"license-{arm}.log")
        run(["npm", "run", "build", "--", "--target", "chrome"], target, evidence / f"build-{arm}.log")
        package = target / "builds/manabitan-chrome.zip"
        identity = {"sha": git("rev-parse", "HEAD", cwd=target), "tree": git("rev-parse", "HEAD^{tree}", cwd=target),
                    "packageSha256": digest(package), "entries": package_entries(package),
                    "lockSha256": digest(target / "package-lock.json"),
                    "fixtureLockSha256": digest(target / "test/perf/dictionaries.lock.json"),
                    "sourceHashes": {path: digest(target / path) if (target / path).is_file() else None for path in PROVENANCE_PATHS}}
        require(identity["sha"] == sha and identity["tree"] == prior_identities[arm]["tree"], f"Arm {arm} exact revision differs")
        require(identity["entries"] == prior_identities[arm]["entries"], f"Arm {arm} package members differ from the original cohort")
        for relative, expected in prior_identities[arm]["sourceHashes"].items():
            if not relative.startswith("builds/"):
                require(identity["sourceHashes"][relative] == expected, f"Arm {arm} prior source hash differs: {relative}")
        require(not git("status", "--porcelain", cwd=target), f"Arm {arm} has unexpected source changes after building")
        sources[arm], identities[arm] = target, identity
        shutil.copyfile(package, evidence / f"package-{arm}.zip")
    require(identities["A"]["entries"].keys() == identities["B"]["entries"].keys(), "Package member sets differ")
    changed_entries = sorted(name for name in identities["A"]["entries"]
                             if identities["A"]["entries"][name] != identities["B"]["entries"][name])
    require(changed_entries == sorted(plan["expectedPackageEntries"]), "Unexpected package delta")
    write_json(evidence / "source-identities.json", {"arms": identities, "changedPackageEntries": changed_entries,
                                                     "priorMemberMapsMatch": True, "containerHashesBoundSeparately": True})

    memory_root = evidence / "memory"
    memory_root.mkdir()
    original_harness = (sources["A"] / HARNESS).read_text()
    instrumented_harness = memory_overlay(original_harness)
    require(hashlib.sha256(original_harness.encode()).hexdigest() == plan["originalHarnessSha256"], "Original memory harness differs")
    overlay_sha = hashlib.sha256(instrumented_harness.encode()).hexdigest()
    require(overlay_sha == plan["overlaySha256"], "Frozen marker overlay differs")
    (memory_root / "harness-original.js").write_text(original_harness)
    (memory_root / "harness-instrumented.js").write_text(instrumented_harness)
    write_json(memory_root / "plan.json", {"schedule": memory_plan, "replication": 1, "dictionary": "vndb",
                                         "authoritativeTiming": False, "sourceHashes": identities, "overlaySha256": overlay_sha,
                                         "scope": plan["scope"], "priorArtifact": plan["priorArtifact"]})
    observations, semantic_failures, attempts = [], [], []
    first_new_receipt = None
    first_new_receipt_name = None
    try:
        for target in sources.values():
            require((target / HARNESS).read_text() == original_harness, "Memory overlay sources differ")
            (target / HARNESS).write_text(instrumented_harness)
        for item in memory_plan:
            arm, target = item["arm"], sources[item["arm"]]
            output = memory_root / item["name"]
            output.mkdir()
            command = ["node", "dev/perf/import-benchmark.js", "vndb", "--runs", "1", "--no-build",
                       "--build-target", "chrome", "--media-check", "sample", "--output", str(output)]
            require(digest(target / "builds/manabitan-chrome.zip") == identities[arm]["packageSha256"], "Product package changed before memory observation")
            attempts.append({**item, "status": "started", "retried": False, "command": command})
            write_json(memory_root / "attempts.json", attempts)
            try:
                sampled = run_with_sampling(command, target, output / "run.log", output / "memory.json", output / "markers.jsonl")
            except Exception as failure:
                write_json(output / "sampling-failure.json", {"type": type(failure).__name__, "message": str(failure), "retried": False})
                memory_path = output / "memory.json"
                if memory_path.exists():
                    memory_path.rename(output / "memory-incomplete.json")
                marker_path = output / "markers.jsonl"
                if not marker_path.exists():
                    marker_path.write_text("")
                try:
                    markers = [json.loads(line) for line in marker_path.read_text().splitlines() if line]
                except json.JSONDecodeError:
                    markers = []
                raw = summarize_import_window([], markers, -1)
                write_json(memory_path, raw)
                sampled = {key: value for key, value in raw.items() if key != "samples"}
            observations.append({**item, **sampled})
            write_json(memory_root / "observations.json", observations)
            attempts[-1]["status"] = "finished"
            write_json(memory_root / "attempts.json", attempts)
            try:
                summary = json.loads((output / "summary.json").read_text())
                report = json.loads((output / "run-1.json").read_text())
                identity = identities[arm]
                hashes = identity["sourceHashes"].copy()
                hashes[HARNESS] = overlay_sha
                receipt = validate_import_summary(summary, report, dictionary="vndb", fixture=fixture,
                    source_sha=identity["sha"], package_sha256=identity["packageSha256"], browser_version=browser_version,
                    import_flags=None, source_hashes=hashes, source_dirty=True, media_check="sample",
                    vndb_sah_allocation_units=(37, 37))
                write_json(output / "canonical-receipt.json", receipt)
                require_matching_receipts(prior_receipt, receipt)
                if first_new_receipt is None:
                    first_new_receipt = receipt
                    first_new_receipt_name = item["name"]
                else:
                    require_matching_receipts(first_new_receipt, receipt)
                for key, expected in plan["expectedActivation"].items():
                    values = list(values_for_key(report, key))
                    require(values and all(type(value) is type(expected) and value == expected for value in values), f"Activation differs: {key}")
                write_json(output / "semantic-binding.json", {"priorReceiptSha256": plan["referenceFileSha256"]["prior-canonical-receipt.json"],
                    "matchesPriorReceipt": True, "matchesNewCohortReference": True, "newCohortReference": first_new_receipt_name, "activationMatches": True})
            except Exception as failure:
                semantic_failures.append({"name": item["name"], "type": type(failure).__name__, "error": str(failure)})
            write_json(memory_root / "semantic-failures.json", semantic_failures)
    finally:
        for arm, target in sources.items():
            (target / HARNESS).write_text(original_harness)
            require(digest(target / "builds/manabitan-chrome.zip") == identities[arm]["packageSha256"], "Product package changed during memory acquisition")
            require(not git("status", "--porcelain", cwd=target), "Unexpected source changes after restoring memory harness")
    result = memory_comparison(observations, "vndb", 1, memory_schedule)
    write_json(memory_root / "memory-comparison.json", result)
    audit_error = None
    try:
        write_json(memory_root / "memory-audit.json", audit_cell(memory_root))
    except Exception as failure:
        audit_error = {"type": type(failure).__name__, "message": str(failure)}
        write_json(memory_root / "memory-audit-failure.json", audit_error)
    require(digest(browser_binary) == plan["browserSha256"], "Browser binary changed during follow-up")
    require(digest(archive) == plan["fixtureSha256"], "Fixture changed during follow-up")
    for relative, expected in plan["requiredSameSha256"].items():
        require(digest(ROOT / relative) == expected, f"Frozen source changed during follow-up: {relative}")
    passed = result["passesProspectiveMemoryScreen"] and not semantic_failures and audit_error is None
    write_json(evidence / "analysis.json", {"scope": plan["scope"], "authoritativeTiming": False,
        "status": "coverage-followup-passed" if passed else "coverage-followup-failed", "memoryPassed": passed,
        "metrics": result["metrics"], "semanticFailures": semantic_failures, "auditFailure": audit_error,
        "originalScreenRemainsFailed": True, "original16MiBPromotionRuleRemainsFailed": True,
        "previousLatencyAndExhaustiveMediaCohortsUnchanged": True, "automaticRetry": False})
    if not passed:
        raise RuntimeError("The single memory-coverage follow-up failed; no repeat is authorized")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    evidence = args.evidence.resolve()
    try:
        main(evidence)
    except Exception as failure:
        if evidence.is_dir():
            write_json(evidence / "failure.json", {"type": type(failure).__name__, "message": str(failure), "retried": False})
        raise
