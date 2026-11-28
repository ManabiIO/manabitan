#!/usr/bin/env python3
"""Run a frozen exploratory import screen with identical-code controls.

This screen can reject an unpromising candidate. It is not release qualification:
there is no process-memory sampling, no exhaustive media acquisition, and no
speedup declaration. Confirmation requires a separate prospective acquisition.
"""

import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import random
import re
import shutil
import statistics
import subprocess
import traceback


ROOT = pathlib.Path(__file__).resolve().parents[2]
HELPER_PATH = ROOT / "dev/perf/import-investigation-20261127-88711ca9.py"
SPEC = importlib.util.spec_from_file_location("frozen_import_diagnostics", HELPER_PATH)
HELPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPER)


def load_config(path):
    config = json.loads(path.read_text())
    expected_keys = {"schemaVersion", "baselineSha", "dictionary", "pairs", "controlEvery", "warmupPairs",
                     "initialOrders", "expectedParserWorkers", "bootstrapSeed", "candidates"}
    if set(config) != expected_keys or type(config["schemaVersion"]) is not int or config["schemaVersion"] != 1:
        raise ValueError("Unexpected screen configuration fields or schema")
    if re.fullmatch(r"[a-f0-9]{40}", config["baselineSha"] or "") is None:
        raise ValueError("Baseline must be a frozen full commit SHA")
    if (config["dictionary"] != "jmdict" or config["pairs"] != 6 or
            config["controlEvery"] != 3 or config["warmupPairs"] != 2 or
            config["initialOrders"] != ["AB", "BA"] or config["expectedParserWorkers"] != 3 or
            type(config["bootstrapSeed"]) is not int):
        raise ValueError("This prospective screen is fixed to the six-pair JMdict protocol")
    if not isinstance(config["candidates"], list) or not config["candidates"]:
        raise ValueError("At least one fully frozen candidate is required")
    seen = set()
    for candidate in config["candidates"]:
        if set(candidate) != {"id", "sha", "expectedSourceChanges", "expectedPackageChanges", "expectedPackageAdditions"}:
            raise ValueError("Unexpected candidate fields")
        name = candidate["id"]
        if re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name or "") is None or name in seen:
            raise ValueError("Candidate IDs must be unique safe identifiers")
        seen.add(name)
        if re.fullmatch(r"[a-f0-9]{40}", candidate["sha"] or "") is None or candidate["sha"] == config["baselineSha"]:
            raise ValueError(f"Candidate {name} needs its final distinct full commit SHA before acquisition")
        for field in ("expectedSourceChanges", "expectedPackageChanges", "expectedPackageAdditions"):
            paths = candidate[field]
            if (not isinstance(paths, list) or (field != "expectedPackageAdditions" and not paths) or
                    any(not isinstance(item, str) or not item or item.startswith("/") or ".." in pathlib.PurePosixPath(item).parts for item in paths) or
                    len(paths) != len(set(paths))):
                raise ValueError(f"Candidate {name} needs an exact valid path list for {field}")
        if set(candidate["expectedPackageChanges"]) & set(candidate["expectedPackageAdditions"]):
            raise ValueError("Changed and added package members must be disjoint")
    return config


def schedule(config, initial_order):
    opposite = initial_order[::-1]
    result = []
    for pair in range(1, config["warmupPairs"] + 1):
        order = initial_order if pair % 2 else opposite
        result.extend({"id": f"warmup-{pair}-{arm}", "kind": "warmup", "pair": pair, "arm": arm, "order": order} for arm in order)
    for pair in range(1, config["pairs"] + 1):
        order = initial_order if pair % 2 else opposite
        result.extend({"id": f"pair-{pair:02d}-{arm}", "kind": "candidate", "pair": pair, "arm": arm, "order": order} for arm in order)
        if pair % config["controlEvery"] == 0:
            control_pair = pair // config["controlEvery"]
            control_order = "AC" if (control_pair + (initial_order == "BA")) % 2 else "CA"
            result.extend({"id": f"control-{control_pair:02d}-{arm}", "kind": "control", "pair": control_pair,
                           "arm": arm, "order": control_order} for arm in control_order)
    return result


