"""Preserve and verify the original zero-observation launcher failure.

This module performs no I/O on import. Its explicit audit entry point reads one
fixed original artifact. It never runs JavaScript, WASM, a compiler or an import.
"""
from pathlib import Path
import re

import original_fields as original
from transport import GitHub, file_digest, parse_json, read_json, require, write_json

ROOT = "native-record-fields-1c413"
OUTER_LOG = "native-record-fields-preparation.log"
DIAGNOSTIC = "clang-21: error: invalid linker name in argument '-fuse-ld=wasm-ld-21'"
ARTIFACT = {
    "id": 15254144071,
    "name": "native-record-fields-1c413-b5743f37aa49eef96319e594ed42acd7a5e857f3",
    "sizeBytes": 3926247,
    "sha256": "c46d327aefbe24c26e6ef3c3b3375a0f786205efb00d56568d242a68d5cf1e7e",
}
PREPARATION_STEP = "Verify exact sources, native reproduction and focused behavior"
SCHEDULE_STEP = "Run the frozen fresh-process complete-call schedule"
UPLOAD_STEP = "Preserve complete source, captures, every observation and failure"


def expected_file_names(source):
    names = [item["path"] for item in source["files"]]
    original.equal(len(names), 77, "Original frozen file count")
    original.equal(len(set(names)), 77, "Original unique frozen file count")
    return {ROOT + "/frozen-kit/" + name for name in names} | {
        ROOT + "/frozen-kit/source.json",
        ROOT + "/frozen-workflow.yml",
        ROOT + "/build.log",
        ROOT + "/preparation.json",
        OUTER_LOG,
    }


def verify_failure_job(publication):
    run = publication["run"]
    job = publication["job"]
    original.equal(run.get("status"), "completed", "Original run completed")
    original.equal(run.get("conclusion"), "failure", "Original run failed")
    original.equal(job.get("status"), "completed", "Original job completed")
    original.equal(job.get("conclusion"), "failure", "Original job failed")
    original.equal(publication["allOriginalJobsSucceeded"], False, "Failure must never become original job success")
    selected = {}
    for name, conclusion in ((PREPARATION_STEP, "failure"), (SCHEDULE_STEP, "skipped"), (UPLOAD_STEP, "success")):
        matches = [step for step in job["steps"] if step.get("name") == name]
        original.equal(len(matches), 1, "One original step " + name)
        step = matches[0]
        original.equal(step.get("status"), "completed", "Completed step " + name)
        original.equal(step.get("conclusion"), conclusion, "Original step outcome " + name)
        selected[name] = step
    return selected


def verify_failure_records(preparation, build_log, outer_log, member_files, source):
    """Pure checks of already loaded records; historical frozen inputs stay separate."""
    original.equal(member_files, expected_file_names(source), "Every original artifact file, with no acquisition additions")
    original.equal(len(member_files), 82, "Original artifact file count")
    original.equal(preparation.get("complete"), False, "Incomplete original preparation")
    original.equal(preparation.get("timingAcquisition"), False, "Preparation was untimed")
    original.equal(preparation.get("localUntimed"), False, "Original hosted preparation")
    original.equal(preparation.get("node"), "v22.22.0", "Original preparation Node")
    original.equal(preparation.get("plannedNode"), "v22.22.0", "Original planned Node")
    original.equal(preparation.get("sources"), original.source_receipt(), "Original frozen sources")
    original.equal(preparation.get("schedule"), original.schedule_balance(), "Original frozen schedule balance")
    for key in ("compilerVersion", "linkerVersion"):
        require(re.search(r"\b21\.1\.8\b", preparation.get(key, "")) is not None, "Original pinned " + key)
    command = preparation["buildCommand"]
    original.equal(len(command), 13, "Original compiler command arity")
    original.equal(command[:2], ["clang-21", "-fuse-ld=wasm-ld-21"], "Exact rejected linker form")
    original.equal(command[2:10], [
        "--target=wasm32", "-O3", "-nostdlib", "-mbulk-memory",
        "-Wl,--no-entry", "-Wl,--import-memory", "-Wl,-z,stack-size=65536",
        "-Wl,--strip-all",
    ], "Original compiler flags")
    original.equal(command[10], "-o", "Original output option")
    require(command[11].startswith("/") and command[11].endswith("/" + ROOT + "/rebuilt-record-fields.wasm"), "Original absolute native output")
    require(command[12].startswith("/") and command[12].endswith("/" + original.KIT + "/record-fields.c"), "Original absolute frozen C source")
    original.equal(preparation.get("buildExitCode"), 1, "Original compiler-driver exit")
    require(DIAGNOSTIC in preparation.get("error", ""), "Exact linker-driver diagnostic in receipt")
    require("prepare.mjs:37:" in preparation.get("stack", ""), "Original failure before tests")
    original.equal(build_log.strip(), DIAGNOSTIC, "Entire original compiler output")
    for key in ("testExitCode", "tests", "rebuild"):
        require(key not in preparation, "No later preparation receipt: " + key)
    lines = [line for line in outer_log.splitlines() if line.strip()]
    original.equal(len(lines), 1, "One original untimed preparation log record")
    original.equal(parse_json(lines[0]), preparation, "Outer log and retained preparation receipt")
    forbidden = ("screen", "untimed-verification", "focused-tests", "rebuilt-record-fields.wasm", "affinity.json", "screen.log")
    for name in forbidden:
        prefix = ROOT + "/" + name
        require(all(item != prefix and not item.startswith(prefix + "/") for item in member_files), "No later original output " + name)
    return {
        "classification": "known-linker-driver-preflight-failure",
        "failureStage": "compiler-driver argument validation",
        "originalBuildExitCode": 1,
        "nativeModuleReproducedInOriginal": False,
        "originalFocusedTestsExecuted": False,
        "originalWarmupObservations": 0,
        "originalMeasuredObservations": 0,
        "newObservationFiles": 0,
        "historicalFrozenStage1RecordsAreNotNewObservations": True,
        "performanceResultAvailable": False,
        "nominationGatePassed": False,
        "qualifiedForComponentNomination": False,
    }


