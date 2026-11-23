#!/usr/bin/env python3
"""Separate fixed Chromium memory diagnostics; no elapsed time is authoritative."""

import argparse
import errno
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shutil
import statistics
import time


ROOT = Path(__file__).resolve().parents[2]
CONFIG = Path(__file__).with_suffix(".json")
OBSERVER = ROOT / "dev/perf/import-r2-memory-observer-20261123.py"
QUALIFICATION = ROOT / "dev/perf/import-r2-qualification-20261123.py"
STUDY_FILES = (
    "dev/perf/import-r2-memory-20261123.py",
    "dev/perf/import-r2-memory-20261123.json",
    "dev/perf/import-r2-memory-observer-20261123.py",
    "dev/perf/import-r2-qualification-20261123.py",
    "test/import-r2-memory-20261123.test.py",
    "test/import-r2-memory-observer-20261123.test.py",
    ".github/workflows/import-r2-memory-20261123.yml",
)
OBSERVER_SHA256 = "ca6c0f7761062761697a810d4bd0007ff0257bbce69099df45657ffdb7ee8f10"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


common = load_module("memory_qualification_helpers", QUALIFICATION)
observer = load_module("memory_observer", OBSERVER)
require = common.require
file_digest = common.file_digest
write_json = common.write_json


def schedule(replication):
    require(replication in (1, 2), "Unknown memory replication")
    return [{"index": i, "arm": arm, "name": f"memory-{i + 1:02d}-{arm}"}
            for i, arm in enumerate("ABBA" if replication == 1 else "BAAB")]


def validate_config(config, case_id):
    common.validate_config(config, case_id)
    require(set(config["cases"]) == {f"transfer-{d}" for d in ("jmdict", "jitendex", "vndb")}, "Unexpected memory cases")
    require(len({case["sha"] for case in config["cases"].values()}) == 1, "Memory candidates differ by corpus")
    for key, case in config["cases"].items():
        common.validate_config(config, key)
        require(key == "transfer-" + case["dictionary"], "Case/dictionary mismatch")
        require(sorted(case["packageDifferences"]) == ["js/dictionary/term-bank-wasm-parser.js", "js/dictionary/term-record-opfs-store.js"], "Unexpected transfer package delta")
    require(config["orders"] == {"1": "ABBA", "2": "BAAB"}, "Frozen memory schedule changed")
    require(config["observer"] == {
        "sourceCommit": "00da5cb2ec28211dd6d09d938dc6cf1e3a4334c9",
        "sourcePath": "dev/perf/import-memory-zombies-study-20261123/chromium_memory.py",
        "sha256": OBSERVER_SHA256,
    }, "Observer provenance changed")
    require(file_digest(OBSERVER) == OBSERVER_SHA256, "Observer must remain byte-identical to the reviewed source")


def source_hashes():
    return {name: file_digest(ROOT / name) for name in STUDY_FILES}


