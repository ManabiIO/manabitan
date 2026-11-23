#!/usr/bin/env python3
"""Fixed, source-matched Chromium import study. Never changes product source."""

import argparse
import errno
import hashlib
import itertools
import json
import math
import os
from pathlib import Path
import random
import re
import shutil
import statistics
import subprocess
import time
import urllib.request
import zipfile


ROOT = Path(__file__).resolve().parents[2]
CONFIG = Path(__file__).with_suffix(".json")
OVERLAY_FILES = (
    "dev/perf/dictionary-fixtures.js",
    "dev/perf/import-benchmark.js",
    "dev/perf/benchmark-support.js",
    "test/chromium/extension-two-dictionary-import.e2e.js",
    "test/perf/dictionaries.lock.json",
)
PACKAGE = "builds/manabitan-chrome.zip"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def capture(args, cwd=ROOT):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def clean_environment():
    return {key: value for key, value in os.environ.items()
            if not re.match(r"^MANABITAN_(?:E2E_|CHROMIUM_)", key)}


def command(args, cwd, log, timeout=1200):
    log = Path(log)
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("w") as output:
        output.write(json.dumps({"argv": args, "cwd": str(cwd)}) + "\n")
        output.flush()
        result = subprocess.run(args, cwd=cwd, env=clean_environment(),
                                stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
    require(result.returncode == 0, f"Command failed ({result.returncode}); see {log}")


def schedule(direction):
    require(direction in ("forward", "reverse"), "Invalid schedule direction")
    orders = ["".join(order) for order in itertools.permutations("ABC")]
    if direction == "reverse":
        orders = [order[::-1] for order in reversed(orders)]
    blocks = [(True, index + 1, order) for index, order in enumerate(orders[:2])]
    blocks += [(False, index + 1, order) for index, order in enumerate(orders * 2)]
    return [{"warmup": warmup, "block": block, "order": order, "arm": arm,
             "name": f"{'warmup' if warmup else 'block'}-{block:02d}-{arm}"}
            for warmup, block, order in blocks for arm in order]


def replace_once(source, before, after):
    require(source.count(before) == 1, f"Harness overlay anchor changed: {before[:90]}")
    return source.replace(before, after, 1)


def overlay_contents(config, dictionary):
    """The ordinary fixture lock is never edited in the research checkout."""
    values = {name: (ROOT / name).read_bytes() for name in OVERLAY_FILES}
    lock = json.loads(values["test/perf/dictionaries.lock.json"])
    require("vndb" not in lock["dictionaries"], "VNDB unexpectedly became a default fixture")
    if dictionary == "vndb":
        lock["dictionaries"]["vndb"] = config["extraFixture"]
    values["test/perf/dictionaries.lock.json"] = (json.dumps(lock, indent=4) + "\n").encode()
    name = "dev/perf/dictionary-fixtures.js"
    source = values[name].decode()
    source = replace_once(source, "jmdictPath: string, fixtures:", "jmdictPath: string, vndbPath: string, fixtures:")
    source = replace_once(source, "        jmdictPath: paths.jmdict,", "        jmdictPath: paths.jmdict,\n        vndbPath: paths.vndb,")
    values[name] = source.encode()
    name = "test/chromium/extension-two-dictionary-import.e2e.js"
    source = values[name].decode()
    source = replace_once(source, "new Set(['jmdict', 'jmnedict', 'jitendex'])", "new Set(['jmdict', 'jmnedict', 'jitendex', 'vndb'])")
    source = replace_once(source,
                          "            jitendex: {label: 'Jitendex', filePath: cachedDictionaries.jitendexPath},",
                          "            jitendex: {label: 'Jitendex', filePath: cachedDictionaries.jitendexPath},\n"
                          "            vndb: {label: 'VNDB Characters by Bee', filePath: cachedDictionaries.vndbPath},")
    values[name] = source.encode()
    return values


def ensure_extra_fixture(fixture, path):
    """Verify all target archives without adding VNDB to other timed workloads."""
    if path.exists() and path.stat().st_size == fixture["sizeBytes"] and file_digest(path) == fixture["sha256"]:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".zip.part")
    try:
        with urllib.request.urlopen(fixture["url"], timeout=120) as source, temporary.open("wb") as target:
            shutil.copyfileobj(source, target, 1024 * 1024)
        require(temporary.stat().st_size == fixture["sizeBytes"] and file_digest(temporary) == fixture["sha256"], "Extra fixture integrity mismatch")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def package_entries(path):
    with zipfile.ZipFile(path) as archive:
        names = [entry.filename for entry in archive.infolist() if not entry.is_dir()]
        require(len(names) == len(set(names)), "Duplicate ZIP package entries")
        return {name: digest(archive.read(name)) for name in sorted(names)}


