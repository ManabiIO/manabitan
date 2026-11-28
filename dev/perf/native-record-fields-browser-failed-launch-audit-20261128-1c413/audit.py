#!/usr/bin/env python3
"""Inspect the six immutable failed launch archives; never acquire imports."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import sys
import zipfile

from transport import (
    AuditError, GitHub, digest, file_digest, inspect_zip, parse_json,
    read_json, require, stream_digest, write_json,
)

REPOSITORY = "ManabiIO/manabitan"
RUN = 46136060186
HEAD = "7d003d51dd3bd6ce24f9159680e658fe8f32dd07"
TREE = "72f34489f0a5449dcc54f6ec1122a26519f1b7e8"
PARENT = "8982dd89fac525100bdcaca7507bfff7feb2c842"
BASE = "f28c2801fcfd9416f220b46b9cbafeee901c1cb2"
BRANCH = "perf/native-record-fields-browser-20261128-1c413"
WORKFLOW = ".github/workflows/import-native-record-fields-1c413.yml"
PRODUCER = "dev/perf/native-record-fields-browser-20261128-1c413"
METADATA = "builds/perf/native-record-fields-browser-metadata"
AUDITOR = "dev/perf/native-record-fields-browser-failed-launch-audit-20261128-1c413"
CELLS = {name + "-" + order for name in ("jmdict", "jitendex", "vndb") for order in ("AB", "BA")}
SOURCE_PATHS = {WORKFLOW} | {
    PRODUCER + "/" + name for name in (
        "ACTIVATION.md", "README.md", "audit-activation.py", "source.json",
        "study.json", "test-activation.py", "verify-source.py",
    )
}
METADATA_PATHS = {METADATA + "/" + name for name in (
    "source-before-setup.json", "source-before-setup.log",
    "activation.json", "activation.log", "step-outcomes.json",
)}
STEP_OUTCOMES = {
    "source": "failure", "setup": "skipped", "generated": "skipped",
    "protocol": "skipped", "browser": "skipped", "qualify": "skipped", "activation": "failure",
}
STEP_NAMES = {
    "Bind original attempt, immutable source and completed prerequisites": "failure",
    "Prepare exact Node and locked dependencies": "skipped",
    "Bind generated native assets and setup document": "skipped",
    "Verify the pure activation receipt checker": "skipped",
    "Install matching Chromium": "skipped",
    "Restore pinned dictionary archives": "skipped",
    "Acquire the original frozen comparisons and separate media and memory checks": "skipped",
    "Audit activation in every original receipt, including failures": "failure",
    "Preserve complete step outcomes without replacing any acquisition": "failure",
    "Preserve every original report, package, source proof and failure": "success",
}
TRANSPORT_SHA = "1c3c6f1c180eb8512146e7999561d8fd8cfdf10efb693a54b21d805a3a2a0aa6"
CHECKER_IDENTITY = {"bytes": 25222, "sha256": "15c994658125015edaa4aae931ce82f122526bd4c0cc4e65286cd3975642010a"}
STUDY_IDENTITY = {"bytes": 56480, "sha256": "fa55a9f32db0561ddf02f1a958874b00ed09f27b3a313c56c27d2b2e602aa8c9"}


def same(actual, expected, message):
    require(json.dumps(actual, sort_keys=True, allow_nan=False) ==
            json.dumps(expected, sort_keys=True, allow_nan=False), message)


def git_blob(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def identity(path):
    return {"bytes": path.stat().st_size, "sha256": file_digest(path)}


def source_binding():
    require(sys.flags.optimize == 0, "Optimized Python is not permitted")
    root = Path(__file__).resolve().parents[3]
    source = read_json(Path(__file__).with_name("source.json"))
    expected_paths = {
        AUDITOR + "/" + name for name in ("audit.py", "test-audit.py", "transport.py", "manifest.json", "README.md")
    } | {".github/workflows/native-fields-browser-failed-launch-audit-1c413.yml"}
    same(sorted(source["files"]), sorted(expected_paths), "Complete auditor source boundary")
    result = {}
    for path, expected in source["files"].items():
        target = root / path
        require(target.is_file() and not target.is_symlink(), "Missing regular auditor source")
        data = target.read_bytes()
        actual = {"gitBlob": git_blob(data), "bytes": len(data), "sha256": digest(data)}
        same(actual, expected, "Auditor source changed: " + path)
        result[path] = actual
    same(file_digest(Path(__file__).with_name("transport.py")), TRANSPORT_SHA, "Reviewed transport changed")
    return root, result


def validate_manifest(manifest):
    same(manifest.get("schemaVersion"), 1, "Manifest version")
    same(manifest.get("enabled"), True, "Inert failure reader")
    same(manifest.get("repository"), REPOSITORY, "Repository")
    same(manifest.get("publication"), {
        "runId": RUN, "headSha": HEAD, "headBranch": BRANCH, "runAttempt": 1,
        "event": "push", "workflowPath": WORKFLOW, "headTree": TREE,
    }, "Exact original publication")
    same(manifest.get("expectedRunConclusion"), "failure", "Original outcome must remain failure")
    same(sorted(manifest.get("archiveSources", {})), sorted(SOURCE_PATHS), "Exact archived source set")
    artifacts = manifest.get("artifacts")
    require(type(artifacts) is list and len(artifacts) == 6, "Every original artifact is required")
    same(sorted(item["kind"] for item in artifacts), sorted(CELLS), "Exact six original roles")
    require(len({item["id"] for item in artifacts}) == 6 and
            len({item["jobId"] for item in artifacts}) == 6, "Duplicate original identity")
    for item in artifacts:
        dictionary, order = item["kind"].split("-")
        same(item["name"], "native-record-fields-browser-" + item["kind"] + "-" + HEAD, "Artifact name")
        same(item["jobName"], "Complete import (" + dictionary + ", " + order + ")", "Job name")
        same(item["expectedConclusion"], "failure", "Failed original cannot become passing")
        for key in ("id", "jobId", "sizeBytes"):
            require(type(item[key]) is int and item[key] > 0, "Invalid original identity")
        require(item["sizeBytes"] < 1024 * 1024 and re.fullmatch(r"[0-9a-f]{64}", item["sha256"]),
                "Unexpected original failure archive")
    return manifest


def validate_original_api(run, jobs, manifest):
    for key, expected in {
        "id": RUN, "head_sha": HEAD, "head_branch": BRANCH, "run_attempt": 1,
        "event": "push", "path": WORKFLOW, "status": "completed", "conclusion": "failure",
    }.items():
        same(run.get(key), expected, "Original run " + key)
    require(jobs.get("total_count") == 6 and len(jobs.get("jobs", [])) == 6, "Complete original jobs")
    same(sorted(job["id"] for job in jobs["jobs"]),
         sorted(item["jobId"] for item in manifest["artifacts"]), "Original job set")
    by_id = {}
    for job in jobs["jobs"]:
        expected = next(item for item in manifest["artifacts"] if item["jobId"] == job["id"])
        for key, value in {
            "run_id": RUN, "head_sha": HEAD, "run_attempt": 1, "name": expected["jobName"],
            "status": "completed", "conclusion": "failure",
        }.items():
            same(job.get(key), value, "Original failed job " + key)
        steps = job["steps"]
        require(len({step["name"] for step in steps}) == len(steps), "Duplicate original step")
        by_name = {step["name"]: step for step in steps}
        for name, conclusion in STEP_NAMES.items():
            same(by_name.get(name, {}).get("conclusion"), conclusion, "Original step " + name)
        failed = sorted(step["name"] for step in steps if step.get("conclusion") == "failure")
        same(failed, sorted(name for name, outcome in STEP_NAMES.items() if outcome == "failure"),
             "Unexpected original failure stage")
        by_id[job["id"]] = job
    return by_id


def validate_members(names):
    same(sorted(names), sorted(SOURCE_PATHS | METADATA_PATHS),
         "The original failure archive must contain exactly eight sources and five failure receipts")
    require(len(names) == 13, "Duplicate/missing original archive member")


def extract_original(path, destination):
    destination.mkdir()
    inventory = []
    with zipfile.ZipFile(path) as archive:
        entries = inspect_zip(archive)
        files = [entry.filename for entry in entries if not entry.is_dir()]
        validate_members(files)
        for entry in entries:
            if entry.is_dir():
                inventory.append({"path": entry.filename, "directory": True, "bytes": 0, "sha256": digest(b"")})
                continue
            target = destination / entry.filename
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(entry) as source, target.open("xb") as output:
                item = stream_digest(source, output, entry.file_size)
            inventory.append({"path": entry.filename, "directory": False, **item})
    return inventory


def one_json(log, key):
    values = []
    for original in log.splitlines():
        line = re.sub(r"^\ufeff?\d{4}-\d\d-\d\dT\S+Z ", "", original)
        if not line.startswith("{"):
            continue
        value = parse_json(line.encode())
        if type(value) is dict and key in value:
            values.append(value)
    require(len(values) == 1, "Expected one complete original " + key + " receipt")
    return values[0]


def verify_failure_receipts(root, kind):
    dictionary, order = kind.split("-")
    source = read_json(root / METADATA / "source-before-setup.json")
    same(source, {
        "schemaVersion": 1, "passed": False, "phase": "launch", "studyHead": HEAD,
        "error": "RuntimeError('Pinned fixture metadata changed')",
        "timingAcquired": False, "productExecuted": False,
    }, "Original source guard failure changed")
    activation = read_json(root / METADATA / "activation.json")
    same(activation, {
        "schemaVersion": 1, "passed": False, "observations": [],
        "checkerFile": CHECKER_IDENTITY, "studyFile": STUDY_IDENTITY,
        "failure": {
            "type": "FileNotFoundError",
            "error": "[Errno 2] No such file or directory: 'builds/perf/native-record-fields-browser-cell/registered-plan.json'",
        },
        "scope": "No acquisition; disabled/unsealed or incomplete original evidence fails closed",
    }, "Original absent-plan failure changed")
    outcome = read_json(root / METADATA / "step-outcomes.json")
    expected = {
        "cellComplete": False, "dictionary": dictionary, "initialOrder": order,
        "numericQualificationDecided": False, "runAttempt": "1",
        "required": list(STEP_OUTCOMES), "failed": list(STEP_OUTCOMES),
        "steps": {name: {"outcome": value, "conclusion": value} for name, value in STEP_OUTCOMES.items()},
    }
    same(outcome, expected, "Original incomplete/skipped outcomes changed")
    same(one_json((root / METADATA / "source-before-setup.log").read_text(encoding="utf-8"), "phase"),
         source, "Guard log and file differ")
    same(one_json((root / METADATA / "activation.log").read_text(encoding="utf-8"), "failure"),
         activation, "Activation log and file differ")
    return {"source": source, "activation": activation, "outcome": outcome}


def fetch_original_log(api, entry, output):
    expected = entry["originalJobLog"]
    raw = api.json("/git/blobs/" + expected["gitBlob"], "original-job-log-" + str(entry["jobId"]))
    same(raw.get("sha"), expected["gitBlob"], "Original retained log Git identity")
    same(raw.get("encoding"), "base64", "Original retained log encoding")
    data = base64.b64decode("".join(raw["content"].split()), validate=True)
    same({"gitBlob": git_blob(data), "bytes": len(data), "sha256": digest(data)}, expected,
         "Original retained log bytes")
    path = output / "original-job.log"
    path.write_bytes(data)
    return data.decode("utf-8")


def audit_cell(api, entry, manifest, job, destination):
    destination.mkdir()
    outer, metadata = api.artifact(entry, manifest["publication"], destination)
    write_json(destination / "original-artifact.json", {"metadata": metadata, "zip": identity(outer)})
    inventory = extract_original(outer, destination / "members")
    write_json(destination / "member-inventory.json", inventory)
    root = destination / "members"
    for path, expected in manifest["archiveSources"].items():
        data = (root / path).read_bytes()
        same({"gitBlob": git_blob(data), "bytes": len(data), "sha256": digest(data)}, expected,
             "Archived immutable source differs: " + path)
        same(data.hex(), api.source(HEAD, path).hex(), "Archived source is not exact original Git: " + path)
    receipts = verify_failure_receipts(root, entry["kind"])
    log = fetch_original_log(api, entry, destination)
    for key, receipt in (("phase", receipts["source"]), ("checkerFile", receipts["activation"]),
                         ("cellComplete", receipts["outcome"])):
        same(one_json(log, key), receipt, "Original job log does not match archived " + key)
    result = {
        "kind": entry["kind"], "artifact": entry, "originalJob": job,
        "auditPassed": True, "originalCellPassed": False, "qualificationPassed": False,
        "verifiedZeroAcquisition": True, "originalReportCount": 0,
        "originalTimingObservationCount": 0, "fullOriginalArchiveRetained": True,
        "sourceFiles": manifest["archiveSources"], "receipts": receipts,
        "members": inventory,
        "scope": "Evidence of the failed original launch only; no corrected cohort is authorized or executed.",
    }
    write_json(destination / "result.json", result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    require(not args.output.exists() and not args.output.is_symlink(), "Output must be fresh")
    args.output.mkdir(parents=True, exist_ok=False)
    result = {"schemaVersion": 1, "cells": [], "errors": [], "auditCompleted": False,
              "allSixOriginalsVerified": False, "verifiedZeroAcquisition": False,
              "originalStudyPassed": False, "qualificationPassed": False,
              "performanceMeasurements": False, "replacementAcquisition": False}
    try:
        require(args.manifest.resolve() == Path(__file__).resolve().with_name("manifest.json"),
                "Use the frozen adjacent manifest")
        source_root, sources = source_binding()
        result["auditorSourceFiles"] = sources
        for relative in sources:
            target = args.output / "auditor-source" / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((source_root / relative).read_bytes())
        manifest = validate_manifest(read_json(args.manifest))
        write_json(args.output / "frozen-original-manifest.json", manifest)
        result["publication"] = manifest["publication"]
        api = GitHub(REPOSITORY, args.output)
        run = api.json("/actions/runs/" + str(RUN), "original-run")
        jobs = api.json("/actions/runs/" + str(RUN) + "/jobs?filter=all&per_page=100", "original-jobs")
        by_id = validate_original_api(run, jobs, manifest)
        listing = api.json("/actions/runs/" + str(RUN) + "/artifacts?per_page=100", "original-artifacts")
        same(listing.get("total_count"), 6, "Complete original artifact list")
        same(sorted(item["id"] for item in listing["artifacts"]),
             sorted(item["id"] for item in manifest["artifacts"]), "Complete original artifact IDs")
        tree = api.tree(HEAD, TREE)
        commit = api.json("/git/commits/" + HEAD, "original-head-commit")
        same([item["sha"] for item in commit["parents"]], [PARENT], "Original sole product parent")
        for path, expected in manifest["archiveSources"].items():
            require(path in tree and tree[path]["mode"] == "100644" and
                    tree[path]["sha"] == expected["gitBlob"] and tree[path]["size"] == expected["bytes"],
                    "Original source tree identity differs")
        for entry in sorted(manifest["artifacts"], key=lambda item: item["kind"]):
            destination = args.output / entry["kind"]
            try:
                result["cells"].append(audit_cell(api, entry, manifest, by_id[entry["jobId"]], destination))
            except Exception as error:
                failure = {"kind": entry["kind"], "stage": "original-artifact", "type": type(error).__name__,
                           "error": str(error), "originalCellPassed": False, "qualificationPassed": False,
                           "allDownloadedBytesRetained": True}
                result["errors"].append(failure)
                destination.mkdir(exist_ok=True)
                write_json(destination / "failure.json", failure)
            write_json(args.output / "result.json", result)
        result["auditCompleted"] = not result["errors"] and len(result["cells"]) == 6
        result["allSixOriginalsVerified"] = result["auditCompleted"]
        result["verifiedZeroAcquisition"] = result["auditCompleted"] and all(
            item["verifiedZeroAcquisition"] for item in result["cells"])
    except Exception as error:
        result["errors"].append({"stage": "preflight", "type": type(error).__name__, "error": str(error)})
    write_json(args.output / "result.json", result)
    print(json.dumps(result, sort_keys=True, allow_nan=False))
    return 0 if result["allSixOriginalsVerified"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
