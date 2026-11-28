#!/usr/bin/env python3
"""Exact-source full parser-output parity only; never a timing experiment."""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import tarfile

BASE = "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2"
CANDIDATE = "ebf4278afc59d83f191692bd587f0e1f7e8682b3"
TREE = "611b6e1591ffbbc9c978c33dee9af72a7b618536"
NODE = "v24.20.0"
ARCHIVE_SHA = "050a01b9994034c0e070d66e17d1f879b20d724772e8c187af354a879936d161"
CHECKPOINT_COMMIT = "35069bdeb7a904fb9a39c919717b61021af9e78b"
CHECKPOINT_PATH = "dev/perf/import-optimization-9bb32/phase1/checkpoint-phase1.tar.gz"
PARSER_SHA = "6962928b4810ac489048b6a686e3a6cdbcd7fe3116328a13fa458bd02634024c"
CHANGED_RUNTIME = {
    "ext/js/dictionary/wasm/term-bank-parser.c": "02fb89b447e8c5520092ae85c4c6194ed5e32e03fecaad2602bbf12545360797",
    "ext/lib/term-bank-parser.wasm": PARSER_SHA,
    "dev/data/dictionary-wasm/manifest.json": "45955ba6895c737e059fd9bba724980a11ca359a6b1859648ec7f3ba38790346",
}
MEMBERS = {
    "pipeline-replay.mjs": ("profiling/pipeline-replay.mjs", "f872a41547445c24d113c3718fcd9bb5e0cd5ea08e7f75d98ff3354c0ef3f214", 20137),
    "canonical-corpus.mjs": ("profiling/canonical-corpus.mjs", "5d822d0ce1d29e9954e9168ea82ff2de17905d8ef3ed70012c56afb17d16b1cc", 3005),
    "baseline-jmdict.json": ("profiling/composite-minsize-screen-1/jmdict-verify-A.json", "3f25a30bc1dec602e8727de2149fb7e84b408ccf3bfa5dddd9622d1fdf19df72", 12685),
    "baseline-jitendex.json": ("profiling/composite-minsize-screen-1/jitendex-verify-A.json", "85018fc74e5f8cb8531741729f1d5fa6ae4a9ac62ef2f23ecef00892ba4e4371", 15097),
    "baseline-vndb.json": ("profiling/composite-minsize-vndb-parity-1/A.json", "4106dfae754be0122f7abda2e94abdc08397399ee903e2464f124a569e63c7b2", 41320),
}
DIGESTS = {
    "jmdict": "3316003073c9c537e6a86fcbc8531aeed0df4d5a47d320816cc3fb13dbd05c6e",
    "jitendex": "bccdf7188947c790c99042dfc30269d0d89504b1adaee1a079d1f508fec34de0",
    "vndb": "cc0f0a5fb3f5bff0da39f7ad64a9339e9063b02a29acec33bb48379f7127f02f",
}
DICTIONARIES = list(DIGESTS)
RESOURCE_FIELDS = {"maxWasmHeapBytes", "parallelPeakQueuedOwnedContentBytes"}

def require(condition, message):
    if not condition:
        raise RuntimeError(message)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def file_digest(path):
    value = hashlib.sha256()
    with path.open("rb") as data:
        for block in iter(lambda: data.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()

def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")

def semantic_profile(value):
    if isinstance(value, list):
        return [semantic_profile(item) for item in value]
    if isinstance(value, dict):
        return {key: semantic_profile(item) for key, item in value.items()
                if not key.endswith("Ms") and key not in RESOURCE_FIELDS}
    return value

p = argparse.ArgumentParser(description=__doc__)
p.add_argument("--source", type=pathlib.Path, required=True)
p.add_argument("--checkpoint", type=pathlib.Path, required=True)
p.add_argument("--output", type=pathlib.Path, required=True)
p.add_argument("--workflow-sha", required=True)
args = p.parse_args()
source = args.source.resolve()
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=False)
status = {"schemaVersion": 1, "complete": False, "authoritativeTiming": False,
          "scope": "Complete logical production parser-worker output parity against retained baseline receipts. No browser import, stored-database, media-readback, memory, or speed claim.",
          "attempts": [], "remainingDictionaries": DICTIONARIES.copy()}
current = None

def git(*command):
    return subprocess.check_output(["git", *command], cwd=source, text=True).strip()

