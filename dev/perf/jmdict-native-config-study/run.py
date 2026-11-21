#!/usr/bin/env python3
"""Fixed, source-bound browser study. All work within a cell is sequential.

This diagnostic never changes product flags or retries an observation. It uses
the existing Chromium import harness and one official-Firefox observation helper.
The authoritative interval is measured inside the browser, not by this process.
"""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import random
import shutil
import signal
import statistics
import subprocess
import sys
import time
import zipfile


STUDY = Path(__file__).resolve().parent
ROOT = STUDY.parents[2]
MANIFEST = STUDY / "manifest.json"
STATE_NAME = "preparation.json"
ORDERS = ("ABCD", "BDAC", "CADB", "DCBA")


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def read(path):
    return json.loads(Path(path).read_text())


def git(*args, cwd=ROOT):
    return subprocess.check_output(["git", *args], cwd=cwd, text=True).strip()


def checked(condition, message):
    if not condition:
        raise RuntimeError(message)


def declared_comparisons(manifest):
    arms = manifest["arms"]
    sources = manifest["sources"]
    checked(set(arms) == set("ABCD") and arms["A"] == arms["C"] == "baseline",
            "A/C must be the same baseline source")
    checked(all(source in sources for source in arms.values()), "Undeclared arm source")
    baseline = sources["baseline"]
    for arm in ("B", "D"):
        source = sources[arms[arm]]
        checked(source["commit"] != baseline["commit"], "Candidate source must differ from baseline")
        checked(source["sourcePaths"] and source["packagePaths"], "Candidate must declare its source and package differences")
    expected = {"C/A": ["A", "C"]}
    left, right = sources[arms["B"]], sources[arms["D"]]
    if left["commit"] == right["commit"]:
        checked(left["tree"] == right["tree"] and left["sourcePaths"] == right["sourcePaths"] and
                left["packagePaths"] == right["packagePaths"],
                "Same candidate commit has inconsistent declarations")
        expected["D/B"] = ["B", "D"]
    expected.update({"B/A": ["A", "B"], "D/A": ["A", "D"]})
    checked(manifest["comparisonPairs"] == expected, "Comparisons do not match declared source controls")
    return expected


def clean_environment():
    prefixes = ("MANABITAN_E2E_", "MANABITAN_CHROMIUM_", "MANABITAN_FIREFOX_", "MANABITAN_AB_")
    return {key: value for key, value in os.environ.items() if not key.startswith(prefixes)}


def command(label, argv, cwd, evidence, timeout=180, extra_env=None, required=True):
    directory = evidence / "commands" / label
    directory.mkdir(parents=True, exist_ok=False)
    receipt = {"command": list(map(str, argv)), "cwd": str(cwd), "startedAt": time.time(),
               "timeoutSeconds": timeout, "complete": False, "environmentOverrides": extra_env or {}}
    save(directory / "command.json", receipt)
    env = clean_environment()
    env.update(extra_env or {})
    process = None
    print(json.dumps({"start": label}), flush=True)
    try:
        with (directory / "stdout.log").open("wb") as out, (directory / "stderr.log").open("wb") as err:
            process = subprocess.Popen(list(map(str, argv)), cwd=cwd, env=env,
                                       stdout=out, stderr=err, start_new_session=True)
            try:
                receipt["exitCode"] = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                receipt["timedOut"] = True
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=10)
                receipt["exitCode"] = process.returncode
        receipt["complete"] = receipt["exitCode"] == 0 and not receipt.get("timedOut", False)
    except Exception as error:
        receipt["error"] = str(error)
    finally:
        if process is not None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        receipt["completedAt"] = time.time()
        receipt["elapsedSeconds"] = receipt["completedAt"] - receipt["startedAt"]
        save(directory / "command.json", receipt)
    print(json.dumps({"end": label, "complete": receipt["complete"], "exitCode": receipt.get("exitCode")}), flush=True)
    if required:
        checked(receipt["complete"], f"{label} failed: {directory / 'command.json'}")
    return receipt


