#!/usr/bin/env python3
"""Audit three immutable original watchdog artifacts; acquire no benchmark data."""
import argparse
import ast
import errno
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import random
import re
import statistics
import sys
import zipfile

from audit_transport import (
    AuditError, GitHub, digest, file_digest, inspect_zip, parse_json,
    read_json, require, stream_digest, write_json,
)

BASELINE = "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2"
CANDIDATE = "e6d86276a257393fa8df63b1825a405408197974"
BASELINE_TREE = "d99ea4d04658f7ec1c76acdc5f3684594212a471"
CANDIDATE_TREE = "66ca1a61caa98d9c91984c16f48c2f6adcd36b77"
RUN_ID = 46111030045
BRANCH = "perf/compression-watchdog-20261128"
WORKFLOW = ".github/workflows/import-compression-watchdog-1c413.yml"
QUALIFIER = "dev/perf/import-qualification-20261125-a7f7.py"
QUALIFIER_SHA256 = "cad1b3fb25766cbd22a1c4260718a0b92353e87276751217ca18dc9eea29c6ef"
RUNTIME = "ext/js/dictionary/zstd-term-content.js"
PACKAGE_ENTRY = "js/dictionary/zstd-term-content.js"
HARNESS = "test/chromium/extension-two-dictionary-import.e2e.js"
MEMORY_DIRECTORY = "dev/perf/import-memory-20261125-a7f7"
MODULE_HASHES = {
    "chromium_memory": "8044bf3f4c48a868c7e076dc5f1bef9c2663f6323fe4a4fba5c121161cada4c7",
    "protocol": "ea0e7c20bbc1273cbe81891c32ecc72658d70ed1bbf1d57cdcfae5b347d493c7",
    "qualification_receipts": "4f7b4eee4f8ff71e821c9162e57524460c48f01f409487f638523a3a27aa8f51",
    "audit_memory": "871f29b9d87c42468714263a0eda05ee9edd2f76bff269ea9cb6d6d1fe51de7c",
}
CHANGED_PATHS = {
    RUNTIME, "test/zstd-term-content-watchdog.test.js", WORKFLOW,
    "dev/perf/compression-watchdog-20261128/PLAN.md",
    "dev/perf/compression-watchdog-20261128/verify-source.py",
}
JOBS = {
    "correctness": (140874375328, "Unit tests, main and test types, lint, and dry build"),
    "jmdict": (140874375134, "Complete import (jmdict, AB)"),
    "jitendex": (140874375333, "Complete import (jitendex, BA)"),
}
ORDERS = {"jmdict": "AB", "jitendex": "BA"}
CORRECTNESS_STEPS = (
    "Verify the frozen source and unchanged qualification boundary",
    "Changed-source lint", "Complete unit suite", "Main source type validation",
    "Test type validation", "All-target dry build",
)
PROVENANCE_PATHS = (
    "package-lock.json", "test/perf/dictionaries.lock.json", "dev/perf/benchmark-support.js",
    "dev/perf/dictionary-fixtures.js", "dev/perf/import-benchmark.js",
    "test/chromium/import-flags-ab-benchmark.js", HARNESS, "test/e2e/import-timing.js",
    "ext/js/pages/settings/dictionary-import-controller.js",
    "builds/manabitan-chrome-dev.zip", "builds/manabitan-chrome.zip",
)


def same(actual, expected, label):
    if type(actual) is set or type(expected) is set:
        require(type(actual) is set and type(expected) is set and actual == expected, label + " differs")
        return
    require(json.dumps(actual, sort_keys=True, allow_nan=False) ==
            json.dumps(expected, sort_keys=True, allow_nan=False), label + " differs")


