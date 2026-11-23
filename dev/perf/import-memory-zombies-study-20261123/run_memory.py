#!/usr/bin/env python3
"""Separate four-observation memory study; no timing result is authoritative."""

import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import time
import zipfile

from chromium_memory import run_with_sampling


ROOT = Path(__file__).resolve().parents[3]
BASELINE = "1e235059a4c05c2509e8757fccba43a2d60222df"
CANDIDATE = "51f095912b11ddd158ac173698eb322e2be99d12"
EXPECTED_PACKAGE_DIFFERENCES = [
    "js/dictionary/term-bank-wasm-parser-worker.js",
    "js/dictionary/term-bank-wasm-parser.js",
]
OVERLAY = (
    "test/perf/dictionaries.lock.json",
    "dev/perf/dictionary-fixtures.js",
    "dev/perf/benchmark-support.js",
    "dev/perf/import-benchmark.js",
    "test/chromium/extension-two-dictionary-import.e2e.js",
)


def run(args, cwd=ROOT, output=None):
    if output is None:
        subprocess.run(args, cwd=cwd, check=True)
    else:
        with output.open("x") as stream:
            subprocess.run(args, cwd=cwd, stdout=stream, stderr=subprocess.STDOUT, check=True)


def text(args, cwd=ROOT):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def digest(filename):
    hasher = hashlib.sha256()
    with filename.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            hasher.update(chunk)
    return hasher.hexdigest()


def save(filename, value):
    # Every receipt is written once. Failed observations are never overwritten.
    with filename.open("x") as stream:
        stream.write(json.dumps(value, indent=2, sort_keys=True) + "\n")


def differences(a, b, location=""):
    if type(a) is not type(b):
        return [{"path": location, "baseline": a, "candidate": b}]
    if isinstance(a, dict):
        if a.keys() != b.keys():
            return [{"path": location, "baseline": a, "candidate": b}]
        return [item for key in a for item in differences(a[key], b[key], location + "/" + key)]
    if isinstance(a, list):
        if len(a) != len(b):
            return [{"path": location, "baseline": a, "candidate": b}]
        return [item for index, (x, y) in enumerate(zip(a, b))
                for item in differences(x, y, location + "/" + str(index))]
    return [] if a == b else [{"path": location, "baseline": a, "candidate": b}]


def verify_preview_counts(probes):
    for term in probes:
        for probe in term["probes"]:
            rows = probe["rowSample"]
            if probe["rowSampleCount"] != len(rows):
                raise ValueError("Physical probe row count mismatch")
            previews = [row["rawContentPreview"] for row in rows]
            if any(value is not None and not isinstance(value, str) for value in previews):
                raise ValueError("Invalid raw preview type")
            readable = sum(isinstance(value, str) and len(value) > 0 and
                           value not in ("<read-null>", "<read-failed>") for value in previews)
            if probe["readablePreviewRowCount"] != readable:
                raise ValueError("Raw preview count derivation mismatch")


def validate_readback(report, validation, fixture):
    if report["status"] != "success" or report["skippedVerification"] is not False:
        raise ValueError("Failed or skipped browser validation")
    if report["benchmark"]["validation"] != validation:
        raise ValueError("Summary and retained report validation differ")
    if (validation["title"] != fixture["expectedTitle"] or validation["revision"] != fixture["revision"] or
            validation["termRows"] != fixture["termRows"] or validation["contentReadable"] is not True or
            validation["probeCount"] < 12 or
            ("mediaRows" in fixture and validation["mediaRows"] != fixture["mediaRows"])):
        raise ValueError("Pinned fixture/readback mismatch")
    for state_name in ("preRestart", "postRestart"):
        state = report["benchmark"]["readbackDiagnostics"][state_name]
        if (state["physicalProbes"] != validation["physicalProbes"] or
                state["physicalDigestSha256"] != validation["outputDigestSha256"] or
                state["semanticProbes"] != validation["semanticProbes"] or
                state["semanticDigestSha256"] != validation["semanticDigestSha256"]):
            raise ValueError("Complete physical/semantic readback changed across restart")
        verify_preview_counts(state["physicalProbes"])
        semantic = state["semanticProbes"]
        if len(semantic) != validation["probeCount"] or [item["term"] for item in semantic] != validation["probeTerms"]:
            raise ValueError("Semantic probes do not match requested terms")
        for item in semantic:
            result = item["result"]
            if not result["dictionaryEntries"] or result.get("dictionaryAvailability"):
                raise ValueError("Empty or degraded semantic result")
        if sum(len(item["result"]["dictionaryEntries"]) for item in semantic) != validation["semanticProbeEntryCount"]:
            raise ValueError("Semantic entry count mismatch")