def package_entries(filename):
    with zipfile.ZipFile(filename) as archive:
        checked(archive.testzip() is None, "Package CRC failed")
        return {entry.filename: hashlib.sha256(archive.read(entry)).hexdigest()
                for entry in archive.infolist() if not entry.is_dir()}


def host():
    result = {"capturedAt": time.time(), "loadAverage": os.getloadavg(), "platform": sys.platform}
    for name in ("cpu.max", "memory.max", "memory.current"):
        path = Path("/sys/fs/cgroup") / name
        result[name] = path.read_text().strip() if path.exists() else None
    result["meminfo"] = Path("/proc/meminfo").read_text() if Path("/proc/meminfo").exists() else None
    return result


def verify_harness(manifest):
    for name, expected in manifest["harnessSha256"].items():
        checked(digest(ROOT / name) == expected, f"Changed harness input: {name}")
    checked(git("rev-parse", "HEAD") == os.environ["GITHUB_SHA"], "Unexpected study checkout")
    checked(os.environ["GITHUB_REF"] == "refs/heads/" + manifest["branch"], "Unexpected study branch")
    checked(sys.platform == "linux", "Linux runner required")


def verify_arm(arm, manifest):
    root = Path(arm["root"])
    checked(git("rev-parse", "HEAD", cwd=root) == arm["commit"], "Changed product commit")
    checked(git("rev-parse", "HEAD^{tree}", cwd=root) == arm["tree"], "Changed product tree")
    changed = set(git("diff", "HEAD", "--name-only", cwd=root).splitlines())
    checked(changed <= {"ext/legal-npm.html"}, "Changed tracked product files")
    checked(digest(arm["package"]) == arm["packageSha256"], "Changed built package")
    for name, expected in arm["frozenFiles"].items():
        checked(digest(root / name) == expected, f"Changed product input: {name}")
    for name, expected in manifest["sharedProductInputs"].items():
        checked(digest(root / name) == expected, f"Changed shared input: {name}")