def git_blob(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def verify_auditor_source():
    require(sys.flags.optimize == 0, "Audit assertions must remain enabled")
    directory = Path(__file__).resolve().parent
    root = directory.parents[2]
    binding_path = directory / "source-binding.json"
    binding = read_json(binding_path)
    prefix = "dev/perf/watchdog-artifact-audit-20261128/"
    expected_paths = {
        prefix + name for name in (
            "audit_transport.py", "audit_watchdog.py", "test_audit_watchdog.py",
            "manifest.json", "README.md",
        )
    } | {".github/workflows/watchdog-original-artifact-audit-1c413.yml"}
    same(set(binding["files"]), expected_paths, "Complete auditor source boundary")
    checked = {}
    for relative, record in binding["files"].items():
        path = root / relative
        require(path.is_file() and not path.is_symlink(), "Missing regular auditor source " + relative)
        data = path.read_bytes()
        same(record, {"bytes": len(data), "gitBlob": git_blob(data)}, "Frozen auditor source " + relative)
        checked[relative] = {**record, "sha256": digest(data)}
    data = binding_path.read_bytes()
    checked[prefix + "source-binding.json"] = {"bytes": len(data), "gitBlob": git_blob(data), "sha256": digest(data)}
    return checked


def frozen_schedule(initial_order, pairs=12):
    require(initial_order in ("AB", "BA") and pairs == 12, "Unexpected frozen timing schedule")
    result = []
    for number, order in enumerate((initial_order, initial_order[::-1]), 1):
        for arm in order:
            result.append({"id": f"warmup-{number}-{arm}", "kind": "warmup", "pair": number, "arm": arm})
    for number in range(1, pairs + 1):
        order = initial_order if number % 2 else initial_order[::-1]
        for arm in order:
            result.append({"id": f"pair-{number:02d}-{arm}", "kind": "candidate", "pair": number, "arm": arm})
        if number % 3 == 0:
            control_pair = number // 3
            order = "AC" if (control_pair + (initial_order == "BA")) % 2 else "CA"
            for arm in order:
                result.append({"id": f"control-{control_pair:02d}-{arm}", "kind": "control",
                               "pair": control_pair, "arm": arm})
    return result


def independent_contrast(observations, kind, left, right):
    groups = {}
    for observation in observations:
        if observation["kind"] != kind:
            continue
        number, arm = observation["pair"], observation["arm"]
        require(arm in (left, right) and arm not in groups.setdefault(number, {}), "Duplicate or unknown pair arm")
        duration = observation["totalImportMs"]
        require(type(duration) in (int, float) and math.isfinite(duration) and duration > 0, "Invalid recorded duration")
        groups[number][arm] = duration
    expected_count = 12 if kind == "candidate" else 4
    same(sorted(groups), list(range(1, expected_count + 1)), "Complete pair identifiers")
    require(all(set(pair) == {left, right} for pair in groups.values()), "Incomplete paired observation")
    pairs = [groups[number] for number in range(1, expected_count + 1)]
    ratios = [pair[right] / pair[left] for pair in pairs]
    generator = random.Random(897)
    medians = sorted(statistics.median(generator.choices(ratios, k=len(ratios))) for _ in range(10000))
    return {
        "count": len(pairs), "ratios": ratios,
        "medianPairedChangePercent": 100 * (statistics.median(ratios) - 1),
        "equalWorkChangePercent": 100 * (sum(pair[right] for pair in pairs) / sum(pair[left] for pair in pairs) - 1),
        "worstPairChangePercent": 100 * (max(ratios) - 1),
        "descriptiveBootstrap95Percent": [100 * (medians[index] - 1) for index in (249, 9749)],
        "fasterPairs": sum(value < 1 for value in ratios),
    }


def nomination(candidate, controls, correctness, memory, source_and_semantics=True):
    gates = {
        "completeSourceAndSemantics": bool(source_and_semantics),
        "separateCorrectness": bool(correctness),
        "separateMemory": bool(memory),
        "pairedMedianAtMostMinusTwoPercent": candidate["medianPairedChangePercent"] <= -2,
        "atLeastNineOfTwelveFaster": candidate["count"] == 12 and candidate["fasterPairs"] >= 9,
        "absoluteControlMedianAtMostOnePercent": abs(controls["medianPairedChangePercent"]) <= 1,
        "absoluteControlEqualWorkAtMostOnePercent": abs(controls["equalWorkChangePercent"]) <= 1,
    }
    return {"nominated": all(gates.values()), "gates": gates,
            "scope": "Nomination for a separate independent six-cell confirmation only; no product PR qualification."}


def validate_manifest(manifest):
    same(manifest["schemaVersion"], 1, "Manifest schema")
    same(manifest["repository"], "ManabiIO/manabitan", "Repository")
    same(manifest["publication"], {
        "runId": RUN_ID, "headSha": CANDIDATE, "headTree": CANDIDATE_TREE,
        "headBranch": BRANCH, "runAttempt": 1, "event": "push", "workflowPath": WORKFLOW,
    }, "Frozen original publication")
    same(manifest["baseline"], {"sha": BASELINE, "tree": BASELINE_TREE}, "Original baseline")
    same(manifest["nominationPolicy"], {
        "medianChangePercentAtMost": -2, "fasterPairsAtLeast": 9, "measuredPairs": 12,
        "absoluteControlMedianAtMost": 1, "absoluteControlEqualWorkAtMost": 1,
        "requireCompleteCorrectness": True, "requireAllOriginalReceipts": True,
        "requireSeparateMemory": True,
        "scope": "Nomination only; new independent six-cell confirmation required before any product PR.",
    }, "Frozen nomination policy")
    entries = manifest["artifacts"]
    require(type(entries) is list and len(entries) == 3, "Exactly three original artifacts are required")
    same(sorted(entry["kind"] for entry in entries), sorted(JOBS), "Artifact roles")
    require(len({entry["id"] for entry in entries}) == 3, "Duplicate artifact ID")
    for entry in entries:
        kind = entry["kind"]
        same((entry["jobId"], entry["jobName"]), JOBS[kind], "Original job")
        same(entry["expectedConclusion"], "success", "Original completed job conclusion")
        require(type(entry["id"]) is int and entry["id"] > 0, "Invalid artifact ID")
        require(type(entry["sizeBytes"]) is int and 0 < entry["sizeBytes"] <= 128 * 1024 * 1024, "Unexpected outer archive size")
        require(re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]) is not None, "Invalid artifact digest")
        expected_name = ("compression-watchdog-validation-" if kind == "correctness" else
                         f"compression-watchdog-{kind}-{ORDERS[kind]}-") + CANDIDATE
        same(entry["name"], expected_name, "Original artifact name")