def verify_cross_arm(observations):
    validations = [item["validation"] for item in observations]
    for key in ("semanticDigestSha256", "outputDigestSha256"):
        if any(re.fullmatch(r"[0-9a-f]{64}", value[key]) is None for value in validations):
            raise ValueError("Invalid readback digest")
    semantic = validations[0]["semanticProbes"]
    if any(value["semanticProbes"] != semantic or
           value["semanticDigestSha256"] != validations[0]["semanticDigestSha256"] for value in validations):
        raise ValueError("Complete public semantic results changed between arms")
    physical = {}
    physical_digests = {}
    for arm in ("A", "B"):
        selected = [item["validation"] for item in observations if item["arm"] == arm]
        if len(selected) != 2:
            raise ValueError("Missing fixed memory observation")
        if any(item["physicalProbes"] != selected[0]["physicalProbes"] or
               item["outputDigestSha256"] != selected[0]["outputDigestSha256"] for item in selected):
            raise ValueError("Physical readback changed within the same package")
        physical[arm] = selected[0]["physicalProbes"]
        physical_digests[arm] = selected[0]["outputDigestSha256"]
    changes = differences(physical["A"], physical["B"])
    for change in changes:
        location = change["path"]
        if re.fullmatch(r"/\d+/probes/\d+/rowSample/\d+/(rawEntryContentOffset|rawContentPreview)", location):
            continue
        match = re.fullmatch(r"/(\d+)/probes/(\d+)/readablePreviewRowCount", location)
        if match:
            a = physical["A"][int(match[1])]["probes"][int(match[2])]
            b = physical["B"][int(match[1])]["probes"][int(match[2])]
            # Every counter was already recomputed from its own rows.
            if any(x["rawContentPreview"] != y["rawContentPreview"] for x, y in zip(a["rowSample"], b["rowSample"])):
                continue
        raise ValueError("Unexplained physical difference: " + location)
    return {"semanticDigestSha256": validations[0]["semanticDigestSha256"],
            "physicalDigests": physical_digests, "differences": changes}


