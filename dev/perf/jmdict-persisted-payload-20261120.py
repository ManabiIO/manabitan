#!/usr/bin/env python3
"""Two fresh Firefox imports; exhaustive term payload equality, no timing claim."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
import traceback
import zipfile


ROOT = Path(__file__).resolve().parents[2]
BASELINE = "d733d0efe53398bfc2b45985aa709ade54f5710a"
CANDIDATE = "a0f8e8e00d30823b8451248b3e6bab20b4640eb8"
CANDIDATE_TREE = "b0d18a0f0bbd096ebe9a18d09bf284d2684d4a65"
FIXTURE_SHA = "7681ee09f9edfef48a5e50773565da237424eb750bdb0e1e59660784ecd53e8a"
HELPER = "test/firefox/jmdict-persisted-payload-observation.js"
READER = "test/e2e/persisted-term-payload-digest.mjs"
MANIFEST = "dev/perf/jmdict-firefox-runtime/manifest.json"
ORDER = ["A", "B"]
PUBLISH_PATHS = sorted([
    ".github/workflows/jmdict-persisted-payload-20261120.yml",
    "dev/perf/jmdict-firefox-runtime/firefox-runtime.py", MANIFEST,
    "dev/perf/jmdict-persisted-payload-20261120.py",
    "test/e2e/persisted-term-payload-checks.mjs",
    "dev/perf/jmdict-persisted-payload-checks.py",
    READER, HELPER,
    "test/firefox/jmdict-persisted-payload-observation.test.js",
])
SHARED_PATHS = sorted([
    ".github/actions/setup/action.yml", "package.json", "package-lock.json",
    "dev/perf/host-environment.js", "dev/perf/dictionary-fixtures.js",
    "dev/perf/prepare-dictionaries.js", "test/perf/dictionaries.lock.json",
    "test/e2e/import-timing.js", "test/e2e/firefox-extension-base-url.js",
    "ext/js/dictionary/term-bank-experiments.js", "ext/js/core/safe-performance.js",
    "dev/bin/build.js", "dev/build-libs.js", "dev/data/manifest-variants.json",
])


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def read(path):
    return json.loads(Path(path).read_text())


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def object_digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def git(*args, cwd=ROOT):
    return subprocess.check_output(["git", *args], cwd=cwd, text=True).strip()


def command(label, argv, cwd, evidence, overrides=None, timeout=600):
    directory = evidence / "commands" / label
    directory.mkdir(parents=True, exist_ok=False)
    receipt = {"argv": list(map(str, argv)), "cwd": str(cwd), "overrides": overrides or {},
               "timeoutSeconds": timeout, "startedAt": time.time(), "complete": False}
    save(directory / "command.json", receipt)
    environment = {key: value for key, value in os.environ.items() if not key.startswith("MANABITAN_")}
    environment.update(overrides or {})
    process = None
    try:
        with (directory / "stdout.log").open("wb") as stdout, (directory / "stderr.log").open("wb") as stderr:
            process = subprocess.Popen(list(map(str, argv)), cwd=cwd, env=environment,
                                       stdout=stdout, stderr=stderr, start_new_session=True)
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
        receipt["finishedAt"] = time.time()
        save(directory / "command.json", receipt)
    return receipt


def required_command(label, argv, cwd, evidence):
    check(command(label, argv, cwd, evidence)["complete"], "Command failed: " + label)


def archive_inputs(paths, destination):
    hashes = {}
    for name in paths:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
        hashes[name] = digest(target)
    return hashes


def package_entries(path):
    with zipfile.ZipFile(path) as archive:
        names = [entry.filename for entry in archive.infolist() if not entry.is_dir()]
        check(len(names) == len(set(names)), "Duplicate release package members")
        return {name: hashlib.sha256(archive.read(name)).hexdigest() for name in sorted(names)}


def init(args):
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    check(not (evidence / "run-context.json").exists(), "Never overwrite an attempted diagnostic")
    save(evidence / "run-context.json", {"schemaVersion": 1, "diagnosticOnly": True,
        "authoritativeTiming": False, "peakMemoryClaim": False, "planned": ORDER,
        "baseline": BASELINE, "candidate": CANDIDATE, "candidateTree": CANDIDATE_TREE,
        "runId": os.environ.get("GITHUB_RUN_ID"), "attempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
        "helper": os.environ.get("GITHUB_SHA"), "ref": os.environ.get("GITHUB_REF")})


def self_check(args):
    evidence = args.evidence.resolve()
    required_command("check-reader-integration", ["node", "--test", "test/e2e/persisted-term-payload-checks.mjs"], ROOT, evidence)
    required_command("check-observer", ["npx", "vitest", "run", "test/firefox/jmdict-persisted-payload-observation.test.js"], ROOT, evidence)
    required_command("check-comparator", ["python3", "dev/perf/jmdict-persisted-payload-checks.py"], ROOT, evidence)


def verify_arm(arm, state):
    root = Path(arm["root"])
    check(git("rev-parse", "HEAD", cwd=root) == arm["source"], "Product commit changed")
    check(git("rev-parse", "HEAD^{tree}", cwd=root) == arm["tree"], "Product tree changed")
    check(git("diff", "--name-only", "HEAD", "--", cwd=root).splitlines() in ([], ["ext/legal-npm.html"]), "Unexpected tracked product overlay")
    check(digest(arm["package"]) == arm["packageSha256"], "Release package changed")
    for name, expected in arm["frozenFiles"].items():
        check(digest(root / name) == expected, "Product input changed: " + name)
    for name, expected in state["helperInputs"].items():
        check(digest(ROOT / name) == expected, "Diagnostic input changed: " + name)
    check(digest(state["fixturePath"]) == FIXTURE_SHA, "Fixture changed")
    check(digest(state["runtime"]["binary"]) == state["runtime"]["binarySha256"], "Firefox changed")
    check(digest(state["runtime"]["driver"]) == state["runtime"]["geckodriver"]["binarySha256"], "geckodriver changed")


def prepare(args):
    evidence = args.evidence.resolve()
    check(not (evidence / "preparation.json").exists(), "Never overwrite preparation")
    state = {"schemaVersion": 1, "complete": False, "planned": ORDER, "baseline": BASELINE,
             "candidate": CANDIDATE, "candidateTree": CANDIDATE_TREE, "arms": {}}
    save(evidence / "preparation.json", state)
    check(sys.platform == "linux", "Linux is required")
    check(subprocess.check_output(["node", "--version"], text=True).strip() == "v22.22.0", "Wrong Node version")
    helper = git("rev-parse", "HEAD")
    check(helper == os.environ["GITHUB_SHA"], "Unexpected diagnostic checkout")
    check(re.fullmatch(r"refs/heads/perf/jmdict-payload-20261120-ccf816-[a-z0-9-]+", os.environ["GITHUB_REF"]), "Unexpected diagnostic branch")
    check(git("rev-list", "--parents", "-n", "1", helper).split() == [helper, CANDIDATE], "Diagnostic needs the exact product parent")
    check(git("diff", "--name-only", "HEAD", "--").splitlines() in ([], ["ext/legal-npm.html"]), "Diagnostic checkout has tracked modifications")
    check(git("rev-parse", CANDIDATE + "^{tree}") == CANDIDATE_TREE, "Candidate tree mismatch")
    check(git("diff", "--name-only", CANDIDATE, helper).splitlines() == PUBLISH_PATHS, "Unexpected diagnostic source difference")
    manifest = read(ROOT / MANIFEST)
    plan = manifest["qualification"]
    check(plan["baseline"] == BASELINE and plan["candidate"] == CANDIDATE and plan["candidateTree"] == CANDIDATE_TREE, "Reused identity manifest has different product pins")
    source_paths = git("diff", "--name-only", BASELINE, CANDIDATE).splitlines()
    check(source_paths == sorted(plan["sourcePaths"]), "Candidate source exceeds the allowlist")
    check(not set(source_paths) & set(SHARED_PATHS), "Candidate changes shared diagnostic inputs")
    state.update({"helper": helper, "helperTree": git("rev-parse", "HEAD^{tree}"),
                  "sourcePaths": source_paths,
                  "helperInputs": archive_inputs(PUBLISH_PATHS, evidence / "helper-inputs"),
                  "sharedInputs": archive_inputs(SHARED_PATHS, evidence / "shared-inputs")})
    (evidence / "product.patch").write_text(git("diff", "--binary", BASELINE, CANDIDATE) + "\n")
    (evidence / "helper.patch").write_text(git("diff", "--binary", CANDIDATE, helper) + "\n")
    state["patchSha256"] = {name: digest(evidence / name) for name in ("product.patch", "helper.patch")}
    required_command("prepare-fixtures", ["node", "dev/perf/prepare-dictionaries.js"], ROOT, evidence)
    lock = read(ROOT / "test/perf/dictionaries.lock.json")
    fixture = lock["dictionaries"]["jmdict"]
    check(fixture["sha256"] == FIXTURE_SHA and fixture["termRows"] == 526942, "Wrong JMdict fixture")
    cache = ROOT / "builds/e2e-dictionary-cache"
    fixture_path = cache / fixture["cacheFile"]
    check(fixture_path.stat().st_size == fixture["sizeBytes"] and digest(fixture_path) == FIXTURE_SHA, "JMdict archive mismatch")
    state.update({"fixture": fixture, "fixturePath": str(fixture_path),
                  "fixtureLockSha256": digest(ROOT / "test/perf/dictionaries.lock.json")})
    state["expectedExperiments"] = json.loads(subprocess.check_output(["node", "--input-type=module", "-e",
        "import {snapshotTermBankExperiments} from './ext/js/dictionary/term-bank-experiments.js';console.log(JSON.stringify(snapshotTermBankExperiments()))"], cwd=ROOT, text=True))
    worktrees = Path(os.environ["RUNNER_TEMP"]) / "jmdict-payload-20261120-worktrees"
    worktrees.mkdir(exist_ok=False)
    maps = {}
    for label, source in (("A", BASELINE), ("B", CANDIDATE)):
        root = worktrees / label
        required_command("worktree-" + label, ["git", "worktree", "add", "--detach", str(root), source], ROOT, evidence)
        (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        (root / "builds").mkdir(exist_ok=True)
        (root / "builds/e2e-dictionary-cache").symlink_to(cache, target_is_directory=True)
        for name in (HELPER, READER):
            shutil.copyfile(ROOT / name, root / name)
        required_command("libraries-" + label, ["npm", "run", "build:libs"], root, evidence)
        shutil.copyfile(ROOT / "ext/legal-npm.html", root / "ext/legal-npm.html")
        required_command("package-" + label, ["node", "dev/bin/build.js", "--target", "firefox"], root, evidence)
        package = root / "builds/manabitan-firefox.zip"
        maps[label] = package_entries(package)
        save(evidence / f"{label}-package-entries.json", maps[label])
        tracked = git("ls-tree", "-r", "--name-only", source, cwd=root).splitlines()
        save(evidence / f"{label}-source-hashes.json", {name: digest(root / name) for name in tracked})
        frozen = sorted(set(SHARED_PATHS + source_paths + [HELPER, READER, "ext/legal-npm.html"]))
        state["arms"][label] = {"source": source, "tree": git("rev-parse", "HEAD^{tree}", cwd=root), "root": str(root),
            "package": str(package), "packageSha256": digest(package), "buildTarget": "firefox",
            "frozenFiles": {name: digest(root / name) for name in frozen if (root / name).is_file()}}
        for name, expected in state["sharedInputs"].items():
            check(digest(root / name) == expected, "Shared input differs: " + name)
    state["changedPackageEntries"] = sorted(name for name in set(maps["A"]) | set(maps["B"]) if maps["A"].get(name) != maps["B"].get(name))
    check(state["changedPackageEntries"] == sorted(plan["packagePaths"]), "Unexpected release package differences")
    state["packageManifestSha256"] = {label: digest(evidence / f"{label}-package-entries.json") for label in ORDER}
    state["sourceManifestSha256"] = {label: digest(evidence / f"{label}-source-hashes.json") for label in ORDER}
    receipt_path = Path(os.environ["MANABITAN_STUDY_FIREFOX_RUNTIME_RECEIPT"])
    check(digest(receipt_path) == manifest["browserRuntimes"]["firefox"]["receiptSha256"], "Wrong Firefox runtime receipt")
    runtime = read(receipt_path)
    runtime.update({"binary": os.environ["MANABITAN_STUDY_FIREFOX_BINARY"], "driver": os.environ["MANABITAN_STUDY_GECKODRIVER"]})
    check(runtime["binarySha256"] == manifest["browserRuntimes"]["firefox"]["binarySha256"], "Wrong pinned Firefox")
    check(runtime["release"] == manifest["browserRuntimes"]["firefox"]["version"] == "161.0b5" and runtime["applicationVersion"] == "161.0", "Wrong Firefox release/application version")
    state["runtime"] = runtime
    shutil.copyfile(receipt_path, evidence / "firefox-runtime.json")
    shutil.copyfile(receipt_path.with_name("source-artifact.json"), evidence / "firefox-source-artifact.json")
    for arm in state["arms"].values():
        verify_arm(arm, state)
    state["complete"] = True
    save(evidence / "preparation.json", state)


def integer(value, minimum=0):
    return type(value) is int and minimum <= value <= 9007199254740991


def validate_payload(value, expected_rows):
    check(value.get("schemaVersion") == 1 and value.get("inventoryStable") is True, "Unstable or unknown payload receipt")
    files, pairs = value.get("files", []), value.get("pairs", [])
    check(files and pairs, "Missing full payload files or generation pairs")
    paths = [item["path"] for item in files]
    check(paths == sorted(set(paths)), "Unsorted or duplicate payload paths")
    by_path = dict(zip(paths, files))
    content_indexes, records, indexes = [], set(), set()
    for item in files:
        name, kind = item["path"], item["kind"]
        check(integer(item["bytes"]), "Invalid persisted file size")
        for key in ("rawSha256", "normalizedSha256"):
            check(re.fullmatch(r"[0-9a-f]{64}", item.get(key, "")), "Invalid per-file SHA-256")
        if kind == "content":
            match = re.fullmatch(r"manabitan-term-content(?:\^([1-9][0-9]*))?\.bin", name)
            check(match is not None, "Unexpected content path")
            content_indexes.append(int(match[1] or 0))
            check(item.get("excludedRange") is None and item["rawSha256"] == item["normalizedSha256"], "Content bytes were normalized")
        else:
            check(kind in ("record", "index"), "Unexpected payload kind")
            suffix = r"\.mbtr" if kind == "record" else r"\.mbtr\.mbti"
            check(re.fullmatch(r"manabitan-term-records/dict-.+" + suffix, name), "Unexpected record/index path")
            expected = {"offset": 8 if kind == "record" else 24, "length": 16, "field": "shardGenerationId"}
            check(item.get("excludedRange") == expected, "Wrong normalized field")
            (records if kind == "record" else indexes).add(name)
    check(sorted(content_indexes) == list(range(len(content_indexes))) and content_indexes, "Missing content segments")
    check(len(pairs) == len(records) == len(indexes), "Incomplete descriptor/index pairing")
    seen_records, seen_indexes, rows = set(), set(), 0
    for pair in pairs:
        record, index = pair["descriptor"], pair["index"]
        check(record in records and index in indexes and index == record + ".mbti", "Invalid generation pair")
        check(record not in seen_records and index not in seen_indexes, "Duplicate generation pair")
        check(re.fullmatch(r"[0-9a-f]{32}", pair.get("generation", "")), "Invalid generation ID")
        check(integer(pair["rows"], 1) and integer(pair["chunkCount"], 1), "Invalid persisted header counts")
        check(by_path[record]["bytes"] >= 26 and by_path[index]["bytes"] >= 40 + pair["chunkCount"] * 40 + pair["rows"] * 8, "Implausible persisted file lengths")
        seen_records.add(record)
        seen_indexes.add(index)
        rows += pair["rows"]
    check(value.get("rowCount") == rows == expected_rows, "Incomplete persisted row coverage")
    check(value.get("fileCount") == len(files), "Wrong persisted file count")
    check(value.get("totalBytes") == sum(item["bytes"] for item in files), "Wrong persisted byte count")
    check(value.get("excludedByteCount") == len(pairs) * 32, "Extra excluded payload bytes")
    for prefix, field in (("raw", "rawSha256"), ("normalized", "normalizedSha256")):
        manifest = [{"path": item["path"], "bytes": item["bytes"], "sha256": item[field]} for item in files]
        check(value.get(prefix + "ManifestSha256") == object_digest(manifest), "Payload manifest hash mismatch: " + prefix)
    return {"rowCount": rows, "fileCount": len(files), "totalBytes": value["totalBytes"],
            "excludedByteCount": value["excludedByteCount"], "normalizedManifestSha256": value["normalizedManifestSha256"],
            "rawManifestSha256": value["rawManifestSha256"]}


def validate_observation(summary, arm, state):
    check(summary.get("completed") is True and summary.get("diagnosticOnly") is True, "Incomplete payload observation")
    check(summary.get("authoritativeTiming") is False and summary.get("peakMemoryClaim") is False, "Diagnostic makes a performance claim")
    check(summary.get("skippedVerification") is False and summary.get("error") is None and summary.get("cleanupErrors") == [] and summary.get("diagnosticErrors") == [], "Payload observation had errors or skipped checks")
    check(summary["source"]["commit"] == arm["source"] and summary["source"]["tree"] == arm["tree"], "Wrong observed product source")
    check(summary["package"]["sha256"] == arm["packageSha256"] and summary["package"]["buildTarget"] == "firefox", "Wrong observed release package")
    manifest = summary["package"]["manifest"]
    gecko = manifest["browser_specific_settings"]["gecko"]
    check(manifest["background"] == {"page": "background.html"} and gecko.get("id") == "{1e12d533-8e72-4ec5-9edc-cd50e26d7d43}" and "update_url" not in gecko, "Wrong Firefox release identity")
    fixture = state["fixture"]
    check(all(summary["fixture"].get(key) == value for key, value in fixture.items()), "Wrong observed dictionary")
    check(summary["fixture"]["lockSha256"] == state["fixtureLockSha256"], "Wrong observed dictionary lock")
    check(summary["runtime"]["binarySha256"] == state["runtime"]["binarySha256"] and summary["runtime"]["geckodriverSha256"] == state["runtime"]["geckodriver"]["binarySha256"] and summary["runtime"]["headless"] is False, "Wrong observed Firefox runtime")
    check(summary["browser"]["freshProfile"] is True and summary["browser"]["suppliedProfile"] is False, "Reused browser profile")
    check(summary["browser"]["version"] == state["runtime"]["applicationVersion"] == "161.0", "Wrong observed Firefox application version")
    environment = summary["productionEnvironment"]
    check(environment.get("flags") is None and environment.get("profiling") is False and environment.get("useSession") is not False and environment.get("disableIntegrityCounts") is not True and environment.get("sharedArrayBuffer") is True, "Changed production settings")
    check(summary["effectiveExperiments"] == state["expectedExperiments"], "Wrong effective experiments")
    check(summary["tooling"]["helperSha256"] == state["helperInputs"][HELPER] and summary["tooling"]["payloadReaderSha256"] == state["helperInputs"][READER] and summary["tooling"]["timingFileSha256"] == state["sharedInputs"]["test/e2e/import-timing.js"], "Wrong executed observer/reader")
    completion = summary["completion"]
    check(completion.get("currentOperationPostUi") is True and completion["trigger"] == "file-input-change" and completion["sequence"] > completion["sequenceBefore"] >= 0 and completion["errorCount"] == 0, "Missing current-operation finalization gate")
    check(summary["reload"]["browserRestarted"] is False and summary["reload"]["reimported"] is False and summary["reload"]["priorOrigin"] != summary["reload"]["nextOrigin"], "Extension realm did not reload")
    for label in ("beforeReload", "afterReload"):
        item = summary[label]
        check(len(item["dictionaryInfo"]) == 1 and item["dictionaryInfo"][0]["title"] == fixture["expectedTitle"] and item["dictionaryInfo"][0]["revision"] == fixture["revision"], "Wrong persisted dictionary metadata")
        check(len(item["counts"]["counts"]) == 1 and item["counts"]["counts"][0]["terms"] == fixture["termRows"] and item["probeCount"] == 12, "Incomplete semantic checks")
        check(item["storage"]["usesFallbackStorage"] is False and item["storage"]["openStorageDiagnostics"]["mode"] == "opfs-sahpool", "Non-OPFS semantic checks")
        check(item["semanticDigest"] == object_digest(item["semantics"]) and item["storageSampleDigest"] == object_digest(item["samples"]), "Corrupt semantic receipt")
        check(len(item["semantics"]) == len(item["samples"]) == len(summary["fixture"]["probes"]) == 12, "Missing semantic samples")
        for actual, probe in zip(item["semantics"], summary["fixture"]["probes"]):
            check(actual == {key: probe[key] for key in ("expression", "reading", "glossary")}, "Semantic source mismatch")
    check(summary["beforeReload"]["counts"] == summary["afterReload"]["counts"] and summary["beforeReload"]["semanticDigest"] == summary["afterReload"]["semanticDigest"] and summary["beforeReload"]["storageSampleDigest"] == summary["afterReload"]["storageSampleDigest"], "Semantic checks changed over reload")
    before, after = summary["payloadBeforeReload"], summary["payloadAfterReload"]
    result = validate_payload(before, fixture["termRows"])
    check(validate_payload(after, fixture["termRows"]) == result, "Persisted payload digests changed over reload")
    check(before["files"] == after["files"] and before["pairs"] == after["pairs"], "Persisted raw files or generations changed over reload")
    check(summary["payloadValidation"] == {**result, "rawEqualityOverReload": True, "normalizedEqualityOverReload": True}, "Wrong reload payload validation")
    return {**result, "profile": summary["browser"]["profile"], "browserVersion": summary["browser"]["version"]}


def compare_payloads(left, right, expected_rows):
    a, b = validate_payload(left, expected_rows), validate_payload(right, expected_rows)
    normalized = lambda value: [{"path": item["path"], "bytes": item["bytes"], "sha256": item["normalizedSha256"]} for item in value["files"]]
    check(normalized(left) == normalized(right), "Full persisted payload differs across arms")
    check(a["normalizedManifestSha256"] == b["normalizedManifestSha256"], "Normalized manifest digests differ across arms")
    return a["normalizedManifestSha256"]


def analyze(evidence):
    state = read(evidence / "preparation.json")
    run = read(evidence / "observations.json")
    context = read(evidence / "run-context.json")
    check(state.get("complete") is True and run.get("complete") is True, "Incomplete diagnostic")
    check(state["planned"] == run["planned"] == ORDER and [item["label"] for item in run["observations"]] == ORDER, "Missing, extra or reordered observations")
    check(state["baseline"] == BASELINE and state["candidate"] == CANDIDATE and state["candidateTree"] == CANDIDATE_TREE, "Wrong frozen products")
    check(context["helper"] == state["helper"] and context["baseline"] == BASELINE and context["candidate"] == CANDIDATE and context["planned"] == ORDER and context["diagnosticOnly"] is True and context["authoritativeTiming"] is False, "Changed initial diagnostic plan")
    check(sorted(state["helperInputs"]) == PUBLISH_PATHS and sorted(state["sharedInputs"]) == SHARED_PATHS, "Missing archived inputs")
    for group, directory in (("helperInputs", "helper-inputs"), ("sharedInputs", "shared-inputs")):
        for name, expected in state[group].items():
            check(digest(evidence / directory / name) == expected, "Archived input changed: " + name)
    manifest = read(evidence / "helper-inputs" / MANIFEST)
    check(manifest["qualification"]["baseline"] == BASELINE and manifest["qualification"]["candidate"] == CANDIDATE and manifest["qualification"]["candidateTree"] == CANDIDATE_TREE, "Archived product pins changed")
    check(state["runtime"]["binarySha256"] == manifest["browserRuntimes"]["firefox"]["binarySha256"], "Archived runtime pin changed")
    check(state["runtime"]["release"] == manifest["browserRuntimes"]["firefox"]["version"] == "161.0b5" and state["runtime"]["applicationVersion"] == "161.0", "Archived Firefox release/application version changed")
    fixture_lock = evidence / "shared-inputs/test/perf/dictionaries.lock.json"
    check(digest(fixture_lock) == state["fixtureLockSha256"] and read(fixture_lock)["dictionaries"]["jmdict"] == state["fixture"] and state["fixture"]["sha256"] == FIXTURE_SHA, "Archived fixture changed")
    for name, expected in state["patchSha256"].items():
        check(digest(evidence / name) == expected, "Archived patch changed")
    maps, sources, results, summaries = {}, {}, {}, {}
    for index, label in enumerate(ORDER):
        arm = state["arms"][label]
        check(arm["source"] == (BASELINE if label == "A" else CANDIDATE), "Changed source roles")
        if label == "B":
            check(arm["tree"] == CANDIDATE_TREE, "Changed candidate tree")
        check(digest(evidence / f"{label}-package-entries.json") == state["packageManifestSha256"][label], "Archived package manifest changed")
        check(digest(evidence / f"{label}-source-hashes.json") == state["sourceManifestSha256"][label], "Archived source manifest changed")
        maps[label] = read(evidence / f"{label}-package-entries.json")
        sources[label] = read(evidence / f"{label}-source-hashes.json")
        observation = run["observations"][index]
        receipt = read(evidence / "commands" / label / "command.json")
        check(observation.get("error") is None and receipt.get("complete") is True and receipt.get("exitCode") == 0 and not receipt.get("timedOut", False), "Observation failed: " + label)
        summaries[label] = read(evidence / "observations" / label / "summary.json")
        results[label] = validate_observation(summaries[label], arm, state)
        check(results[label] == observation["result"], "Live/offline validation differs")
    source_changes = sorted(name for name in set(sources["A"]) | set(sources["B"]) if sources["A"].get(name) != sources["B"].get(name))
    package_changes = sorted(name for name in set(maps["A"]) | set(maps["B"]) if maps["A"].get(name) != maps["B"].get(name))
    check(source_changes == state["sourcePaths"] == sorted(manifest["qualification"]["sourcePaths"]), "Wrong archived source difference")
    check(package_changes == state["changedPackageEntries"] == sorted(manifest["qualification"]["packagePaths"]), "Wrong archived package difference")
    check(results["A"]["profile"] != results["B"]["profile"], "Cross-arm profile reuse")
    check(results["A"]["browserVersion"] == results["B"]["browserVersion"], "Browser version changed")
    compare_payloads(summaries["A"]["payloadBeforeReload"], summaries["B"]["payloadBeforeReload"], state["fixture"]["termRows"])
    return {"complete": True, "diagnosticOnly": True, "authoritativeTiming": False, "peakMemoryClaim": False,
            "baseline": BASELINE, "candidate": CANDIDATE, "helper": state["helper"], "observations": 2,
            "rawEqualityOverReload": True, "normalizedEqualityAcrossArms": True,
            "firefoxRelease": state["runtime"]["release"], "firefoxApplicationVersion": state["runtime"]["applicationVersion"],
            "scope": "Every byte of all persisted term-content segments and term-record/index files; only paired 16-byte generation fields normalized across fresh imports. Extension reload, not browser restart. SQLite metadata and media excluded.",
            "arms": results}


def observe(args):
    evidence = args.evidence.resolve()
    state = read(evidence / "preparation.json")
    check(state.get("complete") is True, "Unprepared diagnostic")
    check(not (evidence / "observations.json").exists(), "Never overwrite attempted observations")
    run = {"complete": False, "planned": ORDER, "observations": []}
    save(evidence / "observations.json", run)
    for label in ORDER:
        arm = state["arms"][label]
        row = {"label": label, "source": arm["source"], "packageSha256": arm["packageSha256"], "error": None}
        run["observations"].append(row)
        save(evidence / "observations.json", run)
        try:
            verify_arm(arm, state)
            directory = evidence / "observations" / label
            overrides = {"MANABITAN_STUDY_SOURCE_ROOT": arm["root"], "MANABITAN_STUDY_SOURCE_SHA": arm["source"],
                "MANABITAN_STUDY_CACHE_DIR": str(Path(state["fixturePath"]).parent), "MANABITAN_STUDY_OUTPUT_DIR": str(directory),
                "MANABITAN_STUDY_PACKAGE": arm["package"], "MANABITAN_STUDY_PACKAGE_SHA256": arm["packageSha256"],
                "MANABITAN_STUDY_LEGAL_SHA256": arm["frozenFiles"]["ext/legal-npm.html"], "MANABITAN_STUDY_DICTIONARY": "jmdict",
                "MANABITAN_STUDY_FIREFOX_BINARY": state["runtime"]["binary"], "MANABITAN_STUDY_GECKODRIVER": state["runtime"]["driver"],
                "MANABITAN_STUDY_FIREFOX_HEADLESS": "0"}
            receipt = command(label, ["node", HELPER], Path(arm["root"]), evidence, overrides)
            check(receipt["complete"], "Firefox observation failed: " + label)
            row["result"] = validate_observation(read(directory / "summary.json"), arm, state)
            verify_arm(arm, state)
        except Exception as error:
            row["error"] = str(error)
        save(evidence / "observations.json", run)
    run["complete"] = True
    save(evidence / "observations.json", run)
    analyze_and_save(evidence)


def analyze_and_save(evidence):
    try:
        result = analyze(evidence)
    except Exception as error:
        result = {"complete": False, "diagnosticOnly": True, "authoritativeTiming": False,
                  "peakMemoryClaim": False, "error": str(error)}
        save(evidence / "analysis.json", result)
        raise
    save(evidence / "analysis.json", result)
    print(json.dumps(result), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("init", "check", "prepare", "observe", "analyze"))
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    phases = {"init": init, "check": self_check, "prepare": prepare, "observe": observe,
              "analyze": lambda value: analyze_and_save(value.evidence.resolve())}
    try:
        phases[args.phase](args)
    except Exception as error:
        save(args.evidence / f"{args.phase}-failure.json", {"phase": args.phase, "error": str(error), "traceback": traceback.format_exc()})
        raise


if __name__ == "__main__":
    main()