def prepare(args, manifest, evidence):
    checked(not (evidence / STATE_NAME).exists(), "Preparation already exists; use a fresh evidence directory")
    state = {"complete": False, "manifestSha256": digest(MANIFEST), "diagnosticCommit": os.environ["GITHUB_SHA"],
             "browser": args.browser, "replication": args.replication, "dictionary": args.dictionary,
             "hostBefore": host(), "arms": {}, "startedAt": time.time()}
    save(evidence / STATE_NAME, state)
    verify_harness(manifest)
    shutil.copy2(MANIFEST, evidence / "manifest.json")
    shutil.copy2(Path(__file__), evidence / "driver.py")
    shutil.copy2(ROOT / manifest["workflow"], evidence / "workflow.yml")
    for name in manifest["harnessSha256"]:
        destination = evidence / "tooling" / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / name, destination)
    bundle = STUDY / manifest["bundle"]["file"]
    checked(digest(bundle) == manifest["bundle"]["sha256"], "Changed candidate bundle")
    command("verify-source-bundle", ["git", "bundle", "verify", bundle], ROOT, evidence)
    command("import-source-bundle", ["git", "fetch", "--no-write-fetch-head", bundle,
                                    *manifest["bundle"]["refs"]], ROOT, evidence)
    command("prepare-fixtures", ["node", "dev/perf/prepare-dictionaries.js"], ROOT, evidence)
    lock = read(ROOT / "test/perf/dictionaries.lock.json")
    fixture = lock["dictionaries"][args.dictionary]
    cache = ROOT / "builds/e2e-dictionary-cache"
    for entry in lock["dictionaries"].values():
        archive = cache / entry["cacheFile"]
        checked(archive.stat().st_size == entry["sizeBytes"] and digest(archive) == entry["sha256"], "Fixture identity mismatch")
    state["fixture"] = fixture
    state["cache"] = str(cache)
    state["node"] = subprocess.check_output(["node", "--version"], text=True).strip()
    checked(state["node"] == manifest["node"], "Unexpected Node version")
    target = "chrome" if args.browser == "chromium" else "firefox-dev"
    worktrees = Path(os.environ["RUNNER_TEMP"]) / f"jmdict-native-config-study-{args.browser}-{args.replication}"
    worktrees.mkdir(parents=True, exist_ok=False)
    entries = {}
    for arm_id, source_name in manifest["arms"].items():
        source = manifest["sources"][source_name]
        root = worktrees / arm_id
        command(f"worktree-{arm_id}", ["git", "worktree", "add", "--detach", root, source["commit"]], ROOT, evidence)
        checked(git("rev-parse", "HEAD^{tree}", cwd=root) == source["tree"], "Wrong source tree")
        changes = git("diff", "--name-only", manifest["sources"]["baseline"]["commit"], source["commit"]).splitlines()
        checked(sorted(changes) == sorted(source["sourcePaths"]), "Unexpected tracked source difference")
        (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        (root / "builds").mkdir(exist_ok=True)
        (root / "builds/e2e-dictionary-cache").symlink_to(cache, target_is_directory=True)
        # The Firefox measurement helper is the sole untracked harness overlay.
        firefox_helper = "test/firefox/jmdict-import-observation.js"
        shutil.copy2(ROOT / firefox_helper, root / firefox_helper)
        command(f"libraries-{arm_id}", ["npm", "run", "build:libs"], root, evidence, timeout=300)
        shutil.copy2(ROOT / "ext/legal-npm.html", root / "ext/legal-npm.html")
        command(f"package-{arm_id}", ["node", "dev/bin/build.js", "--target", target], root, evidence, timeout=300)
        package = root / f"builds/manabitan-{target}.zip"
        entries[arm_id] = package_entries(package)
        frozen_paths = set(source["sourcePaths"]) | set(manifest["sharedProductInputs"]) | {
            "ext/js/dictionary/wasm/term-content-canonical-scan-v1.c",
            "dev/data/dictionary-wasm/manifest.json", "dev/data/dictionary-wasm/term-bank-parser.wasm",
            "dev/data/dictionary-wasm/term-content-canonical-scan-v1.wasm", "ext/lib/term-bank-parser.wasm",
            "ext/lib/term-content-canonical-scan-v1.wasm", "ext/legal-npm.html", firefox_helper}
        frozen = {name: digest(root / name) for name in sorted(frozen_paths)}
        state["arms"][arm_id] = {"source": source_name, "root": str(root), "commit": source["commit"],
                                 "tree": source["tree"], "package": str(package), "buildTarget": target,
                                 "expectedInitialPrefetchFileCount": source["expectedInitialPrefetchFileCount"],
                                 "packageSha256": digest(package), "frozenFiles": frozen,
                                 "commonGeneratedOverlay": {"ext/legal-npm.html": digest(root / "ext/legal-npm.html")}}
        verify_arm(state["arms"][arm_id], manifest)
        save(evidence / f"{arm_id}-package-entries.json", entries[arm_id])
        save(evidence / STATE_NAME, state)
    checked(entries["A"] == entries["C"], "Baseline controls have different package contents")
    if "D/B" in declared_comparisons(manifest):
        checked(entries["B"] == entries["D"], "Candidate controls have different package contents")
    for arm_id in ("B", "D"):
        source = manifest["sources"][manifest["arms"][arm_id]]
        changed = sorted(name for name in entries["A"].keys() | entries[arm_id].keys()
                         if entries["A"].get(name) != entries[arm_id].get(name))
        expected = sorted(source["packagePaths"])
        checked(changed == expected, f"Unexpected packaged product differences for {arm_id}: {changed}")
        state["arms"][arm_id]["changedPackageEntries"] = changed
    if args.browser == "firefox":
        receipt_path = Path(os.environ["MANABITAN_STUDY_FIREFOX_RUNTIME_RECEIPT"])
        checked(digest(receipt_path) == manifest["browserRuntimes"]["firefox"]["receiptSha256"], "Unexpected Firefox runtime receipt")
        shutil.copy2(receipt_path, evidence / "firefox-runtime.json")
        shutil.copy2(receipt_path.with_name("source-artifact.json"), evidence / "firefox-runtime-source-artifact.json")
        runtime = read(receipt_path)
        binary = Path(os.environ["MANABITAN_STUDY_FIREFOX_BINARY"])
        checked(digest(binary) == runtime["binarySha256"], "Firefox executable differs from frozen bootstrap")
        checked(runtime.get("officialMozillaBuild") is True, "Official Mozilla runtime required")
        state["browserRuntime"] = runtime
        state["firefoxBinary"] = str(binary)
        state["geckodriver"] = os.environ["MANABITAN_STUDY_GECKODRIVER"]
        state["geckodriverSha256"] = digest(state["geckodriver"])
        checked(state["geckodriverSha256"] == runtime["geckodriver"]["binarySha256"], "Unexpected geckodriver binary")
    else:
        executable = subprocess.check_output(["node", "--input-type=module", "-e",
                    "import {chromium} from 'playwright'; console.log(chromium.executablePath())"], cwd=ROOT, text=True).strip()
        state["browserRuntime"] = {"binary": executable, "binarySha256": digest(executable),
                                   "version": subprocess.check_output([executable, "--version"], text=True).strip()}
    checked(state["browserRuntime"]["binarySha256"] == manifest["browserRuntimes"][args.browser]["binarySha256"],
            "Runtime binary differs from the predeclared study runtime")
    state["complete"] = True
    state["completedAt"] = time.time()
    state["hostAfter"] = host()
    save(evidence / STATE_NAME, state)


def extract_summary(summary, arm, state, browser):
    if browser == "firefox":
        checked(summary.get("schemaVersion") == 1 and summary.get("completed") is True,
                "Incomplete Firefox observation")
        checked(summary.get("authoritativeTiming") is True and summary.get("skippedVerification") is False,
                "Incomplete Firefox verification")
        checked(summary.get("error") is None and summary.get("cleanupErrors") == [], "Firefox or cleanup error")
        source = summary.get("source", {})
        checked(source.get("commit") == arm["commit"] and source.get("tree") == arm["tree"], "Wrong observed source")
        checked(source.get("packageLockSha256") == arm["frozenFiles"]["package-lock.json"], "Wrong dependency lock")
        checked(source.get("commonGeneratedOverlay") == arm["commonGeneratedOverlay"], "Wrong generated legal page")
        checked(summary.get("package", {}).get("sha256") == arm["packageSha256"], "Wrong observed package")
        fixture = summary.get("fixture", {})
        checked(all(fixture.get(key) == value for key, value in state["fixture"].items()), "Wrong observed fixture")
        checked(fixture.get("lockSha256") == arm["frozenFiles"]["test/perf/dictionaries.lock.json"], "Wrong fixture lock")
        runtime = summary.get("runtime", {})
        checked(runtime.get("binarySha256") == state["browserRuntime"]["binarySha256"], "Unexpected Firefox binary")
        checked(runtime.get("geckodriverSha256") == state["geckodriverSha256"], "Unexpected geckodriver")
        checked(runtime.get("headless") is False, "Expected the fixed headed Firefox configuration")
        validation = summary.get("validation", {})
        checked(validation.get("termRows") == state["fixture"]["termRows"] and validation.get("probeCount") == 12,
                "Incorrect Firefox row or probe count")
        checked(validation.get("contentReadable") is True and validation.get("extensionReloadVerified") is True,
                "Firefox content or extension persistence failed")
        for key in ("semanticDigest", "storageSampleDigest"):
            checked(isinstance(validation.get(key), str) and len(validation[key]) == 64, "Missing Firefox digest")
        checked(summary.get("browser", {}).get("freshProfile") is True, "Firefox profile was not fresh")
        result = {"totalImportMs": summary.get("totalImportMs"), "browserVersion": summary.get("browser", {}).get("version"),
                  "workerImportMs": summary.get("workerImportMs"), "importDebug": summary.get("importResult", {}).get("debug"),
                  "validation": validation, "productionEnvironment": summary.get("productionEnvironment"),
                  "largestParserWasmHeapBytes": summary.get("largestParserWasmHeapBytes")}
    else:
        checked(summary.get("schemaVersion") == 3 and summary.get("dictionary") == state["dictionary"], "Wrong dictionary or schema")
        checked(summary.get("authoritativeTiming") is True and summary.get("traceEnabled") is False, "Non-authoritative observation")
        checked(summary.get("importFlags") is None, "Unexpected import flags")
        checked(summary.get("gitSha") == arm["commit"], "Wrong observed source")
        checked(summary.get("fixture") == state["fixture"], "Wrong observed fixture")
        checked(summary.get("buildTarget") == arm["buildTarget"], "Wrong build target")
        checked(len(summary.get("runs", [])) == 1, "Expected exactly one import")
        run = summary["runs"][0]
        checked(run.get("packageSha256") == arm["packageSha256"], "Wrong observed package")
        validation = run.get("validation", {})
        checked(validation.get("title") == state["fixture"]["expectedTitle"] and
                validation.get("revision") == state["fixture"]["revision"] and
                validation.get("termRows") == state["fixture"]["termRows"] and
                validation.get("contentReadable") is True and validation.get("probeCount") == 12,
                "Incomplete Chromium content verification")
        restart = validation.get("restart", {})
        checked(restart.get("termRows") == state["fixture"]["termRows"] and restart.get("contentReadable") is True
                and restart.get("probeCount") == 12, "Incomplete Chromium restart verification")
        checked(isinstance(validation.get("outputDigestSha256"), str) and len(validation["outputDigestSha256"]) == 64,
                "Missing Chromium content digest")
        result = {"totalImportMs": run.get("totalImportMs"), "browserVersion": summary.get("browserVersion"),
                  "workerImportMs": run.get("workerImportMs"), "importDebug": run.get("importDebug"), "validation": validation}
    elapsed = result["totalImportMs"]
    checked(type(elapsed) in (int, float) and math.isfinite(elapsed) and elapsed > 0, "Invalid elapsed time")
    checked(isinstance(result["browserVersion"], str) and result["browserVersion"], "Missing browser version")
    result["executedPath"] = validate_executed_path(result["importDebug"], arm, state["fixture"])
    return result


def validate_executed_path(debug, arm, fixture):
    checked(isinstance(debug, dict) and debug.get("usesFallbackStorage") is False and
            debug.get("openStorageDiagnostics", {}).get("mode") == "opfs-sahpool", "Expected native OPFS storage")
    phases = debug.get("importerPhaseTimings", [])
    terms = [phase for phase in phases if phase.get("phase", "").startswith("term-file")]
    checked(terms and all(phase["phase"].startswith("term-file-fast-path:") for phase in terms), "Expected native term-file path")
    for key, expected in {"rows": fixture["termRows"], "parserSourceCompressedBytes": 15_574_114,
                          "parserSourceTransferredBytes": 15_574_114, "parserSourceUncompressedBytes": 171_092_992}.items():
        checked(sum(phase.get("details", {}).get(key, 0) for phase in terms) == expected, f"Wrong executed path: {key}")
    for phase in terms:
        details = phase["details"]
        for key in ("parserFusedFallbacks", "dedupNativeFallbackCount", "parserDiscardedFusedRows"):
            checked(details.get(key) == 0, f"Unexpected fallback: {key}")
        expected_prefetch = arm["expectedInitialPrefetchFileCount"]
        checked(details.get("sourceInitialPrefetchFileCount") == expected_prefetch, "Expected prefetch path was not executed")
        checked(details.get("sourceInitialPrefetchEstimatedBytes") == (3_226_520 if expected_prefetch else 0),
                "Unexpected prefetch byte estimate")
    finalizations = [phase.get("details", {}) for phase in phases if phase.get("phase") == "bulk-finalization"]
    checked(len(finalizations) == 1 and finalizations[0].get("ok") is True and finalizations[0].get("published") is True
            and finalizations[0].get("housekeepingErrors") == [], "Import did not publish cleanly")
    return {"termFilePhases": len(terms), "sourceInitialPrefetchFileCount": arm["expectedInitialPrefetchFileCount"],
            "largestParserWasmHeapBytes": max(phase["details"].get("parserMaxWasmHeapBytes", 0) for phase in terms)}


def statistics_for(pairs):
    ratios = [100 * (candidate / baseline - 1) for baseline, candidate in pairs]
    rng = random.Random(20261119)
    bootstrap = sorted(statistics.median(rng.choices(ratios, k=len(ratios))) for _ in range(10000))
    return {"pairs": len(pairs), "pairedChangesPercent": ratios,
            "medianPairedChangePercent": statistics.median(ratios),
            "equalWorkChangePercent": 100 * (sum(b for a, b in pairs) / sum(a for a, b in pairs) - 1),
            "fasterPairs": sum(b < a for a, b in pairs), "worstPairPercent": max(ratios),
            "descriptiveBootstrap95Percent": [bootstrap[250], bootstrap[9749]]}


def comparisons_for(rows, blocks, comparisons):
    return {label: statistics_for([(rows[(block, baseline)]["totalImportMs"], rows[(block, candidate)]["totalImportMs"])
                                   for block in range(blocks)])
            for label, (baseline, candidate) in comparisons.items()}


def build_schedule(manifest, replication):
    schedule = []
    for warmup in range(manifest["warmupsPerArm"]):
        order = "ABCD" if warmup % 2 == 0 else "DCBA"
        if replication == "reverse":
            order = order[::-1]
        schedule.extend({"label": f"warmup-{warmup + 1}-{arm}", "arm": arm, "warmup": True, "block": warmup} for arm in order)
    for block in range(manifest["blocks"]):
        order = ORDERS[block % len(ORDERS)]
        if replication == "reverse":
            order = order[::-1]
        schedule.extend({"label": f"block-{block + 1:02d}-{arm}", "arm": arm, "warmup": False, "block": block} for arm in order)
    return schedule


def measure(args, manifest, evidence):
    state = read(evidence / STATE_NAME)
    checked(state["complete"] and state["manifestSha256"] == digest(MANIFEST), "Incomplete or changed preparation")
    checked((state["browser"], state["replication"], state["dictionary"]) == (args.browser, args.replication, args.dictionary), "Changed cell")
    checked(not (evidence / "cohort.json").exists(), "Never append to or overwrite an attempted cohort")
    verify_harness(manifest)
    schedule = build_schedule(manifest, args.replication)
    cohort = {"complete": False, "browser": args.browser, "replication": args.replication,
              "dictionary": args.dictionary, "manifestSha256": digest(MANIFEST), "planned": schedule,
              "observations": [], "failures": [], "startedAt": time.time(),
              "boundary": "page file-input change to post-UI import-complete event",
              "policy": "No retries or dropped tails. Warmup failure aborts before timing; timed failures invalidate the fixed cohort."}
    save(evidence / "cohort.json", cohort)
    deadline = time.monotonic() + manifest["measurementDeadlineMinutes"] * 60
    versions = set()
    for item in schedule:
        if deadline - time.monotonic() < 30:
            cohort["failures"].append("Declared measurement deadline reached; remaining observations were not started")
            break
        if not item["warmup"] and any(o.get("error") for o in cohort["observations"] if o["warmup"]):
            cohort["failures"].append("At least one warmup failed; the timing cohort was not started")
            break
        arm = state["arms"][item["arm"]]
        directory = evidence / "observations" / item["label"]
        directory.mkdir(parents=True, exist_ok=False)
        observation = {**item, "directory": str(directory.relative_to(evidence)), "hostBefore": host()}
        try:
            verify_arm(arm, manifest)
            if args.browser == "chromium":
                checked(digest(state["browserRuntime"]["binary"]) == state["browserRuntime"]["binarySha256"], "Changed Chromium runtime")
                argv = ["node", "dev/perf/import-benchmark.js", args.dictionary, "--runs", "1", "--no-build",
                        "--build-target", "chrome", "--output", str(directory)]
                overrides = {}
            else:
                checked(digest(state["firefoxBinary"]) == state["browserRuntime"]["binarySha256"], "Changed Firefox runtime")
                checked(digest(state["geckodriver"]) == state["geckodriverSha256"], "Changed geckodriver")
                argv = ["node", "test/firefox/jmdict-import-observation.js"]
                overrides = {"MANABITAN_STUDY_SOURCE_ROOT": arm["root"], "MANABITAN_STUDY_CACHE_DIR": state["cache"],
                             "MANABITAN_STUDY_OUTPUT_DIR": str(directory), "MANABITAN_STUDY_PACKAGE": arm["package"],
                             "MANABITAN_STUDY_PACKAGE_SHA256": arm["packageSha256"], "MANABITAN_STUDY_SOURCE_SHA": arm["commit"],
                             "MANABITAN_STUDY_LEGAL_SHA256": arm["commonGeneratedOverlay"]["ext/legal-npm.html"],
                             "MANABITAN_STUDY_DICTIONARY": args.dictionary, "MANABITAN_STUDY_FIREFOX_BINARY": state["firefoxBinary"],
                             "MANABITAN_STUDY_GECKODRIVER": state["geckodriver"]}
            receipt = command(item["label"], argv, Path(arm["root"]), evidence,
                              timeout=min(manifest["observationTimeoutSeconds"], int(deadline - time.monotonic())), extra_env=overrides, required=False)
            observation["command"] = str((evidence / "commands" / item["label"] / "command.json").relative_to(evidence))
            checked(receipt["complete"], "Observation process failed; retained complete logs and original output")
            result = extract_summary(read(directory / "summary.json"), arm, state, args.browser)
            observation.update(result)
            versions.add(result["browserVersion"])
            verify_arm(arm, manifest)
            runtime_binary = state["firefoxBinary"] if args.browser == "firefox" else state["browserRuntime"]["binary"]
            checked(digest(runtime_binary) == state["browserRuntime"]["binarySha256"], "Browser runtime changed during observation")
        except Exception as error:
            observation["error"] = str(error)
            cohort["failures"].append({"label": item["label"], "error": str(error)})
        observation["hostAfter"] = host()
        cohort["observations"].append(observation)
        save(evidence / "cohort.json", cohort)
        print(json.dumps({"observation": item["label"], "ms": observation.get("totalImportMs"), "error": observation.get("error")}), flush=True)
    if len(versions) != 1:
        cohort["failures"].append("Observations do not share one browser version")
    digest_keys = ("semanticDigest", "storageSampleDigest") if args.browser == "firefox" else ("outputDigestSha256",)
    for key in digest_keys:
        observed = {o["validation"][key] for o in cohort["observations"] if not o.get("error")}
        if len(observed) != 1:
            cohort["failures"].append(f"Cross-arm content verification differs: {key}")
    cohort["complete"] = not cohort["failures"] and len(cohort["observations"]) == len(schedule)
    cohort["completedAt"] = time.time()
    if cohort["complete"]:
        rows = {(o["block"], o["arm"]): o for o in cohort["observations"] if not o["warmup"]}
        cohort["statistics"] = comparisons_for(rows, manifest["blocks"], declared_comparisons(manifest))
        cohort["statisticsNote"] = manifest["interpretation"]["control"] + ". " + manifest["interpretation"]["comparisons"]
    save(evidence / "cohort.json", cohort)
    checked(cohort["complete"], "Study incomplete or failed; all attempted observations remain in cohort.json")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("prepare", "measure", "validate-plan"))
    parser.add_argument("--browser", choices=("chromium", "firefox"), default="chromium")
    parser.add_argument("--replication", choices=("forward", "reverse"), default="forward")
    parser.add_argument("--dictionary", default="jmdict")
    parser.add_argument("--evidence", type=Path)
    args = parser.parse_args()
    manifest = read(MANIFEST)
    checked(args.dictionary == manifest["dictionary"] == "jmdict", "This protocol fixes the JMdict workload")
    checked(manifest["blocks"] > 0 and manifest["blocks"] % 4 == 0, "Blocks must balance four-arm order")
    declared_comparisons(manifest)
    if args.phase == "validate-plan":
        for name, expected in manifest["harnessSha256"].items():
            checked(digest(ROOT / name) == expected, f"Changed input: {name}")
        checked(digest(STUDY / manifest["bundle"]["file"]) == manifest["bundle"]["sha256"], "Changed bundle")
        print(json.dumps({"valid": True, "blocks": manifest["blocks"], "timedObservationsPerCell": 4 * manifest["blocks"]}))
        return
    checked(args.evidence is not None, "--evidence is required")
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    (prepare if args.phase == "prepare" else measure)(args, manifest, evidence)


if __name__ == "__main__":
    main()