def run(command, source, log, timeout=600):
    with log.open("wb") as output:
        result = subprocess.run(command, cwd=source, stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
    if result.returncode:
        print(log.read_text(errors="replace")[-16000:], flush=True)
        raise RuntimeError(f"Command failed ({result.returncode}); original log retained at {log}")


def prepare_source(label, sha, work, evidence, dictionary):
    target = work / label
    run(["git", "worktree", "add", "--detach", str(target), sha], ROOT, evidence / f"worktree-{label}.log")
    same_paths = ["package.json", "package-lock.json", "test/perf/dictionaries.lock.json", ".github/actions/setup/action.yml"]
    same_paths.extend(path for path in HELPER.git(ROOT, "ls-tree", "-r", "--name-only", sha, "dev/perf", "test/e2e", "test/chromium").splitlines()
                      if path.endswith((".js", ".mjs", ".html")))
    for relative in same_paths:
        if (ROOT / relative).read_bytes() != (target / relative).read_bytes():
            raise RuntimeError(f"The frozen product uses a different harness or lock: {label} {relative}")
    shutil.copytree(ROOT / "node_modules", target / "node_modules", copy_function=os.link, symlinks=True)
    (target / "builds").mkdir(exist_ok=True)
    (target / "builds/e2e-dictionary-cache").symlink_to(ROOT / "builds/e2e-dictionary-cache", target_is_directory=True)
    run(["npm", "run", "build:libs"], target, evidence / f"libraries-{label}.log")
    run(["npm", "run", "build", "--", "--target", "chrome"], target, evidence / f"build-{label}.log")
    return target, HELPER.identity(target, sha, dictionary)


def source_changes(baseline, candidate):
    fields = subprocess.check_output(["git", "diff", "--name-status", "--no-renames", "-z", baseline, candidate], cwd=ROOT).decode().split("\0")
    if fields[-1] != "" or (len(fields) - 1) % 2:
        raise RuntimeError("Unexpected source diff encoding")
    return [{"status": fields[index], "path": fields[index + 1]} for index in range(0, len(fields) - 1, 2)]


def verify_package_changes(left, right, candidate):
    removed = sorted(left.keys() - right.keys())
    added = sorted(right.keys() - left.keys())
    changed = sorted(path for path in left.keys() & right.keys() if left[path] != right[path])
    if removed or added != sorted(candidate["expectedPackageAdditions"]) or changed != sorted(candidate["expectedPackageChanges"]):
        raise RuntimeError(f"Unexpected package differences: changed={changed} added={added} removed={removed}")
    return {"changed": changed, "added": added, "removed": removed}


def native_artifact_receipt(source, frozen):
    manifest_path = source / "dev/data/dictionary-wasm/manifest.json"
    manifest = json.loads(manifest_path.read_text())
    files = sorted(path for path in (source / "ext/js/dictionary/wasm").rglob("*")
                   if path.is_file() and path.suffix.lower() in (".c", ".h"))
    source_hash = hashlib.sha256()
    for path in files:
        if path.is_symlink():
            raise RuntimeError("Linked native source is unsupported")
        source_hash.update(f"{path.relative_to(source).as_posix()}\0{HELPER.digest(path)}\n".encode())
    if source_hash.hexdigest() != manifest["sourceDigest"] or len(files) != manifest["sourceFileCount"]:
        raise RuntimeError("Native manifest does not bind the complete C/header source")
    targets = []
    controls = []
    for target in manifest["targets"]:
        checked_in = source / "dev/data/dictionary-wasm" / target["name"]
        package_path = "lib/" + target["name"]
        sha = HELPER.digest(checked_in)
        if sha != target["sha256"] or frozen["packageMembers"].get(package_path) != sha:
            raise RuntimeError("Packaged native module differs from its checked-in artifact or manifest")
        targets.append({"name": target["name"], "bytes": checked_in.stat().st_size, "sha256": sha, "packagePath": package_path})
        controls.append({key: value for key, value in target.items() if key != "sha256"})
    return {
        "manifestSha256": HELPER.digest(manifest_path),
        "sourceDigest": source_hash.hexdigest(),
        "sourceFileCount": len(files),
        "targets": targets,
        "buildControls": {"format": manifest["format"], "toolchain": manifest["toolchain"], "targets": controls},
    }


def check_receipts(reference, receipt, expected_workers):
    if receipt["lookupReceipts"] != reference["lookupReceipts"]:
        raise RuntimeError("Persisted lookup result hashes differ from the reference")
    if receipt["normalizedStorage"] != reference["normalizedStorage"]:
        raise RuntimeError("Exact normalized persisted storage differs from the reference")
    if receipt["validation"] != reference["validation"]:
        # Raw storage contains intentionally random UUID/opaque names; only
        # those names are normalized. Every other semantic field stays exact.
        baseline = {key: value for key, value in reference["validation"].items() if key != "storage"}
        candidate = {key: value for key, value in receipt["validation"].items() if key != "storage"}
        if baseline != candidate:
            raise RuntimeError("Row, restart, media or complete validation receipt differs")
    phases = [item for item in receipt["importerPhases"] if item["phase"].startswith("term-file-fast-path:")]
    if len(phases) != 1 or phases[0]["counters"].get("parserParallelWorkerCount") != expected_workers:
        raise RuntimeError("Unexpected production parser worker policy")


def acquire(source, frozen, dictionary, evidence, observation):
    if HELPER.identity(source, frozen["sourceSha"], dictionary) != frozen:
        raise RuntimeError("Frozen identity changed before observation")
    output = evidence / observation["id"]
    run(["node", "dev/perf/import-benchmark.js", dictionary, "--runs", "1", "--no-build", "--build-target", "chrome",
         "--media-check", "sample", "--output", str(output)], source, evidence / (observation["id"] + ".log"), timeout=900)
    if HELPER.identity(source, frozen["sourceSha"], dictionary) != frozen:
        raise RuntimeError("Frozen identity changed during observation")
    summary_path = output / "summary.json"
    summary = json.loads(summary_path.read_text())
    receipt = HELPER.summarize_observation(summary, frozen, False, "sample")
    HELPER.write_json(output / "screen-receipt.json", receipt)
    lookup = summary["runs"][0]["validation"]["lookup"]
    if receipt["workerImportMs"] is None:
        raise RuntimeError("Missing worker import timing")
    lookups = lookup["observations"]
    first = [item for item in lookups if item["pass"] == 0]
    warm = [item for item in lookups if item["pass"] > 0]
    result = {
        **observation,
        "dictionary": dictionary,
        "sourceSha": frozen["sourceSha"],
        "packageSha256": frozen["packageSha256"],
        "summarySha256": HELPER.digest(summary_path),
        "receiptSha256": HELPER.digest(output / "screen-receipt.json"),
        "lookupReceiptSha256": receipt["lookupReceiptSha256"],
        "storageBytes": receipt["normalizedStorage"]["bytes"],
        "importMs": receipt["totalImportMs"],
        "workerMs": receipt["workerImportMs"],
        "lookupBoundary": lookup["timingBoundary"],
        "firstLookupMs": first[0]["elapsedMs"],
        "firstLookupTerm": first[0]["term"],
        "firstPassLookupSumMs": sum(item["elapsedMs"] for item in first),
        "firstPassLookupMeanMs": statistics.mean(item["elapsedMs"] for item in first),
        "warmLookupMeanMs": statistics.mean(item["elapsedMs"] for item in warm),
        "lookupObservations": [{key: item[key] for key in ("pass", "term", "elapsedMs")} for item in lookups],
    }
    return receipt, result


def percentile(values, probability):
    ordered = sorted(values)
    index = (len(ordered) - 1) * probability
    lower = int(index)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower)


