#!/usr/bin/env python3
"""Frozen browser qualification with interleaved same-package controls.

All observations are attempted once. Analyze also works on a relocated artifact.
"""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import statistics
import subprocess
import sys
import threading
import time
import zipfile


ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "dev/perf/jmdict-firefox-runtime/manifest.json"
WORKFLOW = ".github/workflows/jmdict-final-20261120.yml"
HELPER = "test/firefox/jmdict-import-observation.js"
HARNESS_OVERLAYS = ["dev/perf/benchmark-support.js"]
PROTOCOL = "jmdict-final-20261120-v1"
ORDER = "B1 A1 D1 C1 A2 B2 B3 A3 C2 D2 A4 B4 B5 A5 D3 C3 A6 B6 B7 A7 C4 D4 A8 B8 B9 A9 D5 C5 A10 B10 B11 A11 C6 D6 A12 B12".split()
BASELINE = "d733d0efe53398bfc2b45985aa709ade54f5710a"
QUALIFIER_PATHS = sorted([WORKFLOW, HELPER, "test/firefox/jmdict-import-observation.test.js",
    "dev/perf/jmdict-firefox-runtime/firefox-runtime.py", "dev/perf/jmdict-firefox-runtime/manifest.json",
    "dev/perf/jmdict-final-20261120.py", "dev/perf/benchmark-support.js", "test/perf-experiment-receipts.test.js"])


def check(value, message):
    if not value:
        raise RuntimeError(message)


def read(path):
    return json.loads(Path(path).read_text())


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def object_digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def git(*args, cwd=ROOT):
    return subprocess.check_output(["git", *args], cwd=cwd, text=True).strip()


