#!/usr/bin/env python3
"""Run exact-source complete-import comparisons with interleaved identical controls.

This is isolated qualification tooling, not extension product code. Timed runs use
production defaults, fresh profiles, and the repository's strict import verifier.
Memory sampling and exhaustive media verification run only after the timed plan.
"""
import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import shutil
import statistics
import subprocess
import sys
import time
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--baseline", required=True)
parser.add_argument("--candidate", required=True)
parser.add_argument("--dictionary", required=True, choices=("jmdict", "jitendex", "vndb"))
parser.add_argument("--initial-order", required=True, choices=("AB", "BA"))
parser.add_argument("--pairs", type=int, default=12)
parser.add_argument("--evidence", type=pathlib.Path, required=True)
parser.add_argument("--flags", default="{}")
parser.add_argument("--expected-workers", type=int)
parser.add_argument("--expected-package-entry", action="append", required=True)
parser.add_argument("--expected-package-addition", action="append", default=[])
parser.add_argument("--expected-source-entry", action="append", required=True)
parser.add_argument("--vndb-sah-allocation-units", type=int, nargs=2, metavar=("MIN", "MAX"),
                    help="Prospective VNDB active SAH allocation range in 4096-byte units; default: historical 129–131")
args = parser.parse_args()
for value in (args.baseline, args.candidate):
    if re.fullmatch(r"[a-f0-9]{40}", value) is None:
        parser.error("Source IDs must be complete lowercase commit hashes")
if args.pairs != 12:
    parser.error("This prospective confirmation uses exactly twelve pairs")
flags = json.loads(args.flags)
if flags != {}:
    parser.error("This prospective confirmation preserves the production policy")
if args.expected_workers != 3:
    parser.error("This prospective confirmation requires the existing three-worker policy")

root = pathlib.Path(__file__).resolve().parents[2]
screen_path = root / "dev/perf/import-screen-20261127-88711ca9.py"
spec = importlib.util.spec_from_file_location("frozen_import_screen", screen_path)
screen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(screen)
sys.path.insert(0, str(root / "dev/perf/import-memory-20261125-a7f7"))
from chromium_memory import run_with_sampling, summarize_import_window
from protocol import memory_overlay, memory_comparison, schedule as memory_schedule
from audit_memory import audit_cell
from qualification_receipts import (
    SAH_ALLOCATION_UNIT_BYTES, validate_import_summary, require_matching_receipts,
    validate_vndb_sah_allocation_units,
)

if args.dictionary == "vndb" and args.vndb_sah_allocation_units != [37, 37]:
    parser.error("This frozen current-source VNDB cohort requires exactly 37 SAH units")
if args.vndb_sah_allocation_units is not None and args.dictionary != "vndb":
    parser.error("An explicit VNDB SAH allocation range requires --dictionary vndb")
try:
    vndb_sah_allocation_units = validate_vndb_sah_allocation_units(args.vndb_sah_allocation_units)
except ValueError as error:
    parser.error(str(error))

evidence = args.evidence.resolve()
evidence.mkdir(parents=True, exist_ok=False)
work = evidence.parent / (evidence.name + "-sources")
work.mkdir(exist_ok=False)
env = os.environ.copy()
env["MANABITAN_E2E_STRICT_RUNTIME"] = "1"
env["MANABITAN_CHROMIUM_ALLOW_HEADED_FALLBACK"] = "0"
os.environ["MANABITAN_E2E_STRICT_RUNTIME"] = "1"
os.environ["MANABITAN_CHROMIUM_ALLOW_HEADED_FALLBACK"] = "0"

def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")

def run(command, cwd, log, custom_env=None):
    started = time.time()
    with log.open("wb") as output:
        completed = subprocess.run(command, cwd=cwd, env=custom_env or env, stdout=output, stderr=subprocess.STDOUT)
    if completed.returncode:
        raise RuntimeError(f"Command failed ({completed.returncode}); see {log}")
    return time.time() - started

def git(*command, cwd=root):
    return subprocess.check_output(["git", *command], cwd=cwd, text=True).strip()

