#!/usr/bin/env python3
"""Bind the fresh exact-a300 correctness artifact before a separate full cohort."""
import argparse
import hashlib
import io
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile

TOOL_DIRECTORY = "dev/perf/numeric-suffix-proof-consumer-982-qualification-c563d487"
WORKFLOW_PATH = ".github/workflows/import-suffix-proof-982-qualification-c563d487.yml"
LABELS = [
    "create-candidate", "dependencies", "build-libraries", "license-page", "reproduce-native",
    "scoped-lint", "strict-main-types", "strict-test-types", "complete-unit-suite",
    "options-unit-suite", "all-dry-build-targets",
]
sha = lambda data: hashlib.sha256(data).hexdigest()
blob = lambda data: hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()


def require(condition, label):
    if not condition:
        raise ValueError(label)


def save(output, name, value):
    with (output / name).open("x") as stream:
        stream.write(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n")


def emit(tag, value):
    print("MANABITAN_FRESH_CORRECTNESS_" + tag + " " +
          json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False), flush=True)


def git(root, *arguments):
    return subprocess.check_output(["git", *arguments], cwd=root, stderr=subprocess.PIPE)


def git_text(root, *arguments):
    return git(root, *arguments).decode().strip()


def git_file(root, commit, name):
    return git(root, "show", commit + ":" + name)


def identity(root, commit):
    require(re.fullmatch(r"[a-f0-9]{40}", commit) is not None, "Exact commit ID")
    headers = git(root, "cat-file", "commit", commit).decode().split("\n\n", 1)[0].splitlines()
    trees = [line[5:] for line in headers if line.startswith("tree ")]
    parents = [line[7:] for line in headers if line.startswith("parent ")]
    require(len(trees) == 1, "One source tree")
    return {"commit": commit, "tree": trees[0], "parents": parents}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None

def api_json(path, token, limit=1048576):
    request = urllib.request.Request(
        "https://api.github.com/repos/ManabiIO/manabitan/" + path,
        headers={"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28"},
    )
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
        data = response.read(limit + 1)
    require(len(data) <= limit, "Bounded original metadata response")
    return json.loads(data)

def download_original(correctness, token):
    request = urllib.request.Request(
        "https://api.github.com/repos/ManabiIO/manabitan/actions/artifacts/" +
        str(correctness["artifactId"]) + "/zip",
        headers={"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28"},
    )
    try:
        response = urllib.request.build_opener(NoRedirect()).open(request, timeout=30)
    except urllib.error.HTTPError as redirect:
        require(redirect.code == 302, "Expected original artifact redirect")
        location = redirect.headers["Location"]
    else:
        response.close()
        raise ValueError("Expected original artifact redirect")
    parsed = urllib.parse.urlsplit(location)
    require(parsed.scheme == "https" and bool(parsed.hostname) and
            parsed.username is None and parsed.password is None, "HTTPS artifact location")
    # Do not forward the repository token to the signed artifact storage URL.
    with urllib.request.urlopen(urllib.request.Request(location), timeout=30) as response:
        data = response.read(correctness["artifactBytes"] + 1)
    require(len(data) == correctness["artifactBytes"], "Exact original archive length")
    require(sha(data) == correctness["artifactSha256"], "Exact original archive digest")
    return data


def verify_archive(data, proof):
    expected = {row["path"]: row for row in proof["archiveMembers"]}
    require(len(expected) == len(proof["archiveMembers"]), "Unique frozen artifact members")
    content = {}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        infos = archive.infolist()
        require(len(infos) == len(expected) and {item.filename for item in infos} == set(expected),
                "Exact artifact member set")
        require(sum(item.file_size for item in infos) == proof["archiveExpandedBytes"], "Exact expanded byte count")
        for item in infos:
            path = PurePosixPath(item.filename)
            require(not path.is_absolute() and ".." not in path.parts and not item.is_dir(), "Regular relative proof file")
            require(((item.external_attr >> 16) & 0o170000) != 0o120000, "No artifact symlink")
            value = archive.read(item)
            expected_item = expected[item.filename]
            require(len(value) == item.file_size == expected_item["bytes"] and
                    item.CRC == expected_item["crc32"] and sha(value) == expected_item["sha256"],
                    "Original artifact member bytes and CRC")
            content[item.filename] = value
    prefix = proof["correctnessDirectoryPrefix"]
    require(prefix.endswith("/") and not PurePosixPath(prefix).is_absolute() and ".." not in PurePosixPath(prefix).parts,
            "Exact relative correctness prefix")
    original = {name[len(prefix):]: value for name, value in content.items() if name.startswith(prefix)}
    names = {label + suffix for label in LABELS for suffix in (".log", ".receipt.json")}
    names.update(("source-binding.json", "prospective-review-criteria.json", "a300-source-inventory.json",
                  "source-proof.json", "start.json", "command-plan.json", "compiler-identity.json", "result.json"))
    require(set(original) == names, "Exactly all thirty fresh correctness evidence members")
    return original


