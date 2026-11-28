#!/usr/bin/env python3
"""Inspect fixed six-pair qualification artifacts; never build or run the extension."""
import hashlib
import json
import math
import os
import pathlib
import random
import statistics
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPOSITORY = "ManabiIO/manabitan"
RUN_ID = BASELINE = CANDIDATE = WORKFLOW_HEAD = SOURCE_BRANCH = None
EXPECTED_ENTRIES = EXPECTED_ADDED_ENTRIES = set()
EXPECTED_ARTIFACTS = EXPECTED_TREES = EXPECTED_RUNTIME_PAYLOADS = {}
ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "dev/perf/import-memory-20261125-a7f7"))
from qualification_receipts import validate_import_summary, require_matching_receipts
from protocol import memory_comparison, memory_overlay, schedule as memory_schedule
from audit_memory import audit_cell

FIXTURES = json.loads((ROOT / "test/perf/dictionaries.lock.json").read_text())["dictionaries"]
CONFIG_PATH = ROOT / "dev/perf/import-analysis-b9cacc-experiments.json"
CONFIG_BYTES = CONFIG_PATH.read_bytes()
CONFIG = json.loads(CONFIG_BYTES)
TOKEN = os.environ.get("GITHUB_TOKEN", "")
API = f"https://api.github.com/repos/{REPOSITORY}"
HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "manabitan-frozen-import-evidence-reader",
}

def api(path):
    request = urllib.request.Request(API + path, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)

def same(actual, expected, label):
    if json.dumps(actual, sort_keys=True, allow_nan=False) != json.dumps(expected, sort_keys=True, allow_nan=False):
        raise ValueError(label + " differs from the registered value")

def require_run_identity(run):
    for key, value in (("id", RUN_ID), ("head_sha", WORKFLOW_HEAD), ("head_branch", SOURCE_BRANCH), ("event", "push")):
        same(run.get(key), value, "source run " + key)
    same(run["repository"]["full_name"], REPOSITORY, "source repository")
    same(run.get("run_attempt"), 1, "source run attempt")
    same(run.get("path"), EXPERIMENT["workflowPath"], "source workflow path")
    same(run["head_repository"]["full_name"], REPOSITORY, "source head repository")

def fixed_schedule(order):
    result = []
    for pair, arms in enumerate((order, order[::-1]), 1):
        result.extend({"id": f"warmup-{pair}-{arm}", "kind": "warmup", "pair": pair, "arm": arm} for arm in arms)
    for pair in range(1, 7):
        arms = order if pair % 2 else order[::-1]
        result.extend({"id": f"pair-{pair:02d}-{arm}", "kind": "candidate", "pair": pair, "arm": arm} for arm in arms)
        if pair % 3 == 0:
            control = pair // 3
            arms = "AC" if (control + (order == "BA")) % 2 else "CA"
            result.extend({"id": f"control-{control:02d}-{arm}", "kind": "control", "pair": control, "arm": arm} for arm in arms)
    return result

def paired(rows, kind, right):
    groups = {}
    for row in rows:
        if row["kind"] == kind:
            groups.setdefault(row["pair"], {})[row["arm"]] = row["totalImportMs"]
    complete = [value for value in groups.values() if "A" in value and right in value]
    if not complete:
        return {"count": 0, "incompletePairs": len(groups)}
    ratios = [value[right] / value["A"] for value in complete]
    rng = random.Random(897)
    boot = sorted(statistics.median(rng.choices(ratios, k=len(ratios))) for _ in range(10000))
    return {
        "count": len(complete), "ratios": ratios,
        "medianPairedChangePercent": (statistics.median(ratios) - 1) * 100,
        "equalWorkChangePercent": (sum(v[right] for v in complete) / sum(v["A"] for v in complete) - 1) * 100,
        "worstPairChangePercent": (max(ratios) - 1) * 100,
        "descriptiveBootstrap95Percent": [(boot[i] - 1) * 100 for i in (249, 9749)],
        "fasterPairs": sum(ratio < 1 for ratio in ratios),
    }

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None