def prepare(config, case_id, replication, output, sources):
    validate_config(config, case_id)
    require(not (output / "preparation.json").exists(), "Preparation already exists")
    output.mkdir(parents=True, exist_ok=True)
    write_json(output / "config.json", config)
    write_json(output / "schedule.json", schedule(replication))
    case = config["cases"][case_id]
    dictionary = case["dictionary"]
    node = shutil.which("node")
    require(node is not None and common.capture([node, "--version"]) == "v22.22.0", "Node 22.22.0 is required")
    require(os.environ.get("CI") == "true", "Strict CI browser runtime is required")
    overlay = common.overlay_contents(config, dictionary)
    for name, data in overlay.items():
        target = output / "overlay" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    sources.mkdir(parents=True, exist_ok=True)
    roots = {"A": sources / "baseline", "B": sources / "candidate"}
    shas = {"A": config["baseline"], "B": case["sha"]}
    for arm, root in roots.items():
        require(not root.exists(), "Memory source root already exists")
        common.command(["git", "worktree", "add", "--detach", str(root), shas[arm]], ROOT, output / f"checkout-{arm}.log")
        for name in ("package-lock.json", "test/perf/dictionaries.lock.json"):
            require((root / name).read_bytes() == (ROOT / name).read_bytes(), f"Original lock differs: {name}")
        for name, data in overlay.items():
            (root / name).write_bytes(data)
        (root / "node_modules").symlink_to((ROOT / "node_modules").resolve(), target_is_directory=True)
        common.command(["npm", "run", "build:libs"], root, output / f"libraries-{arm}.log")
        common.command(["npm", "run", "license-report:html"], root, output / f"licenses-{arm}.log")
        common.command([node, "dev/bin/build.js", "--target", "chrome"], root, output / f"package-{arm}.log")
    common.command([node, "dev/perf/prepare-dictionaries.js"], roots["A"], output / "fixtures.log", timeout=600)
    lock = json.loads((roots["A"] / "test/perf/dictionaries.lock.json").read_text())
    fixtures = {}
    for key, fixture in lock["dictionaries"].items():
        archive = roots["A"] / "builds/e2e-dictionary-cache" / fixture["cacheFile"]
        require(archive.stat().st_size == fixture["sizeBytes"] and file_digest(archive) == fixture["sha256"], f"Fixture integrity mismatch: {key}")
        fixtures[key] = {"sizeBytes": archive.stat().st_size, "sha256": file_digest(archive)}
        target = roots["B"] / "builds/e2e-dictionary-cache" / fixture["cacheFile"]
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(archive, target)
        except OSError as error:
            if error.errno != errno.EXDEV:
                raise
            shutil.copyfile(archive, target)
    entries = {arm: common.package_entries(root / common.PACKAGE) for arm, root in roots.items()}
    for arm, value in entries.items():
        write_json(output / f"package-entries-{arm}.json", value)
    changes = common.package_differences(entries["A"], entries["B"])
    write_json(output / "package-differences.json", changes)
    require(changes == sorted(case["packageDifferences"]), "Unexpected packaged runtime changes")
    identities = {arm: common.identity(root, overlay) for arm, root in roots.items()}
    require(identities["A"]["overlaySha256"] == identities["B"]["overlaySha256"], "Asymmetric harness overlay")
    executable = common.capture([node, "--input-type=module", "-e", "import {chromium} from 'playwright'; console.log(chromium.executablePath())"])
    runtime = {"node": common.capture([node, "--version"]), "nodeExecutableSha256": file_digest(node),
               "versions": json.loads(common.capture([node, "-p", "JSON.stringify(process.versions)"])),
               "playwright": json.loads((ROOT / "node_modules/playwright/package.json").read_text())["version"],
               "chromium": common.capture([executable, "--version"]), "chromiumExecutableSha256": file_digest(executable)}
    match = re.search(r"\b(\d+\.\d+\.\d+\.\d+)\b", runtime["chromium"])
    require(match is not None, "Missing browser version")
    runtime["browserVersion"] = match.group(1)
    timeout_executable = shutil.which("timeout")
    require(timeout_executable is not None, "GNU timeout is required for bounded diagnostic observations")
    timeout_version = common.capture([timeout_executable, "--version"]).splitlines()[0]
    require("GNU coreutils" in timeout_version, "Unsupported diagnostic deadline wrapper")
    runtime["deadlineWrapper"] = {"executable": timeout_executable, "sha256": file_digest(timeout_executable),
                                  "version": timeout_version, "seconds": 180, "killAfterSeconds": 5}
    write_json(output / "preparation.json", {
        "schemaVersion": 1, "case": case_id, "dictionary": dictionary, "replication": replication,
        "authoritativeTiming": False, "researchSha": common.capture(["git", "rev-parse", "HEAD"]),
        "researchTree": common.capture(["git", "rev-parse", "HEAD^{tree}"]), "studySourceHashes": source_hashes(),
        "roots": {arm: str(root) for arm, root in roots.items()}, "identities": identities,
        "runtime": runtime, "fixture": lock["dictionaries"][dictionary], "fixtures": fixtures,
        "packageDifferences": changes, "observer": config["observer"],
        "controls": {"strictRuntime": True, "freshProfilePerImport": True, "buildTarget": "chrome",
                     "productionDefaults": True, "externalProcessTreeSampling": True,
                     "harnessProfiling": False, "harnessScreenshots": False, "harnessProcessSampling": False},
        "timingCaveat": "The unmodified harness cannot detect the external observer. All its elapsed times and timing-authority labels are excluded from memory conclusions.",
        "memoryWindow": "Sampled discovered Chromium trees during startup, import, sampled persisted-content readback and restart; not exact import peak memory",
    })