def host():
    result = {"platform": platform.platform(), "cpuCount": os.cpu_count(), "atUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    for name in ("cpuinfo", "meminfo", "loadavg"):
        path = Path("/proc") / name
        result[name] = path.read_text() if path.exists() else None
    return result


def memory_samples(pid, path, stopped):
    """Diagnostic only: include the wrapper and all discoverable descendants."""
    with path.open("x") as stream:
        while not stopped.is_set():
            start = time.monotonic()
            sample = {"startedEpochMs": time.time() * 1000, "rootPid": pid, "processes": [], "errors": [], "discovery": "proc-task-children"}
            pending, seen = [pid], set()
            parent_map = None
            while pending:
                current = pending.pop()
                if current in seen:
                    continue
                seen.add(current)
                root = Path("/proc") / str(current)
                try:
                    child_files = list((root / "task").glob("*/children"))
                    if not child_files:
                        sample["discovery"] = "proc-ppid-fallback"
                        if parent_map is None:
                            parent_map = {}
                            for stat in Path("/proc").glob("[0-9]*/stat"):
                                try:
                                    parent = int(stat.read_text().rsplit(")", 1)[1].split()[1])
                                    parent_map.setdefault(parent, []).append(int(stat.parent.name))
                                except (OSError, ValueError, IndexError):
                                    pass
                        pending.extend(parent_map.get(current, []))
                    for children in child_files:
                        try:
                            pending.extend(int(value) for value in children.read_text().split())
                        except (FileNotFoundError, ProcessLookupError):
                            pass
                    values = {}
                    for line in (root / "smaps_rollup").read_text().splitlines():
                        parts = line.split()
                        if parts[0] in ("Rss:", "Pss:"):
                            values[parts[0][:-1].lower() + "Bytes"] = int(parts[1]) * 1024
                    check(set(values) == {"rssBytes", "pssBytes"}, "Missing RSS/PSS")
                    sample["processes"].append({"pid": current, "name": (root / "comm").read_text().strip(), **values})
                except (FileNotFoundError, ProcessLookupError):
                    sample["errors"].append({"pid": current, "kind": "exited-during-sample"})
                except Exception as error:
                    sample["errors"].append({"pid": current, "kind": type(error).__name__, "message": str(error)})
            sample["completedEpochMs"] = time.time() * 1000
            for key in ("rssBytes", "pssBytes"):
                sample[key] = sum(item[key] for item in sample["processes"])
            stream.write(json.dumps(sample, separators=(",", ":")) + "\n")
            stream.flush()
            stopped.wait(max(0, 0.050 - (time.monotonic() - start)))


def command(label, argv, cwd, evidence, timeout=240, overrides=None, sample_memory=False):
    directory = evidence / "commands" / label
    directory.mkdir(parents=True, exist_ok=False)
    receipt = {"argv": list(map(str, argv)), "cwd": str(cwd), "startedAt": time.time(),
               "timeoutSeconds": timeout, "overrides": overrides or {}, "complete": False}
    save(directory / "command.json", receipt)
    env = {key: value for key, value in os.environ.items() if not key.startswith("MANABITAN_")}
    env.update(overrides or {})
    process, sampler = None, None
    stopped = threading.Event()
    try:
        with (directory / "stdout.log").open("wb") as out, (directory / "stderr.log").open("wb") as err:
            process = subprocess.Popen(list(map(str, argv)), cwd=cwd, env=env, stdout=out, stderr=err, start_new_session=True)
            if sample_memory:
                receipt["memorySampling"] = {"intervalMs": 50, "scope": "wrapper process plus descendants", "diagnosticOnly": True}
                sampler = threading.Thread(target=memory_samples, args=(process.pid, directory / "memory.jsonl", stopped), daemon=True)
                sampler.start()
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
        stopped.set()
        if sampler is not None:
            sampler.join(timeout=10)
            if sampler.is_alive():
                receipt["memorySamplingError"] = "Sampler did not stop"
        if process is not None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        receipt["finishedAt"] = time.time()
        save(directory / "command.json", receipt)
    return receipt


def required_command(label, argv, cwd, evidence, timeout=600):
    result = command(label, argv, cwd, evidence, timeout)
    check(result["complete"], f"Preparation command failed: {label}")


def package_entries(path):
    with zipfile.ZipFile(path) as archive:
        names = [item.filename for item in archive.infolist() if not item.is_dir()]
        check(len(names) == len(set(names)), "Duplicate package members")
        return {name: hashlib.sha256(archive.read(name)).hexdigest() for name in sorted(names)}


def verify_archived_runtime(evidence, state, manifest):
    """Supplemental audit checks; no change to the browser observer."""
    browser = state["browser"]
    lock = manifest["browserRuntimes"][browser]
    check(state["runtime"]["binarySha256"] == lock["binarySha256"], "Archived browser binary differs from pin")
    if browser == "chromium":
        expected = lock["version"]
        check(isinstance(expected, str) and re.fullmatch(r"\d+\.\d+\.\d+\.\d+", expected), "Invalid Chromium version pin")
        check(re.search(r"(?<![\d.])" + re.escape(expected) + r"(?![\d.])", state["runtime"]["version"]), "Prepared Chromium version differs from pin")
        return expected
    check(browser == "firefox", "Unknown runtime")
    path = evidence / "firefox-runtime.json"
    check(digest(path) == lock["receiptSha256"], "Archived Firefox runtime receipt differs from pin")
    receipt = read(path)
    check(receipt["schemaVersion"] == 1 and receipt["officialMozillaBuild"] is True and receipt["release"] == lock["version"] and receipt["binarySha256"] == lock["binarySha256"], "Archived Firefox receipt identity differs")
    check(state["runtime"] == {**receipt, "binary": state["runtime"]["binary"], "driver": state["runtime"]["driver"]}, "Prepared Firefox runtime differs from archived receipt")
    metadata = read(evidence / "firefox-source-artifact.json")
    expected_fields = {"id": lock["sourceArtifactId"], "name": lock["sourceArtifactName"], "size_in_bytes": lock["sourceArtifactBytes"], "digest": "sha256:" + lock["sourceArtifactSha256"], "expired": False}
    check(all(metadata.get(key) == value for key, value in expected_fields.items()), "Archived Firefox source artifact identity differs")
    check(metadata["workflow_run"]["id"] == lock["sourceRunId"] and metadata["workflow_run"]["head_sha"] == lock["sourceToolingCommit"], "Archived Firefox tooling source differs")
    expected = receipt["applicationVersion"]
    check(isinstance(expected, str) and re.fullmatch(r"\d+\.\d+(?:\.\d+)*", expected), "Invalid Firefox application version")
    return expected


def verify_observation_runtime(summary, raw, state, expected_version):
    """Bind observed versions and runtime hashes to the immutable runtime."""
    if state["browser"] == "chromium":
        versions = [summary.get("browserVersion"), summary["runs"][0].get("browserVersion"), raw.get("browserVersion")]
        check(all(value == expected_version for value in versions), "Chromium raw/run/summary version differs from pin")
    else:
        check(summary["browser"].get("version") == expected_version, "Firefox capability version differs from pinned application.ini")
        runtime = summary["runtime"]
        check(runtime["binarySha256"] == state["runtime"]["binarySha256"] and runtime["geckodriverSha256"] == state["runtime"]["geckodriver"]["binarySha256"], "Firefox observed runtime hashes differ")
        check(runtime["node"] == "v22.22.0", "Firefox observer used a different Node version")


def init(args):
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    check(not (evidence / "run-context.json").exists(), "Never overwrite an attempted job")
    save(evidence / "run-context.json", {"protocol": PROTOCOL, "runId": os.environ.get("GITHUB_RUN_ID"), "attempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
        "qualifier": os.environ.get("GITHUB_SHA"), "ref": os.environ.get("GITHUB_REF"),
        "browser": args.browser, "dictionary": args.dictionary, "order": ORDER, "host": host()})


def verify_arm(arm, state):
    root = Path(arm["root"])
    check(git("rev-parse", "HEAD", cwd=root) == arm["source"], "Product checkout changed")
    check(git("rev-parse", "HEAD^{tree}", cwd=root) == arm["tree"], "Product tree changed")
    tracked_changes = set(git("diff", "--name-only", "HEAD", "--", cwd=root).splitlines())
    active_overlays = state["appliedHarnessOverlays"]
    check(set(active_overlays) <= tracked_changes <= set(active_overlays + ["ext/legal-npm.html"]), "Unexpected or missing tracked harness overlay")
    check(digest(arm["package"]) == arm["packageSha256"], "Built package changed")
    for name, expected in arm["frozenFiles"].items():
        check(digest(root / name) == expected, f"Changed product or observer input: {name}")
    for name, expected in state["qualifierInputs"].items():
        check(digest(ROOT / name) == expected, f"Changed qualifier input: {name}")
    check(digest(state["runtime"]["binary"]) == state["runtime"]["binarySha256"], "Changed browser runtime")
    check(digest(state["fixturePath"]) == state["fixture"]["sha256"], "Changed fixture")


def prepare(args):
    evidence = args.evidence.resolve()
    check(not (evidence / "preparation.json").exists(), "Never overwrite preparation")
    manifest = read(MANIFEST)
    plan = manifest["qualification"]
    state = {"protocol": PROTOCOL, "complete": False, "browser": args.browser, "dictionary": args.dictionary, "order": ORDER,
             "manifestSha256": digest(MANIFEST), "hostBefore": host(), "arms": {}}
    save(evidence / "preparation.json", state)
    check(sys.platform == "linux", "Linux runner required")
    check(subprocess.check_output(["node", "--version"], text=True).strip() == "v22.22.0", "Wrong Node version")
    check(plan["baseline"] == BASELINE and plan["order"] == ORDER and plan["protocol"] == PROTOCOL and plan["pairCounts"] == {"B/A": 12, "D/C": 6}, "Changed frozen final plan")
    qualifier = git("rev-parse", "HEAD")
    check(qualifier == os.environ["GITHUB_SHA"], "Unexpected qualifier checkout")
    check(re.fullmatch(r"refs/heads/perf/jmdict-final-20261120-ccf816-[a-z0-9-]+", os.environ["GITHUB_REF"]), "Unexpected qualifier branch")
    parents = git("rev-list", "--parents", "-n", "1", qualifier).split()
    check(len(parents) == 2, "Qualifier needs exactly one product parent")
    candidate = parents[1]
    check(plan.get("candidate") == candidate, "Wrong candidate parent")
    check(plan.get("candidateTree") == git("rev-parse", candidate + "^{tree}"), "Wrong candidate tree")
    check(candidate != BASELINE, "A/B candidate must differ; C/D supply same-code control")
    subprocess.run(["git", "merge-base", "--is-ancestor", BASELINE, candidate], cwd=ROOT, check=True)
    check(git("diff", "--name-only", candidate, qualifier).splitlines() == QUALIFIER_PATHS, "Unexpected qualifier source difference")
    source_paths = git("diff", "--name-only", BASELINE, candidate).splitlines()
    check(source_paths == sorted(plan["sourcePaths"]), "Candidate source differs from frozen allowlist")
    check(plan["packagePaths"] and len(plan["packagePaths"]) == len(set(plan["packagePaths"])), "Missing package allowlist")
    state.update({"qualifier": qualifier, "candidate": candidate, "baseline": BASELINE,
                  "qualifierTree": git("rev-parse", "HEAD^{tree}"), "productSourcePaths": source_paths,
                  "qualifierInputs": {name: digest(ROOT / name) for name in QUALIFIER_PATHS}})
    shutil.copyfile(MANIFEST, evidence / "manifest.json")
    for name in QUALIFIER_PATHS:
        destination = evidence / "qualifier-inputs" / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, destination)
    (evidence / "product.patch").write_text(git("diff", "--binary", BASELINE, candidate) + "\n")
    (evidence / "qualifier.patch").write_text(git("diff", "--binary", candidate, qualifier) + "\n")
    # Every unchanged harness dependency is retained, not only its hash.
    shared_names = git("ls-tree", "-r", "--name-only", BASELINE, "dev/perf", "test/e2e", "test/chromium", "test/perf",
                       ".github/actions/setup", "package.json", "package-lock.json", "dev/bin/build.js", "dev/build-libs.js",
                       "dev/data/manifest-variants.json", "ext/js/core/safe-performance.js", "ext/js/dictionary/term-bank-experiments.js").splitlines()
    shared_names = [name for name in shared_names if name.endswith((".js", ".json", ".yml"))]
    check(not set(shared_names) & set(source_paths), "Candidate changes shared harness/policy inputs")
    check(sorted(plan["harnessOverlays"]) == HARNESS_OVERLAYS, "Changed explicit shared-harness scope")
    check(plan["harnessOverlayBrowsers"] == {"dev/perf/benchmark-support.js": ["chromium"]}, "Changed shared-harness browser scope")
    state["appliedHarnessOverlays"] = [name for name in HARNESS_OVERLAYS if args.browser in plan["harnessOverlayBrowsers"][name]]
    state["harnessOverlays"] = {}
    shared_bytes = {name: (ROOT / name).read_bytes() for name in shared_names}
    for name in HARNESS_OVERLAYS:
        original = subprocess.check_output(["git", "show", BASELINE + ":" + name], cwd=ROOT)
        check(subprocess.check_output(["git", "show", candidate + ":" + name], cwd=ROOT) == original, "Product changes overlaid harness")
        identity = {"baselineSha256": hashlib.sha256(original).hexdigest(), "qualifiedSha256": digest(ROOT / name)}
        check(identity == plan["harnessOverlays"][name], "Changed shared-harness overlay identity")
        state["harnessOverlays"][name] = identity
        destination = evidence / "baseline-shared-inputs" / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(original)
        if name not in state["appliedHarnessOverlays"]:
            shared_bytes[name] = original
    state["sharedInputs"] = {name: hashlib.sha256(value).hexdigest() for name, value in shared_bytes.items()}
    for name in shared_names:
        destination = evidence / "shared-inputs" / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(shared_bytes[name])
    required_command("receipt-policy-tests", ["npx", "vitest", "run", "test/perf-benchmark-support.test.js", "test/perf-experiment-receipts.test.js"], ROOT, evidence)
    required_command("prepare-dictionaries", ["node", "dev/perf/prepare-dictionaries.js"], ROOT, evidence)
    cache = ROOT / "builds/e2e-dictionary-cache"
    lock = read(ROOT / "test/perf/dictionaries.lock.json")
    fixture = lock["dictionaries"][args.dictionary]
    state["fixture"] = fixture
    state["fixtureLockSha256"] = digest(ROOT / "test/perf/dictionaries.lock.json")
    state["fixturePath"] = str(cache / fixture["cacheFile"])
    for item in lock["dictionaries"].values():
        file = cache / item["cacheFile"]
        check(file.stat().st_size == item["sizeBytes"] and digest(file) == item["sha256"], "Pinned archive mismatch")
    with zipfile.ZipFile(state["fixturePath"]) as archive:
        banks = [entry for entry in archive.infolist() if re.fullmatch(r"term_bank_\d+\.json", entry.filename)]
        state["sourceWork"] = {"banks": len(banks), "rows": fixture["termRows"],
            "parserSourceCompressedBytes": sum(entry.compress_size for entry in banks),
            "parserSourceTransferredBytes": sum(entry.compress_size for entry in banks),
            "parserSourceUncompressedBytes": sum(entry.file_size for entry in banks)}
    expected = subprocess.check_output(["node", "--input-type=module", "-e",
        "import {snapshotTermBankExperiments} from './ext/js/dictionary/term-bank-experiments.js';console.log(JSON.stringify(snapshotTermBankExperiments()))"], cwd=ROOT, text=True)
    state["expectedExperiments"] = json.loads(expected)
    target = "chrome" if args.browser == "chromium" else "firefox"
    worktrees = Path(os.environ["RUNNER_TEMP"]) / f"jmdict-20261120-{args.browser}-{args.dictionary}"
    worktrees.mkdir(exist_ok=False)
    maps = {}
    for arm, source in (("A", BASELINE), ("B", candidate)):
        root = worktrees / arm
        required_command("worktree-" + arm, ["git", "worktree", "add", "--detach", str(root), source], ROOT, evidence)
        (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        (root / "builds").mkdir(exist_ok=True)
        (root / "builds/e2e-dictionary-cache").symlink_to(cache, target_is_directory=True)
        shutil.copyfile(ROOT / HELPER, root / HELPER)
        for name in state["appliedHarnessOverlays"]:
            shutil.copyfile(ROOT / name, root / name)
        required_command("libraries-" + arm, ["npm", "run", "build:libs"], root, evidence)
        shutil.copyfile(ROOT / "ext/legal-npm.html", root / "ext/legal-npm.html")
        required_command("package-" + arm, ["node", "dev/bin/build.js", "--target", target], root, evidence)
        package = root / f"builds/manabitan-{target}.zip"
        maps[arm] = package_entries(package)
        save(evidence / f"{arm}-package-entries.json", maps[arm])
        tracked = git("ls-tree", "-r", "--name-only", source, cwd=root).splitlines()
        save(evidence / f"{arm}-source-hashes.json", {name: digest(root / name) for name in tracked})
        frozen = sorted(set(shared_names + source_paths + [HELPER, "ext/legal-npm.html"]))
        state["arms"][arm] = {"source": source, "tree": git("rev-parse", "HEAD^{tree}", cwd=root), "root": str(root),
            "package": str(package), "packageSha256": digest(package), "buildTarget": target,
            "frozenFiles": {name: digest(root / name) for name in frozen if (root / name).is_file()}}
        for name, expected_hash in state["sharedInputs"].items():
            check(digest(root / name) == expected_hash, "Changed shared input in product: " + name)
    changed_entries = sorted(name for name in set(maps["A"]) | set(maps["B"]) if maps["A"].get(name) != maps["B"].get(name))
    check(changed_entries == sorted(plan["packagePaths"]), "Unexpected release package differences: " + str(changed_entries))
    state["changedPackageEntries"] = changed_entries
    state["packageEntryManifestSha256"] = {arm: digest(evidence / f"{arm}-package-entries.json") for arm in ("A", "B")}
    state["sourceManifestSha256"] = {arm: digest(evidence / f"{arm}-source-hashes.json") for arm in ("A", "B")}
    state["patchSha256"] = {name: digest(evidence / name) for name in ("product.patch", "qualifier.patch")}
    state["armSources"] = {"A": "A", "B": "B", "C": "A", "D": "A"}
    if args.browser == "chromium":
        binary = subprocess.check_output(["node", "--input-type=module", "-e", "import {chromium} from 'playwright';console.log(chromium.executablePath())"], cwd=ROOT, text=True).strip()
        runtime = {"binary": binary, "binarySha256": digest(binary), "version": subprocess.check_output([binary, "--version"], text=True).strip()}
        check(runtime["binarySha256"] == manifest["browserRuntimes"]["chromium"]["binarySha256"], "Wrong Chromium binary")
        check("153.0.8010.12" in runtime["version"], "Wrong Chromium version")
    else:
        receipt_path = Path(os.environ["MANABITAN_STUDY_FIREFOX_RUNTIME_RECEIPT"])
        check(digest(receipt_path) == manifest["browserRuntimes"]["firefox"]["receiptSha256"], "Wrong Firefox receipt")
        runtime = read(receipt_path)
        runtime.update({"binary": os.environ["MANABITAN_STUDY_FIREFOX_BINARY"], "driver": os.environ["MANABITAN_STUDY_GECKODRIVER"]})
        check(digest(runtime["binary"]) == runtime["binarySha256"], "Wrong Firefox binary")
        check(digest(runtime["driver"]) == runtime["geckodriver"]["binarySha256"], "Wrong geckodriver")
        shutil.copyfile(receipt_path, evidence / "firefox-runtime.json")
        shutil.copyfile(receipt_path.with_name("source-artifact.json"), evidence / "firefox-source-artifact.json")
    state["runtime"] = runtime
    state["expectedBrowserVersion"] = verify_archived_runtime(evidence, state, manifest)
    for arm in state["arms"].values():
        verify_arm(arm, state)
    state["complete"] = True
    state["hostAfter"] = host()
    save(evidence / "preparation.json", state)


def executed_path(debug, state):
    fixture = state["fixture"]
    check(debug.get("hasResult") is True and debug.get("resultTitle") == fixture["expectedTitle"], "Wrong imported title")
    check(debug.get("errorCount") == 0 and debug.get("addSettingsErrorCount") == 0, "Import reported errors")
    check(debug.get("usesFallbackStorage") is False and debug.get("openStorageDiagnostics", {}).get("mode") == "opfs-sahpool", "Expected actual OPFS")
    phases = debug.get("importerPhaseTimings", [])
    terms = [phase for phase in phases if phase.get("phase", "").startswith("term-file")]
    check(terms, "Missing term work")
    for key, value in state["sourceWork"].items():
        if key == "banks":
            continue
        check(sum(phase.get("details", {}).get(key, 0) for phase in terms) == value, "Wrong source work: " + key)
    receipts = 0
    roles = set()
    bank_phases = [phase for phase in phases if phase.get("phase") == "import-data-banks"]
    check(len(bank_phases) == 1, "Missing or duplicate parser policy context")
    bank_details = bank_phases[0].get("details") or {}
    for phase in phases:
        details = phase.get("details") or {}
        for key in ("parserExperiments", "fastPathParserExperiments", "fastPathParserEffectiveExperiments", "compressionExperiments"):
            if key not in details:
                continue
            receipts += 1
            roles.add(key)
            expected = dict(state["expectedExperiments"])
            effective = key in ("parserExperiments", "fastPathParserEffectiveExperiments")
            prefix = "parser" if key == "parserExperiments" else "fastPathParser"
            source_bytes, workers = details.get(prefix + "SourceUncompressedBytes"), details.get(prefix + "ParallelWorkerCount")
            large_projected_native = (effective and bank_details.get("useMediaPipeline") is True and
                bank_details.get("hasArchiveImageMediaFiles") is True and type(workers) is int and workers > 0 and
                prefix + "ParallelSkipReason" in details and details[prefix + "ParallelSkipReason"] is None and
                type(source_bytes) is int and source_bytes >= 512 * 1024 * 1024)
            if large_projected_native:
                expected["experimentalNativeEscapedKeys"] = True
            check(details[key] == expected, "Wrong production receipt for role: " + key)
    check(receipts >= 4 and roles == {"parserExperiments", "fastPathParserExperiments", "fastPathParserEffectiveExperiments", "compressionExperiments"}, "Missing requested/effective/compression receipts")
    for phase in terms:
        for key in ("parserFusedFallbacks", "dedupNativeFallbackCount", "parserDiscardedFusedRows"):
            check(phase["details"].get(key) == 0, "Fallback or missing path receipt: " + key)
    final = [phase["details"] for phase in phases if phase.get("phase") == "bulk-finalization"]
    check(len(final) == 1 and final[0].get("ok") is True and final[0].get("published") is True and final[0].get("housekeepingErrors") == [], "Unclean publication")


def extract(directory, arm, state):
    summary = read(directory / "summary.json")
    raw = None
    fixture = state["fixture"]
    if state["browser"] == "chromium":
        check(summary.get("schemaVersion") == 3 and summary.get("dictionary") == state["dictionary"], "Wrong Chromium summary")
        check(summary.get("gitSha") == arm["source"] and summary.get("buildTarget") == "chrome", "Wrong Chromium source/target")
        check(summary.get("fixture") == fixture and summary.get("importFlags") is None and summary.get("authoritativeTiming") is True and summary.get("traceEnabled") is False, "Wrong Chromium settings")
        check(len(summary.get("runs", [])) == 1, "Expected one observation")
        run = summary["runs"][0]
        raw = read(directory / "run-1.json")
        check(raw.get("status") == "success" and raw.get("skippedVerification") is False, "Chromium skipped or failed")
        check(raw.get("packageSha256") == run.get("packageSha256") == arm["packageSha256"], "Wrong Chromium package")
        benchmark = raw["benchmark"]
        for key, expected in {"dictionary": state["dictionary"], "pinnedDictionaries": True, "productionImportDefaults": True,
                              "traceEnabled": False, "authoritativeTiming": True, "phaseProfiling": False,
                              "phaseScreenshots": False, "processSampling": False, "importFlags": None}.items():
            check(benchmark.get(key) == expected, "Wrong Chromium benchmark setting: " + key)
        phases = [phase for phase in raw["phases"] if phase.get("name") == fixture["label"] + ": total import"]
        check(len(phases) == 1, "Missing/duplicate import interval")
        timing = phases[0]["data"]["browserTiming"]
        debug = phases[0]["data"]["importDebug"]
        check(debug == run["importDebug"], "Summary/raw import diagnostics disagree")
        validation = run["validation"]
        check(validation == benchmark["validation"], "Summary/raw validation disagree")
        restart = validation.get("restart", {})
        for item in (validation, restart):
            check(item.get("termRows") == fixture["termRows"] and item.get("contentReadable") is True and item.get("probeCount", 0) >= 12, "Incomplete Chromium readback/restart")
        check(validation.get("title") == fixture["expectedTitle"] and validation.get("revision") == fixture["revision"], "Wrong persisted dictionary")
        content_digest = validation["outputDigestSha256"]
        check(re.fullmatch(r"[0-9a-f]{64}", content_digest), "Invalid content digest")
        version = summary["browserVersion"]
        elapsed = run["totalImportMs"]
        profile = None
    else:
        check(summary.get("completed") is True and summary.get("authoritativeTiming") is True and summary.get("skippedVerification") is False, "Incomplete Firefox observation")
        check(summary.get("error") is None and summary.get("cleanupErrors") == [] and summary.get("diagnosticErrors") == [], "Firefox error")
        check(summary["source"]["commit"] == arm["source"] and summary["source"]["tree"] == arm["tree"], "Wrong Firefox source")
        check(summary["package"]["sha256"] == arm["packageSha256"] and summary["package"].get("buildTarget") == "firefox", "Wrong Firefox release package")
        package_manifest = summary["package"]["manifest"]
        check(package_manifest["browser_specific_settings"]["gecko"]["id"] == "{1e12d533-8e72-4ec5-9edc-cd50e26d7d43}", "Wrong release ID")
        check(package_manifest["background"] == {"page": "background.html"}, "Wrong Firefox background")
        check(all(summary["fixture"].get(key) == value for key, value in fixture.items()), "Wrong Firefox fixture")
        check(summary["fixture"]["lockSha256"] == state["fixtureLockSha256"], "Wrong Firefox lock")
        check(summary["runtime"]["binarySha256"] == state["runtime"]["binarySha256"] and summary["runtime"]["geckodriverSha256"] == state["runtime"]["geckodriver"]["binarySha256"] and summary["runtime"]["headless"] is False, "Wrong Firefox runtime")
        environment = summary["productionEnvironment"]
        check(environment.get("flags") is None and environment.get("profiling") is False and environment.get("useSession") is not False and environment.get("disableIntegrityCounts") is not True and environment.get("sharedArrayBuffer") is True, "Changed Firefox production defaults")
        check(summary["browser"].get("freshProfile") is True and summary["browser"].get("suppliedProfile") is False, "Firefox profile was reused")
        profile = summary["browser"]["profile"]
        check(summary["reload"]["browserRestarted"] is False and summary["reload"]["reimported"] is False and summary["reload"]["priorOrigin"] != summary["reload"]["nextOrigin"], "Firefox realm did not reload")
        before, after = summary["beforeReload"], summary["afterReload"]
        for item in (before, after):
            check(item["counts"]["counts"][0]["terms"] == fixture["termRows"] and item["probeCount"] == 12, "Incomplete Firefox readback")
            check(item["storage"]["usesFallbackStorage"] is False and item["storage"]["openStorageDiagnostics"]["mode"] == "opfs-sahpool", "Firefox readback used fallback")
            check(item["semanticDigest"] == object_digest(item["semantics"]) and item["storageSampleDigest"] == object_digest(item["samples"]), "Firefox readback digest mismatch")
            check(len(item["semantics"]) == 12 and len(item["samples"]) == 12, "Missing Firefox probes")
            for actual, probe in zip(item["semantics"], summary["fixture"]["probes"]):
                check(actual == {key: probe[key] for key in ("expression", "reading", "glossary")}, "Firefox semantic source mismatch")
        check(before["counts"] == after["counts"] and before["semanticDigest"] == after["semanticDigest"] and before["storageSampleDigest"] == after["storageSampleDigest"], "Firefox persistence changed")
        validation = summary["validation"]
        check(validation.get("extensionReloadVerified") is True and validation.get("contentReadable") is True, "Unverified Firefox reload")
        content_digest = before["semanticDigest"] + ":" + before["storageSampleDigest"]
        timing = summary["importResult"]["timing"]
        debug = summary["importResult"]["debug"]
        version = summary["browser"]["version"]
        elapsed = summary["totalImportMs"]
    verify_observation_runtime(summary, raw, state, state["expectedBrowserVersion"])
    check(timing.get("trigger") == "file-input-change" and timing.get("errorCount") == 0 and timing["sequence"] > timing["sequenceBefore"] >= 0, "Wrong current-operation timer")
    computed = timing["completedAtMs"] - timing["startedAtMs"]
    check(type(elapsed) in (float, int) and math.isfinite(elapsed) and elapsed > 0 and abs(computed - elapsed) < 1e-8, "Wrong elapsed arithmetic")
    executed_path(debug, state)
    return {"totalImportMs": elapsed, "browserVersion": version, "contentDigest": content_digest,
            "profile": profile, "summarySha256": digest(directory / "summary.json"), "validation": validation}


def observation_command(label, directory, arm, state, evidence, trace=False):
    if state["browser"] == "chromium":
        argv = ["node", "dev/perf/import-benchmark.js", state["dictionary"], "--runs", "1", "--no-build", "--build-target", "chrome", "--output", str(directory)]
        if trace:
            argv.append("--trace")
        overrides = {}
    else:
        argv = ["node", HELPER]
        overrides = {"MANABITAN_STUDY_SOURCE_ROOT": arm["root"], "MANABITAN_STUDY_SOURCE_SHA": arm["source"],
            "MANABITAN_STUDY_CACHE_DIR": str(Path(state["fixturePath"]).parent), "MANABITAN_STUDY_OUTPUT_DIR": str(directory),
            "MANABITAN_STUDY_PACKAGE": arm["package"], "MANABITAN_STUDY_PACKAGE_SHA256": arm["packageSha256"],
            "MANABITAN_STUDY_LEGAL_SHA256": arm["frozenFiles"]["ext/legal-npm.html"], "MANABITAN_STUDY_DICTIONARY": state["dictionary"],
            "MANABITAN_STUDY_FIREFOX_BINARY": state["runtime"]["binary"], "MANABITAN_STUDY_GECKODRIVER": state["runtime"]["driver"],
            "MANABITAN_STUDY_FIREFOX_HEADLESS": "0"}
    return command(label, argv, Path(arm["root"]), evidence, timeout=100 if not trace else 180, overrides=overrides, sample_memory=trace)


def statistics_for(pairs):
    changes = [100 * (b / a - 1) for a, b in pairs]
    return {"pairs": len(pairs), "pairedChangesPercent": changes, "medianPairedChangePercent": statistics.median(changes),
            "equalWorkChangePercent": 100 * (sum(b for a, b in pairs) / sum(a for a, b in pairs) - 1),
            "meanSavingMs": statistics.mean(a - b for a, b in pairs), "fasterPairs": sum(b < a for a, b in pairs)}


def analyze(evidence):
    state = read(evidence / "preparation.json")
    cohort = read(evidence / "cohort.json")
    check(state["protocol"] == PROTOCOL and state["complete"] and cohort["complete"] and state["order"] == ORDER and cohort["planned"] == ORDER, "Incomplete or changed plan")
    check(digest(evidence / "manifest.json") == state["manifestSha256"], "Changed archived manifest")
    manifest = read(evidence / "manifest.json")
    check(manifest["qualification"]["protocol"] == PROTOCOL and manifest["qualification"]["pairCounts"] == {"B/A": 12, "D/C": 6}, "Changed archived final identity")
    check(sorted(state["harnessOverlays"]) == HARNESS_OVERLAYS and state["harnessOverlays"] == manifest["qualification"]["harnessOverlays"], "Changed archived shared-harness scope")
    check(manifest["qualification"]["harnessOverlayBrowsers"] == {"dev/perf/benchmark-support.js": ["chromium"]}, "Changed archived browser scope")
    expected_overlays = HARNESS_OVERLAYS if state["browser"] == "chromium" else []
    check(state["appliedHarnessOverlays"] == expected_overlays, "Changed applied harness overlays")
    for name, identity in state["harnessOverlays"].items():
        check(digest(evidence / "baseline-shared-inputs" / name) == identity["baselineSha256"], "Changed original shared-harness bytes")
        check(digest(evidence / "qualifier-inputs" / name) == identity["qualifiedSha256"], "Changed qualified shared-harness bytes")
        expected_hash = identity["qualifiedSha256"] if name in expected_overlays else identity["baselineSha256"]
        check(digest(evidence / "shared-inputs" / name) == expected_hash, "Changed browser-selected shared-harness bytes")
    check(manifest["qualification"]["order"] == ORDER and manifest["qualification"]["sourcePaths"] == state["productSourcePaths"], "Changed archived plan")
    check(manifest["qualification"]["baseline"] == BASELINE and manifest["qualification"].get("candidate") == state["candidate"], "Changed archived product pin")
    check(state["baseline"] == BASELINE and state["armSources"] == {"A": "A", "B": "B", "C": "A", "D": "A"}, "Changed source roles")
    check(state["arms"]["A"]["source"] == BASELINE and state["arms"]["B"]["source"] == state["candidate"], "Changed product identities")
    check(manifest["qualification"].get("candidateTree") == state["arms"]["B"]["tree"], "Changed archived candidate tree")
    check(state["runtime"]["binarySha256"] == manifest["browserRuntimes"][state["browser"]]["binarySha256"], "Changed archived browser pin")
    check(state["expectedBrowserVersion"] == verify_archived_runtime(evidence, state, manifest), "Changed expected browser version")
    lock_path = evidence / "shared-inputs/test/perf/dictionaries.lock.json"
    check(digest(lock_path) == state["fixtureLockSha256"] and read(lock_path)["dictionaries"][state["dictionary"]] == state["fixture"], "Changed archived fixture")
    maps, sources = {}, {}
    for arm in ("A", "B"):
        path = evidence / f"{arm}-package-entries.json"
        check(digest(path) == state["packageEntryManifestSha256"][arm], "Changed archived package entries")
        check(digest(evidence / f"{arm}-source-hashes.json") == state["sourceManifestSha256"][arm], "Changed archived source manifest")
        sources[arm] = read(evidence / f"{arm}-source-hashes.json")
        maps[arm] = read(path)
    changed_sources = sorted(name for name in set(sources["A"]) | set(sources["B"]) if sources["A"].get(name) != sources["B"].get(name))
    check(changed_sources == state["productSourcePaths"], "Archived source differences exceed allowlist")
    changed = sorted(name for name in set(maps["A"]) | set(maps["B"]) if maps["A"].get(name) != maps["B"].get(name))
    check(changed == state["changedPackageEntries"] == sorted(manifest["qualification"]["packagePaths"]), "Wrong package allowlist")
    for name, expected in state["patchSha256"].items():
        check(digest(evidence / name) == expected, "Changed archived source patch")
    check(sorted(state["qualifierInputs"]) == QUALIFIER_PATHS, "Missing qualifier input")
    for name, expected in state["qualifierInputs"].items():
        check(digest(evidence / "qualifier-inputs" / name) == expected, "Changed archived qualifier")
    for name, expected in state["sharedInputs"].items():
        check(digest(evidence / "shared-inputs" / name) == expected, "Changed archived harness")
    check([row["label"] for row in cohort["observations"]] == ORDER, "Missing, extra or reordered observations")
    rows, errors = {}, []
    for row in cohort["observations"]:
        label = row["label"]
        try:
            receipt = read(evidence / "commands" / label / "command.json")
            check(receipt["complete"] and receipt.get("exitCode") == 0 and not receipt.get("timedOut", False), "Command failed")
            check(row.get("error") is None, "Live observation failed: " + str(row.get("error")))
            arm = state["arms"][state["armSources"][label[0]]]
            check(row["source"] == arm["source"] and row["packageSha256"] == arm["packageSha256"], "Wrong observation identity")
            check("memorySampling" not in receipt, "Timed cohort was sampled")
            result = extract(evidence / "observations" / label, arm, state)
            check(result == row["result"], "Live and offline receipts differ")
            rows[label] = result
        except Exception as error:
            errors.append({"label": label, "error": str(error)})
    if not errors:
        check(len({item["browserVersion"] for item in rows.values()}) == 1, "Browser versions differ")
        check(len({item["contentDigest"] for item in rows.values()}) == 1, "Cross-arm content differs")
        if state["browser"] == "firefox":
            check(len({item["profile"] for item in rows.values()}) == len(ORDER), "Firefox profile reused")
    result = {"protocol": PROTOCOL, "complete": not errors, "browser": state["browser"], "dictionary": state["dictionary"], "baseline": state["baseline"],
        "candidate": state["candidate"], "qualifier": state["qualifier"], "observations": len(cohort["observations"]), "errors": errors,
        "scope": "All planned observations retained; C/D use the same prebuilt baseline package. Firefox persistence is extension reload, Chromium is browser restart.",
        "comparisons": None}
    if not errors:
        result["comparisons"] = {"B/A": statistics_for([(rows[f"A{i}"]["totalImportMs"], rows[f"B{i}"]["totalImportMs"]) for i in range(1, 13)]),
                                 "D/C": statistics_for([(rows[f"C{i}"]["totalImportMs"], rows[f"D{i}"]["totalImportMs"]) for i in range(1, 7)])}
    return result


def memory_analysis(evidence, arm_id, state):
    """Never substitute these profiled runs for authoritative elapsed samples."""
    raw = read(evidence / "traces" / arm_id / "run-1.json")
    check(raw["status"] == "success" and raw["benchmark"]["traceEnabled"] is True and raw["benchmark"]["authoritativeTiming"] is False, "Not a separate diagnostic run")
    check(raw["packageSha256"] == state["arms"][arm_id]["packageSha256"], "Diagnostic package changed")
    phases = [p for p in raw["phases"] if p["name"] == state["fixture"]["label"] + ": total import"]
    check(len(phases) == 1, "Missing diagnostic import interval")
    windows = [p for p in phases[0]["data"]["importDebug"]["localPhaseTimings"] if p["phase"] == "worker-import-dictionary"]
    check(len(windows) == 1, "Missing worker import window")
    start, end = windows[0]["startEpochMs"], windows[0]["endEpochMs"]
    all_samples = [json.loads(line) for line in (evidence / "commands" / ("trace-" + arm_id) / "memory.jsonl").read_text().splitlines()]
    samples = [sample for sample in all_samples if start <= sample["startedEpochMs"] <= sample["completedEpochMs"] <= end and sample["processes"]]
    check(samples, "No complete memory samples inside worker interval")
    return {"arm": arm_id, "diagnosticOnly": True, "scope": "wrapper plus descendant processes; full samples contained in worker-import interval",
            "windowStartEpochMs": start, "windowEndEpochMs": end, "allSamples": len(all_samples), "windowSamples": len(samples),
            "samplesWithErrors": sum(bool(sample["errors"]) for sample in samples),
            "peakPssBytes": max(sample["pssBytes"] for sample in samples), "peakRssBytes": max(sample["rssBytes"] for sample in samples),
            "medianPssBytes": statistics.median(sample["pssBytes"] for sample in samples),
            "sampledPeakIsLowerBound": True, "timingExcluded": True}


def measure(args):
    evidence = args.evidence.resolve()
    state = read(evidence / "preparation.json")
    check(state["complete"] and state["manifestSha256"] == digest(MANIFEST), "Unprepared or changed plan")
    check((state["browser"], state["dictionary"]) == (args.browser, args.dictionary), "Changed cell")
    check(not (evidence / "cohort.json").exists(), "Never append to or retry a cohort")
    cohort = {"planned": ORDER, "observations": [], "complete": False}
    save(evidence / "cohort.json", cohort)
    for label in ORDER:
        arm = state["arms"][state["armSources"][label[0]]]
        directory = evidence / "observations" / label
        directory.mkdir(parents=True, exist_ok=False)
        row = {"label": label, "source": arm["source"], "packageSha256": arm["packageSha256"], "hostBefore": host(), "error": None}
        try:
            verify_arm(arm, state)
            receipt = observation_command(label, directory, arm, state, evidence)
            check(receipt["complete"], "Observation command failed")
            row["result"] = extract(directory, arm, state)
            verify_arm(arm, state)
        except Exception as error:
            row["error"] = str(error)
        row["hostAfter"] = host()
        cohort["observations"].append(row)
        save(evidence / "cohort.json", cohort)
        print(json.dumps({"label": label, "ms": row.get("result", {}).get("totalImportMs"), "error": row["error"]}), flush=True)
    cohort["complete"] = True
    save(evidence / "cohort.json", cohort)
    analysis = analyze(evidence)
    save(evidence / "analysis.json", analysis)
    if analysis["complete"] and state["browser"] == "chromium":
        traces = []
        for arm_id in ("A", "B"):
            arm = state["arms"][arm_id]
            trace = {"arm": arm_id, "outsideTimedCohort": True, "error": None}
            try:
                verify_arm(arm, state)
                receipt = observation_command("trace-" + arm_id, evidence / "traces" / arm_id, arm, state, evidence, trace=True)
                check(receipt["complete"], "Diagnostic trace command failed")
                verify_arm(arm, state)
                trace["memory"] = memory_analysis(evidence, arm_id, state)
            except Exception as error:
                trace["error"] = str(error)
            traces.append(trace)
        save(evidence / "trace-status.json", traces)
    print(json.dumps(analysis, indent=2), flush=True)
    check(analysis["complete"], "Cohort retained but failed qualification")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("init", "prepare", "measure", "analyze"))
    parser.add_argument("--browser", choices=("chromium", "firefox"), default="chromium")
    parser.add_argument("--dictionary", choices=("jmdict", "jmnedict", "jitendex"), default="jmdict")
    parser.add_argument("--evidence", required=True, type=Path)
    args = parser.parse_args()
    if args.phase == "analyze":
        result = analyze(args.evidence.resolve())
        print(json.dumps(result, indent=2))
        check(result["complete"], "Invalid cohort")
    else:
        check(args.browser != "firefox" or args.dictionary == "jmdict", "Firefox helper only qualifies locked JMdict")
        globals()[args.phase](args)


if __name__ == "__main__":
    main()