def download(artifact, target):
    request = urllib.request.Request(API + f"/actions/artifacts/{artifact['id']}/zip", headers=HEADERS)
    try:
        response = urllib.request.build_opener(NoRedirect).open(request, timeout=60)
    except urllib.error.HTTPError as error:
        if error.code not in (301, 302, 303, 307, 308):
            raise
        location = error.headers.get("Location", "")
        parsed = urllib.parse.urlparse(location)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("Invalid artifact download redirect")
        # Do not forward the GitHub token to the signed storage URL.
        response = urllib.request.urlopen(urllib.request.Request(location), timeout=120)
    digest = hashlib.sha256()
    total = 0
    with response:
        while True:
            block = response.read(1024 * 1024)
            if not block:
                break
            total += len(block)
            if total > 1024 * 1024 * 1024:
                raise ValueError("Artifact exceeds the one-GiB inspection budget")
            digest.update(block)
            target.write(block)
    target.seek(0)
    actual = "sha256:" + digest.hexdigest()
    expected = artifact.get("digest")
    if not isinstance(expected, str) or not expected.startswith("sha256:") or len(expected) != 71:
        raise ValueError("Artifact metadata has no complete SHA-256 digest")
    same(actual, expected, "artifact ZIP digest")
    same(total, artifact["size_in_bytes"], "artifact ZIP byte size")
    return {"bytes": total, "sha256": digest.hexdigest(), "metadataDigestVerified": True}


def member_bytes(archive, name, maximum=32 * 1024 * 1024):
    info = archive.getinfo(name)
    if info.is_dir() or info.file_size > maximum:
        raise ValueError("Oversized or non-file artifact member " + name)
    data = archive.read(info)
    same(len(data), info.file_size, "artifact member length")
    return data

def verify_source_hashes(identity):
    same(identity["lockSha256"], hashlib.sha256((ROOT / "package-lock.json").read_bytes()).hexdigest(), "actual dependency lock")
    same(identity["fixtureLockSha256"], hashlib.sha256((ROOT / "test/perf/dictionaries.lock.json").read_bytes()).hexdigest(), "actual fixture lock")
    paths = (
        "package-lock.json", "test/perf/dictionaries.lock.json", "dev/perf/benchmark-support.js",
        "dev/perf/dictionary-fixtures.js", "dev/perf/import-benchmark.js", "test/chromium/import-flags-ab-benchmark.js",
        "test/chromium/extension-two-dictionary-import.e2e.js", "test/e2e/import-timing.js",
        "ext/js/pages/settings/dictionary-import-controller.js", "builds/manabitan-chrome-dev.zip", "builds/manabitan-chrome.zip",
    )
    same(sorted(identity["sourceHashes"]), sorted(paths), "source-hash path set")
    for relative in paths:
        expected = identity["packageSha256"] if relative == "builds/manabitan-chrome.zip" else (
            None if relative == "builds/manabitan-chrome-dev.zip" else hashlib.sha256((ROOT / relative).read_bytes()).hexdigest())
        same(identity["sourceHashes"][relative], expected, "actual qualification source " + relative)