def verify_inputs(preparation):
    require(source_hashes() == preparation["studySourceHashes"], "Memory study sources changed")
    wrapper = preparation["runtime"]["deadlineWrapper"]
    require(wrapper["seconds"] == 180 and wrapper["killAfterSeconds"] == 5 and
            file_digest(wrapper["executable"]) == wrapper["sha256"], "Diagnostic deadline wrapper changed")
    for arm, value in preparation["roots"].items():
        root = Path(value)
        require(common.identity(root, common.OVERLAY_FILES) == preparation["identities"][arm], "Source/package/lock/harness identity changed")
        fixture = preparation["fixture"]
        archive = root / "builds/e2e-dictionary-cache" / fixture["cacheFile"]
        require(archive.stat().st_size == fixture["sizeBytes"] and file_digest(archive) == fixture["sha256"], "Target archive changed")


def validate_observation(summary, report, preparation, arm):
    # The shared verifier checks the untouched harness's internal controls.
    # External sampling is declared independently and invalidates every timer.
    verified = common.verify_observation(summary, report, preparation, arm)
    validation = report["benchmark"]["validation"]
    require(summary["runs"][0]["validation"] == validation, "Summary/readback validation mismatch")
    require(len(validation.get("probeTerms", [])) == 12 and len(set(validation["probeTerms"])) == 12, "Missing unique persisted-content probes")
    phases = [phase["data"] for phase in report.get("phases", [])
              if isinstance(phase.get("data"), dict) and phase["data"].get("kind") == "dictionary-import"]
    require(len(phases) == 1, "Missing unique raw browser import phase")
    timing = phases[0].get("browserTiming", {})
    require(timing.get("trigger") == "file-input-change" and type(timing.get("sequenceBefore")) is int and
            type(timing.get("sequence")) is int and timing["sequence"] == timing["sequenceBefore"] + 1 and
            timing.get("errorCount") == 0, "Browser import trigger/sequence/errors changed")
    values = [timing.get(key) for key in ("startedAtMs", "completedAtMs")]
    require(all(type(value) in (int, float) and math.isfinite(value) and value >= 0 for value in values) and
            values[0] < values[1], "Missing monotonic browser completion receipt")
    require("nextFrameAtMs" in timing, "Missing optional browser frame receipt")
    frame = timing["nextFrameAtMs"]
    require(frame is None or (type(frame) in (int, float) and math.isfinite(frame) and frame >= values[1]),
            "Nonmonotonic browser frame receipt")
    debug = phases[0].get("importDebug", {})
    require(debug == summary["runs"][0].get("importDebug") and debug.get("hasResult") is True and
            debug.get("errorCount") == 0 and debug.get("addSettingsErrorCount") == 0 and
            debug.get("usesFallbackStorage") is False and
            debug.get("openStorageDiagnostics", {}).get("mode") == "opfs-sahpool", "Import errors or storage fallback observed")
    return {key: value for key, value in verified.items() if key not in ("totalImportMs", "workerImportMs")}


def observation_hashes(folder):
    return {str(path.relative_to(folder)): file_digest(path) for path in sorted(folder.rglob("*")) if path.is_file()}