def validate_original_jobs(run, jobs, manifest):
    for key, value in (("id", RUN_ID), ("head_sha", CANDIDATE), ("head_branch", BRANCH),
                       ("run_attempt", 1), ("event", "push"), ("path", WORKFLOW), ("status", "completed")):
        same(run.get(key), value, "Original run " + key)
    same(run.get("conclusion"), "success", "Original run conclusion")
    same(jobs["total_count"], 3, "Original job count")
    same(sorted(job["id"] for job in jobs["jobs"]), sorted(item["jobId"] for item in manifest["artifacts"]), "Original job IDs")
    by_id = {}
    for job in jobs["jobs"]:
        expected = next(item for item in manifest["artifacts"] if item["jobId"] == job["id"])
        for key, value in (("run_id", RUN_ID), ("run_attempt", 1), ("head_sha", CANDIDATE),
                           ("name", expected["jobName"]), ("status", "completed"), ("conclusion", expected["expectedConclusion"])):
            same(job.get(key), value, "Original job " + key)
        by_id[job["id"]] = job
    return by_id


def load_paired_summary(qualifier):
    same(digest(qualifier), QUALIFIER_SHA256, "Pinned qualifier")
    parsed = ast.parse(qualifier, filename=QUALIFIER)
    definitions = [node for node in parsed.body if isinstance(node, ast.FunctionDef) and node.name == "paired_summary"]
    require(len(definitions) == 1 and not definitions[0].decorator_list, "Missing unique pure paired summary")
    namespace = {"random": random, "statistics": statistics, "observations": []}
    isolated = ast.Module(body=definitions, type_ignores=[])
    # Deliberately compile one verified FunctionDef, never the qualifier module.
    exec(compile(isolated, QUALIFIER + ":paired_summary-only", "exec"), namespace)
    return namespace