def inspect_packages(archive, prefix, identities):
    maps, proofs = {}, {}
    for arm in ("A", "B"):
        identity = identities["arms"][arm]
        name = prefix + f"package-{arm}.zip"
        info = archive.getinfo(name)
        if info.is_dir() or info.file_size > 256 * 1024 * 1024:
            raise ValueError("Invalid nested package size")
        digest, size = hashlib.sha256(), 0
        with tempfile.TemporaryFile() as target:
            with archive.open(info) as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    size += len(block)
                    if size > 256 * 1024 * 1024:
                        raise ValueError("Nested package exceeds inspection budget")
                    digest.update(block)
                    target.write(block)
            same(size, info.file_size, "nested package byte size")
            same(digest.hexdigest(), identity["packageSha256"], "actual nested package digest")
            target.seek(0)
            entries, lengths = {}, {}
            with zipfile.ZipFile(target) as package:
                names = package.namelist()
                if len(names) != len(set(names)):
                    raise ValueError("Duplicate nested package member names")
                unpacked = 0
                for entry in package.infolist():
                    parts = pathlib.PurePosixPath(entry.filename)
                    if parts.is_absolute() or ".." in parts.parts or "\\" in entry.filename:
                        raise ValueError("Unsafe nested package member")
                    if entry.is_dir():
                        continue
                    unpacked += entry.file_size
                    if unpacked > 1024 * 1024 * 1024:
                        raise ValueError("Nested package members exceed inspection budget")
                    member_hash, length = hashlib.sha256(), 0
                    with package.open(entry) as stream:
                        for block in iter(lambda: stream.read(1024 * 1024), b""):
                            length += len(block)
                            if length > entry.file_size:
                                raise ValueError("Nested package member size mismatch")
                            member_hash.update(block)
                    same(length, entry.file_size, "actual nested member byte size")
                    entries[entry.filename] = member_hash.hexdigest()
                    lengths[entry.filename] = length
            same(entries, identity["entries"], "actual complete package member map")
            payload_proof = {}
            for member, expected in EXPECTED_RUNTIME_PAYLOADS[arm].items():
                actual = {"bytes": lengths.get(member), "sha256": entries.get(member)}
                same(actual, expected, "source-frozen runtime payload " + arm + ":" + member)
                payload_proof[member] = actual
            maps[arm] = entries
            proofs[arm] = {"sourceSha": identity["sha"], "sourceTree": identity["tree"],
                "packageSha256": digest.hexdigest(), "packageBytes": size, "memberCount": len(entries),
                "memberMapSha256": hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
                "runtimePayloads": payload_proof}
    changed = sorted(name for name in maps["A"].keys() & maps["B"].keys() if maps["A"][name] != maps["B"][name])
    added = sorted(maps["B"].keys() - maps["A"].keys())
    removed = sorted(maps["A"].keys() - maps["B"].keys())
    same(changed, sorted(EXPECTED_ENTRIES), "actual nested changed entries")
    same(added, sorted(EXPECTED_ADDED_ENTRIES), "actual nested added entries")
    same(removed, [], "actual nested removed entries")
    return {"status": "verified", "packages": proofs, "changedPackageEntries": changed,
        "addedPackageEntries": added, "removedPackageEntries": removed}


