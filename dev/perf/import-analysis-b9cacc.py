#!/usr/bin/env python3
"""Read one frozen qualification run; never build or run the extension."""
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
RUN_ID = 46101323881
BASELINE = "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2"
CANDIDATE = "15b77f6a453dac57bd4bd2a9bc0ba3a7ccb733e2"
SOURCE_BRANCH = "perf/import-compression-batch-20261127-b9cacc"
EXPECTED_ENTRIES = {
    "js/dictionary/zstd-term-content.js",
    "js/dictionary/zstd-term-content-compression-worker.js",
}
EXPECTED_ARTIFACTS = {
    f"compression-batch-{dictionary}-{order}-b9cacc": (dictionary, order)
    for dictionary in ("jmdict", "jitendex", "vndb") for order in ("AB", "BA")
}
ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "dev/perf/import-memory-20261125-a7f7"))
from qualification_receipts import validate_import_summary, require_matching_receipts
from protocol import memory_comparison, schedule as memory_schedule

FIXTURES = json.loads((ROOT / "test/perf/dictionaries.lock.json").read_text())["dictionaries"]
TOKEN = os.environ["GITHUB_TOKEN"]
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
    for key, value in (("id", RUN_ID), ("head_sha", CANDIDATE), ("head_branch", SOURCE_BRANCH), ("event", "push")):
        same(run.get(key), value, "source run " + key)
    same(run["repository"]["full_name"], REPOSITORY, "source repository")
    same(run.get("run_attempt"), 1, "source run attempt")

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
    if expected is not None:
        same(actual, expected, "artifact ZIP digest")
    return {"bytes": total, "sha256": digest.hexdigest(), "metadataDigestVerified": expected is not None}

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
            if dictionary == "vndb":
                same(plan.get("vndbSahAllocationPolicy"), {"unitBytes": 4096, "rangeUnits": [37, 37], "origin": "explicit"}, "VNDB allocation policy")
            same(identities["arms"]["A"]["sha"], BASELINE, "baseline identity")
            same(identities["arms"]["B"]["sha"], CANDIDATE, "candidate identity")
            a, b = identities["arms"]["A"], identities["arms"]["B"]
            same(set(a["entries"]) == set(b["entries"]), True, "package file sets")
            changes = sorted(name for name in a["entries"] if a["entries"][name] != b["entries"][name])
            same(changes, sorted(EXPECTED_ENTRIES), "actual package changes")
            same(sorted(identities["changedPackageEntries"]), changes, "package change receipt")
            same(a["lockSha256"], b["lockSha256"], "dependency lock")
            same(a["fixtureLockSha256"], b["fixtureLockSha256"], "fixture lock")
            browser = read_json("browser-identity.json")
            result["identities"] = {
                "baselineSha": a["sha"], "candidateSha": b["sha"],
                "baselinePackageSha256": a["packageSha256"], "candidatePackageSha256": b["packageSha256"],
                "changedPackageEntries": changes, "lockSha256": a["lockSha256"],
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
            memory_rows = read_json("memory/observations.json")
            recomputed = memory_comparison(memory_rows, dictionary, 1 if order == "AB" else 2, memory_schedule)
            same(recomputed, memory, "memory summary recomputation")
            if memory_audit is not None:
                for key in ("everyObservationQualified", "passesProspectiveMemoryScreen", "metrics"):
                    same(memory_audit[key], memory[key], "producer memory audit " + key)
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
    )
    result["auditStatus"] = "failed" if result["auditErrors"] else (
        "verified" if result["completeAcquisition"] else "incomplete"
    )
    result["limits"] = "Per-host timing only; no pooling. ZIP digest and summary/raw/canonical receipts checked. Nested package bytes and raw memory scans were not independently reopened; memory summary arithmetic was recomputed."
    return result

deadline = time.monotonic() + 45 * 60
last_status = None
while True:
    source_run = api(f"/actions/runs/{RUN_ID}")
    require_run_identity(source_run)
    status = (source_run["status"], source_run.get("conclusion"))
    if status != last_status:
        print(json.dumps({"sourceRun": RUN_ID, "status": status[0], "conclusion": status[1]}), flush=True)
        last_status = status
    if source_run["status"] == "completed" or time.monotonic() >= deadline:
        break
    time.sleep(30)
listing = api(f"/actions/runs/{RUN_ID}/artifacts?per_page=100")
artifacts = listing["artifacts"]
if listing["total_count"] > len(artifacts):
    raise RuntimeError("Artifact pagination exceeds the frozen six-artifact plan")
jobs = api(f"/actions/runs/{RUN_ID}/jobs?per_page=100")["jobs"]
names = [item["name"] for item in artifacts]
report = {
    "schemaVersion": 1, "sourceRunId": RUN_ID, "sourceHead": CANDIDATE,
    "sourceRunStatus": source_run["status"], "sourceRunConclusion": source_run.get("conclusion"),
    "waitTimedOut": source_run["status"] != "completed",
    "missingArtifacts": sorted(set(EXPECTED_ARTIFACTS) - set(names)),
    "unexpectedArtifacts": sorted(set(names) - set(EXPECTED_ARTIFACTS)),
    "duplicateArtifactNames": sorted({name for name in names if names.count(name) > 1}),
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
        if artifact.get("expired"):
            raise ValueError("Artifact expired")
        workflow_run = artifact.get("workflow_run") or {}
        same(workflow_run.get("id"), RUN_ID, "artifact source run")
        same(workflow_run.get("head_sha"), CANDIDATE, "artifact source head")
        with tempfile.TemporaryFile() as target:
            cell["download"] = download(artifact, target)
            with zipfile.ZipFile(target) as archive:
                cell.update(inspect_zip(archive, *EXPECTED_ARTIFACTS[artifact["name"]]))
    except Exception as error:
        cell["auditStatus"] = "failed"
        cell["downloadOrInspectionError"] = type(error).__name__ + ": " + str(error)
    report["cells"].append(cell)
print("BEGIN_MANABITAN_IMPORT_AUDIT_JSON")
print(json.dumps(report, sort_keys=True, allow_nan=False))
print("END_MANABITAN_IMPORT_AUDIT_JSON")
