#!/usr/bin/env python3
"""Run one separate corrected physical/decoded-proof compression trial.

This is isolated qualification tooling, not extension product code. Timed runs use
production defaults, fresh profiles, and the repository's strict import verifier.
Memory sampling and exhaustive media verification run only after the timed plan.
The original qualification driver/receipt validator remain unchanged. This new
study accepts only the independently predicted content-file deltas and saves
raw physical receipts, additive decoded proofs and distinctly labeled logical comparison copies.
No original warmup, failed trial or observation is reused.
"""
import argparse
import hashlib
import json
import os
import pathlib
import random
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
parser.add_argument("--dictionary", required=True, choices=("jmdict", "jitendex"))
parser.add_argument("--initial-order", required=True, choices=("AB", "BA"))
parser.add_argument("--pairs", type=int, default=6)
parser.add_argument("--evidence", type=pathlib.Path, required=True)
parser.add_argument("--flags", default="{}")
parser.add_argument("--expected-workers", type=int)
parser.add_argument("--expected-package-entry", action="append", required=True)
args = parser.parse_args()
for value in (args.baseline, args.candidate):
    if re.fullmatch(r"[a-f0-9]{40}", value) is None:
        parser.error("Source IDs must be complete lowercase commit hashes")
if args.pairs != 6 or args.initial_order != "AB":
    parser.error("This separate correction has exactly six pairs with fixed initial order AB")
if args.expected_workers != 3:
    parser.error("This fixed study requires an observation assertion of exactly three parser workers")
flags = json.loads(args.flags)
if not isinstance(flags, dict):
    parser.error("Flags must be an object")

root = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / "dev/perf/import-memory-20261125-a7f7"))
from chromium_memory import run_with_sampling, summarize_import_window
from protocol import memory_overlay, memory_comparison, schedule as memory_schedule
from audit_memory import audit_cell
from qualification_receipts import validate_import_summary


sys.path.insert(0, str(root / "dev/perf/import-compression-level-20261128-1b47"))
import compression_receipts as original_storage_policy
sys.path.insert(0, str(root / "dev/perf/import-compression-proof-20261128-1b47"))
from compression_proof_receipts import (
    BASELINE_SHA, STORAGE_PREDICTION_BASELINE_SHA, PRODUCT_SOURCE_SHA,
    comparison_receipt, policy_manifest, require_matching_trial_receipts,
)
from compression_harness_overlay import ORIGINAL_HARNESS_SHA256, apply_overlay

# Freeze this new trial prospectively. These are study gates, never import flags.
if args.baseline != BASELINE_SHA:
    parser.error("Corrected compression trial common baseline must be the frozen dcfc02a0 source")
if flags:
    parser.error("Compression trial requires empty import flags and production defaults")
if args.expected_package_entry != ["js/dictionary/zstd-term-content.js"]:
    parser.error("Compression trial permits only the Zstd runtime package entry")
original_tooling_hashes = {
    "dev/perf/import-qualification-20261125-a7f7.py": "cad1b3fb25766cbd22a1c4260718a0b92353e87276751217ca18dc9eea29c6ef",
    "dev/perf/import-memory-20261125-a7f7/qualification_receipts.py": "4f7b4eee4f8ff71e821c9162e57524460c48f01f409487f638523a3a27aa8f51",
}
for relative, expected in original_tooling_hashes.items():
    if hashlib.sha256((root / relative).read_bytes()).hexdigest() != expected:
        parser.error(f"Original qualification tooling changed: {relative}")

previous_trial_tooling_hashes = {
    "dev/perf/import-compression-level-20261128-1b47.py": "7fe216453d56094cb94a2504915efcbc64e08b5a3c99be25ca206b435b094d98",
    "dev/perf/import-compression-level-20261128-1b47/compression_receipts.py": "7512dd8f4422fc01fe094eb49dcccc4a3f8a80cb9dbf8fc2e37b8b00e1f68bb8",
    "dev/perf/import-compression-level-20261128-1b47/test_compression_receipts.py": "ffc48b76a565eccb100fc0fa1a9f7d5f355b087bc6c6199ad2a58639ca47789d",
}
for relative, expected in previous_trial_tooling_hashes.items():
    if hashlib.sha256((root / relative).read_bytes()).hexdigest() != expected:
        parser.error(f"Original failed-trial tooling changed: {relative}")