def inspect_zip(archive, dictionary, order):
    members = archive.namelist()
    if len(members) != len(set(members)):
        raise ValueError("Duplicate artifact member names")
    plans = [name for name in members if name == "registered-plan.json" or name.endswith("/registered-plan.json")]
    if len(plans) > 1:
        raise ValueError("Ambiguous registered plan")
    prefix = plans[0][:-len("registered-plan.json")] if plans else ""
    def read_json(name, required=True):
        key = prefix + name
        if key not in members:
            if required:
                raise ValueError("Missing " + name)
            return None
        if archive.getinfo(key).file_size > 32 * 1024 * 1024:
            raise ValueError("Oversized JSON member " + name)
        return json.loads(archive.read(key))
    result = {"dictionary": dictionary, "initialOrder": order, "auditErrors": []}
    reference = None
    plan = read_json("registered-plan.json", False)
    identities = read_json("source-identities.json", False)
    observations = read_json("observations.json", False) or []
    analysis = read_json("analysis.json", False)
    result["registeredPlanPresent"] = plan is not None
    result["observations"] = observations
    result["producerAnalysis"] = analysis
    if plan is None or identities is None:
        result["auditErrors"].append("Acquisition stopped before source identities and the timed plan were registered")
    else:
        try:
            expected_schedule = fixed_schedule(order)
            for key, expected in (("baseline", BASELINE), ("candidate", CANDIDATE), ("dictionary", dictionary),
                                  ("initialOrder", order), ("pairs", 6), ("flags", {}), ("schedule", expected_schedule)):
                same(plan.get(key), expected, "plan " + key)
            same(set(plan.get("expectedPackageEntries", [])) == EXPECTED_ENTRIES, True, "expected package entries")
            same(sorted(plan.get("expectedAddedPackageEntries", [])), sorted(EXPECTED_ADDED_ENTRIES), "expected added package entries")
            same(plan.get("expectedWorkers"), None, "unchanged production worker policy")
            same(plan.get("memorySchedule"), memory_schedule(1 if order == "AB" else 2), "registered memory schedule")
            if dictionary == "vndb":
                same(plan.get("vndbSahAllocationPolicy"), {"unitBytes": 4096, "rangeUnits": [37, 37], "origin": "explicit"}, "VNDB allocation policy")
            same(identities["arms"]["A"]["sha"], BASELINE, "baseline identity")
            same(identities["arms"]["B"]["sha"], CANDIDATE, "candidate identity")
            a, b = identities["arms"]["A"], identities["arms"]["B"]
            for arm, identity in (("A", a), ("B", b)):
                same(identity["tree"], EXPECTED_TREES[arm], "runtime source tree " + arm)
                verify_source_hashes(identity)
            changes = sorted(name for name in a["entries"].keys() & b["entries"].keys() if a["entries"][name] != b["entries"][name])
            added = sorted(b["entries"].keys() - a["entries"].keys())
            removed = sorted(a["entries"].keys() - b["entries"].keys())
            same(changes, sorted(EXPECTED_ENTRIES), "package changes")
            same(added, sorted(EXPECTED_ADDED_ENTRIES), "package additions")
            same(removed, [], "package removals")
            same(sorted(identities["changedPackageEntries"]), changes, "package change receipt")
            same(sorted(identities.get("addedPackageEntries", [])), added, "package addition receipt")
            same(sorted(identities.get("removedPackageEntries", [])), removed, "package removal receipt")
            result["nestedPackageAudit"] = inspect_packages(archive, prefix, identities)
            same(a["lockSha256"], b["lockSha256"], "dependency lock")
            same(a["fixtureLockSha256"], b["fixtureLockSha256"], "fixture lock")
            browser = read_json("browser-identity.json")
            result["identities"] = {
                "baselineSha": a["sha"], "candidateSha": b["sha"],
                "baselinePackageSha256": a["packageSha256"], "candidatePackageSha256": b["packageSha256"],
                "changedPackageEntries": changes, "addedPackageEntries": added, "removedPackageEntries": removed, "lockSha256": a["lockSha256"],
                "fixtureLockSha256": a["fixtureLockSha256"], "browser": browser,
            }
            if len(observations) > len(expected_schedule):
                raise ValueError("More observations than registered")
            reference = None
            workers = set()
            hosts = []
            for index, item in enumerate(observations):
                same({key: item[key] for key in ("id", "kind", "pair", "arm")}, expected_schedule[index], "observation schedule")
                if type(item.get("totalImportMs")) not in (int, float) or not math.isfinite(item["totalImportMs"]) or item["totalImportMs"] <= 0:
                    raise ValueError("Invalid complete-import duration")
                arm = "B" if item["arm"] == "B" else "A"
                identity = identities["arms"][arm]
                summary = read_json(item["id"] + "/summary.json")
                raw = read_json(item["id"] + "/run-1.json")
                receipt = validate_import_summary(
                    summary, raw, dictionary=dictionary, fixture=FIXTURES[dictionary],
                    source_sha=identity["sha"], package_sha256=identity["packageSha256"],
                    browser_version=browser["version"], import_flags=None,
                    source_hashes=identity["sourceHashes"], source_dirty=False, media_check="sample",
                    vndb_sah_allocation_units=(37, 37) if dictionary == "vndb" else None,
                )
                same(receipt, read_json(item["id"] + "/canonical-receipt.json"), "canonical receipt")
                if reference is not None:
                    require_matching_receipts(reference, receipt)
                else:
                    reference = receipt
                same(item["totalImportMs"], summary["runs"][0]["totalImportMs"], "observation duration")
                for entry in summary["runs"][0]["step4Breakdown"]["dictionaries"]:
                    workers.add(entry.get("parserWorkerCount"))
                if item["kind"] == "candidate" and item["pair"] == 1:
                    host = summary["hostEnvironment"]
                    hosts.append({"arm": arm, **{key: host.get(key) for key in (
                        "nodeVersion", "v8Version", "cpuModel", "logicalCpuCount", "availableParallelism",
                        "totalMemoryBytes", "cgroupCpuQuotaCores", "cgroupMemoryMaxBytes", "loadAverage",
                    )}})
            result["parserWorkerCounts"] = sorted(workers, key=str)
            result["hostExamples"] = hosts
            result["validatedTimedReceipts"] = len(observations)
            result["completeRegisteredTimingCohort"] = len(observations) == len(expected_schedule)
            result["candidateVsBaseline"] = paired(observations, "candidate", "B")
            result["identicalCodeControl"] = paired(observations, "control", "C")
            if analysis is not None:
                same(result["candidateVsBaseline"], analysis["candidateVsBaseline"], "paired analysis recomputation")
                same(result["identicalCodeControl"], analysis["identicalCodeControl"], "control analysis recomputation")
            media_reference = None
            media_count = 0
            for arm in order:
                key = "exhaustive-media-" + arm
                summary = read_json(key + "/summary.json", False)
                if summary is None:
                    continue
                identity = identities["arms"][arm]
                receipt = validate_import_summary(
                    summary, read_json(key + "/run-1.json"), dictionary=dictionary, fixture=FIXTURES[dictionary],
                    source_sha=identity["sha"], package_sha256=identity["packageSha256"],
                    browser_version=browser["version"], import_flags=None,
                    source_hashes=identity["sourceHashes"], source_dirty=False, media_check="all",
                    vndb_sah_allocation_units=(37, 37) if dictionary == "vndb" else None,
                )
                same(receipt, read_json(key + "/canonical-receipt.json"), "all-media canonical receipt")
                if reference is None:
                    raise ValueError("All-media receipt without timed reference")
                require_matching_receipts(reference, receipt, compare_media=False)
                if media_reference is not None:
                    require_matching_receipts(media_reference, receipt)
                media_reference = receipt
                media_count += 1
            result["validatedAllMediaReceipts"] = media_count
        except Exception as error:
            result["auditErrors"].append(type(error).__name__ + ": " + str(error))
    memory = read_json("memory/memory-comparison.json", False)
    memory_audit = read_json("memory/memory-audit.json", False)
    result["producerMemoryAudit"] = memory_audit
    result["memorySemanticFailures"] = read_json("memory/semantic-failures.json", False)
    result["memoryAuditFailure"] = read_json("memory/memory-audit-failure.json", False)
    if memory is not None:
        try:
            replication = 1 if order == "AB" else 2
            expected_memory = memory_schedule(replication)
            memory_plan = read_json("memory/plan.json")
            for key, expected in (("schedule", expected_memory), ("replication", replication), ("dictionary", dictionary),
                                  ("authoritativeTiming", False), ("sourceHashes", identities["arms"])):
                same(memory_plan.get(key), expected, "memory plan " + key)
            original = member_bytes(archive, prefix + "memory/harness-original.js")
            instrumented = member_bytes(archive, prefix + "memory/harness-instrumented.js")
            harness_path = "test/chromium/extension-two-dictionary-import.e2e.js"
            if original != (ROOT / harness_path).read_bytes():
                raise ValueError("Memory original harness bytes differ from the frozen source")
            if instrumented != memory_overlay(original.decode("utf-8")).encode():
                raise ValueError("Memory overlay differs from the exact registered transformation")
            overlay_sha = hashlib.sha256(instrumented).hexdigest()
            same(memory_plan["overlaySha256"], overlay_sha, "memory overlay digest")
            memory_rows = read_json("memory/observations.json")
            same([{key: row[key] for key in ("index", "arm", "name", "pair")} for row in memory_rows], expected_memory, "memory observation schedule")
            recomputed = memory_comparison(memory_rows, dictionary, replication, memory_schedule)
            same(recomputed, memory, "memory summary recomputation")
            memory_receipts = 0
            extracted = 0
            with tempfile.TemporaryDirectory(prefix="manabitan-raw-memory-audit-") as directory:
                target = pathlib.Path(directory)
                selected = ["plan.json", "observations.json", "memory-comparison.json"]
                for item in expected_memory:
                    selected.extend([item["name"] + "/memory.json", item["name"] + "/markers.jsonl"])
                    identity = identities["arms"][item["arm"]]
                    hashes = dict(identity["sourceHashes"])
                    hashes[harness_path] = overlay_sha
                    summary = read_json("memory/" + item["name"] + "/summary.json")
                    raw = read_json("memory/" + item["name"] + "/run-1.json")
                    receipt = validate_import_summary(
                        summary, raw, dictionary=dictionary, fixture=FIXTURES[dictionary],
                        source_sha=identity["sha"], package_sha256=identity["packageSha256"],
                        browser_version=browser["version"], import_flags=None, source_hashes=hashes,
                        source_dirty=True, media_check="sample",
                        vndb_sah_allocation_units=(37, 37) if dictionary == "vndb" else None,
                    )
                    same(receipt, read_json("memory/" + item["name"] + "/canonical-receipt.json"), "memory canonical receipt")
                    if reference is None:
                        raise ValueError("Memory receipt without verified timed reference")
                    require_matching_receipts(reference, receipt)
                    memory_receipts += 1
                for relative in selected:
                    payload = member_bytes(archive, prefix + "memory/" + relative)
                    extracted += len(payload)
                    if extracted > 512 * 1024 * 1024:
                        raise ValueError("Raw memory files exceed inspection budget")
                    path = target / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(payload)
                independent = audit_cell(target)
            if memory_audit is not None:
                same(independent, memory_audit, "raw-scan memory audit recomputation")
            result["independentRawMemoryAudit"] = independent
            result["validatedMemoryReceipts"] = memory_receipts
            result["memorySummary"] = {key: memory[key] for key in (
                "everyObservationQualified", "passesProspectiveMemoryScreen", "metrics", "pairs"
            )}
        except Exception as error:
            result["auditErrors"].append("Memory " + type(error).__name__ + ": " + str(error))
    if analysis is None or result["auditErrors"] or result.get("memorySemanticFailures") or result.get("memoryAuditFailure"):
        tails = []
        for name in members:
            if not name.endswith(".log"):
                continue
            tail = b""
            with archive.open(name) as stream:
                while True:
                    block = stream.read(65536)
                    if not block:
                        break
                    tail = (tail + block)[-12000:]
            text = tail.decode("utf-8", "replace")
            if any(marker in text for marker in ("Traceback", "Error:", "FAIL", "failed", "Target crashed")):
                tails.append({"path": name, "tail": text[-2400:]})
        result["failureLogTails"] = tails[-6:]
    result["completeAcquisition"] = bool(
        result.get("completeRegisteredTimingCohort") and result.get("validatedAllMediaReceipts") == 2
        and analysis is not None and memory is not None and memory_audit is not None
        and result.get("memorySemanticFailures") == [] and result.get("memoryAuditFailure") is None
        and result.get("validatedMemoryReceipts") == 4 and result.get("independentRawMemoryAudit") is not None
        and result.get("nestedPackageAudit", {}).get("status") == "verified"
    )
    result["auditStatus"] = "failed" if result["auditErrors"] else (
        "verified" if result["completeAcquisition"] else "incomplete"
    )
    result["limits"] = "Per-host timing only; no pooling. Outer ZIP metadata, actual nested package bytes/member maps, source trees, frozen runtime payloads, summary/raw/canonical import receipts, and original process-memory scans/markers independently checked. Sampling remains an approximation of peaks; arithmetic correctness does not establish a latency gain."
    return result