def compare(rows, left_arm, right_arm, kind, key, seed):
    pairs = {}
    for row in rows:
        if row["kind"] == kind:
            pairs.setdefault(row["pair"], {})[row["arm"]] = row
    changes = []
    absolute = []
    left_sum = 0.0
    right_sum = 0.0
    by_order = {}
    right_faster = 0
    for pair, arms in sorted(pairs.items()):
        left = arms[left_arm][key]
        right = arms[right_arm][key]
        left_sum += left
        right_sum += right
        absolute.append(right - left)
        right_faster += right < left
        change = (right / left - 1) * 100 if left > 0 else None
        changes.append(change)
        by_order.setdefault(arms[left_arm]["order"], []).append(change)
    valid = bool(changes) and all(value is not None for value in changes)
    interval = None
    if valid and len(changes) >= 3:
        rng = random.Random(seed)
        draws = [statistics.median(rng.choices(changes, k=len(changes))) for _ in range(10000)]
        interval = [percentile(draws, 0.025), percentile(draws, 0.975)]
    return {
        "metric": key,
        "leftArm": left_arm,
        "rightArm": right_arm,
        "pairs": len(changes),
        "pairedChangesPercent": changes,
        "pairedAbsoluteChangesMs": absolute,
        "medianPairedPercent": statistics.median(changes) if valid else None,
        "medianPairedMs": statistics.median(absolute),
        "descriptiveBootstrap95Percent": interval,
        "equalWorkPercent": (right_sum / left_sum - 1) * 100 if left_sum > 0 else None,
        "rightFasterPairs": right_faster,
        "byOrderPercent": by_order,
        "interpretation": "Negative means the right arm is faster; exploratory descriptive statistics, not a release speedup claim",
    }