def audit_previous_failure(manifest, output, checkout):
    """Audit one immutable previous failure and return a nonqualifying receipt.

    On any mismatch the fresh evidence directory and failed receipt are kept,
    then an exception stops the caller. A valid failure may pass this records
    audit; it can never pass a component nomination.
    """
    output = Path(output).resolve()
    checkout = Path(checkout).resolve()
    require(not output.exists(), "Previous-failure output must be new")
    output.mkdir(parents=True)
    report = {
        "schemaVersion": 1,
        "kind": "original-zero-observation-launcher-failure-audit",
        "originalRunId": original.RUN,
        "originalJobId": original.JOB,
        "originalHead": original.HEAD,
        "originalTree": original.TREE,
        "auditPassed": False,
        "archiveIntegrityPassed": False,
        "sourceAndCaptureIntegrityPassed": False,
        "originalJobSucceeded": False,
        "performanceResultAvailable": False,
        "nominationGatePassed": False,
        "qualifiedForComponentNomination": False,
        "newTimingOrImportAcquired": False,
        "productCodeExecuted": False,
    }
    try:
        original.equal(manifest.get("schemaVersion"), 1, "Previous-failure manifest schema")
        original.equal(manifest.get("enabled"), True, "Explicit original-failure audit authorization")
        original.equal(manifest.get("repository"), original.REPO, "Original repository")
        original.equal(manifest.get("runId"), original.RUN, "Original run identity")
        original.equal(manifest.get("jobId"), original.JOB, "Original job identity")
        original.equal(manifest.get("headSha"), original.HEAD, "Original head identity")
        original.equal(manifest.get("artifact"), ARTIFACT, "Exact original artifact metadata")
        write_json(output / "audit-manifest.json", manifest)
        api = GitHub(original.REPO, output)
        publication = original.publication(api)
        report["originalSteps"] = verify_failure_job(publication)
        archive, metadata = api.artifact(ARTIFACT, {
            "runId": original.RUN, "headSha": original.HEAD, "headBranch": original.BRANCH,
        }, output)
        inventory = original.preserve_archive(archive, output / "original-evidence", metadata)
        report["archiveIntegrityPassed"] = True
        report["artifact"] = ARTIFACT
        report["originalArchiveRetained"] = archive.name
        evidence = output / "original-evidence" / ROOT
        plan, frozen, _encoder = original.verify_frozen_sources(evidence, checkout, api)
        capture, derived, totals = original.verify_captures(plan, frozen)
        report["sourceAndCaptureIntegrityPassed"] = True
        write_json(output / "independent-historical-capture-work.json", {
            "calls": derived, "totals": totals,
            "capturedCalls": len(capture["calls"]),
            "outputDigest": original.OUTPUT_DIGEST,
            "historicalCaptureReconstructionOnly": True,
            "newProductExecution": False,
        })
        source = read_json(frozen / "source.json")
        members = {name for name, value in inventory["members"].items() if not value["directory"]}
        preparation = read_json(evidence / "preparation.json")
        classification = verify_failure_records(
            preparation, (evidence / "build.log").read_text(),
            (output / "original-evidence" / OUTER_LOG).read_text(),
            members, source,
        )
        report.update(classification)
        report["artifactFiles"] = len(members)
        report["preparationSha256"] = file_digest(evidence / "preparation.json")
        report["buildLogSha256"] = file_digest(evidence / "build.log")
        report["outerLogSha256"] = file_digest(output / "original-evidence" / OUTER_LOG)
        report["auditPassed"] = True
        return report
    except Exception as error:
        report["error"] = type(error).__name__ + ": " + str(error)
        raise
    finally:
        write_json(output / "previous-failure-audit.json", report)