frozen_product_blobs = {
    "ext/js/dictionary/zstd-term-content.js": "9a63ef28bcf862108c407c5636eb492009ba815f",
    "test/zstd-compression-worker-context.test.js": "c9b3006765f6ed3b51ba39622d5a370f46409bc0",
    "test/zstd-term-content-startup-overlap.test.js": "301c4ba0d8a0d1d1842479868ef44ffb878d9d49",
}
source_context = {
    "commonBaselineSha": BASELINE_SHA,
    "compressionProductOriginSha": PRODUCT_SOURCE_SHA,
    "historicalStoragePredictionBaselineSha": STORAGE_PREDICTION_BASELINE_SHA,
    "historicalPredictionRole": "Original 9e10 byte predictions remain fixed fail-closed predicates; no recalibration for the current common baseline",
    "productDeltaPaths": sorted(frozen_product_blobs),
    "supersededPreparation": "The unacquired 9e10 corrected preparation was preserved before choosing this current common baseline; no old observation or warmup is reused",
}
vndb_sah_allocation_units = None
harness_path = "test/chromium/extension-two-dictionary-import.e2e.js"
disposition_policy = {
    "scope": "One bounded correction; no further optimization variants, replacement cohorts, old-warmup reuse or pooling",
    "activeCorpora": ["jmdict", "jitendex"],
    "requiredBeforeAnyProvisionalDraft": "Both active-corpus semantic, exact-storage and memory gates qualify; at least one has candidate paired median and equal-work changes below zero, descriptive upper bound below zero, and both changes more favorable than the corresponding identical-code controls",
    "otherCorpus": "Reject a compression PR if its descriptive lower bound is above zero, or if at least five of six pairs are slower and both paired median and equal-work changes are above zero; otherwise retain all ambiguity",
    "reviewRuleScope": "Review triage, not statistical significance, merge readiness or a latency non-regression claim from semantic/memory success",
    "noControlSubtraction": True,
    "oldComponentReplayAloneJustifiesPr": False,
    "noQualifyingCorpus": "Close the compression mechanism without a product PR",
    "oneHostLimitation": "Even a qualifying result permits only a provisional draft review, not merge-ready evidence",
    "decisionOwner": "Parent review of both complete fixed cohorts; no automatic publication",
}

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

def require_registered_overlay(target, overlay):
    """Every observation admits only its exact registered harness modification."""
    if (target / harness_path).read_text() != overlay:
        raise RuntimeError("Observation harness differs from its exact registered overlay")
    if git("status", "--porcelain", cwd=target) != "M " + harness_path:
        # git() strips leading whitespace from the only expected ' M path' row.
        raise RuntimeError("Observation has an unregistered dirty or untracked path")
    if git("diff", "--name-only", cwd=target) != harness_path or git("diff", "--cached", "--name-only", cwd=target):
        raise RuntimeError("Observation dirty-path boundary differs from the registered harness only")

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
if git("diff", "--name-only", args.baseline, args.candidate, "--", "ext", "dev/data") != "ext/js/dictionary/zstd-term-content.js":
    raise RuntimeError("Corrected trial changes product/native assets beyond the exact compression runtime on the current common baseline")
if git("diff", "--name-only", STORAGE_PREDICTION_BASELINE_SHA, args.baseline, "--", *frozen_product_blobs):
    raise RuntimeError("Current common baseline changes the original compression runtime or its two expectation tests")