def execute(config, candidate, initial_order, work, evidence, config_path):
    evidence.mkdir(parents=True, exist_ok=False)
    work.mkdir(parents=True, exist_ok=False)
    plan = {
        "config": config,
        "configSha256": HELPER.digest(config_path),
        "toolingSha": HELPER.git(ROOT, "rev-parse", "HEAD"),
        "scriptSha256": HELPER.digest(pathlib.Path(__file__).resolve()),
        "identityHelperSha256": HELPER.digest(HELPER_PATH),
        "candidate": candidate,
        "initialOrder": initial_order,
        "schedule": schedule(config, initial_order),
        "controlC": "The exact A checkout and package, imported into a fresh browser profile",
        "scope": "Exploratory screen only; no process-memory measurements, exhaustive-media qualification, or claimed speedup",
        "failurePolicy": "Stop on the first failure, retain all failed/completed observations; no replacement observations",
    }
    HELPER.write_json(evidence / "registered-plan.json", plan)
    HELPER.emit("SCREEN_PLAN", plan)
    rows = []
    current_observation = None
    try:
        sources = {}
        identities = {}
        for label, sha in (("A", config["baselineSha"]), ("B", candidate["sha"])):
            run(["git", "fetch", "--no-tags", "--depth", "1", "origin", sha], ROOT, evidence / f"fetch-{label}.log")
        changes = source_changes(config["baselineSha"], candidate["sha"])
        if sorted(item["path"] for item in changes) != sorted(candidate["expectedSourceChanges"]):
            raise RuntimeError(f"Candidate differs from its exact expected source paths: {changes}")
        HELPER.write_json(evidence / "source-changes.json", changes)
        native_artifacts = {}
        for label, sha in (("A", config["baselineSha"]), ("B", candidate["sha"])):
            sources[label], identities[label] = prepare_source(label, sha, work, evidence, config["dictionary"])
            native_artifacts[label] = native_artifact_receipt(sources[label], identities[label])
        if native_artifacts["A"]["buildControls"] != native_artifacts["B"]["buildControls"]:
            raise RuntimeError("Candidate changes native compiler/linker controls or native source lists")
        left, right = (identities[label]["packageMembers"] for label in ("A", "B"))
        package_changes = verify_package_changes(left, right, candidate)
        HELPER.write_json(evidence / "identities.json", {"arms": identities, "packageChanges": package_changes,
                                                        "sourceChanges": changes, "nativeArtifacts": native_artifacts})
        HELPER.emit("SCREEN_IDENTITIES", {"packageChanges": package_changes, "sourceChanges": changes, "nativeArtifacts": native_artifacts,
                                          "arms": {label: {key: value for key, value in frozen.items() if key != "packageMembers"}
                                                   for label, frozen in identities.items()}})
        reference = None
        for observation in plan["schedule"]:
            current_observation = observation
            arm = "A" if observation["arm"] == "C" else observation["arm"]
            receipt, row = acquire(sources[arm], identities[arm], config["dictionary"], evidence, observation)
            if reference is None:
                reference = receipt
            check_receipts(reference, receipt, config["expectedParserWorkers"])
            rows.append(row)
            HELPER.write_json(evidence / "observations.json", rows)
            HELPER.emit("SCREEN_OBSERVATION", row)
        metrics = ("importMs", "workerMs", "firstLookupMs", "firstPassLookupSumMs", "warmLookupMeanMs")
        result = {
            "status": "screen-complete",
            "scope": plan["scope"],
            "candidate": candidate["id"],
            "initialOrder": initial_order,
            "observations": len(rows),
            "timedCandidatePairs": config["pairs"],
            "identicalControlPairs": config["pairs"] // config["controlEvery"],
            "candidateComparisons": [compare(rows, "A", "B", "candidate", key, config["bootstrapSeed"]) for key in metrics],
            "identicalCodeComparisons": [compare(rows, "A", "C", "control", key, config["bootstrapSeed"]) for key in metrics],
        }
        HELPER.write_json(evidence / "screen-summary.json", result)
        HELPER.emit("SCREEN_SUMMARY", result)
    except Exception as error:
        failure = {"error": str(error), "completedObservations": len(rows), "observation": current_observation,
                   "traceback": traceback.format_exc()}
        HELPER.write_json(evidence / "failure.json", failure)
        HELPER.emit("SCREEN_FAILURE", failure)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=pathlib.Path, required=True)
    parser.add_argument("--matrix", action="store_true")
    parser.add_argument("--candidate")
    parser.add_argument("--initial-order", choices=("AB", "BA"))
    parser.add_argument("--work", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path)
    args = parser.parse_args()
    config = load_config(args.config)
    if args.matrix:
        print("matrix=" + json.dumps({"include": [{"candidate": item["id"], "order": order}
                                                   for item in config["candidates"] for order in config["initialOrders"]]}, separators=(",", ":")))
        return
    if not all((args.candidate, args.initial_order, args.work, args.output)):
        parser.error("Acquisition needs candidate, order, work and output arguments")
    candidates = [item for item in config["candidates"] if item["id"] == args.candidate]
    if len(candidates) != 1:
        parser.error("Candidate ID is absent from the frozen configuration")
    execute(config, candidates[0], args.initial_order, args.work.resolve(), args.output.resolve(), args.config.resolve())


if __name__ == "__main__":
    main()