def run_study(case_id, replication, output):
    preparation = json.loads((output / "preparation.json").read_text())
    require(preparation["case"] == case_id and preparation["replication"] == replication, "Wrong memory cell")
    require(preparation["authoritativeTiming"] is False and os.environ.get("CI") == "true", "Memory runtime controls changed")
    expected = schedule(replication)
    require(json.loads((output / "schedule.json").read_text()) == expected, "Memory schedule changed")
    require(not (output / "observations.json").exists(), "An attempted memory observation cannot be retried")
    verify_inputs(preparation)
    observations = []
    for item in expected:
        row = {**item, "authoritativeTiming": False, "status": "started", "startedUnixTime": time.time()}
        observations.append(row)
        write_json(output / "observations.json", observations)
        folder = output / "observations" / item["name"]
        folder.mkdir(parents=True, exist_ok=False)
        root = Path(preparation["roots"][item["arm"]])
        try:
            verify_inputs(preparation)
            write_json(folder / "host-before.json", json.loads(common.capture(["node", "dev/perf/host-environment.js"])))
            command = [preparation["runtime"]["deadlineWrapper"]["executable"], "--kill-after=5s", "180s",
                       "node", "dev/perf/import-benchmark.js", preparation["dictionary"], "--runs", "1", "--no-build",
                       "--build-target", "chrome", "--output", str(folder)]
            write_json(folder / "identity.json", {"authoritativeTiming": False, **item, "command": command,
                       "source": preparation["identities"][item["arm"]], "preparationSha256": file_digest(output / "preparation.json")})
            # Keep the reviewed observer byte-identical; only sanitize the
            # environment around its child launch, as the timing runner does.
            old_environment = dict(os.environ)
            sanitized_environment = common.clean_environment()
            try:
                os.environ.clear()
                os.environ.update(sanitized_environment)
                row["memory"] = observer.run_with_sampling(command, root, folder / "run.log", folder / "chromium-memory.json")
            finally:
                os.environ.clear()
                os.environ.update(old_environment)
            row.update(validate_observation(json.loads((folder / "summary.json").read_text()),
                                            json.loads((folder / "run-1.json").read_text()), preparation, item["arm"]))
            require(row["memory"]["qualifiedForWholeTreePss"] is True, "Process-tree coverage is unqualified")
            require(row["memory"]["authoritativeTiming"] is False, "Observer timing label changed")
            prior = [value for value in observations[:-1] if value["status"] == "success"]
            if prior:
                for key in ("outputDigestSha256", "browserVersion", "workReceipt"):
                    require(row[key] == prior[0][key], f"Cross-arm import work/readback changed: {key}")
            verify_inputs(preparation)
            row["status"] = "success"
        except Exception as error:
            row["status"] = "failed"
            row["error"] = f"{type(error).__name__}: {error}"
        finally:
            try:
                write_json(folder / "host-after.json", json.loads(common.capture(["node", "dev/perf/host-environment.js"])))
            except Exception as error:
                row["status"] = "failed"
                row["postflightError"] = f"{type(error).__name__}: {error}"
            row["endedUnixTime"] = time.time()
            row["receiptHashes"] = observation_hashes(folder)
            write_json(output / "observations.json", observations)
        print(json.dumps({"case": case_id, "replication": replication, "index": item["index"], "arm": item["arm"], "status": row["status"]}), flush=True)
    verify_inputs(preparation)
    require(all(row["status"] == "success" for row in observations), "Failed memory observations invalidate the complete cell")
    write_json(output / "cohort-complete.json", {
        "case": case_id, "dictionary": preparation["dictionary"], "replication": replication, "authoritativeTiming": False,
        "observationsSha256": file_digest(output / "observations.json"), "scheduleSha256": file_digest(output / "schedule.json"),
        "preparationSha256": file_digest(output / "preparation.json"), "configSha256": file_digest(output / "config.json"),
        "completedUnixTime": time.time(),
    })