try:
    require(git("rev-parse", "HEAD") == CANDIDATE, "Unexpected candidate commit")
    require(git("rev-parse", "HEAD^{tree}") == TREE, "Unexpected candidate tree")
    require(git("status", "--porcelain") == "", "Candidate checkout is dirty")
    node = shutil.which("node")
    require(node is not None, "Node is unavailable")
    require(subprocess.check_output([node, "--version"], text=True).strip() == NODE, "Node version differs")
    require(file_digest(args.checkpoint) == ARCHIVE_SHA, "Checkpoint archive hash differs")
    tools = output / "helpers"
    tools.mkdir()
    with tarfile.open(args.checkpoint, "r:gz") as archive:
        names = [member.name for member in archive.getmembers()]
        require(len(names) == len(set(names)), "Duplicate archive member")
        for destination, (member_name, expected_hash, expected_size) in MEMBERS.items():
            member = archive.getmember(member_name)
            require(member.isfile(), "Selected member is not a regular file")
            data = archive.extractfile(member).read()
            require(len(data) == expected_size and digest(data) == expected_hash, "Selected checkpoint member differs: " + member_name)
            (tools / destination).write_bytes(data)
    baselines = {name: json.loads((tools / ("baseline-" + name + ".json")).read_text()) for name in DICTIONARIES}
    plan = {
        "schemaVersion": 1, "authoritativeTiming": False,
        "scope": status["scope"],
        "baselineCommit": BASE, "candidateCommit": CANDIDATE, "candidateTree": TREE,
        "localCandidateEquivalentCommit": "1ec7369996d8b4e24802854b0524709aa54aadb3",
        "workflowCommit": args.workflow_sha,
        "checkpoint": {"commit": CHECKPOINT_COMMIT, "path": CHECKPOINT_PATH, "sha256": ARCHIVE_SHA},
        "selectedMembers": MEMBERS, "parserSha256": PARSER_SHA, "expectedChangedRuntimeHashes": CHANGED_RUNTIME,
        "helperSha256": file_digest(pathlib.Path(__file__)),
        "nodeVersion": NODE, "nodeBinarySha256": file_digest(pathlib.Path(node).resolve()),
        "schedule": DICTIONARIES, "processesPerDictionary": 1, "mode": "verify",
        "heapMiB": 192, "hardwareConcurrency": 4, "deviceMemoryGiB": 8, "flags": {},
        "perProcessTimeoutSeconds": 300,
        "failurePolicy": "Stop at first failed process or parity check; retain its log/partial output; no retries or substitutions.",
        "comparison": "Exact full-output digest, every group shape, options, fixtures/locks/source identities, and all native profile fields except timings and two resource high-water fields.",
        "excludedProfileFields": sorted(RESOURCE_FIELDS),
        "timingPolicy": "Unchanged verify-mode harness retains incidental duration/resource fields in raw reports; these are never compared, interpreted, or promoted as performance evidence.",
    }
    write_json(output / "plan.json", plan)
    for name in DICTIONARIES:
        current = None
        baseline = baselines[name]
        expected = baseline["observations"][0]
        require(baseline["complete"] and baseline["node"] == NODE, "Baseline receipt is incomplete or uses a different Node")
        require(baseline["gitIdentity"]["sha"] == BASE, "Baseline receipt source differs")
        require(baseline["runnerSha256"] == MEMBERS["pipeline-replay.mjs"][1], "Baseline runner differs")
        require(expected["phase"] == "verify" and expected["digest"] == DIGESTS[name], "Retained baseline digest differs")
        expected_source = {**baseline["source"], **CHANGED_RUNTIME}
        for relative, expected_hash in expected_source.items():
            require(file_digest(source / relative) == expected_hash, "Candidate runtime file differs: " + relative)
        current = {"dictionary": name, "status": "started", "returnCode": None}
        status["attempts"].append(current)
        status["remainingDictionaries"] = DICTIONARIES[DICTIONARIES.index(name) + 1:]
        write_json(output / "status.json", status)
        report_path = output / (name + ".json")
        command = [node, "--max-old-space-size=192", "--expose-gc", str(tools / "pipeline-replay.mjs"),
                   str(source), name, str(report_path), "1", "{}", "4", "verify"]
        current["command"] = command
        with (output / (name + ".log")).open("wb") as log:
            completed = subprocess.run(command, cwd=source, stdout=log, stderr=subprocess.STDOUT, timeout=300)
        current["returnCode"] = completed.returncode
        require(completed.returncode == 0, "Verify process failed: " + name)
        actual = json.loads(report_path.read_text())
        require(actual["complete"] is True and len(actual["observations"]) == 1, "Incomplete or repeated verification")
        observation = actual["observations"][0]
        require(actual["node"] == NODE and actual["gitIdentity"]["sha"] == CANDIDATE and actual["gitIdentity"]["tree"] == TREE and actual["gitIdentity"]["status"] == "", "Actual source/runtime identity differs")
        require(actual["source"] == expected_source, "Observed runtime file hashes differ")
        require(actual["wasmSha256"] == PARSER_SHA and actual["runnerSha256"] == MEMBERS["pipeline-replay.mjs"][1], "Executed parser or harness differs")
        require(actual["fixture"] == baseline["fixture"] and actual["lockSha256"] == baseline["lockSha256"], "Fixture identity differs")
        require(actual["hardwareConcurrency"] == 4 and actual["deviceMemory"] == 8 and actual["canonicalCapture"] is None, "Component configuration differs")
        require(actual["options"] == baseline["options"] and actual["rawTermBankSourceBytes"] == baseline["rawTermBankSourceBytes"], "Production planner options differ")
        require(observation["phase"] == "verify" and observation["iteration"] == 0, "Unexpected observation mode")
        require(observation["digest"] == DIGESTS[name], "Full logical output digest differs")
        require(observation["rows"] == expected["rows"] and observation["chunks"] == expected["chunks"], "Group shapes or row counts differ")
        require(semantic_profile(observation["profiles"]) == semantic_profile(expected["profiles"]), "Native work/profile counters differ")
        require(git("status", "--porcelain") == "" and git("rev-parse", "HEAD") == CANDIDATE, "Source changed during parity")
        current.update({"status": "passed", "fullOutputDigest": observation["digest"],
                        "rows": observation["rows"], "groups": len(observation["chunks"]),
                        "reportSha256": file_digest(report_path)})
        write_json(output / "status.json", status)
        print("PARITY_JSON " + json.dumps(current, sort_keys=True), flush=True)
    status["complete"] = True
    status["status"] = "all-three-full-parser-outputs-match"
except Exception as error:
    status["status"] = "failed-no-retry"
    status["failure"] = {"type": type(error).__name__, "message": str(error)}
    if current is not None:
        current["status"] = "failed"
    write_json(output / "status.json", status)
    print("PARITY_JSON " + json.dumps(status, sort_keys=True), flush=True)
    raise
write_json(output / "status.json", status)
print("PARITY_JSON " + json.dumps(status, sort_keys=True), flush=True)
