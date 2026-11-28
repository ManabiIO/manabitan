"""Bind saved GitHub API records and a job log without acquiring observations."""

import hashlib
import json
from pathlib import Path
import re


REPOSITORY = "ManabiIO/manabitan"
REPOSITORY_ID = 1165902460
RUN_ID = 46114139837
RUN_ATTEMPT = 1
WORKFLOW_ID = 433451382
WORKFLOW_PATH = ".github/workflows/import-inflight-validation-830-83b3.yml"
BASELINE = "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2"
HEAD = "049cb11e6963604435998aa060e1400cc00365cb"
BRANCH = "perf/jmdict-inflight-validation-20261123-71149"
ARTIFACT_PREFIX = "import-inflight-validation-830-83b3"
READER_SHA256 = "593ee1c210689d8e9844763e3f87996e15330b03c888593b3b66e0411765136c"
READER_DIRECTORY = "import-inflight-validation-830-83b3-analysis-source"
CELLS = {"jmdict-AB": 12, "jmdict-BA": 12, "jitendex-AB": 6, "vndb-AB": 6}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, "Duplicate JSON key: " + key)
        value[key] = item
    return value


def read_binding(staging, cell):
    """Return the raw artifact record and independently checkable identity receipt.

    Outcome is deliberately separate: failed/incomplete jobs and an unfinished
    matrix run may still provide valid evidence. This function does not qualify it.
    """
    require(cell in CELLS, "Unexpected qualification cell")
    inputs = {}

    def read_record(name):
        path = staging / name
        require(path.is_file() and not path.is_symlink(), "Missing or linked API input: " + name)
        data = path.read_bytes()
        inputs[name] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        return json.loads(data, object_pairs_hook=unique_object,
                          parse_constant=lambda value: (_ for _ in ()).throw(ValueError("Nonfinite JSON: " + value)))

    run = read_record("run-api.json")
    job = read_record(cell + "-job-api.json")
    artifact = read_record(cell + "-artifact-api.json")
    log_fetch = read_record(cell + "-job-log-fetch.json")
    require(run["id"] == RUN_ID and run["run_attempt"] == RUN_ATTEMPT, "Run or attempt differs")
    require(run["head_sha"] == HEAD and run["head_branch"] == BRANCH, "Run source differs")
    require(run["workflow_id"] == WORKFLOW_ID and run["path"] == WORKFLOW_PATH, "Workflow differs")
    require(run["event"] == "pull_request", "Run event differs")
    require(run["repository"]["id"] == REPOSITORY_ID and run["repository"]["full_name"] == REPOSITORY,
            "Run repository differs")
    pulls = [pull for pull in run["pull_requests"] if pull["number"] == 830]
    require(len(pulls) == 1, "Run does not uniquely identify PR830")
    pull = pulls[0]
    require(pull["head"]["sha"] == HEAD and pull["head"]["ref"] == BRANCH, "PR head differs")
    require(pull["base"]["sha"] == BASELINE and pull["base"]["ref"] == "develop", "PR base differs")
    require(pull["head"]["repo"]["id"] == pull["base"]["repo"]["id"] == REPOSITORY_ID,
            "PR repositories differ")
    dictionary, order = cell.rsplit("-", 1)
    job_name = f"Complete import ({dictionary}, {order}, {CELLS[cell]} pairs)"
    require(type(job["id"]) is int and job["id"] > 0, "Invalid job ID")
    require(job["run_id"] == RUN_ID and job["run_attempt"] == RUN_ATTEMPT, "Job run or attempt differs")
    require(job["head_sha"] == HEAD and job["head_branch"] == BRANCH, "Job source differs")
    require(job["name"] == job_name, "Job cell differs")
    require(job["url"] == f"https://api.github.com/repos/{REPOSITORY}/actions/jobs/{job['id']}",
            "Job API URL differs")
    require(log_fetch["tool"] == "mcp__codex_apps__github_fetch_workflow_job_logs" and
            log_fetch["request"] == {"repo_full_name": REPOSITORY, "job_id": job["id"]},
            "Job log fetch request differs")
    require(type(artifact["id"]) is int and artifact["id"] > 0, "Invalid artifact ID")
    require(type(artifact["size_in_bytes"]) is int and artifact["size_in_bytes"] > 0, "Invalid artifact size")
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", artifact["digest"]) is not None, "Invalid artifact digest")
    require(artifact["name"] == ARTIFACT_PREFIX + "-" + cell, "Artifact cell differs")
    owner = artifact["workflow_run"]
    require(owner["id"] == RUN_ID and owner["head_sha"] == HEAD and owner["head_branch"] == BRANCH,
            "Artifact run or source differs")
    require(owner["repository_id"] == owner["head_repository_id"] == REPOSITORY_ID,
            "Artifact repositories differ")
    log_path = staging / (cell + "-workflow-job.log")
    require(log_path.is_file() and not log_path.is_symlink(), "Missing or linked job log")
    expected_lines = {
        "upload": (f"Artifact {artifact['name']} has been successfully uploaded! "
                   f"Final size is {artifact['size_in_bytes']} bytes. Artifact ID is {artifact['id']}"),
        "permanentUrl": (f"Artifact download URL: https://github.com/{REPOSITORY}/actions/runs/"
                         f"{RUN_ID}/artifacts/{artifact['id']}"),
    }
    matched, log_hash, log_bytes = {}, hashlib.sha256(), 0
    with log_path.open("rb") as stream:
        for line_number, raw in enumerate(stream, 1):
            log_hash.update(raw)
            log_bytes += len(raw)
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            for label, expected in expected_lines.items():
                if line.endswith(expected) and label not in matched:
                    matched[label] = {"lineNumber": line_number, "line": line}
    require(set(matched) == set(expected_lines), "Job log does not bind exact uploaded artifact name, size, ID and URL")
    require(log_fetch["output"] == {"encoding": "utf-8", "bytes": log_bytes, "sha256": log_hash.hexdigest()},
            "Job log bytes differ from the captured authenticated tool response")
    inputs[log_path.name] = {"bytes": log_bytes, "sha256": log_hash.hexdigest()}
    receipt = {
        "schemaVersion": 1, "identityVerified": True, "newAcquisition": False,
        "cell": cell, "runId": RUN_ID, "runAttempt": RUN_ATTEMPT, "headSha": HEAD,
        "workflowId": WORKFLOW_ID, "workflowPath": WORKFLOW_PATH,
        "runOutcome": {"status": run["status"], "conclusion": run["conclusion"]},
        "job": {"id": job["id"], "name": job_name, "status": job["status"], "conclusion": job["conclusion"]},
        "artifact": {"id": artifact["id"], "name": artifact["name"], "bytes": artifact["size_in_bytes"],
                     "sha256": artifact["digest"].removeprefix("sha256:"), "expired": artifact["expired"]},
        "logBinding": matched, "inputFiles": inputs,
        "binderSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "qualificationClaim": False,
        "scope": "Saved authenticated API identities, the exact job-log fetch request/output receipt, and the job upload log. Job/run outcome is retained without requiring success.",
    }
    return artifact, receipt
