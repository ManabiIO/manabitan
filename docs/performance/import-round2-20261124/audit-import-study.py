#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Audit retained import studies against frozen Git sources and raw browser reports.

This is an analysis-only verifier. It never runs a benchmark, fetches Git objects,
changes a product checkout, drops an observation, or pools independent cohorts.
"""

import argparse
from functools import lru_cache
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import random
import re
import stat
import statistics
import subprocess
import zipfile


VERSION = 2
BASELINE = "d24b4e56ceb1fe14ad96ef3853f4d397efa6fa26"
BASELINE_TREE = "7f5c6cd0657114da17b832d3f074b9cea0c6c880"
RUNNER_PATH = "dev/perf/import-runtime-next.py"
WORKFLOW_PATH = ".github/workflows/import-runtime-next.yml"
RUNNER_SHA256 = "81931ea66937ebdf7fc55c6cdac2998a54d364485de7aae19909beef5aaa917b"
BRANCH = "perf/import-round2-20261124-0a175-study"
RUNS = {
    "45351292649": ("2f0b03ad34169afa0dfc0f784928083b58088841", "baseline", ()),
    "45352695368": ("4072cbbea0cfc455aaf7416a0f72af73995c4114", "screen", ("sequence",)),
    "45353118407": ("478556323c394977992bfb767ad311d42990ee2a", "screen", ("media", "canonical")),
}
ALIASES = {"sequence": "monotonic-sequence", "media": "media-bookkeeping", "canonical": "canonical-counters"}
RUNTIME_MEMBERS = {
    "sequence": {
        "js/dictionary/wasm/term-bank-parser.c": "ext/js/dictionary/wasm/term-bank-parser.c",
        "lib/term-bank-parser.wasm": "dev/data/dictionary-wasm/term-bank-parser.wasm",
    },
    "media": {
        "js/dictionary/dictionary-importer.js": "ext/js/dictionary/dictionary-importer.js",
        "js/dictionary/source-zip-media-pack.js": "ext/js/dictionary/source-zip-media-pack.js",
    },
    "canonical": {
        "js/dictionary/wasm/term-content-canonical-scan-v1.c": "ext/js/dictionary/wasm/term-content-canonical-scan-v1.c",
        "lib/term-content-canonical-scan-v1.wasm": "dev/data/dictionary-wasm/term-content-canonical-scan-v1.wasm",
    },
}
ORDERS = ["ABC", "CBA", "BAC", "CAB", "BCA", "ACB", "ACB", "BCA", "CAB", "BAC", "CBA", "ABC"]
HARNESS_PATHS = (
    "dev/perf", "test/chromium", "test/e2e", "test/perf", "test/firefox/data",
    "package.json", "package-lock.json", ".github/actions/setup/action.yml",
    "ext/js/core/json.js", "ext/js/core/safe-performance.js",
    "ext/js/dictionary/term-bank-experiments.js", "ext/js/data/anki-util.js",
    "ext/js/media/media-util.js", "ext/js/pages/settings/dictionary-import-controller.js",
)
EMITTED_HARNESS_PATHS = (
    "package-lock.json", "test/perf/dictionaries.lock.json", "dev/perf/benchmark-support.js",
    "dev/perf/dictionary-fixtures.js", "dev/perf/import-benchmark.js",
    "test/chromium/import-flags-ab-benchmark.js", "test/chromium/extension-two-dictionary-import.e2e.js",
    "test/e2e/import-timing.js", "ext/js/pages/settings/dictionary-import-controller.js",
)
EXPERIMENT_DEFAULTS = {
    "experimentalGenericSpanCompression": True, "experimentalParserWorkers3": True,
    "experimentalSkipFusedParse": False, "experimentalLookupScratchReuse": True,
    "experimentalNativeSegmentedLookup": True, "experimentalDirectLookupArena": False,
    "experimentalSinglePassLookupCompaction": False, "experimentalTermBankSpans": False,
    "experimentalNativeEscapedKeys": False, "experimentalValidatedGlossaryReuse": True,
    "experimentalFusedSingleBank": False, "experimentalGlobalExactContentReuse": False,
    "experimentalFastGlossaryNormalization": False,
}
INTERVAL_METHOD = "Descriptive percentile bootstrap; 10000 block-paired resamples, seed 20261123; no multiple-comparison correction"
INTERVAL_CAVEAT = "Intervals are descriptive; six-pair screens are exploratory. Assess candidate comparisons together with identical-product drift. Do not pool independent stages."
TIMING_BOUNDARY = "page file-input change event to post-UI import-complete event; browser monotonic clock"


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        check(key not in result, f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def decode(data):
    def reject_constant(value):
        raise AssertionError(f"Non-finite JSON constant: {value}")
    return json.loads(data, object_pairs_hook=unique_object, parse_constant=reject_constant)


def read(path):
    return decode(path.read_bytes())


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def valid_digest(value):
    return isinstance(value, str) and re.fullmatch("[a-f0-9]{64}", value) is not None


def number(value, positive=False, integer=False):
    return (type(value) in (int, float) and math.isfinite(value)
            and (value > 0 if positive else value >= 0)
            and (not integer or (value == int(value) and value <= 2**53 - 1)))


def contained(root, relative):
    check(isinstance(relative, str) and relative != "", "Empty/non-string artifact path")
    parts = PurePosixPath(relative)
    check(not parts.is_absolute() and ".." not in parts.parts and "\\" not in relative,
          f"Unsafe artifact path: {relative}")
    path = (root / relative).resolve()
    check(path.is_relative_to(root.resolve()) and path.is_file(), f"Missing/escaped artifact file: {relative}")
    return path


@lru_cache(maxsize=None)
def git(repo, *args):
    # Never silently fetch an absent object from a promisor remote during analysis.
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True,
                          env={**os.environ, "GIT_NO_LAZY_FETCH": "1"}, timeout=30).stdout


def git_text(repo, *args):
    return git(repo, *args).decode().strip()


def git_file(repo, revision, path):
    return git(repo, "show", f"{revision}:{path}")


def source_identity(repo, revision):
    check(re.fullmatch("[a-f0-9]{40}", revision) is not None, "Source is not a full commit SHA")
    check(git_text(repo, "rev-parse", f"{revision}^{{commit}}") == revision, "Commit resolution differs")
    return {"commit": revision, "tree": git_text(repo, "rev-parse", f"{revision}^{{tree}}")}


@lru_cache(maxsize=None)
def harness_hashes(repo, revision):
    paths = git(repo, "ls-tree", "-rz", "--name-only", revision, "--", *HARNESS_PATHS).decode().split("\0")
    return {path: digest(git_file(repo, revision, path)) for path in paths if path and path != RUNNER_PATH}


def artifact_integrity(root, evidence, run_id, tooling, dictionary, stage, candidate):
    alias = "baseline-round2" if candidate is None else ALIASES[candidate]
    artifact_name = f"import-crossover-{alias}-{stage}-{dictionary}-{run_id}-1"
    matches = []
    for path in sorted((evidence / "browser/artifact-metadata").glob("*.json")):
        value = read(path)
        entries = value.get("artifacts", [value])
        matches.extend(item for item in entries if item.get("name") == artifact_name)
    check(len(matches) == 1, f"Missing/duplicate original artifact metadata: {artifact_name}")
    metadata = matches[0]
    workflow = metadata["workflow_run"]
    check(str(workflow["id"]) == run_id and workflow["head_sha"] == tooling
          and workflow["head_branch"] == BRANCH, "Original artifact workflow identity differs")
    archive_name = f"baseline-{dictionary}.zip" if candidate is None else f"{alias}-{stage}-{dictionary}.zip"
    archive = evidence / "browser/original-artifacts" / archive_name
    archive_sha = file_digest(archive)
    check(archive.stat().st_size == metadata["size_in_bytes"] and metadata["digest"] == f"sha256:{archive_sha}",
          "Original artifact ZIP digest/size differs from retained GitHub metadata")
    members = set()
    with zipfile.ZipFile(archive) as packet:
        for item in packet.infolist():
            if item.is_dir():
                continue
            check(item.filename not in members, f"Duplicate artifact ZIP member: {item.filename}")
            check(stat.S_IFMT(item.external_attr >> 16) != stat.S_IFLNK, "Artifact ZIP contains a symlink")
            members.add(item.filename)
            path = contained(root, item.filename)
            content = packet.read(item)  # Also verifies each retained member's CRC.
            check(path.stat().st_size == item.file_size and file_digest(path) == digest(content),
                  f"Extracted artifact differs from original ZIP: {item.filename}")
    actual = {path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()}
    check(actual == members, "Extracted packet contains missing/additional files")
    return {"id": metadata["id"], "name": artifact_name, "sha256": archive_sha,
            "bytes": archive.stat().st_size, "verifiedMembers": len(members)}


def planned_observations(stage, orders, diagnostics):
    items = []
    if stage == "baseline":
        items += [(f"baseline-{i:02d}-A", "A", "baseline-diagnostic", None, None, "sample") for i in range(1, 4)]
    items += [(f"block-{block:02d}-{position}-{arm}", arm, "timed", block, position, "sample")
              for block, order in enumerate(orders, 1) for position, arm in enumerate(order, 1)]
    items += [(f"diagnostic-{arm}", arm, "exhaustive-diagnostic", None, None, "all") for arm in diagnostics]
    return items


def comparison(base, candidate):
    check(len(base) == len(candidate) and len(base) > 0, "Incomplete paired cohort")
    changes = [(right / left - 1) * 100 for left, right in zip(base, candidate, strict=True)]
    rng = random.Random(20261123)
    resamples = sorted(statistics.median(rng.choices(changes, k=len(changes))) for _ in range(10000))
    return {"pairs": len(changes), "fasterPairs": sum(value < 0 for value in changes),
            "pairedChangesPercent": changes, "pairedMedianPercent": statistics.median(changes),
            "pairedMedianBootstrap95Percent": [resamples[249], resamples[9749]],
            "intervalMethod": INTERVAL_METHOD, "equalWorkPercent": (sum(candidate) / sum(base) - 1) * 100,
            "baselineMedianMs": statistics.median(base), "candidateMedianMs": statistics.median(candidate)}


def singleton_timing(value):
    return {"count": 1, "minMs": value, "medianMs": value, "p95Ms": value, "maxMs": value}


def validate_raw(raw, summary, fixture, dictionary, media_mode, package_sha, browser, name):
    check(raw["status"] == "success" and raw["failureReason"] == "" and raw["skippedVerification"] is False
          and raw["skipReason"] == "", f"Failed/skipped raw report: {name}")
    check(raw["browserFlavor"] == "chromium" and raw["buildTarget"] == "chrome" and raw["launchMode"] == "headless",
          f"Browser mode differs: {name}")
    check(raw["packageSha256"] == package_sha and raw["browserVersion"] == browser, f"Raw package/browser differs: {name}")
    check(raw["hostEnvironment"]["nodeVersion"] == "v22.22.0", f"Raw Node differs: {name}")
    benchmark = raw["benchmark"]
    config = {"dictionary": dictionary, "pinnedDictionaries": True, "productionImportDefaults": True,
              "traceEnabled": False, "authoritativeTiming": True, "phaseProfiling": False,
              "phaseScreenshots": False, "processSampling": False, "importFlags": None, "mediaCheck": media_mode}
    check({key: benchmark[key] for key in config} == config, f"Raw benchmark configuration differs: {name}")
    phases = raw["phases"]
    check(raw["phaseCount"] == len(phases), f"Raw phase count differs: {name}")
    total = [p for p in phases if p["name"] == f"{fixture['label']}: total import"]
    triggers = [p for p in phases if p["name"] == f"Import {fixture['label']} via file input"]
    check(len(total) == len(triggers) == 1, f"Missing/duplicate raw total or trigger: {name}")
    total, trigger = total[0], triggers[0]
    check(all(number(p[field]) for p in (total, trigger) for field in ("startMs", "endMs", "durationMs")),
          f"Invalid raw automation clock: {name}")
    check(total["startMs"] == trigger["startMs"] <= trigger["endMs"] <= total["endMs"]
          and abs(total["durationMs"] - (total["endMs"] - total["startMs"])) <= 0.001,
          f"Raw automation boundary differs: {name}")
    data = total["data"]
    check(data["kind"] == "dictionary-import" and data["dictionary"] == fixture["label"], f"Wrong raw import phase: {name}")
    timing = data["browserTiming"]
    check(number(timing["startedAtMs"]) and number(timing["completedAtMs"])
          and timing["completedAtMs"] > timing["startedAtMs"] and timing["trigger"] == "file-input-change"
          and timing["errorCount"] == 0 and number(timing["sequenceBefore"], integer=True)
          and number(timing["sequence"], integer=True) and timing["sequence"] > timing["sequenceBefore"],
          f"Missing/current-operation browser timing invalid: {name}")
    duration = timing["completedAtMs"] - timing["startedAtMs"]
    run = summary["runs"][0]
    check(run["totalImportMs"] == duration and run["automationObservedImportMs"] == total["durationMs"],
          f"Summary duration differs from raw clocks: {name}")
    for key in ("importDebug", "stepTimingSummary", "step4Breakdown"):
        check(run[key] == data[key], f"Raw/summary {key} differs: {name}")
    check(run["validation"] == benchmark["validation"], f"Raw/summary validation differs: {name}")
    workers = [p for p in data["importDebug"]["localPhaseTimings"] if p["phase"] == "worker-import-dictionary"]
    worker_ms = workers[0]["elapsedMs"] if len(workers) == 1 else None
    check(worker_ms is None or number(worker_ms), f"Invalid worker clock: {name}")
    check(run["workerImportMs"] == worker_ms, f"Worker timing differs: {name}")
    for key, value in (("timing", duration), ("automationObservedTiming", total["durationMs"]), ("workerTiming", worker_ms)):
        check(summary[key] == (singleton_timing(value) if value is not None else None), f"Summary aggregate differs: {name}/{key}")
    diagnostics = raw["runtimeDiagnostics"]
    check(diagnostics["openStorageMode"] == "opfs-sahpool" and diagnostics["hasStorageGetDirectory"] is True
          and diagnostics["hasBackendCreateSyncAccessHandle"] is True and diagnostics["hasOpfsSahpoolVfs"] is True,
          f"Raw OPFS runtime unavailable: {name}")
    return duration, timing


def validate_experiments(debug, fixture, name):
    phases = debug["importerPhaseTimings"]
    banks = [p for p in phases if p["phase"] == "import-data-banks"]
    fast = [p for p in phases if p["phase"].startswith("term-file-fast-path:")]
    finalization = [p for p in phases if p["phase"] == "bulk-finalization"]
    check(len(banks) == len(finalization) == 1 and fast, f"Missing/duplicate production phase receipts: {name}")
    bank = banks[0]["details"]
    check(bank["terms"] == sum(p["details"]["rows"] for p in fast) == fixture["termRows"], f"Parser row inventory differs: {name}")
    final = finalization[0]["details"]
    check(final["ok"] is True and final["published"] is True and final["housekeepingErrors"] == [], f"Finalization failed: {name}")
    check("fastPathParserEffectiveExperiments" in bank and "fastPathParserExperiments" in bank
          and "compressionExperiments" in final and all("parserExperiments" in p["details"] for p in fast),
          f"Missing experiment receipts: {name}")
    for phase in phases:
        details = phase.get("details") or {}
        for key in ("parserExperiments", "fastPathParserEffectiveExperiments", "fastPathParserExperiments", "compressionExperiments"):
            if key not in details:
                continue
            prefix = "parser" if key == "parserExperiments" else "fastPathParser"
            effective = key in ("parserExperiments", "fastPathParserEffectiveExperiments")
            projected = (effective and bank.get("useMediaPipeline") is True and bank.get("hasArchiveImageMediaFiles") is True
                         and number(details.get(prefix + "ParallelWorkerCount"), positive=True, integer=True)
                         and details.get(prefix + "ParallelSkipReason") is None
                         and number(details.get(prefix + "SourceUncompressedBytes"), integer=True)
                         and details[prefix + "SourceUncompressedBytes"] >= 512 * 1024 * 1024)
            expected = {**EXPERIMENT_DEFAULTS, **({"experimentalNativeEscapedKeys": True} if projected else {})}
            check(details[key] == expected, f"Production experiment defaults differ: {name}/{phase['phase']}/{key}")
    return [{"phase": p["phase"], "elapsedMs": p.get("elapsedMs"), "details": p.get("details")}
            for p in phases if p["phase"] in ("import-data-banks", "bulk-finalization") or p["phase"].startswith("term-file-fast-path:")]


def validate_validation(validation, fixture, media_mode, name):
    expected = {"title": fixture["expectedTitle"], "revision": fixture["revision"], "termRows": fixture["termRows"],
                "contentReadable": True, "probeCount": 12}
    check({key: validation[key] for key in expected} == expected, f"Inventory/content differs: {name}")
    restart = validation["restart"]
    check({key: restart[key] for key in expected} == expected and restart["mediaFiles"] == fixture["mediaFiles"],
          f"Restart inventory/content differs: {name}")
    probes = validation["probeTerms"]
    check(len(probes) == len(set(probes)) == 12 and all(isinstance(term, str) and term for term in probes), f"Invalid distinct probes: {name}")
    check(valid_digest(validation["outputDigestSha256"]), f"Invalid content digest: {name}")
    lookup = validation["lookup"]
    check(lookup["timingBoundary"] == "settings-page termsFind RPC; first pass after restart, then five warm passes; excludes result hashing",
          f"Lookup boundary differs: {name}")
    rows = lookup["observations"]
    check([(row["pass"], row["term"]) for row in rows] == [(index, term) for index in range(6) for term in probes],
          f"Missing/duplicate/reordered lookup observations: {name}")
    for row in rows:
        check(number(row["pass"], integer=True) and number(row["elapsedMs"]) and number(row["results"], positive=True, integer=True)
              and row["hasExactHeadwordMatch"] is True and valid_digest(row["sha256"])
              and row["originalTextLength"] == len(row["term"].encode("utf-16-le")) // 2, f"Lookup failure: {name}")
    media = validation["media"]
    check(media["mode"] == media_mode and media["totalFiles"] == fixture["mediaFiles"] and media["totalBytes"] == fixture["mediaBytes"],
          f"Media inventory/mode differs: {name}")
    count = fixture["mediaFiles"] if media_mode == "all" else min(64, fixture["mediaFiles"])
    check(media["files"] == count and number(media["bytes"], integer=True) and media["bytes"] <= fixture["mediaBytes"]
          and valid_digest(media["sha256"]), f"Invalid media receipt: {name}")
    check((count == 0 and media["bytes"] == 0 and media["sha256"] == digest(b"")) or (count > 0 and media["bytes"] > 0),
          f"Empty/nonempty media mismatch: {name}")
    check(media_mode != "all" or media["bytes"] == fixture["mediaBytes"], f"Incomplete exhaustive media: {name}")
    storage = validation["storage"]
    check(storage["kind"] == "OPFS logical file sizes after restart and verification" and number(storage["bytes"], positive=True, integer=True),
          f"Storage receipt differs: {name}")
    files = storage["files"]
    check(files and len({item["path"] for item in files}) == len(files)
          and all(number(item["bytes"], integer=True) for item in files)
          and sum(item["bytes"] for item in files) == storage["bytes"], f"Storage inventory sum/uniqueness differs: {name}")
    identity = sorted([row["pass"], row["term"], row["results"], row["sha256"]] for row in rows)
    return {"lookup": identity, "sampledContentDigest": validation["outputDigestSha256"],
            "storageBytes": storage["bytes"], f"media-{media_mode}": media}


def audit(root, evidence=None, repo=None):
    evidence = Path(evidence or Path(__file__).resolve().parent).resolve()
    repo = Path(repo or evidence.parent / "manabitan").resolve()
    root = root.resolve()
    publication = read(evidence / "publication-identities.json")
    protocol, state, observations = (read(root / file) for file in ("protocol.json", "state.json", "observations.json"))
    run_id = protocol["github"]["GITHUB_RUN_ID"]
    check(run_id in RUNS, f"Unregistered workflow run: {run_id}")
    tooling, expected_stage, allowed = RUNS[run_id]
    stage, dictionary = protocol["stage"], protocol["dictionary"]
    check(stage == expected_stage and dictionary in ("jmdict", "jitendex", "vndb"), "Unregistered stage/dictionary")
    candidate = None
    if stage != "baseline":
        matches = [key for key in allowed if protocol["sourceIdentities"]["B"]["commit"] == publication[key]["remoteCommit"]]
        check(len(matches) == 1, "Unregistered candidate for this workflow run")
        candidate = matches[0]
        published = publication[candidate]
        check(published["parent"] == BASELINE, "Publication parent differs")
        for commit in (published["localCommit"], published["remoteCommit"]):
            check(source_identity(repo, commit)["tree"] == published["tree"], "Published/local source tree differs")
            check(git_text(repo, "merge-base", BASELINE, commit) == BASELINE, "Candidate baseline ancestry differs")
        check(git_text(repo, "rev-parse", f"{published['remoteCommit']}^") == BASELINE, "Published candidate parent differs")
        changed = git_text(repo, "diff", "--name-only", BASELINE, published["remoteCommit"]).splitlines()
        check(sorted(changed) == sorted(file["path"] for file in published["files"]), "Published changed-file inventory differs")
        for file in published["files"]:
            content = git_file(repo, published["remoteCommit"], file["path"])
            check(len(content) == file["bytes"] and git_text(repo, "rev-parse", f"{published['remoteCommit']}:{file['path']}") == file["blob"],
                  f"Published source blob differs: {file['path']}")
    baseline = source_identity(repo, BASELINE)
    check(baseline["tree"] == BASELINE_TREE, "Baseline tree differs")
    identities = {"A": baseline, "C": baseline}
    if candidate is not None:
        identities["B"] = {"commit": publication[candidate]["remoteCommit"], "tree": publication[candidate]["tree"]}
    check(protocol["sourceIdentities"] == identities, "Protocol source identities differ from frozen publication")
    expected_github = {"GITHUB_REF": f"refs/heads/{BRANCH}", "GITHUB_RUN_ATTEMPT": "1", "GITHUB_RUN_ID": run_id,
                       "GITHUB_SHA": tooling, "GITHUB_WORKFLOW": "Import optimization round 2 (frozen sources)"}
    check(protocol["github"] == expected_github and protocol["toolingCommit"] == tooling, "Tooling workflow identity differs")
    check((root / "tooling-sha.txt").read_text().strip() == tooling and not (root / "tooling-status.txt").read_text().strip(),
          "Tooling checkout identity/cleanliness differs")
    check((root / "workflow.yml").read_bytes() == git_file(repo, tooling, WORKFLOW_PATH), "Retained workflow differs from frozen Git")
    runner = (root / "runner.py").read_bytes()
    check(runner == git_file(repo, tooling, RUNNER_PATH) and digest(runner) == protocol["runnerSha256"] == RUNNER_SHA256,
          "Frozen runner differs")
    expected_harness = harness_hashes(repo, BASELINE)
    check(protocol["unchangedHarnessSha256"] == expected_harness == harness_hashes(repo, tooling), "Full frozen harness differs")
    for source in identities.values():
        check(harness_hashes(repo, source["commit"]) == expected_harness, "Candidate harness differs")
    fixture_lock = decode(git_file(repo, BASELINE, "test/perf/dictionaries.lock.json"))
    fixture = fixture_lock["dictionaries"][dictionary]
    check(protocol["fixture"] == fixture, "Fixture differs from frozen d24 lock")
    check(protocol["schemaVersion"] == 1 and protocol["nodeVersion"] == "v22.22.0"
          and protocol["warmupsExcluded"] == 0 and protocol["harnessOverlay"] is None, "Protocol defaults differ")
    orders = ORDERS[:6] if stage == "screen" else ORDERS if stage == "qualification" else []
    diagnostics = ["A"] if candidate is None else ["A", "B"]
    check(protocol["orders"] == orders and protocol["plannedBlocks"] == len(orders)
          and protocol["baselineSnapshotRuns"] == (3 if stage == "baseline" else 0)
          and protocol["diagnosticArms"] == diagnostics and protocol["timingMediaCheck"] == "sample"
          and protocol["diagnosticMediaCheck"] == "all", "Prespecified cohort selection differs")
    expected = planned_observations(stage, orders, diagnostics)
    check([(o["name"], o["arm"], o["cohort"], o["block"], o["position"], o["mediaCheck"]) for o in observations] == expected,
          "Observation tuple omission/reorder/relabel")
    check(state["status"] == "success" and state["buildComplete"] is True and state["stage"] == stage
          and state["dictionary"] == dictionary and state["attemptedObservations"] == len(expected)
          and state["timedObservations"] == 3 * len(orders) and state["exhaustiveDiagnostics"] == len(diagnostics),
          "Completed cohort state differs")
    check(read(root / "fixture.json") == {"sizeBytes": fixture["sizeBytes"], "sha256": fixture["sha256"], "fixture": fixture},
          "Verified fixture receipt differs from frozen lock")
    setup_ids = ["jmdict", "jmnedict", "jitendex"] + (["vndb"] if dictionary == "vndb" else [])
    check(protocol["setupCacheDictionaryIds"] == setup_ids, "Setup cache inventory differs")
    check(read(root / "setup-fixtures.json") == {key: {"sizeBytes": fixture_lock["dictionaries"][key]["sizeBytes"],
          "sha256": fixture_lock["dictionaries"][key]["sha256"], "fixture": fixture_lock["dictionaries"][key]} for key in setup_ids},
          "Setup fixtures differ from frozen lock")
    artifact = artifact_integrity(root, evidence, run_id, tooling, dictionary, stage, candidate)
    packages = {arm: read(root / f"package-{arm}.json") for arm in identities}
    for arm, package in packages.items():
        check(package["source"] == identities[arm] and valid_digest(package["archiveSha256"]), f"Package source identity differs: {arm}")
        check(package["entries"] and all(valid_digest(value) for value in package["entries"].values()), f"Invalid package manifest: {arm}")
        if arm != "C":
            check(not (root / f"source-status-{arm}.txt").read_text().strip(), f"Unclean built source: {arm}")
    check(packages["C"] == {**packages["A"], "identicalArchiveFromArm": "A"}, "Identical-product control package differs")
    differences = []
    if candidate is not None:
        a, b = packages["A"]["entries"], packages["B"]["entries"]
        differences = [path for path in sorted(set(a) | set(b)) if a.get(path) != b.get(path)]
        check(differences == read(root / "package-differences.json") == sorted(RUNTIME_MEMBERS[candidate]),
              "Release package delta exceeds intended runtime members")
        for arm in ("A", "B"):
            for member, source_path in RUNTIME_MEMBERS[candidate].items():
                check(packages[arm]["entries"][member] == digest(git_file(repo, identities[arm]["commit"], source_path)),
                      f"Packaged runtime differs from frozen source: {arm}/{member}")
        check(not any(path.startswith("test/") for path in packages["B"]["entries"]), "Test fixture shipped in release package")
    names = [row[0] for row in expected]
    for filename in ("summary.json", "run-1.json", "phase-counters.json"):
        check({path.relative_to(root).as_posix() for path in root.rglob(filename)} == {f"{name}/{filename}" for name in names},
              f"Missing/additional observation files: {filename}")
    common, times, receipts = {}, {arm: [] for arm in "ABC"}, []
    report_root = None
    for observation in observations:
        name, arm = observation["name"], observation["arm"]
        check(observation["status"] == "success" and observation["source"] == identities[arm]
              and number(observation["commandElapsedSeconds"], positive=True), f"Failed/invalid observation: {name}")
        check(observation["summary"] == f"{name}/summary.json" and observation["phaseCounters"] == f"{name}/phase-counters.json",
              f"Observation file alias/traversal: {name}")
        summary_path = contained(root, observation["summary"])
        summary = read(summary_path)
        check(summary["schemaVersion"] == 3 and len(summary["runs"]) == 1, f"Summary shape: {name}")
        run = summary["runs"][0]
        check(run["index"] == 1, f"Unregistered repeat: {name}")
        for key, filename in (("reportPath", "run-1.html"), ("reportJsonPath", "run-1.json")):
            path = PurePosixPath(run[key])
            check(path.is_absolute() and ".." not in path.parts and path.parts[-2:] == (name, filename), f"Report path alias/traversal: {name}")
            if report_root is None:
                report_root = str(path.parent.parent)
            check(str(path.parent.parent) == report_root, f"Report root differs: {name}")
            contained(root, f"{name}/{filename}")
        source = identities[arm]
        check(summary["dictionary"] == dictionary and summary["fixture"] == fixture, f"Summary fixture differs: {name}")
        check(summary["gitSha"] == summary["source"]["gitSha"] == source["commit"] and summary["source"]["dirty"] is False,
              f"Summary source/cleanliness differs: {name}")
        emitted = {path: expected_harness[path] for path in EMITTED_HARNESS_PATHS}
        emitted.update({"builds/manabitan-chrome-dev.zip": None, "builds/manabitan-chrome.zip": packages[arm]["archiveSha256"]})
        check(summary["source"]["sha256"] == emitted, f"Missing/additional/changed emitted provenance: {name}")
        check(summary["buildTarget"] == "chrome" and summary["authoritativeTiming"] is True
              and summary["timingBoundary"] == TIMING_BOUNDARY and summary["traceEnabled"] is False
              and run["tracePath"] is None and summary["importFlags"] is None and summary["mediaCheck"] == observation["mediaCheck"],
              f"Summary timing/defaults differ: {name}")
        check(summary["browserVersion"] == run["browserVersion"] == state["browserVersion"] and run["packageSha256"] == packages[arm]["archiveSha256"],
              f"Summary package/browser differs: {name}")
        check(summary["hostEnvironment"]["nodeVersion"] == "v22.22.0", f"Summary Node differs: {name}")
        for filename in ("host-before.json", "host-after.json"):
            check(read(contained(root, f"{name}/{filename}"))["nodeVersion"] == "v22.22.0", f"Host Node differs: {name}/{filename}")
        raw_path = contained(root, f"{name}/run-1.json")
        raw = read(raw_path)
        duration, clock = validate_raw(raw, summary, fixture, dictionary, observation["mediaCheck"], packages[arm]["archiveSha256"], state["browserVersion"], name)
        check(duration == observation["totalImportMs"] and number(duration, positive=True), f"Observation/raw timing differs: {name}")
        debug = run["importDebug"]
        check(debug["hasResult"] is True and debug["resultTitle"] == fixture["expectedTitle"] and debug["errorCount"] == 0
              and debug["addSettingsErrorCount"] == 0 and debug["usesFallbackStorage"] is False
              and debug["openStorageDiagnostics"]["mode"] == "opfs-sahpool" and debug["useImportSession"] is True
              and debug["finalizeImportSession"] is True, f"Import/lifecycle/storage failure: {name}")
        phases = validate_experiments(debug, fixture, name)
        check(read(contained(root, observation["phaseCounters"])) == phases, f"Copied phase counters differ from raw report: {name}")
        values = validate_validation(run["validation"], fixture, observation["mediaCheck"], name)
        check(observation["storageBytes"] == values["storageBytes"], f"Observation storage differs: {name}")
        for key, value in values.items():
            if key in common:
                check(common[key] == value, f"Correctness receipt differs across observations: {name}/{key}")
            common[key] = value
        if observation["cohort"] == "timed":
            times[arm].append(duration)
        receipts.append({"name": name, "arm": arm, "cohort": observation["cohort"], "block": observation["block"],
                         "position": observation["position"], "totalImportMs": duration, "rawBrowserClock": clock,
                         "summarySha256": file_digest(summary_path), "rawReportSha256": file_digest(raw_path),
                         "mediaMode": observation["mediaCheck"], "lookupReceipts": 72,
                         "sourceBankCount": sum(p["details"]["parserBankSpanCount"] for p in phases if p["phase"].startswith("term-file-fast-path:"))})
    expected_receipts = {key: value for key, value in common.items() if key != "sampledContentDigest"}
    check(read(root / "correctness.json") == {"status": "passed", "identicalReceipts": expected_receipts}, "Runner correctness receipt differs")
    comparisons = {}
    if orders:
        analysis = read(root / "analysis.json")
        for label, left, right in (("candidate", "A", "B"), ("candidateVsSecondBaseline", "C", "B"), ("identicalProductControl", "A", "C")):
            check(len(times[left]) == len(times[right]) == len(orders), "Timed arm count differs")
            comparisons[label] = comparison(times[left], times[right])
        recomputed = {"status": "complete", "stage": stage, "dictionary": dictionary, "browserVersion": state["browserVersion"],
                      "screeningOnly": stage == "screen", "independentQualificationRequired": stage == "screen",
                      "intervalCaveat": INTERVAL_CAVEAT, **comparisons, "allTimingsMs": times}
        check(analysis == recomputed, "Analysis differs from independent raw-clock statistics")
    else:
        check(not (root / "analysis.json").exists(), "Unexpected inferential analysis in diagnostic cohort")
    return {"auditVersion": VERSION, "auditSha256": file_digest(Path(__file__)), "status": "passed", "stage": stage,
            "dictionary": dictionary, "candidate": candidate, "workflowRun": run_id, "toolingCommit": tooling,
            "artifactIntegrity": artifact, "publicationIdentitiesSha256": file_digest(evidence / "publication-identities.json"),
            "fixtureLockSha256": digest(git_file(repo, BASELINE, "test/perf/dictionaries.lock.json")),
            "sourceIdentities": identities, "runnerSha256": RUNNER_SHA256, "verifiedFrozenHarnessFiles": len(expected_harness),
            "verifiedEmittedHarnessFilesPerObservation": len(EMITTED_HARNESS_PATHS), "browserVersion": state["browserVersion"],
            "attemptedObservations": len(observations), "timedObservations": 3 * len(orders), "lookupReceipts": len(observations) * 72,
            "exhaustiveDiagnostics": len(diagnostics), "changedPackageMembers": differences, "allTimingsMs": times,
            "comparisons": comparisons, "observations": receipts,
            "limits": "All retained timings and tails included. Frozen sources, retained package manifests and changed runtime hashes, full inventory, restart and source-media receipts are verified. Release product ZIPs are not retained: this audit matches reported archive digests and manifest entries, without independently rebuilding or reading every release ZIP entry. Terms remain 12 sampled probes over six lookup passes. No all-term semantics or process peak-memory proof. Native/component timings and overlapping phase counters do not establish complete-import gains. Screens are exploratory and not pooled with baseline/qualification cohorts."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--evidence-root", type=Path)
    parser.add_argument("--repo", type=Path)
    args = parser.parse_args()
    result = audit(args.root, args.evidence_root, args.repo)
    serialized = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(serialized)
    print(serialized)


if __name__ == "__main__":
    main()