def analyze(case_id, replication, output):
    rows_path = output / "observations.json"
    rows = json.loads(rows_path.read_text()) if rows_path.exists() else []
    result = {"case": case_id, "replication": replication, "authoritativeTiming": False,
              "qualifiedMemoryMeasurement": False, "plannedImports": 4, "observedImports": len(rows),
              "qualificationFailures": [], "pairs": [],
              "scope": "Sampled maxima of discovered Chromium process-tree PSS/private bytes during startup/import/readback/restart; not exact import peaks or timing evidence"}
    try:
        preparation = json.loads((output / "preparation.json").read_text())
        receipt = json.loads((output / "cohort-complete.json").read_text())
        config = json.loads((output / "config.json").read_text())
        validate_config(config, case_id)
        require(preparation["case"] == receipt["case"] == case_id and preparation["replication"] == receipt["replication"] == replication, "Wrong completed cell")
        require(preparation["dictionary"] == receipt["dictionary"] == config["cases"][case_id]["dictionary"], "Wrong completed dictionary")
        require(preparation["authoritativeTiming"] is False and receipt["authoritativeTiming"] is False, "Unexpected timing authority")
        require(preparation["identities"]["A"]["sha"] == config["baseline"] and
                preparation["identities"]["B"]["sha"] == config["cases"][case_id]["sha"], "Prepared source differs from frozen config")
        maps = {arm: json.loads((output / f"package-entries-{arm}.json").read_text()) for arm in ("A", "B")}
        require(common.package_differences(maps["A"], maps["B"]) == sorted(config["cases"][case_id]["packageDifferences"]) ==
                preparation["packageDifferences"], "Prepared package-entry delta changed")
        require(preparation["studySourceHashes"] == source_hashes(), "Analysis study sources differ from preparation")
        require(not (output / "prepare-failure.json").exists() and not (output / "run-failure.json").exists(), "Preparation/run failure is retained")
        for name in ("observations", "schedule", "preparation", "config"):
            require(file_digest(output / f"{name}.json") == receipt[name + "Sha256"], "Completed receipt hash mismatch")
        expected = schedule(replication)
        require(json.loads((output / "schedule.json").read_text()) == expected, "Wrong frozen schedule")
        require(len(rows) == 4 and [{key: row.get(key) for key in item} for row, item in zip(rows, expected)] == expected, "Incomplete/misordered memory observations")
        for row in rows:
            require(row["status"] == "success" and row["authoritativeTiming"] is False, "Unqualified memory observation")
            folder = output / "observations" / row["name"]
            require(observation_hashes(folder) == row["receiptHashes"], "Retained observation files changed")
            memory = json.loads((folder / "chromium-memory.json").read_text())
            require({key: value for key, value in memory.items() if key != "samples"} == row["memory"], "Observer summary mismatch")
            require(observer.summarize_samples(memory["samples"], memory["benchmarkExitCode"]) == memory, "Observer coverage/maximum derivation mismatch")
            require(memory["qualifiedForWholeTreePss"] is True and memory["authoritativeTiming"] is False, "Incomplete observed process-tree coverage")
            observed = validate_observation(json.loads((folder / "summary.json").read_text()), json.loads((folder / "run-1.json").read_text()), preparation, row["arm"])
            require(all(row[key] == value for key, value in observed.items()), "Browser report/receipt mismatch")
            for key in ("outputDigestSha256", "browserVersion", "workReceipt"):
                require(row[key] == rows[0][key], "Cross-arm output/work changed")
            for key in ("maxSampledPssKiB", "maxSampledPrivateKiB"):
                require(type(memory[key]) in (int, float) and math.isfinite(memory[key]) and memory[key] > 0, "Invalid sampled memory total")
        for start in (0, 2):
            pair = {row["arm"]: row for row in rows[start:start + 2]}
            metrics = {}
            for key in ("maxSampledPssKiB", "maxSampledPrivateKiB"):
                a, b = (pair[arm]["memory"][key] for arm in ("A", "B"))
                metrics[key] = {"baseline": a, "candidate": b, "changePercent": 100 * (b / a - 1)}
            result["pairs"].append({"indices": [start, start + 1], "metrics": metrics})
        result["medianPairedPercent"] = {key: statistics.median(pair["metrics"][key]["changePercent"] for pair in result["pairs"])
                                         for key in ("maxSampledPssKiB", "maxSampledPrivateKiB")}
        result["qualifiedMemoryMeasurement"] = True
    except Exception as error:
        result["qualificationFailures"].append(f"{type(error).__name__}: {error}")
        result["pairs"] = []
    write_json(output / "memory-analysis.json", result)
    return result["qualifiedMemoryMeasurement"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("validate", "prepare", "run", "analyze"))
    parser.add_argument("--case", required=True)
    parser.add_argument("--replication", required=True, type=int, choices=(1, 2))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--sources", type=Path)
    args = parser.parse_args()
    config = json.loads(CONFIG.read_text())
    validate_config(config, args.case)
    if args.phase == "validate":
        common.overlay_contents(config, config["cases"][args.case]["dictionary"])
        require(len(schedule(args.replication)) == 4, "Unexpected memory schedule length")
        print("Fixed memory protocol and reviewed observer validated")
        return
    require(args.output is not None, "--output is required")
    output = args.output.resolve()
    try:
        if args.phase == "prepare":
            require(args.sources is not None, "--sources is required")
            prepare(config, args.case, args.replication, output, args.sources.resolve())
        elif args.phase == "run":
            run_study(args.case, args.replication, output)
        elif not analyze(args.case, args.replication, output):
            raise SystemExit(1)
    except Exception as error:
        write_json(output / f"{args.phase}-failure.json", {"error": f"{type(error).__name__}: {error}", "unixTime": time.time(), "authoritativeTiming": False})
        raise


if __name__ == "__main__":
    main()