def package_differences(baseline, candidate):
    return sorted(name for name in baseline.keys() | candidate.keys()
                  if baseline.get(name) != candidate.get(name))


def validate_config(config, case_id):
    require(config.get("schemaVersion") == 1, "Unsupported study configuration")
    require(case_id in config["cases"], "Unsupported study case")
    case = config["cases"][case_id]
    dictionary = case["dictionary"]
    require(dictionary in ("jmdict", "jitendex", "vndb"), "Unsupported study dictionary")
    for sha in (config["baseline"], case["sha"]):
        require(isinstance(sha, str) and re.fullmatch(r"[a-f0-9]{40}", sha), "Candidate/base must be a pinned full commit SHA")
    require(config["baseline"] != case["sha"], "Candidate must differ from baseline")
    require(case["packageDifferences"], "Package delta declaration is empty")
    require(config["extraFixture"]["sha256"] == "da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792", "Unexpected VNDB fixture")


def identity(root, overlay):
    return {"sha": capture(["git", "rev-parse", "HEAD"], root),
            "tree": capture(["git", "rev-parse", "HEAD^{tree}"], root),
            "packageSha256": file_digest(root / PACKAGE),
            "packageLockSha256": file_digest(root / "package-lock.json"),
            "trackedDiffSha256": digest(subprocess.check_output(["git", "diff", "--binary", "HEAD"], cwd=root)),
            "originalFixtureLockSha256": digest(subprocess.check_output(["git", "show", "HEAD:test/perf/dictionaries.lock.json"], cwd=root)),
            "overlaySha256": {name: file_digest(root / name) for name in overlay}}


