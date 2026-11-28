#!/usr/bin/env python3
"""Fresh exact-a300 correctness or one excluded baseline storage observation."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import zipfile

PREFIX = "MANABITAN_A300_PREREQUISITE_"
TOOL = Path(__file__).resolve().parent
ROOT = TOOL.parents[2]


def emit(kind, value):
    print(PREFIX + kind + " " + json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False), flush=True)


def write(path, value):
    with path.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1048576), b""):
            digest.update(block)
    return digest.hexdigest()


def git(*args, cwd=ROOT):
    return subprocess.check_output(["git", *args], cwd=cwd, text=True).strip()


def blob(revision, path):
    return subprocess.check_output(["git", "show", revision + ":" + path], cwd=ROOT)


def byte_identity(data):
    return {"bytes": len(data), "sha256": sha(data),
            "gitBlobSha1": hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def check_identity(data, expected, label):
    actual = byte_identity(data)
    for key in ("bytes", "sha256", "gitBlobSha1"):
        require(actual[key] == expected[key], label + ": " + key + " differs")
    return actual


def check_sources(binding):
    base, candidate = binding["baseline"], binding["candidate"]
    require(git("rev-parse", base["commit"] + "^{tree}") == base["tree"], "Baseline tree differs")
    require(git("rev-parse", candidate["commit"] + "^{tree}") == candidate["tree"], "Candidate tree differs")
    require(git("show", "-s", "--format=%P", candidate["commit"]) == base["commit"], "Candidate is not the exact direct child")
    changed = git("diff", "--name-only", base["commit"], candidate["commit"]).splitlines()
    require(set(changed) == {item["path"] for item in binding["productFiles"]}, "Product changed-file set differs")
    products = {}
    for item in binding["productFiles"]:
        products[item["path"]] = check_identity(blob(candidate["commit"], item["path"]), item, item["path"])
    inventory_path = TOOL / binding["sourceInventory"]["path"]
    require(file_sha(inventory_path) == binding["sourceInventory"]["sha256"], "Source inventory differs")
    inventory = json.loads(inventory_path.read_text())
    require(inventory["current"] == base, "Source inventory base differs")
    for item in inventory["sourceFiles"]:
        check_identity(blob(base["commit"], item["path"]), item, "Baseline " + item["path"])
    required = inventory["observer"]["requiredSame"]
    explicit = {
        "package.json", "package-lock.json", ".github/actions/setup/action.yml",
        "test/perf/dictionaries.lock.json", "dev/perf/import-benchmark.js",
        "dev/perf/benchmark-support.js", "dev/perf/dictionary-fixtures.js",
        "test/chromium/extension-two-dictionary-import.e2e.js", "test/e2e/import-timing.js",
        "dev/perf/import-media-validation.js",
    }
    derived = explicit | {path for path in git("ls-tree", "-r", "--name-only", base["commit"], "test/e2e", "test/chromium", "dev/perf").splitlines()
                          if path.endswith((".js", ".mjs", ".html"))}
    require(len(required) == 39 and {item["path"] for item in required} == derived, "Required-same inventory differs")
    for item in required:
        check_identity(blob(candidate["commit"], item["path"]), item, "Candidate harness " + item["path"])
        check_identity((ROOT / item["path"]).read_bytes(), item, "Tooling harness " + item["path"])
    for path, digest in binding["unchangedSourceFiles"].items():
        for label, data in (("baseline", blob(base["commit"], path)), ("candidate", blob(candidate["commit"], path)),
                            ("tooling", (ROOT / path).read_bytes())):
            require(sha(data) == digest, label + " source differs: " + path)
    native_paths = {
        "cSha256": "ext/js/dictionary/wasm/term-bank-parser.c",
        "wasmSha256": "dev/data/dictionary-wasm/term-bank-parser.wasm",
        "manifestSha256": "dev/data/dictionary-wasm/manifest.json",
    }
    for field, path in native_paths.items():
        require(sha(blob(base["commit"], path)) == binding["nativeBaseline"][field], "Baseline native bytes differ")
    require(git("diff", "--name-only", base["commit"], "HEAD", "--",
                "dev/perf/import-qualification-20261125-a7f7.py", "dev/perf/import-memory-20261125-a7f7") == "",
            "Original qualification observer differs")
    require(subprocess.check_output(["node", "--version"], text=True).strip() == binding["runtime"]["node"], "Node version differs")
    criteria = TOOL / binding["criteria"]["path"]
    require(file_sha(criteria) == binding["criteria"]["sha256"], "Prospective criteria differ")
    return {"baseline": base, "candidate": candidate, "changedProductPaths": sorted(changed),
            "productFiles": products, "requiredSameCount": len(required),
            "sourceInventorySha256": file_sha(inventory_path), "criteriaSha256": file_sha(criteria)}


def command(label, argv, cwd, output, receipts):
    started = time.time()
    emit("COMMAND_START", {"label": label, "command": argv, "cwd": str(cwd), "scope": "Prerequisite only; no comparison observation"})
    log = output / (label + ".log")
    code, failure = None, None
    try:
        with log.open("xb") as stream:
            code = subprocess.run(argv, cwd=cwd, stdout=stream, stderr=subprocess.STDOUT, timeout=3600).returncode
    except Exception as error:
        failure = {"type": type(error).__name__, "message": str(error)}
    receipt = {"label": label, "command": argv, "cwd": str(cwd), "startedEpoch": started,
               "finishedEpoch": time.time(), "exitCode": code, "exception": failure,
               "logSha256": file_sha(log) if log.is_file() else None, "retried": False}
    write(output / (label + ".receipt.json"), receipt)
    receipts.append(receipt)
    emit("COMMAND", receipt)
    require(code == 0 and failure is None, "Prerequisite command failed: " + label)


def check_worktree(target, revision, binding, candidate=False):
    require(git("rev-parse", "HEAD", cwd=target) == revision, "Worktree head differs")
    require(git("status", "--porcelain", cwd=target) == "", "Worktree is dirty")
    if candidate:
        for item in binding["productFiles"]:
            check_identity((target / item["path"]).read_bytes(), item, "Worktree product " + item["path"])


def correctness(binding, output, target, receipts):
    versions = {}
    for name, executable, expected in (
        ("clang", binding["runtime"]["clangPath"], binding["runtime"]["clang"]),
        ("lld", binding["runtime"]["wasmLdPath"], binding["runtime"]["lld"]),
    ):
        value = subprocess.check_output([executable, "--version"], text=True).strip()
        require(re.search(r"\b" + re.escape(expected) + r"\b", value) is not None, name + " version differs")
        versions[name] = value
    write(output / "compiler-identity.json", versions)
    tests = [item["path"] for item in binding["productFiles"] if item["path"].startswith("test/")]
    plan = [
        ("create-candidate", ["git", "worktree", "add", "--detach", str(target), binding["candidate"]["commit"]], ROOT),
        ("dependencies", ["npm", "ci"], target),
        ("build-libraries", ["npm", "run", "build:libs"], target),
        ("license-page", ["npm", "run", "license-report:html"], target),
        ("reproduce-native", ["npm", "run", "build:dictionary-wasm", "--", "--check"], target),
        ("scoped-lint", ["npx", "eslint", *tests], target),
        ("strict-main-types", ["npm", "run", "test:ts:main"], target),
        ("strict-test-types", ["npm", "run", "test:ts:test"], target),
        ("complete-unit-suite", ["npm", "run", "test:unit", "--", "--maxWorkers=2"], target),
        ("options-unit-suite", ["npm", "run", "test:unit:options", "--", "--maxWorkers=2"], target),
        ("all-dry-build-targets", ["npm", "run", "test:build"], target),
    ]
    write(output / "command-plan.json", [{"label": label, "command": argv, "cwd": str(cwd)} for label, argv, cwd in plan])
    for label, argv, cwd in plan:
        command(label, argv, cwd, output, receipts)
    check_worktree(target, binding["candidate"]["commit"], binding, candidate=True)
    require(file_sha(target / "ext/lib/term-bank-parser.wasm") ==
            next(item["sha256"] for item in binding["productFiles"] if item["path"] == "dev/data/dictionary-wasm/term-bank-parser.wasm"),
            "Runtime native artifact differs")
    return {"correctnessPass": True, "freshExactHead": binding["candidate"]["commit"],
            "freshExactTree": binding["candidate"]["tree"], "commandCount": len(receipts),
            "compilerIdentity": versions, "sourceClean": True, "performanceObservations": 0}


def storage(binding, output, target, dictionary, receipts):
    sys.path.insert(0, str(ROOT / "dev/perf/import-memory-20261125-a7f7"))
    from chromium_memory import run_with_sampling
    from protocol import memory_overlay
    require(dictionary in binding["prerequisite"]["dictionaries"], "Unknown prerequisite corpus")
    require(os.environ.get("MANABITAN_E2E_STRICT_RUNTIME") == "1", "Strict runtime is required")
    require(os.environ.get("MANABITAN_CHROMIUM_ALLOW_HEADED_FALLBACK") == "0", "Headed fallback must remain disabled")
    command("prepare-locked-fixture", ["node", "dev/perf/prepare-dictionaries.js", dictionary], ROOT, output, receipts)
    command("create-baseline", ["git", "worktree", "add", "--detach", str(target), binding["baseline"]["commit"]], ROOT, output, receipts)
    shutil.copytree(ROOT / "node_modules", target / "node_modules", copy_function=os.link, symlinks=True)
    (target / "builds").mkdir(exist_ok=True)
    (target / "builds/e2e-dictionary-cache").symlink_to(ROOT / "builds/e2e-dictionary-cache", target_is_directory=True)
    command("build-libraries", ["npm", "run", "build:libs"], target, output, receipts)
    command("license-page", ["npm", "run", "license-report:html"], target, output, receipts)
    command("release-package", ["npm", "run", "build", "--", "--target", "chrome"], target, output, receipts)
    check_worktree(target, binding["baseline"]["commit"], binding)
    package = target / "builds/manabitan-chrome.zip"
    package_sha = file_sha(package)
    with zipfile.ZipFile(package) as archive:
        names = [item.filename for item in archive.infolist()]
        require(len(names) == len(set(names)), "Duplicate package entries")
        entries = {item.filename: {"sha256": sha(archive.read(item)), "bytes": item.file_size, "compressedBytes": item.compress_size}
                   for item in archive.infolist() if not item.is_dir()}
    write(output / "package-entries.json", {"packageSha256": package_sha, "packageBytes": package.stat().st_size, "entries": entries})
    shutil.copyfile(package, output / "package-A.zip")
    browser = Path(subprocess.check_output(["node", "--input-type=module", "-e",
                   "import {chromium} from 'playwright'; process.stdout.write(chromium.executablePath())"], cwd=ROOT, text=True))
    browser_version = subprocess.check_output([str(browser), "--version"], text=True).strip()
    browser_identity = {"path": str(browser), "sha256": file_sha(browser), "versionOutput": browser_version}
    write(output / "browser-identity.json", browser_identity)
    require(browser_identity["sha256"] == binding["runtime"]["browser"]["sha256"], "Pinned Chromium binary differs")
    require(browser_version == binding["runtime"]["browser"]["versionOutput"], "Pinned Chromium version differs")
    harness = target / "test/chromium/extension-two-dictionary-import.e2e.js"
    original = harness.read_text()
    instrumented = memory_overlay(original)
    (output / "harness-original.js").write_text(original)
    (output / "harness-instrumented.js").write_text(instrumented)
    observation = output / "baseline-only"
    observation.mkdir()
    argv = ["node", "dev/perf/import-benchmark.js", dictionary, "--runs", "1", "--no-build",
            "--build-target", "chrome", "--media-check", "sample", "--output", str(observation)]
    write(output / "observation-plan.json", {
        "dictionary": dictionary, "baseline": binding["baseline"], "observations": 1,
        "candidateObservations": 0, "authoritativeTiming": False, "comparison": False,
        "flags": {}, "command": argv, "packageSha256": package_sha,
        "sourceOverlay": {"path": "test/chromium/extension-two-dictionary-import.e2e.js",
                          "originalSha256": sha(original.encode()), "instrumentedSha256": sha(instrumented.encode()),
                          "purpose": "The unchanged a7f7 whole-process-tree import-window marker overlay only"},
        "allocationBound": None, "allocationInterpretation": "Record actual baseline storage; no full-cohort bound is inferred or accepted automatically.",
        "failurePolicy": "One attempt only; preserve all failures and partial output; no retries.",
    })
    sampled = None
    try:
        harness.write_text(instrumented)
        require(file_sha(package) == package_sha, "Package changed before excluded observation")
        try:
            sampled = run_with_sampling(argv, target, observation / "run.log", observation / "memory.json", observation / "markers.jsonl")
        except Exception as error:
            write(output / "sampling-failure.json", {"type": type(error).__name__, "message": str(error), "retried": False})
            raise
        write(output / "sampled-summary.json", sampled)
        emit("SAMPLED_BASELINE", {"dictionary": dictionary, "value": sampled, "authoritativeTiming": False})
        require(sampled.get("benchmarkExitCode") == 0, "Excluded baseline benchmark process failed")
    finally:
        harness.write_text(original)
        require(file_sha(package) == package_sha, "Package changed during excluded observation")
        check_worktree(target, binding["baseline"]["commit"], binding)
    report = json.loads((observation / "run-1.json").read_text())
    summary = json.loads((observation / "summary.json").read_text())
    inventory_receipt = {
        "dictionary": dictionary, "baseline": binding["baseline"], "candidateObserved": False,
        "reportStatus": report.get("status"), "validation": report.get("benchmark", {}).get("validation"),
        "summarySource": summary.get("source"), "summaryGitSha": summary.get("gitSha"),
        "files": {name: file_sha(observation / name) for name in ("run-1.json", "summary.json", "memory.json", "markers.jsonl")},
        "prospectiveFullStorageBound": None, "manualStructuralReviewRequired": True,
        "fullQualificationLaunched": False,
    }
    write(output / "storage-inventory.json", inventory_receipt)
    emit("STORAGE_INVENTORY", inventory_receipt)
    require(report.get("status") == "success", "Excluded baseline import or verification failed")
    require(report.get("skippedVerification") is False, "Excluded verification was skipped")
    require(report.get("buildTarget") == "chrome" and report.get("browserFlavor") == "chromium" and
            report.get("launchMode") == "headless", "Excluded browser mode differs")
    benchmark = report.get("benchmark", {})
    for key, expected in (("dictionary", dictionary), ("pinnedDictionaries", True), ("productionImportDefaults", True),
                          ("traceEnabled", False), ("phaseProfiling", False), ("phaseScreenshots", False),
                          ("processSampling", False), ("importFlags", None), ("mediaCheck", "sample")):
        require(key in benchmark and benchmark[key] == expected, "Excluded benchmark option differs: " + key)
    require(summary.get("importFlags") is None and summary.get("mediaCheck") == "sample", "Excluded summary options differ")
    require(len(summary.get("runs", [])) == 1, "Excluded baseline observation count differs")
    require(summary.get("gitSha") == binding["baseline"]["commit"], "Excluded baseline source differs")
    require(summary["runs"][0].get("packageSha256") == package_sha and report.get("packageSha256") == package_sha,
            "Excluded baseline package differs")
    require(summary["runs"][0].get("validation") == benchmark.get("validation"), "Summary/raw validation differs")
    provenance_paths = (
        "package-lock.json", "test/perf/dictionaries.lock.json", "dev/perf/benchmark-support.js",
        "dev/perf/dictionary-fixtures.js", "dev/perf/import-benchmark.js", "test/chromium/import-flags-ab-benchmark.js",
        "test/chromium/extension-two-dictionary-import.e2e.js", "test/e2e/import-timing.js",
        "ext/js/pages/settings/dictionary-import-controller.js", "builds/manabitan-chrome-dev.zip", "builds/manabitan-chrome.zip",
    )
    hashes = {path: file_sha(target / path) if (target / path).is_file() else None for path in provenance_paths}
    hashes["test/chromium/extension-two-dictionary-import.e2e.js"] = sha(instrumented.encode())
    require(summary.get("source", {}).get("gitSha") == binding["baseline"]["commit"] and
            summary.get("source", {}).get("dirty") is True, "Excluded marker-overlay provenance differs")
    actual_hashes = summary.get("source", {}).get("sha256", {})
    for path, expected in hashes.items():
        require(path in actual_hashes and actual_hashes[path] == expected, "Excluded source hash differs: " + path)
    return {"baselineObservationCompleted": True, "dictionary": dictionary, "observations": 1,
            "candidateObservations": 0, "authoritativeTiming": False, "comparison": False,
            "qualifiedForWholeTreePss": sampled.get("qualifiedForWholeTreePss"),
            "memoryQualificationFailures": sampled.get("qualificationFailures"),
            "storageCompatibilityAccepted": False, "manualStructuralReviewRequired": True,
            "fullQualificationLaunched": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("correctness", "storage"))
    parser.add_argument("--binding", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--worktree", type=Path, required=True)
    parser.add_argument("--dictionary", choices=("jmdict", "jitendex", "vndb"))
    args = parser.parse_args()
    output, target = args.output.resolve(), args.worktree.resolve()
    require(not target.exists(), "Never reuse an existing source worktree")
    output.mkdir(parents=True, exist_ok=False)
    receipts = []
    try:
        binding = json.loads(args.binding.read_text())
        source = check_sources(binding)
        write(output / "source-proof.json", source)
        for name in (args.binding.name, binding["criteria"]["path"], binding["sourceInventory"]["path"]):
            data = (TOOL / name).read_bytes()
            (output / name).write_bytes(data)
        start = {"mode": args.mode, "dictionary": args.dictionary, "bindingSha256": file_sha(args.binding),
                 "scriptSha256": file_sha(Path(__file__)), "workflowHead": os.environ.get("GITHUB_SHA"),
                 "runId": os.environ.get("GITHUB_RUN_ID"), "runAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
                 "pythonVersion": sys.version, "pythonVersionInfo": list(sys.version_info),
                 "nodeVersion": subprocess.check_output(["node", "--version"], text=True).strip(),
                 "source": source, "timingIsAuthoritative": False}
        write(output / "start.json", start)
        emit("START", start)
        if args.mode == "correctness":
            result = correctness(binding, output, target, receipts)
        else:
            result = storage(binding, output, target, args.dictionary, receipts)
        result.update({"status": "complete", "bindingSha256": file_sha(args.binding), "retried": False,
                       "commandReceipts": {row["label"]: file_sha(output / (row["label"] + ".receipt.json")) for row in receipts}})
        write(output / "result.json", result)
        emit("RESULT", result)
    except Exception as error:
        failure = {"status": "failed", "type": type(error).__name__, "message": str(error),
                   "mode": args.mode, "dictionary": args.dictionary, "retried": False,
                   "completedCommandLabels": [row["label"] for row in receipts if row["exitCode"] == 0],
                   "reachedCommandLabels": [row["label"] for row in receipts], "fullQualificationLaunched": False}
        write(output / "failure.json", failure)
        emit("FAILURE", failure)
        raise


if __name__ == "__main__":
    main()