def configure(experiment):
    global EXPERIMENT, RUN_ID, BASELINE, CANDIDATE, WORKFLOW_HEAD, SOURCE_BRANCH
    global EXPECTED_ENTRIES, EXPECTED_ADDED_ENTRIES, EXPECTED_ARTIFACTS, EXPECTED_TREES, EXPECTED_RUNTIME_PAYLOADS
    EXPERIMENT = experiment
    RUN_ID, BASELINE, CANDIDATE = experiment["runId"], experiment["baseline"], experiment["candidate"]
    WORKFLOW_HEAD, SOURCE_BRANCH = experiment["workflowHead"], experiment["sourceBranch"]
    EXPECTED_ENTRIES = set(experiment["expectedPackageEntries"])
    EXPECTED_ADDED_ENTRIES = set(experiment["expectedAddedPackageEntries"])
    EXPECTED_TREES = experiment["expectedTrees"]
    EXPECTED_RUNTIME_PAYLOADS = experiment["expectedRuntimePayloads"]
    same(experiment["pairs"], 6, "frozen initial cohort pair count")
    EXPECTED_ARTIFACTS = {
        f"{experiment['artifactPrefix']}-{dictionary}-{order}-b9cacc": (dictionary, order)
        for dictionary in ("jmdict", "jitendex", "vndb") for order in ("AB", "BA")
    }