def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as data:
        for block in iter(lambda: data.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()

def package_entries(path):
    with zipfile.ZipFile(path) as package:
        names = [item.filename for item in package.infolist()]
        if len(names) != len(set(names)):
            raise RuntimeError(f"Duplicate package member names: {path}")
        return {
            item.filename: hashlib.sha256(package.read(item)).hexdigest()
            for item in package.infolist() if not item.is_dir()
        }

sources = {}
identities = {}
frozen_identities = {}
native_artifacts = {}
changes = screen.source_changes(args.baseline, args.candidate)
if sorted(item["path"] for item in changes) != sorted(args.expected_source_entry):
    raise RuntimeError(f"Unexpected source changes: {changes}")
write_json(evidence / "source-changes.json", changes)
required_same = (
    "package.json",
    "package-lock.json",
    ".github/actions/setup/action.yml",
    "test/perf/dictionaries.lock.json",
    "dev/perf/import-benchmark.js",
    "dev/perf/benchmark-support.js",
    "dev/perf/dictionary-fixtures.js",
    "test/chromium/extension-two-dictionary-import.e2e.js",
    "test/e2e/import-timing.js",
    "dev/perf/import-media-validation.js",
)
required_same = tuple(sorted(set(required_same).union(
    path for path in git("ls-tree", "-r", "--name-only", args.baseline, "test/e2e", "test/chromium", "dev/perf").splitlines()
    if path.endswith((".js", ".mjs", ".html"))
)))
provenance_paths = (
    "package-lock.json", "test/perf/dictionaries.lock.json", "dev/perf/benchmark-support.js",
    "dev/perf/dictionary-fixtures.js", "dev/perf/import-benchmark.js", "test/chromium/import-flags-ab-benchmark.js",
    "test/chromium/extension-two-dictionary-import.e2e.js", "test/e2e/import-timing.js",
    "ext/js/pages/settings/dictionary-import-controller.js", "builds/manabitan-chrome-dev.zip", "builds/manabitan-chrome.zip",
)
fixture = json.loads((root / "test/perf/dictionaries.lock.json").read_text())["dictionaries"][args.dictionary]
browser_binary = pathlib.Path(subprocess.check_output([
    "node", "--input-type=module", "-e", "import {chromium} from 'playwright'; process.stdout.write(chromium.executablePath())",
], cwd=root, text=True))
browser_text = subprocess.check_output([str(browser_binary), "--version"], text=True).strip()
browser_version = re.search(r"\d+\.\d+\.\d+\.\d+", browser_text).group(0)
write_json(evidence / "browser-identity.json", {"executable": str(browser_binary), "sha256": digest(browser_binary), "versionOutput": browser_text, "version": browser_version})
run(["node", "dev/perf/prepare-dictionaries.js", args.dictionary], root, evidence / "fixtures.log")
for label, sha in (("A", args.baseline), ("B", args.candidate)):
    target = work / label
    run(["git", "worktree", "add", "--detach", str(target), sha], root, evidence / f"worktree-{label}.log")
    for relative in required_same:
        if (target / relative).read_bytes() != (root / relative).read_bytes():
            raise RuntimeError(f"Source or harness differs: {label} {relative}")
    shutil.copytree(root / "node_modules", target / "node_modules", copy_function=os.link, symlinks=True)
    (target / "builds").mkdir(exist_ok=True)
    (target / "builds/e2e-dictionary-cache").symlink_to(root / "builds/e2e-dictionary-cache", target_is_directory=True)
    run(["npm", "run", "build:libs"], target, evidence / f"libs-{label}.log")
    run(["npm", "run", "build", "--", "--target", "chrome"], target, evidence / f"build-{label}.log")
    archive = target / "builds/manabitan-chrome.zip"
    frozen_identities[label] = screen.HELPER.identity(target, sha, args.dictionary)
    native_artifacts[label] = screen.native_artifact_receipt(target, frozen_identities[label])
    identities[label] = {
        "sha": git("rev-parse", "HEAD", cwd=target),
        "tree": git("rev-parse", "HEAD^{tree}", cwd=target),
        "packageSha256": digest(archive),
        "entries": package_entries(archive),
        "lockSha256": digest(target / "package-lock.json"),
        "fixtureLockSha256": digest(target / "test/perf/dictionaries.lock.json"),
        "sourceHashes": {path: digest(target / path) if (target / path).is_file() else None for path in provenance_paths},
    }
    if git("status", "--porcelain", cwd=target):
        raise RuntimeError(f"Unexpected source changes after building arm {label}")
    sources[label] = target
    shutil.copyfile(archive, evidence / f"package-{label}.zip")
if native_artifacts["A"]["buildControls"] != native_artifacts["B"]["buildControls"]:
    raise RuntimeError("Candidate changes native compiler/linker controls")
package_changes = screen.verify_package_changes(
    identities["A"]["entries"], identities["B"]["entries"],
    {"expectedPackageChanges": args.expected_package_entry,
     "expectedPackageAdditions": args.expected_package_addition},
)
write_json(evidence / "source-identities.json", {
    "arms": identities, "frozenIdentities": frozen_identities,
    "packageChanges": package_changes, "nativeArtifacts": native_artifacts,
    "sourceChanges": changes,
    "controlC": "Same A source, package, runtime, and flags under a distinct observation label",
})
if not package_changes["changed"] and not package_changes["added"]:
    raise RuntimeError("Candidate has no changed runtime package bytes")
screen.HELPER.emit("QUALIFICATION_IDENTITIES", {
    "sourceChanges": changes, "packageChanges": package_changes,
    "arms": {label: {key: value for key, value in value.items() if key not in ("entries",)}
             for label, value in identities.items()},
    "nativeArtifacts": native_artifacts,
})

def verify_identity(arm):
    if screen.HELPER.identity(sources[arm], identities[arm]["sha"], args.dictionary) != frozen_identities[arm]:
        raise RuntimeError(f"Frozen identity changed for {arm}")

def verify_memory_identity(arm, overlay, harness_path):
    target = sources[arm]
    status = subprocess.check_output(["git", "status", "--porcelain=v1", "-z"], cwd=target)
    if status != f" M {harness_path}\0".encode():
        raise RuntimeError(f"Memory observation has changes beyond its sole marker overlay: {arm}")
    if git("rev-parse", "HEAD", cwd=target) != identities[arm]["sha"]:
        raise RuntimeError(f"Memory observation source revision changed: {arm}")
    if (target / harness_path).read_text() != overlay:
        raise RuntimeError(f"Memory marker overlay changed: {arm}")
    if digest(target / "builds/manabitan-chrome.zip") != identities[arm]["packageSha256"]:
        raise RuntimeError(f"Memory observation package changed: {arm}")
    fixture_path = target / "builds/e2e-dictionary-cache" / fixture["cacheFile"]
    if digest(fixture_path) != frozen_identities[arm]["fixtureSha256"]:
        raise RuntimeError(f"Memory observation fixture changed: {arm}")

schedule = []
first = args.initial_order
opposite = first[::-1]
for pair, order in enumerate((first, opposite), 1):
    for arm in order:
        schedule.append({"id": f"warmup-{pair}-{arm}", "kind": "warmup", "pair": pair, "arm": arm})
for pair in range(1, args.pairs + 1):
    order = first if pair % 2 else opposite
    for arm in order:
        schedule.append({"id": f"pair-{pair:02d}-{arm}", "kind": "candidate", "pair": pair, "arm": arm})
    if pair % 3 == 0:
        control_pair = pair // 3
        control_order = "AC" if (control_pair + (first == "BA")) % 2 else "CA"
        for arm in control_order:
            schedule.append({"id": f"control-{control_pair:02d}-{arm}", "kind": "control", "pair": control_pair, "arm": arm})
write_json(evidence / "registered-plan.json", {
    "baseline": args.baseline, "candidate": args.candidate, "dictionary": args.dictionary,
    "initialOrder": first, "pairs": args.pairs, "flags": flags, "schedule": schedule,
    "mediaCheck": "sample per timed observation; separate all-media verification after timing",
    "failurePolicy": {
        "timingAndMedia": "Stop on first failure; retain all completed and failed evidence without replacements",
        "memory": "Retain all four prescribed observations including invalid samples; abort on source/package identity changes; no retries or replacements",
    },
    "memoryPolicy": "Separate instrumented A/B observations after all timing and media verification",
    "sourceBoundary": "Each revision built independently before timing; no product or harness overlays",
    "expectedPackageEntries": args.expected_package_entry,
    "expectedPackageAdditions": args.expected_package_addition,
    "expectedSourceChanges": args.expected_source_entry,
    "toolingSha": git("rev-parse", "HEAD"),
    "scriptSha256": digest(pathlib.Path(__file__).resolve()),
    "screenHelperSha256": digest(screen_path),
    "expectedWorkers": args.expected_workers,
    "vndbSahAllocationPolicy": {
        "unitBytes": SAH_ALLOCATION_UNIT_BYTES,
        "rangeUnits": vndb_sah_allocation_units,
        "origin": "explicit" if args.vndb_sah_allocation_units is not None else "legacy-default",
    } if args.dictionary == "vndb" else None,
    "memorySchedule": memory_schedule(1 if first == "AB" else 2),
    "statistics": "Per-host paired median and equal-work ratios; descriptive percentile bootstrap interval of paired median, 10000 complete-pair resamples, seed 88711027. No pooling hosts or timing from instrumented runs.",
})
screen.HELPER.emit("QUALIFICATION_PLAN", json.loads((evidence / "registered-plan.json").read_text()))
observations = []
reference = None

def validate_observation(output, arm, media_check="sample", overlay=None):
    summary = json.loads((output / "summary.json").read_text())
    report = json.loads((output / "run-1.json").read_text())
    identity = identities[arm]
    hashes = identity["sourceHashes"].copy()
    if overlay is not None:
        hashes["test/chromium/extension-two-dictionary-import.e2e.js"] = hashlib.sha256(overlay.encode()).hexdigest()
    receipt = validate_import_summary(
        summary, report, dictionary=args.dictionary, fixture=fixture,
        source_sha=identity["sha"], package_sha256=identity["packageSha256"],
        browser_version=browser_version, import_flags=flags if flags else None,
        source_hashes=hashes, source_dirty=overlay is not None, media_check=media_check,
        vndb_sah_allocation_units=vndb_sah_allocation_units,
    )
    if args.expected_workers is not None:
        actual = summary["runs"][0]["step4Breakdown"]["dictionaries"][0]["parserWorkerCount"]
        if actual != args.expected_workers:
            raise RuntimeError(f"Existing parser policy did not execute: expected {args.expected_workers}, observed {actual}")
    write_json(output / "canonical-receipt.json", receipt)
    return summary, receipt

for item in schedule:
    arm = "B" if item["arm"] == "B" else "A"
    verify_identity(arm)
    target = sources[arm]
    output = evidence / item["id"]
    output.mkdir()
    if digest(target / "builds/manabitan-chrome.zip") != identities["B" if item["arm"] == "B" else "A"]["packageSha256"]:
        raise RuntimeError("Package changed during cohort")
    run(["node", str(root / "dev/perf/host-environment.js")], root, output / "host-before.json")
    command = [
        "node", "dev/perf/import-benchmark.js", args.dictionary, "--runs", "1",
        "--no-build", "--build-target", "chrome", "--media-check", "sample", "--output", str(output),
    ]
    if flags:
        command.extend(("--flags", args.flags))
    run(command, target, output / "run.log")
    verify_identity(arm)
    result, receipt = validate_observation(output, arm)
    if reference is None:
        reference = receipt
    else:
        require_matching_receipts(reference, receipt)
    duration = result["runs"][0]["totalImportMs"]
    if not isinstance(duration, (int, float)) or not 0 < duration < float("inf"):
        raise RuntimeError("Invalid complete-import duration")
    lookup = result["runs"][0]["validation"]["lookup"]
    first_pass = [row for row in lookup["observations"] if row["pass"] == 0]
    warm = [row for row in lookup["observations"] if row["pass"] > 0]
    pair_order = first if item["pair"] % 2 else opposite
    if item["kind"] == "control":
        pair_order = "AC" if (item["pair"] + (first == "BA")) % 2 else "CA"
    observations.append({**item, "order": pair_order, "importMs": duration,
                         "workerMs": result["runs"][0]["workerImportMs"],
                         "firstLookupMs": first_pass[0]["elapsedMs"],
                         "firstPassLookupSumMs": sum(row["elapsedMs"] for row in first_pass),
                         "warmLookupMeanMs": statistics.mean(row["elapsedMs"] for row in warm),
                         "lookupObservations": [{key: row[key] for key in ("pass", "term", "elapsedMs")} for row in lookup["observations"]],
                         "storageBytes": receipt["common"]["validation"]["storage"]["bytes"],
                         "summarySha256": digest(output / "summary.json"),
                         "receiptSha256": digest(output / "canonical-receipt.json")})
    screen.HELPER.emit("QUALIFICATION_OBSERVATION", observations[-1])
    write_json(evidence / "observations.json", observations)
    run(["node", str(root / "dev/perf/host-environment.js")], root, output / "host-after.json")

full_media_reference = None
for arm in first:
    verify_identity(arm)
    target = sources[arm]
    output = evidence / f"exhaustive-media-{arm}"
    output.mkdir()
    command = [
        "node", "dev/perf/import-benchmark.js", args.dictionary, "--runs", "1",
        "--no-build", "--build-target", "chrome", "--media-check", "all", "--output", str(output),
    ]
    if flags:
        command.extend(("--flags", args.flags))
    run(command, target, output / "run.log")
    verify_identity(arm)
    _, receipt = validate_observation(output, arm, "all")
    screen.HELPER.emit("QUALIFICATION_MEDIA", {"arm": arm, "media": receipt["media"],
                                               "receiptSha256": digest(output / "canonical-receipt.json")})
    require_matching_receipts(reference, receipt, compare_media=False)
    if full_media_reference is None:
        full_media_reference = receipt
    else:
        require_matching_receipts(full_media_reference, receipt)

memory_root = evidence / "memory"
memory_root.mkdir()
replication = 1 if first == "AB" else 2
memory_plan = memory_schedule(replication)
harness_path = "test/chromium/extension-two-dictionary-import.e2e.js"
original_harness = (sources["A"] / harness_path).read_text()
instrumented_harness = memory_overlay(original_harness)
(memory_root / "harness-original.js").write_text(original_harness)
(memory_root / "harness-instrumented.js").write_text(instrumented_harness)
write_json(memory_root / "plan.json", {
    "schedule": memory_plan, "replication": replication, "dictionary": args.dictionary,
    "authoritativeTiming": False, "sourceHashes": identities,
    "overlaySha256": hashlib.sha256(instrumented_harness.encode()).hexdigest(),
})
memory_observations = []
semantic_failures = []
try:
    for target in sources.values():
        if (target / harness_path).read_text() != original_harness:
            raise RuntimeError("Memory harness overlay sources differ")
        (target / harness_path).write_text(instrumented_harness)
    for item in memory_plan:
        arm = item["arm"]
        target = sources[arm]
        output = memory_root / item["name"]
        output.mkdir()
        command = ["node", "dev/perf/import-benchmark.js", args.dictionary, "--runs", "1", "--no-build", "--build-target", "chrome", "--media-check", "sample", "--output", str(output)]
        if flags:
            command.extend(("--flags", args.flags))
        verify_memory_identity(arm, instrumented_harness, harness_path)
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
        verify_memory_identity(arm, instrumented_harness, harness_path)
        memory_observations.append({**item, **sampled})
        write_json(memory_root / "observations.json", memory_observations)
        try:
            _, receipt = validate_observation(output, arm, overlay=instrumented_harness)
            require_matching_receipts(reference, receipt)
        except Exception as failure:
            semantic_failures.append({"name": item["name"], "error": str(failure)})
        write_json(memory_root / "semantic-failures.json", semantic_failures)
finally:
    for target in sources.values():
        (target / harness_path).write_text(original_harness)
        if digest(target / "builds/manabitan-chrome.zip") != identities["B" if target == sources["B"] else "A"]["packageSha256"]:
            raise RuntimeError("Product package changed during memory acquisition")
        if git("status", "--porcelain", cwd=target):
            raise RuntimeError("Unexpected source changes after restoring memory harness")
        verify_identity("B" if target == sources["B"] else "A")
memory_result = memory_comparison(memory_observations, args.dictionary, replication, memory_schedule)
write_json(memory_root / "memory-comparison.json", memory_result)
audit_error = None
try:
    write_json(memory_root / "memory-audit.json", audit_cell(memory_root))
except Exception as failure:
    audit_error = {"type": type(failure).__name__, "message": str(failure)}
    write_json(memory_root / "memory-audit-failure.json", audit_error)

metrics = ("importMs", "workerMs", "firstLookupMs", "firstPassLookupSumMs", "warmLookupMeanMs")
analysis = {
    "status": "correctness-memory-passed" if memory_result["passesProspectiveMemoryScreen"] and not semantic_failures and audit_error is None else "memory-or-semantics-failed",
    "candidateComparisons": [screen.compare(observations, "A", "B", "candidate", key, 88711027) for key in metrics],
    "identicalCodeComparisons": [screen.compare(observations, "A", "C", "control", key, 88711027) for key in metrics],
    "memory": memory_result,
    "memoryAuditError": audit_error,
    "semanticFailures": semantic_failures,
    "memoryPassed": memory_result["passesProspectiveMemoryScreen"] and not semantic_failures and audit_error is None,
    "timingInterpretation": "Descriptive paired comparison only. A passing correctness/memory status is not a latency or speedup claim.",
    "timingScope": "File input change through post-UI completion; fresh profile per observation",
    "limits": "One host/cohort only; independent opposite-order replication required. Memory observations remain separate.",
}
write_json(evidence / "analysis.json", analysis)
screen.HELPER.emit("QUALIFICATION_SUMMARY", analysis)
if semantic_failures or audit_error is not None or not memory_result["passesProspectiveMemoryScreen"]:
    raise RuntimeError("Complete timing retained; separate memory/semantic qualification failed")