def verify_sources(api, manifest, output):
    require(sys.flags.optimize == 0, "Memory audit assertions must remain enabled")
    trees = {"A": api.tree(BASELINE, BASELINE_TREE), "B": api.tree(CANDIDATE, CANDIDATE_TREE)}
    commit = api.json("/git/commits/" + CANDIDATE, "candidate-ancestry")
    same([parent["sha"] for parent in commit["parents"]], [BASELINE], "Candidate sole parent")
    paths = set(trees["A"]) | set(trees["B"])
    changed = {path for path in paths if
               (trees["A"].get(path, {}).get("sha"), trees["A"].get(path, {}).get("mode")) !=
               (trees["B"].get(path, {}).get("sha"), trees["B"].get(path, {}).get("mode"))}
    same(sorted(changed), sorted(CHANGED_PATHS), "Complete changed source boundary")
    proof = manifest["sourceProof"]
    same(proof["baseline"], BASELINE, "Source proof baseline")
    same(proof["candidate"], CANDIDATE, "Source proof candidate")
    same(proof["tree"], CANDIDATE_TREE, "Source proof tree")
    same(proof["parent"], BASELINE, "Source proof parent")
    same(proof["passed"], True, "Source proof status")
    same(proof["changedPaths"], sorted(CHANGED_PATHS), "Source proof paths")
    same(proof["expectedPackageEntries"], [PACKAGE_ENTRY], "Source proof package delta")
    same(set(proof["sources"]), CHANGED_PATHS, "Source proof source inventory")
    for path, record in proof["sources"].items():
        data = api.source(CANDIDATE, path)
        same(record, {"bytes": len(data), "gitBlob": git_blob(data), "sha256": digest(data)}, "Frozen source " + path)
    for path, expected in proof["unchangedObserverHashes"].items():
        same(trees["A"][path]["sha"], trees["B"][path]["sha"], "Unchanged observer blob " + path)
        same(digest(api.source(BASELINE, path)), expected, "Unchanged observer hash " + path)
    trusted = output / "trusted-modules"
    trusted.mkdir()
    modules = {}
    for name, expected in MODULE_HASHES.items():
        data = api.source(BASELINE, MEMORY_DIRECTORY + "/" + name + ".py")
        same(digest(data), expected, "Pinned pure helper " + name)
        target = trusted / (name + ".py")
        target.write_bytes(data)
        spec = importlib.util.spec_from_file_location(name, target)
        require(spec is not None and spec.loader is not None, "Cannot load trusted pure helper")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        modules[name] = module
    # Only these imported functions inspect recorded bytes. Acquisition functions
    # in chromium_memory are never called, including on the audit host.
    require(errno.ENOENT == 2 and errno.ESRCH == 3, "Recorded Linux gone-process errno mapping differs")
    qualifier = api.source(BASELINE, QUALIFIER)
    namespace = load_paired_summary(qualifier)
    fixture = parse_json(api.source(BASELINE, "test/perf/dictionaries.lock.json"))["dictionaries"]
    write_json(output / "verified-source-proof.json", proof)
    write_json(output / "trusted-module-bindings.json", {
        "baseline": BASELINE, "modules": MODULE_HASHES, "qualifierSha256": QUALIFIER_SHA256,
        "qualifierExecutionScope": "Only the isolated paired_summary FunctionDef; no module top-level execution",
    })
    return trees, modules, namespace, fixture


def archive_member_digest(source, length, target=None):
    sha256 = hashlib.sha256()
    sha1 = hashlib.sha1(b"blob " + str(length).encode() + b"\0")
    count = 0
    for block in iter(lambda: source.read(1024 * 1024), b""):
        count += len(block)
        require(count <= length, "ZIP member exceeds declared size")
        sha256.update(block)
        sha1.update(block)
        if target is not None:
            target.write(block)
    require(count == length, "Truncated ZIP member")
    return {"bytes": count, "sha256": sha256.hexdigest(), "gitBlob": sha1.hexdigest()}


def unpack_artifact(outer, output, kind):
    extracted = output / "extracted"
    extracted.mkdir()
    inventory = []
    packages = {}
    allowed = {f"compression-watchdog-comparison/package-{arm}.zip": arm for arm in "AB"} if kind != "correctness" else {}
    try:
        with zipfile.ZipFile(outer) as archive:
            for info in inspect_zip(archive):
                target = extracted.joinpath(*Path(info.filename).parts)
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    inventory.append({"path": info.filename, "directory": True, "bytes": 0})
                    continue
                archive_suffix = info.filename.lower().endswith((".zip", ".gz", ".bz2", ".xz", ".tar", ".7z", ".zst"))
                require(not archive_suffix or info.filename in allowed, "Unexpected nested archive")
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as source, target.open("xb") as destination:
                    record = archive_member_digest(source, info.file_size, destination)
                inventory.append({"path": info.filename, **record})
                if info.filename in allowed:
                    arm = allowed[info.filename]
                    entries = {}
                    members = []
                    with zipfile.ZipFile(target) as package:
                        for member in inspect_zip(package):
                            if member.is_dir():
                                members.append({"path": member.filename, "directory": True, "bytes": 0})
                                continue
                            with package.open(member) as stream:
                                checked = archive_member_digest(stream, member.file_size)
                            entries[member.filename] = checked["sha256"]
                            members.append({"path": member.filename, **checked})
                    packages[arm] = {"sha256": record["sha256"], "bytes": record["bytes"],
                                     "entries": entries, "members": members}
        same(set(packages), set("AB") if kind != "correctness" else set(), "Complete original package inventory")
        # Validate strict JSON syntax before the unchanged validators read it.
        for path in extracted.rglob("*.json"):
            read_json(path)
        for path in extracted.rglob("*.jsonl"):
            for line in path.read_text().splitlines():
                if line:
                    parse_json(line)
        return extracted, packages, inventory
    finally:
        write_json(output / "outer-member-inventory.json", inventory)
        write_json(output / "package-member-inventories.json", packages)