def inspect_experiment(name, experiment):
    configure(experiment)
    source_run = api(f"/actions/runs/{RUN_ID}")
    require_run_identity(source_run)
    source_trees = {}
    for arm, sha in (("A", BASELINE), ("B", CANDIDATE)):
        commit = api("/git/commits/" + sha)
        same(commit["sha"], sha, "runtime Git commit " + arm)
        same(commit["tree"]["sha"], EXPECTED_TREES[arm], "runtime Git tree " + arm)
        source_trees[arm] = commit["tree"]["sha"]
    listing = api(f"/actions/runs/{RUN_ID}/artifacts?per_page=100")
    artifacts = listing["artifacts"]
    if listing["total_count"] > len(artifacts):
        raise RuntimeError("Artifact pagination exceeds the frozen six-artifact plan")
    job_listing = api(f"/actions/runs/{RUN_ID}/jobs?per_page=100")
    jobs = job_listing["jobs"]
    if job_listing["total_count"] > len(jobs):
        raise RuntimeError("Job pagination exceeds the source workflow")
    names = [item["name"] for item in artifacts]
    auxiliary_names = set(experiment["expectedAuxiliaryArtifacts"])
    auxiliary = []
    for artifact in artifacts:
        if artifact["name"] not in auxiliary_names:
            continue
        workflow_run = artifact.get("workflow_run") or {}
        same(artifact.get("expired"), False, "auxiliary artifact expiry")
        for key, expected in (("id", RUN_ID), ("head_sha", WORKFLOW_HEAD), ("head_branch", SOURCE_BRANCH),
                              ("repository_id", source_run["repository"]["id"]), ("head_repository_id", source_run["head_repository"]["id"])):
            same(workflow_run.get(key), expected, "auxiliary artifact source " + key)
        auxiliary.append({key: artifact.get(key) for key in ("id", "name", "size_in_bytes", "digest", "expired")})
    report = {
        "schemaVersion": 2, "experiment": name, "sourceRunId": RUN_ID, "workflowHead": WORKFLOW_HEAD,
        "runtimeCandidate": CANDIDATE, "sourceTreesVerifiedFromGitHub": source_trees,
        "sourceRunStatus": source_run["status"], "sourceRunConclusion": source_run.get("conclusion"),
        "snapshotOnlyNoWait": True,
        "missingArtifacts": sorted(set(EXPECTED_ARTIFACTS) - set(names)),
        "unexpectedArtifacts": sorted(set(names) - set(EXPECTED_ARTIFACTS) - auxiliary_names),
        "missingAuxiliaryArtifacts": sorted(auxiliary_names - set(names)),
        "auxiliaryArtifactMetadata": auxiliary,
        "auxiliaryScope": "Named build-validation metadata only; its package bytes are reviewed separately. All six import-cell packages are independently reopened here.",
        "duplicateArtifactNames": sorted({value for value in names if names.count(value) > 1}),
        "jobs": [{key: job.get(key) for key in (
            "id", "name", "status", "conclusion", "started_at", "completed_at", "runner_name", "runner_id"
        )} for job in jobs],
        "cells": [],
    }
    for artifact in sorted(artifacts, key=lambda item: item["name"]):
        if artifact["name"] not in EXPECTED_ARTIFACTS:
            continue
        cell = {"artifactId": artifact["id"], "artifactName": artifact["name"], "artifactExpired": artifact.get("expired")}
        try:
            same(artifact.get("expired"), False, "artifact expiry")
            workflow_run = artifact.get("workflow_run") or {}
            for key, expected in (("id", RUN_ID), ("head_sha", WORKFLOW_HEAD), ("head_branch", SOURCE_BRANCH),
                                  ("repository_id", source_run["repository"]["id"]), ("head_repository_id", source_run["head_repository"]["id"])):
                same(workflow_run.get(key), expected, "artifact source " + key)
            with tempfile.TemporaryFile() as target:
                cell["download"] = download(artifact, target)
                with zipfile.ZipFile(target) as archive:
                    cell.update(inspect_zip(archive, *EXPECTED_ARTIFACTS[artifact["name"]]))
        except Exception as error:
            cell["auditStatus"] = "failed"
            cell["downloadOrInspectionError"] = type(error).__name__ + ": " + str(error)
        report["cells"].append(cell)
    report["completeFrozenCohortAudited"] = bool(
        source_run["status"] == "completed" and not report["missingArtifacts"] and not report["unexpectedArtifacts"]
        and not report["duplicateArtifactNames"] and not report["missingAuxiliaryArtifacts"] and len(report["cells"]) == len(EXPECTED_ARTIFACTS)
        and all(cell.get("auditStatus") == "verified" for cell in report["cells"])
    )
    report["allMemoryScreensPassed"] = bool(report["completeFrozenCohortAudited"] and all(
        cell.get("memorySummary", {}).get("passesProspectiveMemoryScreen") is True for cell in report["cells"]
    ))
    report["performancePromotionClaim"] = False
    return report