for relative, expected in frozen_product_blobs.items():
    if git("rev-parse", f"{args.candidate}:{relative}") != expected or git("rev-parse", f"{PRODUCT_SOURCE_SHA}:{relative}") != expected:
        raise RuntimeError(f"Original product/test blob changed: {relative}")
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
# The original Python qualification/memory gates also remain byte-identical.
required_same = tuple(sorted(set(required_same).union(original_tooling_hashes).union(
    path for path in git("ls-tree", "-r", "--name-only", args.baseline,
                        "dev/perf/import-memory-20261125-a7f7").splitlines()
    if path.endswith(".py")
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
    run(["npm", "run", "license-report:html"], target, evidence / f"license-{label}.log")
    run(["npm", "run", "build", "--", "--target", "chrome"], target, evidence / f"build-{label}.log")
    archive = target / "builds/manabitan-chrome.zip"
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
if identities["A"]["entries"].keys() != identities["B"]["entries"].keys():
    raise RuntimeError("Candidate changes the set of packaged files")
changed_entries = [
    name for name in identities["A"]["entries"]
    if identities["A"]["entries"][name] != identities["B"]["entries"][name]
]
tracked_original_harness = (sources["A"] / harness_path).read_text()
if hashlib.sha256(tracked_original_harness.encode()).hexdigest() != ORIGINAL_HARNESS_SHA256:
    raise RuntimeError("Original harness differs from the exact proof-overlay input")
proof_harness = apply_overlay(tracked_original_harness)
instrumented_harness = memory_overlay(proof_harness)
proof_overlay = {
    "path": harness_path,
    "originalSha256": ORIGINAL_HARNESS_SHA256,
    "proofSha256": hashlib.sha256(proof_harness.encode()).hexdigest(),
    "memorySha256": hashlib.sha256(instrumented_harness.encode()).hexdigest(),
    "allowedDirtyPaths": [harness_path],
    "symmetry": "Same proof source on A/B/C; memory markers compose on that same proof source",
    "boundary": "Additive physical/decoded evidence after the unchanged import endpoint; no product overlay",
}
proof_root = evidence / "proof-overlay"
proof_root.mkdir()
(proof_root / "harness-original.js").write_text(tracked_original_harness)
(proof_root / "harness-proof.js").write_text(proof_harness)
(proof_root / "harness-memory.js").write_text(instrumented_harness)
write_json(evidence / "source-identities.json", {
    "arms": identities, "changedPackageEntries": changed_entries,
    "controlC": "Same A source, package, runtime, and flags under a distinct observation label",
    "proofOverlay": proof_overlay,
    "sourceContext": source_context,
    "frozenProductBlobs": frozen_product_blobs,
})
if not changed_entries:
    raise RuntimeError("Candidate has no changed runtime package bytes")
if set(changed_entries) != set(args.expected_package_entry):
    raise RuntimeError(f"Unexpected packaged changes: {changed_entries}")
try:
    for target in sources.values():
        if (target / harness_path).read_text() != tracked_original_harness:
            raise RuntimeError("Original harness sources differ before symmetric proof overlay")
        (target / harness_path).write_text(proof_harness)
        require_registered_overlay(target, proof_harness)

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
        "failurePolicy": "Stop on first failed observation; retain all completed and failed evidence",
        "memoryPolicy": "Separate instrumented A/B observations after all timing and media verification",
        "sourceBoundary": "Products built independently before timing; the same registered additive proof-only harness overlay on A/B/C; registered memory markers compose on it. No product overlay or timer change.",
        "expectedPackageEntries": args.expected_package_entry,
        "storagePolicy": original_storage_policy.policy_manifest(args.dictionary),
        "compressionProofPolicy": policy_manifest(args.dictionary),
        "proofOverlay": proof_overlay,
        "sourceContext": source_context,
        "frozenProductBlobs": frozen_product_blobs,
        "previousTrialToolingSha256": previous_trial_tooling_hashes,
        "physicalStabilityPolicy": "Separate A-family and B raw receipt/proof anchors across warmup, measured, exhaustive-media and memory observations; media exception only at explicit sample/all boundary; full-media A/B compare remains exact",
        "dispositionPolicy": disposition_policy,
        "studyToolingSha256": {
            relative: digest(root / relative) for relative in (
                "dev/perf/import-compression-proof-20261128-1b47.py",
                "dev/perf/import-compression-proof-20261128-1b47/compression_proof_receipts.py",
                "dev/perf/import-compression-proof-20261128-1b47/test_compression_proof_receipts.py",
                "dev/perf/import-compression-proof-20261128-1b47/compression_harness_overlay.py",
                "dev/perf/import-compression-proof-20261128-1b47/test_compression_harness_overlay.py",
                "dev/perf/import-compression-proof-20261128-1b47/test_driver_boundaries.py",
                "dev/perf/import-compression-proof-20261128-1b47/audit_artifact.py",
                "dev/perf/import-compression-proof-20261128-1b47/test_audit_artifact.py",
                "dev/perf/import-compression-proof-20261128-1b47/README.md",
                ".github/workflows/compression-proof-screen-1b47.yml",
            )
        },
        "originalToolingSha256": original_tooling_hashes,
        "expectedWorkers": args.expected_workers,
        "vndbSahAllocationPolicy": None,
        "memorySchedule": memory_schedule(1 if first == "AB" else 2),
        "statistics": "Per-host paired median and equal-work ratios; descriptive percentile bootstrap interval of paired median, 10000 complete-pair resamples, seed 897. No pooling hosts or timing from instrumented runs.",
    })
    observations = []
    reference = None
    reference_arm = None
    reference_proof = None
    physical_references = {}

    def validate_observation(output, arm, media_check="sample", overlay=proof_harness, receipt_arm=None):
        summary = json.loads((output / "summary.json").read_text())
        report_path = pathlib.Path(summary["runs"][0]["reportJsonPath"])
        if report_path.resolve() != (output / "run-1.json").resolve():
            raise RuntimeError("Summary raw-report path differs from this observation's new output")
        report = json.loads(report_path.read_text())
        identity = identities[arm]
        hashes = identity["sourceHashes"].copy()
        if overlay is not None:
            hashes["test/chromium/extension-two-dictionary-import.e2e.js"] = hashlib.sha256(overlay.encode()).hexdigest()
        receipt = validate_import_summary(
            summary, report, dictionary=args.dictionary, fixture=fixture,
            source_sha=identity["sha"], package_sha256=identity["packageSha256"],
            browser_version=browser_version, import_flags=flags if flags else None,
            source_hashes=hashes, source_dirty=True, media_check=media_check,
            vndb_sah_allocation_units=vndb_sah_allocation_units,
        )
        if args.expected_workers is not None:
            actual = summary["runs"][0]["step4Breakdown"]["dictionaries"][0]["parserWorkerCount"]
            if actual != args.expected_workers:
                raise RuntimeError(f"Existing parser policy did not execute: expected {args.expected_workers}, observed {actual}")
        # Raw canonical receipts retain actual observed bytes. Comparison copies
        # are separate evidence and become accepted only after the strict matcher.
        write_json(output / "canonical-receipt.json", receipt)
        proof = report["benchmark"].get("compressionProof")
        write_json(output / "compression-proof.json", proof)
        policy_arm = receipt_arm or arm
        compared, adjustment = comparison_receipt(receipt, proof, dictionary=args.dictionary, arm=policy_arm)
        write_json(output / "comparison-receipt.json", compared)
        write_json(output / "compression-storage-policy.json", adjustment["originalStorageAudit"])
        write_json(output / "compression-proof-policy.json", adjustment)
        family = "B" if policy_arm == "B" else "A"
        if family in physical_references:
            anchor_receipt, anchor_proof, anchor_media = physical_references[family]
            require_matching_trial_receipts(anchor_receipt, receipt, dictionary=args.dictionary,
                reference_arm=family, candidate_arm=policy_arm, reference_proof=anchor_proof,
                candidate_proof=proof, compare_media=anchor_media == media_check)
        else:
            physical_references[family] = (receipt, proof, media_check)
        return summary, receipt, proof

    for item in schedule:
        arm = item["arm"]
        target = sources["B" if arm == "B" else "A"]
        output = evidence / item["id"]
        output.mkdir()
        require_registered_overlay(target, proof_harness)
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
        result, receipt, proof = validate_observation(output, "B" if arm == "B" else "A", receipt_arm=arm)
        if reference is None:
            reference = receipt
            reference_arm = arm
            reference_proof = proof
        else:
            require_matching_trial_receipts(reference, receipt, dictionary=args.dictionary,
                                            reference_arm=reference_arm, candidate_arm=arm,
                                            reference_proof=reference_proof, candidate_proof=proof)
        duration = result["runs"][0]["totalImportMs"]
        if not isinstance(duration, (int, float)) or not 0 < duration < float("inf"):
            raise RuntimeError("Invalid complete-import duration")
        observations.append({**item, "totalImportMs": duration})
        write_json(evidence / "observations.json", observations)
        run(["node", str(root / "dev/perf/host-environment.js")], root, output / "host-after.json")

    full_media_reference = None
    full_media_reference_arm = None
    full_media_reference_proof = None
    for arm in first:
        target = sources[arm]
        output = evidence / f"exhaustive-media-{arm}"
        output.mkdir()
        require_registered_overlay(target, proof_harness)
        command = [
            "node", "dev/perf/import-benchmark.js", args.dictionary, "--runs", "1",
            "--no-build", "--build-target", "chrome", "--media-check", "all", "--output", str(output),
        ]
        if flags:
            command.extend(("--flags", args.flags))
        run(command, target, output / "run.log")
        _, receipt, proof = validate_observation(output, arm, "all")
        require_matching_trial_receipts(reference, receipt, dictionary=args.dictionary,
                                        reference_arm=reference_arm, candidate_arm=arm, compare_media=False,
                                        reference_proof=reference_proof, candidate_proof=proof)
        if full_media_reference is None:
            full_media_reference = receipt
            full_media_reference_arm = arm
            full_media_reference_proof = proof
        else:
            require_matching_trial_receipts(full_media_reference, receipt, dictionary=args.dictionary,
                                            reference_arm=full_media_reference_arm, candidate_arm=arm,
                                            reference_proof=full_media_reference_proof, candidate_proof=proof)

    memory_root = evidence / "memory"
    memory_root.mkdir()
    replication = 1 if first == "AB" else 2
    memory_plan = memory_schedule(replication)
    (memory_root / "harness-original.js").write_text(proof_harness)
    (memory_root / "harness-instrumented.js").write_text(instrumented_harness)
    write_json(memory_root / "plan.json", {
        "schedule": memory_plan, "replication": replication, "dictionary": args.dictionary,
        "authoritativeTiming": False, "sourceHashes": identities,
        "overlaySha256": hashlib.sha256(instrumented_harness.encode()).hexdigest(),
        "baseHarnessKind": "registered compression-proof overlay",
        "proofOverlay": proof_overlay,
    })
    memory_observations = []
    semantic_failures = []
    try:
        for target in sources.values():
            require_registered_overlay(target, proof_harness)
            (target / harness_path).write_text(instrumented_harness)
        for item in memory_plan:
            arm = item["arm"]
            target = sources[arm]
            output = memory_root / item["name"]
            output.mkdir()
            require_registered_overlay(target, instrumented_harness)
            command = ["node", "dev/perf/import-benchmark.js", args.dictionary, "--runs", "1", "--no-build", "--build-target", "chrome", "--media-check", "sample", "--output", str(output)]
            if flags:
                command.extend(("--flags", args.flags))
            if digest(target / "builds/manabitan-chrome.zip") != identities[arm]["packageSha256"]:
                raise RuntimeError("Product package changed before memory observation")
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
            memory_observations.append({**item, **sampled})
            write_json(memory_root / "observations.json", memory_observations)
            try:
                _, receipt, proof = validate_observation(output, arm, overlay=instrumented_harness)
                require_matching_trial_receipts(reference, receipt, dictionary=args.dictionary,
                                                reference_arm=reference_arm, candidate_arm=arm,
                                                reference_proof=reference_proof, candidate_proof=proof)
            except Exception as failure:
                semantic_failures.append({"name": item["name"], "error": str(failure)})
            write_json(memory_root / "semantic-failures.json", semantic_failures)
    finally:
        for target in sources.values():
            (target / harness_path).write_text(proof_harness)
            if digest(target / "builds/manabitan-chrome.zip") != identities["B" if target == sources["B"] else "A"]["packageSha256"]:
                raise RuntimeError("Product package changed during memory acquisition")
            require_registered_overlay(target, proof_harness)
    memory_result = memory_comparison(memory_observations, args.dictionary, replication, memory_schedule)
    write_json(memory_root / "memory-comparison.json", memory_result)
    audit_error = None
    try:
        write_json(memory_root / "memory-audit.json", audit_cell(memory_root))
    except Exception as failure:
        audit_error = {"type": type(failure).__name__, "message": str(failure)}
        write_json(memory_root / "memory-audit-failure.json", audit_error)

    def paired_summary(kind, left, right):
        pairs = {}
        for item in observations:
            if item["kind"] == kind:
                pairs.setdefault(item["pair"], {})[item["arm"]] = item["totalImportMs"]
        complete = [values for values in pairs.values() if left in values and right in values]
        if len(complete) != len(pairs):
            raise RuntimeError("Incomplete paired observations")
        ratios = [values[right] / values[left] for values in complete]
        rng = random.Random(897)
        resampled = sorted(statistics.median(rng.choices(ratios, k=len(ratios))) for _ in range(10000))
        return {
            "count": len(complete), "ratios": ratios,
            "medianPairedChangePercent": (statistics.median(ratios) - 1) * 100,
            "equalWorkChangePercent": (sum(v[right] for v in complete) / sum(v[left] for v in complete) - 1) * 100,
            "worstPairChangePercent": (max(ratios) - 1) * 100,
            "descriptiveBootstrap95Percent": [(resampled[index] - 1) * 100 for index in (249, 9749)],
            "fasterPairs": sum(ratio < 1 for ratio in ratios),
        }
    write_json(evidence / "analysis.json", {
        "status": "correctness-memory-passed" if memory_result["passesProspectiveMemoryScreen"] and not semantic_failures and audit_error is None else "memory-or-semantics-failed",
        "candidateVsBaseline": paired_summary("candidate", "A", "B"),
        "identicalCodeControl": paired_summary("control", "A", "C") if args.pairs >= 3 else None,
        "memoryPassed": memory_result["passesProspectiveMemoryScreen"] and not semantic_failures and audit_error is None,
        "storagePolicy": original_storage_policy.policy_manifest(args.dictionary),
        "compressionProofPolicy": policy_manifest(args.dictionary),
        "dispositionPolicy": disposition_policy,
        "timingInterpretation": "Descriptive paired comparison with an explicitly quantified storage tradeoff. A passing correctness/memory status is not a latency or speedup claim.",
        "timingScope": "File input change through post-UI completion; fresh profile per observation",
        "limits": "One host per fixed corpus; no independent-host replication, replacement cohort or further variant. A qualifying result permits only provisional draft review. Memory observations remain separate.",
    })
    if semantic_failures or audit_error is not None or not memory_result["passesProspectiveMemoryScreen"]:
        raise RuntimeError("Complete timing retained; separate memory/semantic qualification failed")

finally:
    restoration = []
    restoration_errors = []
    for label, target in sources.items():
        try:
            (target / harness_path).write_text(tracked_original_harness)
            if digest(target / "builds/manabitan-chrome.zip") != identities[label]["packageSha256"]:
                raise RuntimeError("Product package changed during acquisition")
            if git("status", "--porcelain", cwd=target):
                raise RuntimeError("Unexpected source changes after restoring the original tracked harness")
            restoration.append({"arm": label, "originalHarnessSha256": digest(target / harness_path),
                                "trackedTreeClean": True, "packageBytesUnchanged": True})
        except Exception as failure:
            restoration_errors.append({"arm": label, "type": type(failure).__name__, "message": str(failure)})
    write_json(evidence / "overlay-restoration.json", {"observations": restoration, "errors": restoration_errors})
    if restoration_errors:
        raise RuntimeError("Registered overlay restoration failed; see overlay-restoration.json")