def verify_source_proof(path, manifest):
    same(read_json(path), manifest["sourceProof"], "Original source guard receipt")


def verify_correctness(extracted, job, manifest):
    verify_source_proof(extracted / "source-proof.json", manifest)
    steps = {}
    for step in job["steps"]:
        require(step["name"] not in steps, "Duplicate correctness step")
        steps[step["name"]] = step
    for name in CORRECTNESS_STEPS:
        require(name in steps, "Missing correctness step " + name)
        same(steps[name]["status"], "completed", "Correctness step status")
        same(steps[name]["conclusion"], "success", "Correctness step conclusion")
    logs = {}
    for name in ("lint.log", "unit.log", "types-main.log", "types-test.log", "dry-build.log"):
        path = extracted / name
        require(path.is_file() and path.stat().st_size > 0, "Missing original correctness log " + name)
        logs[name] = {"bytes": path.stat().st_size, "sha256": file_digest(path)}
    clean = re.sub(r"\x1b\[[0-9;]*m", "", (extracted / "unit.log").read_text(errors="replace"))
    summary = [line.strip() for line in clean.splitlines() if re.search(r"\b(Test Files|Tests)\s", line)]
    return {"evidenceValidated": True, "passed": True, "requiredSteps": list(CORRECTNESS_STEPS),
            "logs": logs, "unitSummary": summary[-2:]}


def verify_packages(root, packages, api, trees):
    identities = read_json(root / "source-identities.json")
    same(set(identities["arms"]), {"A", "B"}, "Source arms")
    same(identities["controlC"], "Same A source, package, runtime, and flags under a distinct observation label", "Identical control source")
    for arm, sha in (("A", BASELINE), ("B", CANDIDATE)):
        identity = identities["arms"][arm]
        same(identity["sha"], sha, "Arm source commit")
        same(identity["tree"], BASELINE_TREE if arm == "A" else CANDIDATE_TREE, "Arm source tree")
        same(identity["entries"], packages[arm]["entries"], "Complete nested package member hashes")
        same(identity["packageSha256"], packages[arm]["sha256"], "Original package SHA")
        same(set(identity["sourceHashes"]), set(PROVENANCE_PATHS), "Provenance path inventory")
        for path in PROVENANCE_PATHS:
            value = identity["sourceHashes"][path]
            if path == "builds/manabitan-chrome.zip":
                same(value, packages[arm]["sha256"], "Reported packaged source hash")
            elif path == "builds/manabitan-chrome-dev.zip":
                require(value is None or (type(value) is str and re.fullmatch(r"[0-9a-f]{64}", value)), "Invalid optional development-package hash")
            else:
                same(value, digest(api.source(sha, path)), "Original report source " + path)
        same(identity["lockSha256"], digest(api.source(sha, "package-lock.json")), "Dependency lock")
        same(identity["fixtureLockSha256"], digest(api.source(sha, "test/perf/dictionaries.lock.json")), "Fixture lock")
        matches = []
        unmapped = []
        for member in packages[arm]["members"]:
            if member.get("directory"):
                continue
            path = "ext/" + member["path"]
            if path in trees[arm]:
                require(trees[arm][path]["mode"] in ("100644", "100755"), "Nonregular packaged source")
                same(member["gitBlob"], trees[arm][path]["sha"], "Packaged tracked source " + path)
                matches.append(path)
            else:
                unmapped.append(member["path"])
        packages[arm]["trackedSourceMatches"] = matches
        packages[arm]["generatedOrDependencyEntries"] = unmapped
    same(set(packages["A"]["entries"]), set(packages["B"]["entries"]), "Packaged path set")
    changed = sorted(name for name in packages["A"]["entries"] if packages["A"]["entries"][name] != packages["B"]["entries"][name])
    same(changed, [PACKAGE_ENTRY], "Exact single-entry packaged delta")
    same(sorted(identities["changedPackageEntries"]), changed, "Declared packaged delta")
    for arm, sha in (("A", BASELINE), ("B", CANDIDATE)):
        same(packages[arm]["entries"][PACKAGE_ENTRY], digest(api.source(sha, RUNTIME)), "Actual packaged watchdog bytes")
    return identities