def prepare(config, case_id, direction, output, sources):
    validate_config(config, case_id)
    case = config["cases"][case_id]
    dictionary = case["dictionary"]
    require(not (output / "preparation.json").exists(), "Preparation already exists; use a new evidence directory")
    output.mkdir(parents=True, exist_ok=True)
    write_json(output / "config.json", config)
    write_json(output / "schedule.json", schedule(direction))
    node = shutil.which("node")
    require(node is not None, "Node executable is unavailable")
    require(capture([node, "--version"]) == "v22.22.0", "This study requires Node 22.22.0")
    overlay = overlay_contents(config, dictionary)
    for name, data in overlay.items():
        destination = output / "overlay" / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    sources.mkdir(parents=True, exist_ok=True)
    roots = {"A": sources / "baseline", "B": sources / "candidate"}
    shas = {"A": config["baseline"], "B": case["sha"]}
    for arm, root in roots.items():
        require(not root.exists(), f"Source worktree already exists: {root}")
        command(["git", "worktree", "add", "--detach", str(root), shas[arm]], ROOT, output / f"checkout-{arm}.log")
        require((root / "package-lock.json").read_bytes() == (ROOT / "package-lock.json").read_bytes(), "Dependency locks differ")
        require((root / "test/perf/dictionaries.lock.json").read_bytes() == (ROOT / "test/perf/dictionaries.lock.json").read_bytes(), "Original fixture locks differ")
        for name, data in overlay.items():
            (root / name).write_bytes(data)
        (root / "node_modules").symlink_to((ROOT / "node_modules").resolve(), target_is_directory=True)
        command(["npm", "run", "build:libs"], root, output / f"libraries-{arm}.log")
        command(["npm", "run", "license-report:html"], root, output / f"licenses-{arm}.log")
        command([node, "dev/bin/build.js", "--target", "chrome"], root, output / f"package-{arm}.log")
    baseline, candidate = roots["A"], roots["B"]
    command([node, "dev/perf/prepare-dictionaries.js"], baseline, output / "fixtures.log", timeout=600)
    original_lock = json.loads((baseline / "test/perf/dictionaries.lock.json").read_text())
    fixtures = {}
    for key, fixture in original_lock["dictionaries"].items():
        source = baseline / "builds/e2e-dictionary-cache" / fixture["cacheFile"]
        require(source.stat().st_size == fixture["sizeBytes"] and file_digest(source) == fixture["sha256"], f"Fixture mismatch: {key}")
        fixtures[key] = {"sizeBytes": source.stat().st_size, "sha256": file_digest(source)}
        destination = candidate / "builds/e2e-dictionary-cache" / fixture["cacheFile"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(source, destination)
        except OSError as error:
            if error.errno != errno.EXDEV:
                raise
            shutil.copyfile(source, destination)
    if "vndb" not in fixtures:
        source = ROOT / "builds/import-qualification-dictionary-cache" / config["extraFixture"]["cacheFile"]
        ensure_extra_fixture(config["extraFixture"], source)
        fixtures["vndb"] = {"sizeBytes": source.stat().st_size, "sha256": file_digest(source)}
    maps = {arm: package_entries(root / PACKAGE) for arm, root in roots.items()}
    for arm, entries in maps.items():
        write_json(output / f"package-entries-{arm}.json", entries)
    write_json(output / "package-entries-C.json", maps["A"])
    differences = package_differences(maps["A"], maps["B"])
    write_json(output / "package-differences.json", differences)
    require(differences == sorted(case["packageDifferences"]), f"Unexpected package delta: {differences}")
    identities = {arm: identity(root, overlay) for arm, root in roots.items()}
    require(identities["A"]["overlaySha256"] == identities["B"]["overlaySha256"], "Harness overlay differs between arms")
    executable = capture([node, "--input-type=module", "-e", "import {chromium} from 'playwright'; console.log(chromium.executablePath())"])
    runtime = {"node": capture([node, "--version"]), "nodeExecutableSha256": file_digest(node),
               "versions": json.loads(capture([node, "-p", "JSON.stringify(process.versions)"])),
               "playwright": json.loads((ROOT / "node_modules/playwright/package.json").read_text())["version"],
               "chromium": capture([executable, "--version"]), "chromiumExecutableSha256": file_digest(executable)}
    browser_version = re.search(r"\b(\d+\.\d+\.\d+\.\d+)\b", runtime["chromium"])
    require(browser_version is not None, "Missing prepared Chromium version")
    runtime["browserVersion"] = browser_version.group(1)
    write_json(output / "preparation.json", {"schemaVersion": 1, "case": case_id, "dictionary": dictionary, "direction": direction,
               "researchSha": capture(["git", "rev-parse", "HEAD"]), "researchTree": capture(["git", "rev-parse", "HEAD^{tree}"]),
               "runnerSha256": file_digest(__file__), "configSha256": file_digest(CONFIG),
               "roots": {arm: str(root) for arm, root in roots.items()}, "identities": identities,
               "sameCodeControl": "C uses the exact A package and worktree with a fresh browser profile",
               "measurementControls": {"strictRuntime": True, "freshProfilePerImport": True, "buildTarget": "chrome",
                                       "productionDefaults": True, "profiling": False, "screenshots": False, "processSampling": False},
               "runtime": runtime, "fixtures": fixtures,
               "fixture": original_lock["dictionaries"][dictionary], "packageDifferences": differences})


def verify_observation(summary, report, preparation, arm):
    source = preparation["identities"]["A" if arm == "C" else arm]
    require(summary.get("dictionary") == preparation["dictionary"], "Observation dictionary mismatch")
    require(summary.get("buildTarget") == "chrome" and summary.get("authoritativeTiming") is True and
            summary.get("traceEnabled") is False and summary.get("importFlags") is None, "Nonproduction timing controls")
    require(summary.get("gitSha") == source["sha"], "Observation source SHA mismatch")
    observed_hashes = summary.get("source", {}).get("sha256", {})
    require(observed_hashes.get(PACKAGE) == source["packageSha256"], "Observed package provenance mismatch")
    require(observed_hashes.get("package-lock.json") == source["packageLockSha256"] and
            all(observed_hashes.get(name) == expected for name, expected in source["overlaySha256"].items()),
            "Observed lock/harness provenance mismatch")
    require(summary.get("fixture") == preparation["fixture"], "Observed fixture differs from frozen fixture")
    require(summary.get("hostEnvironment", {}).get("nodeVersion") == preparation["runtime"]["node"], "Observed Node runtime changed")
    require(summary.get("browserVersion") == preparation["runtime"]["browserVersion"] and
            report.get("browserVersion") == preparation["runtime"]["browserVersion"], "Observed browser runtime changed")
    require(len(summary.get("runs", [])) == 1, "Observation must contain exactly one import")
    run = summary["runs"][0]
    require(run.get("packageSha256") == source["packageSha256"], "Observed package differs from frozen package")
    duration = run.get("totalImportMs")
    require(type(duration) in (int, float) and math.isfinite(duration) and duration > 0, "Invalid import duration")
    require(report.get("status") == "success" and report.get("skippedVerification") is False, "Browser verification failed or skipped")
    benchmark = report.get("benchmark", {})
    require(benchmark.get("phaseProfiling") is False and benchmark.get("phaseScreenshots") is False and
            benchmark.get("processSampling") is False, "Instrumentation contaminated timing")
    validation = benchmark.get("validation", {})
    restart = validation.get("restart", {})
    fixture = summary["fixture"]
    require(all(validation.get(key) == fixture[expected] and restart.get(key) == fixture[expected]
                for key, expected in (("title", "expectedTitle"), ("revision", "revision"), ("termRows", "termRows"))), "Persisted dictionary mismatch")
    require(validation.get("contentReadable") is True and validation.get("probeCount") == 12 and
            restart.get("contentReadable") is True and restart.get("probeCount") == 12, "Missing restart/content verification")
    require(re.fullmatch(r"[a-f0-9]{64}", validation.get("outputDigestSha256", "")), "Missing persisted probe digest")
    return {"totalImportMs": duration, "workerImportMs": run.get("workerImportMs"),
            "outputDigestSha256": validation["outputDigestSha256"], "browserVersion": summary.get("browserVersion"),
            "packageSha256": run["packageSha256"]}


def run_study(case_id, dictionary, direction, output):
    preparation = json.loads((output / "preparation.json").read_text())
    require(preparation["case"] == case_id and preparation["dictionary"] == dictionary and preparation["direction"] == direction, "Cell identity mismatch")
    require(preparation["runnerSha256"] == file_digest(__file__) and preparation["configSha256"] == file_digest(CONFIG), "Study sources changed after preparation")
    expected = schedule(direction)
    require(json.loads((output / "schedule.json").read_text()) == expected, "Frozen schedule changed")
    require(not (output / "observations.json").exists(), "Timing already attempted; observations cannot be retried")
    roots = {arm: Path(value) for arm, value in preparation["roots"].items()}
    for arm, root in roots.items():
        require(identity(root, OVERLAY_FILES) == preparation["identities"][arm], "Prepared source/package/overlay changed")
    observations = []
    for item in expected:
        observation = dict(item)
        observation["status"] = "started"
        observation["startedUnixTime"] = time.time()
        observations.append(observation)
        write_json(output / "observations.json", observations)
        folder = output / "observations" / item["name"]
        folder.mkdir(parents=True)
        root = roots["A" if item["arm"] == "C" else item["arm"]]
        try:
            write_json(folder / "host-before.json", json.loads(capture(["node", "dev/perf/host-environment.js"])))
            command(["node", "dev/perf/import-benchmark.js", dictionary, "--runs", "1", "--no-build",
                     "--build-target", "chrome", "--output", str(folder)], root, folder / "run.log", timeout=660)
            observation.update(verify_observation(json.loads((folder / "summary.json").read_text()),
                                                  json.loads((folder / "run-1.json").read_text()), preparation, item["arm"]))
            if len(observations) > 1:
                require(observation["outputDigestSha256"] == observations[0]["outputDigestSha256"], "Persisted output digest changed between arms")
                require(observation["browserVersion"] == observations[0]["browserVersion"], "Browser version changed between imports")
            require(file_digest(root / PACKAGE) == observation["packageSha256"], "Package changed during observation")
            observation["status"] = "success"
        except Exception as error:
            observation["status"] = "failed"
            observation["error"] = f"{type(error).__name__}: {error}"
            raise
        finally:
            observation["endedUnixTime"] = time.time()
            write_json(output / "observations.json", observations)
            write_json(folder / "host-after.json", json.loads(capture(["node", "dev/perf/host-environment.js"])))
        print(f"{case_id} {direction} {item['name']}: {observation['totalImportMs']:.1f}ms", flush=True)
    for arm, root in roots.items():
        require(identity(root, OVERLAY_FILES) == preparation["identities"][arm], "Sources changed during the cohort")
    write_json(output / "cohort-complete.json", {"observationsSha256": file_digest(output / "observations.json"),
               "scheduleSha256": file_digest(output / "schedule.json"), "case": case_id, "dictionary": dictionary,
               "preparationSha256": file_digest(output / "preparation.json"), "configSha256": file_digest(output / "config.json"),
               "direction": direction, "completedUnixTime": time.time()})


def comparison(rows, numerator, denominator):
    groups = {}
    for row in rows:
        groups.setdefault(row["block"], {})[row["arm"]] = row["totalImportMs"]
    deltas = [(group[numerator] / group[denominator] - 1) * 100 for group in groups.values()]
    rng = random.Random(20261122)
    bootstrap = sorted(statistics.median(rng.choices(deltas, k=len(deltas))) for _ in range(5000))
    return {"pairs": len(deltas), "pairedPercentChanges": deltas, "medianPairedPercent": statistics.median(deltas),
            "equalWorkPercent": (sum(group[numerator] for group in groups.values()) /
                                  sum(group[denominator] for group in groups.values()) - 1) * 100,
            "descriptiveBootstrap95": [bootstrap[124], bootstrap[4874]],
            "fasterPairs": sum(value < 0 for value in deltas), "worstPairPercent": max(deltas)}


def analyze(case_id, dictionary, direction, output):
    path = output / "observations.json"
    rows = json.loads(path.read_text()) if path.exists() else []
    expected = schedule(direction)
    receipt_path = output / "cohort-complete.json"
    receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
    preparation_path = output / "preparation.json"
    preparation = json.loads(preparation_path.read_text()) if preparation_path.exists() else {}
    complete = (len(rows) == len(expected) and all(row.get("status") == "success" for row in rows) and
                [{key: row.get(key) for key in planned} for row, planned in zip(rows, expected)] == expected and
                receipt.get("case") == case_id and preparation.get("case") == case_id and
                receipt.get("dictionary") == dictionary and preparation.get("dictionary") == dictionary and
                preparation.get("direction") == direction and receipt.get("preparationSha256") == file_digest(preparation_path) and
                (output / "config.json").exists() and receipt.get("configSha256") == file_digest(output / "config.json") and
                receipt.get("direction") == direction and receipt.get("observationsSha256") == (file_digest(path) if path.exists() else None) and
                (output / "schedule.json").exists() and receipt.get("scheduleSha256") == file_digest(output / "schedule.json") and
                not (output / "prepare-failure.json").exists() and not (output / "run-failure.json").exists())
    result = {"case": case_id, "dictionary": dictionary, "direction": direction, "complete": complete, "plannedImports": 42, "observedImports": len(rows),
              "successfulImports": sum(row.get("status") == "success" for row in rows),
              "failedImports": [row for row in rows if row.get("status") != "success"],
              "timingBoundary": "file-input change to post-UI import-complete event; fresh profile every import",
              "limitations": "Linux x64 Chromium only; twelve source-derived probes are sampled persisted-content evidence, not exhaustive equality"}
    if complete:
        measured = [row for row in rows if not row["warmup"]]
        result["candidateVsBaseline"] = comparison(measured, "B", "A")
        result["candidateVsControl"] = comparison(measured, "B", "C")
        result["sameCodeControl"] = comparison(measured, "C", "A")
    write_json(output / "analysis.json", result)
    return complete


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("validate", "prepare", "run", "analyze"))
    parser.add_argument("--case", choices=("parser-jmdict", "parser-jitendex", "parser-vndb", "media-vndb"), default="parser-jmdict")
    parser.add_argument("--direction", choices=("forward", "reverse"), default="forward")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--sources", type=Path)
    args = parser.parse_args()
    config = json.loads(CONFIG.read_text())
    dictionary = config["cases"][args.case]["dictionary"]
    if args.phase == "validate":
        validate_config(config, args.case)
        overlay_contents(config, dictionary)
        require(len(schedule(args.direction)) == 42, "Unexpected schedule size")
        print("Study configuration and exact harness overlay validated")
        return
    require(args.output is not None, "--output is required")
    output = args.output.resolve()
    try:
        if args.phase == "prepare":
            require(args.sources is not None, "--sources is required for preparation")
            prepare(config, args.case, args.direction, output, args.sources.resolve())
        elif args.phase == "run":
            run_study(args.case, dictionary, args.direction, output)
        else:
            if not analyze(args.case, dictionary, args.direction, output):
                raise SystemExit(1)
    except Exception as error:
        write_json(output / f"{args.phase}-failure.json", {"error": f"{type(error).__name__}: {error}", "unixTime": time.time()})
        raise


if __name__ == "__main__":
    main()