def main():
    if not TOKEN:
        raise RuntimeError("Read-only GitHub token is required")
    same(CONFIG["schemaVersion"], 1, "reader config schema")
    support_proof = {}
    for relative, expected in CONFIG["supportSha256"].items():
        actual = hashlib.sha256((ROOT / relative).read_bytes()).hexdigest()
        same(actual, expected, "frozen independent audit support " + relative)
        support_proof[relative] = actual
    selected = os.environ.get("MANABITAN_AUDIT_EXPERIMENTS", "score-validation").split(",")
    if len(selected) != len(set(selected)) or any(name not in CONFIG["experiments"] for name in selected):
        raise ValueError("Unknown or duplicate selected experiment")
    report = {"schemaVersion": 2, "readerWorkflowHead": os.environ.get("GITHUB_SHA"),
        "readerSha256": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
        "configSha256": hashlib.sha256(CONFIG_BYTES).hexdigest(), "supportSha256": support_proof,
        "acquiredAtEpochSeconds": time.time(), "snapshotOnlyNoWait": True, "experiments": []}
    for name in selected:
        try:
            report["experiments"].append(inspect_experiment(name, CONFIG["experiments"][name]))
        except Exception as error:
            report["experiments"].append({"experiment": name, "completeFrozenCohortAudited": False,
                "auditError": type(error).__name__ + ": " + str(error)})
    report["allSelectedFrozenCohortsAudited"] = all(item.get("completeFrozenCohortAudited") is True for item in report["experiments"])
    output = ROOT / "builds/perf/frozen-evidence-reader"
    output.mkdir(parents=True, exist_ok=False)
    (output / "report.json").write_text(json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + "\n")
    (output / "reader.py").write_bytes(pathlib.Path(__file__).read_bytes())
    (output / "experiments.json").write_bytes(CONFIG_BYTES)
    print("BEGIN_MANABITAN_IMPORT_AUDIT_JSON")
    print(json.dumps(report, sort_keys=True, allow_nan=False))
    print("END_MANABITAN_IMPORT_AUDIT_JSON")
    return 0 if report["allSelectedFrozenCohortsAudited"] else 1

if __name__ == "__main__":
    raise SystemExit(main())