def audit_browser(extracted, packages, cell, api, trees, modules, namespace, fixtures, manifest, output, correctness):
    dictionary = cell["kind"]
    initial = ORDERS[dictionary]
    root = extracted / "compression-watchdog-comparison"
    verify_source_proof(extracted / "compression-watchdog-source-proof.json", manifest)
    identities = verify_packages(root, packages, api, trees)
    write_json(output / "package-source-binding.json", packages)
    plan = read_json(root / "registered-plan.json")
    sequence = frozen_schedule(initial)
    protocol = modules["protocol"]
    replication = 1 if initial == "AB" else 2
    memory_schedule = protocol.schedule(replication)
    expected_plan = {
        "baseline": BASELINE, "candidate": CANDIDATE, "dictionary": dictionary,
        "initialOrder": initial, "pairs": 12, "flags": {}, "schedule": sequence,
        "mediaCheck": "sample per timed observation; separate all-media verification after timing",
        "failurePolicy": "Stop on first failed observation; retain all completed and failed evidence",
        "memoryPolicy": "Separate instrumented A/B observations after all timing and media verification",
        "sourceBoundary": "Each revision built independently before timing; no product or harness overlays",
        "expectedPackageEntries": [PACKAGE_ENTRY], "expectedWorkers": None,
        "vndbSahAllocationPolicy": None, "memorySchedule": memory_schedule,
        "statistics": "Per-host paired median and equal-work ratios; descriptive percentile bootstrap interval of paired median, 10000 complete-pair resamples, seed 897. No pooling hosts or timing from instrumented runs.",
    }
    same(plan, expected_plan, "Entire registered original plan")
    original_harness = api.source(BASELINE, HARNESS).decode()
    instrumented_harness = protocol.memory_overlay(original_harness)
    memory_root = root / "memory"
    same((memory_root / "harness-original.js").read_text(), original_harness, "Original memory harness")
    same((memory_root / "harness-instrumented.js").read_text(), instrumented_harness, "Exact unchanged memory overlay")
    same(read_json(memory_root / "plan.json"), {
        "schedule": memory_schedule, "replication": replication, "dictionary": dictionary,
        "authoritativeTiming": False, "sourceHashes": identities["arms"],
        "overlaySha256": digest(instrumented_harness.encode()),
    }, "Entire original memory plan")
    browser = read_json(root / "browser-identity.json")
    require(re.fullmatch(r"[0-9a-f]{64}", browser["sha256"]) is not None, "Invalid recorded browser executable hash")
    require(re.fullmatch(r"\d+\.\d+\.\d+\.\d+", browser["version"]) is not None, "Invalid recorded browser version")
    require(browser["version"] in browser["versionOutput"], "Recorded browser version output differs")
    receipt_module = modules["qualification_receipts"]
    reference = None
    media_reference = None
    reconstructed = []
    details = []
    expected_locations = [item["id"] for item in sequence]
    expected_locations += ["exhaustive-media-" + arm for arm in initial]
    expected_locations += ["memory/" + item["name"] for item in memory_schedule]
    for filename in ("summary.json", "run-1.json", "canonical-receipt.json"):
        actual = sorted(str(path.parent.relative_to(root)) for path in root.rglob(filename))
        same(actual, sorted(expected_locations), "Complete 42-observation inventory " + filename)
    rows = [(item["id"], item["arm"], "sample", False, item) for item in sequence]
    rows += [("exhaustive-media-" + arm, arm, "all", False, None) for arm in initial]
    rows += [("memory/" + item["name"], item["arm"], "sample", True, None) for item in memory_schedule]
    for location, label, media_mode, is_memory, scheduled in rows:
        arm = "B" if label == "B" else "A"
        identity = identities["arms"][arm]
        source_hashes = identity["sourceHashes"].copy()
        if is_memory:
            source_hashes[HARNESS] = digest(instrumented_harness.encode())
        folder = root / location
        summary = read_json(folder / "summary.json")
        report = read_json(folder / "run-1.json")
        receipt = receipt_module.validate_import_summary(
            summary, report, dictionary=dictionary, fixture=fixtures[dictionary],
            source_sha=identity["sha"], package_sha256=identity["packageSha256"],
            browser_version=browser["version"], import_flags=None, source_hashes=source_hashes,
            source_dirty=is_memory, media_check=media_mode,
        )
        same(receipt, read_json(folder / "canonical-receipt.json"), "Original canonical receipt " + location)
        if reference is None:
            reference = receipt
        else:
            receipt_module.require_matching_receipts(reference, receipt, compare_media=media_mode != "all")
        if media_mode == "all":
            if media_reference is None:
                media_reference = receipt
            else:
                receipt_module.require_matching_receipts(media_reference, receipt)
        if scheduled is not None:
            reconstructed.append({**scheduled, "totalImportMs": summary["runs"][0]["totalImportMs"]})
        role = scheduled["kind"] if scheduled is not None else ("memory" if is_memory else "full-media")
        details.append({"path": location, "arm": label, "role": role, "order": len(details) + 1,
                        "pair": scheduled["pair"] if scheduled is not None else None,
                        "mediaCheck": media_mode, "memory": is_memory,
                        "recordedTotalImportMs": summary["runs"][0]["totalImportMs"],
                        "includedInContrasts": role in ("candidate", "control"),
                        "timingUse": ("Separate instrumented memory; excluded from contrasts" if is_memory else
                                      "Separate full-media verification; excluded from contrasts" if media_mode == "all" else
                                      "Original warmup; excluded from contrasts" if role == "warmup" else
                                      "Original uninstrumented paired observation"),
                        "summarySha256": file_digest(folder / "summary.json"),
                        "rawReportSha256": file_digest(folder / "run-1.json"),
                        "canonicalReceiptSha256": file_digest(folder / "canonical-receipt.json")})
        write_json(output / "validated-observations.json", details)
    same(reconstructed, read_json(root / "observations.json"), "All recorded durations and original order")
    same(read_json(memory_root / "semantic-failures.json"), [], "Original memory semantic failures")
    audited_memory = modules["audit_memory"].audit_cell(memory_root)
    same(audited_memory, read_json(memory_root / "memory-audit.json"), "Original raw-memory audit")
    memory_observations = read_json(memory_root / "observations.json")
    comparison = protocol.memory_comparison(memory_observations, dictionary, replication, protocol.schedule)
    same(comparison, read_json(memory_root / "memory-comparison.json"), "Independently recomputed memory comparison")
    memory_passed = bool(comparison["passesProspectiveMemoryScreen"])
    namespace["observations"] = reconstructed
    candidate = namespace["paired_summary"]("candidate", "A", "B")
    controls = namespace["paired_summary"]("control", "A", "C")
    same(candidate, independent_contrast(reconstructed, "candidate", "A", "B"), "Independent candidate contrast")
    same(controls, independent_contrast(reconstructed, "control", "A", "C"), "Independent identical-code contrast")
    expected_analysis = {
        "status": "correctness-memory-passed" if memory_passed else "memory-or-semantics-failed",
        "candidateVsBaseline": candidate, "identicalCodeControl": controls, "memoryPassed": memory_passed,
        "timingInterpretation": "Descriptive paired comparison only. A passing correctness/memory status is not a latency or speedup claim.",
        "timingScope": "File input change through post-UI completion; fresh profile per observation",
        "limits": "One host/cohort only; independent opposite-order replication required. Memory observations remain separate.",
    }
    same(read_json(root / "analysis.json"), expected_analysis, "Original complete analysis")
    result = {
        "evidenceValidated": True, "dictionary": dictionary, "initialOrder": initial,
        "originalArtifactId": cell["id"], "originalJobId": cell["jobId"],
        "reportsValidated": len(details), "timingObservations": reconstructed,
        "allOriginalObservations": details,
        "candidateVsBaseline": candidate, "identicalCodeControl": controls,
        "memory": {"audit": audited_memory, "comparison": comparison},
        "memoryScanSummary": [{
            "name": row["name"], "arm": row["arm"], "pair": row["pair"],
            "allObservedSampleCount": row["allObservedSampleCount"],
            "stableFullyReadImportSampleCount": row["stableFullyReadImportSampleCount"],
            "qualifiedForWholeTreePss": row["qualifiedForWholeTreePss"],
            "qualificationFailures": row["qualificationFailures"],
            "maxSampledPssKiB": row["maxSampledPssKiB"],
            "maxSampledPrivateKiB": row["maxSampledPrivateKiB"],
        } for row in memory_observations],
        "browserIdentity": browser, "changedPackageEntries": [PACKAGE_ENTRY],
        "nomination": nomination(candidate, controls, correctness, memory_passed),
        "limits": [
            "Only original recorded browser durations contribute; this audit host acquires no timing.",
            "This two-cell screen may nominate a target only; an independent six-cell confirmation is required before a product PR.",
            "The optional development-package provenance hash is retained and bound across reports; only the actual Chrome runtime packages are present for complete member verification.",
        ],
    }
    write_json(output / "independent-audit.json", result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    require(not args.output.exists() and not args.output.is_symlink(), "The audit requires a fresh output root")
    args.output.mkdir(parents=True, exist_ok=False)
    manifest = read_json(args.manifest)
    result = {"schemaVersion": 1, "auditKind": "Read-only original artifact audit", "authoritativeTiming": False,
              "originalRunId": RUN_ID, "originalCandidate": CANDIDATE, "cells": [], "errors": [],
              "acquisition": "None: no browser, dictionary import, process sampling, native execution or new benchmark observation."}
    try:
        validate_manifest(manifest)
        write_json(args.output / "frozen-artifact-manifest.json", manifest)
        require(args.manifest.resolve() == Path(__file__).resolve().with_name("manifest.json"), "Use the frozen adjacent manifest")
        auditor_sources = verify_auditor_source()
        write_json(args.output / "auditor-source-identities.json", auditor_sources)
        snapshot = args.output / "auditor-source-files"
        snapshot.mkdir()
        repository_root = Path(__file__).resolve().parents[3]
        for relative in auditor_sources:
            name = "workflow.yml" if relative.startswith(".github/") else Path(relative).name
            target = snapshot / name
            require(not target.exists(), "Duplicate visible auditor snapshot name")
            target.write_bytes((repository_root / relative).read_bytes())
        api = GitHub(manifest["repository"], args.output)
        run = api.json("/actions/runs/" + str(RUN_ID), "original-run")
        jobs = api.json(f"/actions/runs/{RUN_ID}/jobs?filter=all&per_page=100", "original-jobs")
        by_id = validate_original_jobs(run, jobs, manifest)
        listing = api.json(f"/actions/runs/{RUN_ID}/artifacts?per_page=100", "original-artifacts")
        same(listing["total_count"], 3, "Original artifact count")
        same(sorted(item["id"] for item in listing["artifacts"]), sorted(item["id"] for item in manifest["artifacts"]), "Original artifact set")
        trees, modules, namespace, fixtures = verify_sources(api, manifest, args.output)
        correctness_passed = False
        ordered = sorted(manifest["artifacts"], key=lambda item: (item["kind"] != "correctness", item["kind"]))
        for cell in ordered:
            destination = args.output / cell["kind"]
            destination.mkdir()
            try:
                outer, metadata = api.artifact(cell, manifest["publication"], destination)
                write_json(destination / "verified-outer-artifact.json", {
                    "id": cell["id"], "bytes": outer.stat().st_size, "sha256": file_digest(outer),
                    "metadata": metadata, "retainedEntireOriginalZip": True,
                })
                extracted, packages, inventory = unpack_artifact(outer, destination, cell["kind"])
                if cell["kind"] == "correctness":
                    audit = verify_correctness(extracted, by_id[cell["jobId"]], manifest)
                    correctness_passed = audit["passed"]
                    write_json(destination / "independent-audit.json", audit)
                    result["correctness"] = audit
                else:
                    audit = audit_browser(extracted, packages, cell, api, trees, modules, namespace, fixtures,
                                          manifest, destination, correctness_passed)
                    result["cells"].append(audit)
            except Exception as error:
                failure = {"kind": cell["kind"], "originalArtifactId": cell["id"],
                           "evidenceValidated": False, "nominated": False,
                           "errorType": type(error).__name__, "message": str(error),
                           "retry": False, "allDownloadedOriginalBytesRetained": True}
                write_json(destination / "audit-failure.json", failure)
                result["errors"].append(failure)
            write_json(args.output / "audit-result.json", result)
        result["evidenceValidated"] = not result["errors"] and correctness_passed and len(result["cells"]) == 2
        result["nominatedTargets"] = [cell["dictionary"] for cell in result["cells"] if cell["nomination"]["nominated"]] if result["evidenceValidated"] else []
    except Exception as error:
        result["errors"].append({"errorType": type(error).__name__, "message": str(error), "retry": False})
        result["evidenceValidated"] = False
        result["nominatedTargets"] = []
    hashes = {}
    for path in sorted(args.output.rglob("*.json")):
        relative = path.relative_to(args.output)
        if "extracted" in relative.parts or str(relative) in ("audit-result.json", "audit-file-manifest.json"):
            continue
        hashes[str(relative)] = {"bytes": path.stat().st_size, "sha256": file_digest(path)}
    write_json(args.output / "audit-file-manifest.json", hashes)
    result["auditEvidenceHashes"] = hashes
    result["auditFileManifestSha256"] = file_digest(args.output / "audit-file-manifest.json")
    write_json(args.output / "audit-result.json", result)
    print(json.dumps(result, sort_keys=True, allow_nan=False))
    return 0 if result["evidenceValidated"] else 1


if __name__ == "__main__":
    sys.exit(main())