def main():
    dictionary = os.environ["PERF_DICTIONARY"]
    replication = int(os.environ["PERF_REPLICATION"])
    if dictionary not in ("jmdict", "jitendex", "vndb") or replication not in (1, 2):
        raise ValueError("Unexpected corpus or replication")
    for commit in (BASELINE, CANDIDATE):
        run(["git", "cat-file", "-e", commit + "^{commit}"])
    evidence = ROOT / "builds/import-memory-zombies-study" / dictionary / str(replication)
    evidence.mkdir(parents=True, exist_ok=False)
    stage = Path(os.environ["RUNNER_TEMP"]) / f"import-memory-zombies-71149b-{dictionary}-{replication}"
    stage.mkdir(exist_ok=False)
    fixture = json.loads((ROOT / OVERLAY[0]).read_text())["dictionaries"][dictionary]
    overlay_hashes = {name: digest(ROOT / name) for name in OVERLAY}
    schedule = list("ABBA" if replication == 1 else "BAAB")
    plan = {
        "schemaVersion": 1, "authoritativeTiming": False,
        "observerRule": "stable-single-thread-zombie-esrch-v1",
        "scope": "Separate fixed Chromium PSS diagnostics with confirmed single-thread zombie exclusions; no timing claims",
        "baseline": BASELINE, "candidate": CANDIDATE,
        "harnessCommit": text(["git", "rev-parse", "HEAD"]),
        "harnessTree": text(["git", "rev-parse", "HEAD^{tree}"]),
        "node": text(["node", "--version"]), "host": platform.uname()._asdict(),
        "dictionary": dictionary, "fixture": fixture, "replication": replication,
        "schedule": schedule, "overlaidHarnessFiles": overlay_hashes,
        "studySourceHashes": {p.name: digest(p) for p in Path(__file__).parent.glob("*.py")},
        "expectedPackageDifferences": EXPECTED_PACKAGE_DIFFERENCES,
        "timingCaveat": "Unmodified quick-harness raw reports cannot detect external sampling. Their timer-authority labels do not apply to this memory study; all elapsed times are excluded from results.",
    }
    save(evidence / "plan.json", plan)
    run(["node", "--input-type=module", "-e", (
        "import {ensurePinnedDictionaryCache} from './dev/perf/dictionary-fixtures.js';"
        "await ensurePinnedDictionaryCache('builds/e2e-dictionary-cache',[process.argv[1]])"
    ), dictionary], output=evidence / "fixtures.log")
    archive = ROOT / "builds/e2e-dictionary-cache" / fixture["cacheFile"]
    if archive.stat().st_size != fixture["sizeBytes"] or digest(archive) != fixture["sha256"]:
        raise ValueError("Pinned archive mismatch")
    roots, packages, package_members = {}, {}, {}
    for arm, sha in (("A", BASELINE), ("B", CANDIDATE)):
        root = stage / arm
        run(["git", "worktree", "add", "--detach", str(root), sha])
        if (root / "package-lock.json").read_bytes() != (ROOT / "package-lock.json").read_bytes():
            raise ValueError("Dependency locks differ")
        for name in OVERLAY:
            shutil.copyfile(ROOT / name, root / name)
        (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        (root / "builds").mkdir(exist_ok=True)
        (root / "builds/e2e-dictionary-cache").symlink_to(ROOT / "builds/e2e-dictionary-cache", target_is_directory=True)
        run(["npm", "run", "build:libs"], root, evidence / f"{arm}-libs.log")
        run(["npm", "run", "build", "--", "--target", "chrome"], root, evidence / f"{arm}-build.log")
        package = root / "builds/manabitan-chrome.zip"
        packages[arm] = digest(package)
        with zipfile.ZipFile(package) as zipped:
            package_members[arm] = {name: hashlib.sha256(zipped.read(name)).hexdigest()
                                    for name in zipped.namelist() if not name.endswith("/")}
        save(evidence / f"{arm}-package-entries.json", package_members[arm])
        save(evidence / f"{arm}-identity.json", {"sourceCommit": sha, "sourceTree": text(["git", "rev-parse", "HEAD^{tree}"], root),
             "packageSha256": packages[arm], "statusWithHarnessOverlay": text(["git", "status", "--porcelain"], root)})
        roots[arm] = root
    changed = sorted(name for name in set(package_members["A"]) | set(package_members["B"])
                     if package_members["A"].get(name) != package_members["B"].get(name))
    save(evidence / "package-differences.json", changed)
    if changed != sorted(EXPECTED_PACKAGE_DIFFERENCES):
        raise ValueError("Unexpected packaged source differences")

    observations = []
    for index, arm in enumerate(schedule):
        output = evidence / f"memory-{index:02d}-{arm}"
        output.mkdir()
        root = roots[arm]
        sha = BASELINE if arm == "A" else CANDIDATE
        if (text(["git", "rev-parse", "HEAD"], root) != sha or
                digest(root / "builds/manabitan-chrome.zip") != packages[arm] or
                digest(archive) != fixture["sha256"] or
                {name: digest(root / name) for name in OVERLAY} != overlay_hashes):
            raise ValueError("Immutable inputs changed before diagnostic import")
        command = ["node", "dev/perf/import-benchmark.js", dictionary, "--runs", "1", "--no-build",
                   "--build-target", "chrome", "--output", str(output)]
        save(output / "identity.json", {"authoritativeTiming": False, "index": index, "arm": arm,
             "planSha256": digest(evidence / "plan.json"), "sourceCommit": sha,
             "sourceTree": text(["git", "rev-parse", "HEAD^{tree}"], root),
             "packageSha256": packages[arm], "fixtureSha256": fixture["sha256"],
             "overlaidHarnessFiles": overlay_hashes, "command": command,
             "startedAtEpochSeconds": time.time(), "loadAverage": os.getloadavg()})
        print(f"{dictionary} replication {replication}: memory {index + 1}/4 arm {arm}", flush=True)
        memory = run_with_sampling(command, root, output / "run.log", output / "chromium-memory.json")
        observation = {"index": index, "arm": arm, "authoritativeTiming": False, "memory": memory,
                       "sourceCommit": sha, "packageSha256": packages[arm], "validation": None, "failure": None}
        try:
            summary = json.loads((output / "summary.json").read_text())
            report = json.loads((output / "run-1.json").read_text())
            if summary["gitSha"] != sha or len(summary["runs"]) != 1:
                raise ValueError("Wrong source or run count")
            result = summary["runs"][0]
            if (result["packageSha256"] != packages[arm] or report["packageSha256"] != packages[arm] or
                    digest(root / "builds/manabitan-chrome.zip") != packages[arm] or
                    digest(archive) != fixture["sha256"]):
                raise ValueError("Package or archive identity changed")
            validate_readback(report, result["validation"], fixture)
            observation["validation"] = result["validation"]
        except (OSError, ValueError, KeyError, TypeError) as error:
            observation["failure"] = {"type": type(error).__name__, "message": str(error)}
        observation["receiptHashes"] = {p.name: digest(p) for p in output.iterdir()
                                         if p.is_file() and p.name != "observation.json"}
        save(output / "observation.json", observation)
        observations.append(observation)
    save(evidence / "observations.json", observations)
    failures = [f"observation-{item['index']}-unqualified" for item in observations
                if item["failure"] is not None or not item["memory"]["qualifiedForWholeTreePss"]]
    comparison = {"authoritativeTiming": False, "qualifiedMemoryMeasurement": False,
                  "qualificationFailures": failures, "schedule": schedule, "pairs": []}
    if not failures:
        try:
            save(evidence / "readback-comparison.json", verify_cross_arm(observations))
        except (ValueError, KeyError, TypeError) as error:
            failures.append("cross-arm-readback: " + str(error))
    if not failures:
        for start in (0, 2):
            pair = {item["arm"]: item for item in observations[start:start + 2]}
            metrics = {}
            for key in ("maxSampledPssKiB", "maxSampledPrivateKiB"):
                a, b = (pair[arm]["memory"][key] for arm in ("A", "B"))
                metrics[key] = {"baseline": a, "candidate": b, "changePercent": 100 * (b / a - 1) if a else None}
            comparison["pairs"].append({"indices": [start, start + 1], "metrics": metrics})
        comparison["qualifiedMemoryMeasurement"] = True
    save(evidence / "memory-comparison.json", comparison)
    print(json.dumps(comparison, indent=2), flush=True)
    if failures:
        raise RuntimeError("Memory study remains unqualified: " + "; ".join(failures))


if __name__ == "__main__":
    main()