def verify_commands(content, source, proof):
    plan = json.loads(content["command-plan.json"])
    receipts = {label: json.loads(content[label + ".receipt.json"]) for label in LABELS}
    repository = receipts["create-candidate"]["cwd"]
    candidate = receipts["create-candidate"]["command"][4]
    require(all(PurePosixPath(value).is_absolute() for value in (repository, candidate)) and repository != candidate,
            "Distinct absolute source and candidate roots")
    tests = [item["path"] for item in source["productFiles"] if item["path"].startswith("test/")]
    expected = {
        "create-candidate": (repository, ["git", "worktree", "add", "--detach", candidate, source["candidate"]["commit"]]),
        "dependencies": (candidate, ["npm", "ci"]),
        "build-libraries": (candidate, ["npm", "run", "build:libs"]),
        "license-page": (candidate, ["npm", "run", "license-report:html"]),
        "reproduce-native": (candidate, ["npm", "run", "build:dictionary-wasm", "--", "--check"]),
        "scoped-lint": (candidate, ["npx", "eslint", *tests]),
        "strict-main-types": (candidate, ["npm", "run", "test:ts:main"]),
        "strict-test-types": (candidate, ["npm", "run", "test:ts:test"]),
        "complete-unit-suite": (candidate, ["npm", "run", "test:unit", "--", "--maxWorkers=2"]),
        "options-unit-suite": (candidate, ["npm", "run", "test:unit:options", "--", "--maxWorkers=2"]),
        "all-dry-build-targets": (candidate, ["npm", "run", "test:build"]),
    }
    require(plan == [{"label": label, "command": expected[label][1], "cwd": expected[label][0]} for label in LABELS],
            "Exact fresh command plan")
    last = -math.inf
    for label in LABELS:
        row = receipts[label]
        require(row["label"] == label and type(row["exitCode"]) is int and row["exitCode"] == 0 and
                row["exception"] is None and row["retried"] is False, "Every fresh command succeeded once")
        require((row["cwd"], row["command"]) == expected[label], "Exact current source and command")
        require(sha(content[label + ".log"]) == row["logSha256"], "Exact command log")
        start, end = row["startedEpoch"], row["finishedEpoch"]
        require(type(start) in (int, float) and type(end) in (int, float) and math.isfinite(start) and math.isfinite(end)
                and last <= start <= end, "Sequential original correctness receipts")
        last = end
    unit = re.sub(r"\x1b\[[0-9;]*m", "", content["complete-unit-suite.log"].decode())
    counts = proof["unitCounts"]
    require(re.search(r"Test Files\s+" + str(counts["files"]) + r" passed\s+\(" + str(counts["files"]) + r"\)", unit) is not None,
            "Fresh complete unit file count")
    require(re.search(r"Tests\s+" + str(counts["passed"]) + r" passed\s+\|\s+" + str(counts["skipped"]) +
                      r" skipped\s+\(" + str(counts["passed"] + counts["skipped"]) + r"\)", unit) is not None,
            "Fresh complete unit case count")
    for name, count in proof["focusedCaseCounts"].items():
        require(name + " (" + str(count) + " tests)" in unit, "Fresh native regression suite")
    options = re.sub(r"\x1b\[[0-9;]*m", "", content["options-unit-suite.log"].decode())
    require(re.search(r"Tests\s+" + str(proof["optionsPassed"]) + r" passed\s+\(" + str(proof["optionsPassed"]) + r"\)", options) is not None,
            "Fresh options cases")
    build_log = content["all-dry-build-targets.log"].decode()
    built_targets = re.findall(r"^Building ([a-z-]+)\.\.\.$", build_log, re.MULTILINE)
    require(built_targets == proof["dryBuildTargets"] ==
            ["chrome", "chrome-dev", "chrome-playwright", "firefox", "firefox-dev", "firefox-android", "edge"],
            "All seven explicit dry build targets")
    native_log = content["reproduce-native.log"].decode()
    native_check = json.loads(native_log[native_log.index("{"):])
    expected_parser = next(item["sha256"] for item in source["productFiles"]
                           if item["path"] == "dev/data/dictionary-wasm/term-bank-parser.wasm")
    require(native_check == proof["nativeCheck"] ==
            {"mode": "check", "toolchain": {"compilerVersion": "21.1.8", "linkerVersion": "21.1.8"},
             "targets": [{"name": "term-content-canonical-scan-v1.wasm",
                          "sha256": "40948d5c20d26253e86c93d267e3cbb3817ea87c9731e02bcca0523c0eb3d6af"},
                         {"name": "term-bank-parser.wasm", "sha256": expected_parser}]},
            "Both exact native targets reproduced with pinned compiler and linker")
    return receipts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binding", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(os.environ["GITHUB_WORKSPACE"]).resolve()
    here = args.binding.resolve().parent
    output = args.output.resolve()
    created = False
    stage = "new-output"
    try:
        output.mkdir(parents=True, exist_ok=False)
        created = True
        stage = "frozen-source-and-proof"
        binding_bytes = args.binding.read_bytes()
        binding = json.loads(binding_bytes)
        require(binding["acquisitionAuthorized"] is True and binding["fullStoragePolicyApproved"] is True,
                "No full cohort before the separately approved storage bound and source freeze")
        require(os.environ.get("GITHUB_RUN_ATTEMPT") == "1", "No replacement full cohort")
        require(here == root / TOOL_DIRECTORY, "Exact qualification tooling directory")
        source_bytes = (here / binding["sourceBinding"]["file"]).read_bytes()
        require(sha(source_bytes) == binding["sourceBinding"]["sha256"], "Frozen current source binding")
        source = json.loads(source_bytes)
        proof_bytes = (here / binding["freshCorrectnessProof"]["file"]).read_bytes()
        require(sha(proof_bytes) == binding["freshCorrectnessProof"]["sha256"], "Frozen fresh correctness proof")
        proof = json.loads(proof_bytes)
        criteria_bytes = (here / binding["criteria"]["file"]).read_bytes()
        require(sha(criteria_bytes) == binding["criteria"]["sha256"] == source["criteria"]["sha256"], "Unchanged7812 criteria")
        base, candidate = source["baseline"]["commit"], source["candidate"]["commit"]
        require(os.environ["PERF_BASELINE"] == base and os.environ["PERF_CANDIDATE"] == candidate, "Workflow source IDs")
        base_identity, candidate_identity = identity(root, base), identity(root, candidate)
        require(base_identity["tree"] == source["baseline"]["tree"], "Current baseline tree")
        require(candidate_identity["tree"] == source["candidate"]["tree"] and candidate_identity["parents"] == [base],
                "Exact current product direct child")
        expected_files = {item["path"]: item for item in source["productFiles"]}
        changes = git_text(root, "diff", "--name-only", base, candidate).splitlines()
        require(len(changes) == 8 and set(changes) == set(expected_files), "Exact eight-file product")
        for name, expected in expected_files.items():
            value = git_file(root, candidate, name)
            require(len(value) == expected["bytes"] and sha(value) == expected["sha256"] and blob(value) == expected["gitBlobSha1"],
                    "Every published product byte")
        changed_tooling = git_text(root, "diff", "--name-only", base, "HEAD").splitlines()
        require(all(path == WORKFLOW_PATH or path.startswith(TOOL_DIRECTORY + "/") for path in changed_tooling),
                "Full workflow is isolated tooling only")
        require(git_text(root, "rev-parse", "HEAD") == os.environ["GITHUB_SHA"], "Exact tooling head")
        correctness = proof["originalCorrectness"]
        build_identity = identity(root, correctness["toolingCommit"])
        require(build_identity["tree"] == correctness["toolingTree"] and build_identity["parents"] == [base],
                "Fresh prerequisite tooling source")
        for path, digest in proof["originalToolHashes"].items():
            require(sha(git_file(root, correctness["toolingCommit"], path)) == digest, "Original fresh observer bytes")

        stage = "original-api-and-artifact"
        token = os.environ["CORRECTNESS_GITHUB_TOKEN"]
        run = api_json("actions/runs/" + str(correctness["runId"]), token)
        job = api_json("actions/jobs/" + str(correctness["jobId"]), token)
        metadata = api_json("actions/artifacts/" + str(correctness["artifactId"]), token)
        save(output, "original-run.json", run)
        save(output, "original-job.json", job)
        save(output, "original-artifact.json", metadata)
        require(run["head_sha"] == correctness["toolingCommit"] and run["run_attempt"] == 1 and
                run["status"] == "completed" and run["conclusion"] == "success",
                "Original prerequisite run completed successfully once")
        require(job["run_id"] == correctness["runId"] and job["head_sha"] == correctness["toolingCommit"] and
                job["run_attempt"] == 1 and job["status"] == "completed" and job["conclusion"] == "success",
                "Fresh correctness job completed successfully once")
        require(metadata["id"] == correctness["artifactId"] and metadata["expired"] is False and
                metadata["workflow_run"]["id"] == correctness["runId"] and
                metadata["workflow_run"]["head_sha"] == correctness["toolingCommit"] and
                metadata["size_in_bytes"] == correctness["artifactBytes"] and
                metadata["digest"] == "sha256:" + correctness["artifactSha256"], "Exact original artifact API binding")
        data = download_original(correctness, token)
        (output / "original-correctness.zip").write_bytes(data)
        content = verify_archive(data, proof)
        require(sha(content["source-binding.json"]) == binding["sourceBinding"]["sha256"] and
                content["source-binding.json"] == source_bytes, "Exact fresh source binding copy")
        require(content["prospective-review-criteria.json"] == criteria_bytes, "Exact criteria copy")
        require(sha(content["a300-source-inventory.json"]) == source["sourceInventory"]["sha256"], "Exact source inventory")

        stage = "fresh-head-and-commands"
        start = json.loads(content["start.json"])
        source_proof = json.loads(content["source-proof.json"])
        result = json.loads(content["result.json"])
        require(start["mode"] == "correctness" and start["dictionary"] is None and
                start["workflowHead"] == correctness["toolingCommit"] and str(start["runId"]) == str(correctness["runId"]) and
                str(start["runAttempt"]) == "1" and start["scriptSha256"] == proof["originalScriptSha256"] and
                start["bindingSha256"] == binding["sourceBinding"]["sha256"] and start["nodeVersion"] == "v22.22.0",
                "Fresh correctness start receipt")
        require(start["source"] == source_proof and source_proof["baseline"] == source["baseline"] and
                source_proof["candidate"] == source["candidate"], "Same source proof before all commands")
        require(set(source_proof["productFiles"]) == set(expected_files), "All eight proven product files")
        for name, expected in expected_files.items():
            require(source_proof["productFiles"][name] == {key: expected[key] for key in ("bytes", "sha256", "gitBlobSha1")},
                    "Exact tested product bytes")
        require(result["status"] == "complete" and result["correctnessPass"] is True and result["retried"] is False and
                result["freshExactHead"] == candidate and result["freshExactTree"] == source["candidate"]["tree"] and
                result["sourceClean"] is True and result["performanceObservations"] == 0 and
                result["commandCount"] == 11 and result["bindingSha256"] == binding["sourceBinding"]["sha256"],
                "Fresh exact-head correctness result")
        compilers = json.loads(content["compiler-identity.json"])
        require(result["compilerIdentity"] == compilers and all(re.search(r"\b21\.1\.8\b", compilers[key]) is not None
                for key in ("clang", "lld")), "Pinned compiler identities")
        receipts = verify_commands(content, source, proof)
        require(result["commandReceipts"] == {label: sha(content[label + ".receipt.json"]) for label in LABELS},
                "All command receipts bound by final result")
        for label in LABELS:
            emit("COMMAND_RECEIPT", receipts[label])
        complete = {"complete": True, "sameFreshExactHead": candidate, "sameFreshExactTree": source["candidate"]["tree"],
                    "baseline": base_identity, "candidate": candidate_identity, "workflowHead": os.environ["GITHUB_SHA"],
                    "originalCorrectness": correctness, "allElevenCommandsPassed": True,
                    "unitCounts": proof["unitCounts"], "focusedCaseCounts": proof["focusedCaseCounts"],
                    "optionsPassed": proof["optionsPassed"], "dryBuildTargets": proof["dryBuildTargets"],
                    "nativeCheck": proof["nativeCheck"], "sourceBindingSha256": sha(source_bytes),
                    "criteriaSha256": sha(criteria_bytes), "freshCorrectnessProofSha256": sha(proof_bytes),
                    "newTestsExecuted": False, "benchmarkExecuted": False,
                    "scope": "The exact current-a300 product passed fresh correctness once in the prerequisite run; this dependency verifies all original bytes and successful receipts.",
                    "requiredExactHeadRepositoryChecksRemainRequiredBeforeMerge": True}
        save(output, "correctness-binding-result.json", complete)
        for name, value in (("full-qualification-binding.json", binding_bytes), (binding["sourceBinding"]["file"], source_bytes),
                            (binding["freshCorrectnessProof"]["file"], proof_bytes), (binding["criteria"]["file"], criteria_bytes)):
            (output / name).write_bytes(value)
        emit("RESULT", complete)
    except BaseException as error:
        failure = {"complete": False, "stage": stage, "errorType": type(error).__name__,
                   "newTestsExecuted": False, "benchmarkExecuted": False}
        if isinstance(error, ValueError):
            failure["invariant"] = str(error)
        if created:
            save(output, "failure.json", failure)
        emit("FAILURE", failure)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
