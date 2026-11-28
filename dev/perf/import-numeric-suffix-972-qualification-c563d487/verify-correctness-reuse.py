#!/usr/bin/env python3
"""Bind exact current-base product bytes to the existing successful correctness run."""
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

BINDING_SHA256 = "5e05d27bb1d7dd1bc0b95e3255e9ad8f0035a11c61c31b2c771d9e52f949cb03"
TOOL_DIRECTORY = "dev/perf/import-numeric-suffix-972-qualification-c563d487"
WORKFLOW_PATH = ".github/workflows/import-numeric-suffix-972-qualification-c563d487.yml"
LABELS = [
    "fetch-baseline", "create-baseline", "create-candidate",
    "dependencies-baseline", "dependencies-candidate", "reproduce-baseline",
    "apply-check", "apply-patch", "build-native-candidate",
    "build-candidate-libraries", "reproduce-candidate", "scoped-lint",
    "strict-main-types", "strict-test-types", "complete-unit-suite",
    "options-unit-suite", "all-dry-build-targets",
]
sha = lambda data: hashlib.sha256(data).hexdigest()
blob = lambda data: hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()

def require(condition, label):
    if not condition:
        raise ValueError(label)

def emit(tag, value):
    print(tag + " " + json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False), flush=True)

def save(output, name, value):
    (output / name).write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")

def git(root, *arguments):
    return subprocess.check_output(["git", *arguments], cwd=root, stderr=subprocess.PIPE)

def git_text(root, *arguments):
    return git(root, *arguments).decode().strip()

def git_file(root, commit, name):
    return git(root, "show", commit + ":" + name)

def commit_identity(root, commit):
    require(re.fullmatch(r"[a-f0-9]{40}", commit) is not None, "Complete lowercase commit identity")
    headers = git(root, "cat-file", "commit", commit).decode().split("\n\n", 1)[0].splitlines()
    trees = [line[5:] for line in headers if line.startswith("tree ")]
    parents = [line[7:] for line in headers if line.startswith("parent ")]
    require(len(trees) == 1, "Exactly one commit tree")
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

def verify_archive(data, proof, binding):
    expected = {row["path"]: row for row in proof["originalArchiveMembers"]}
    require(len(expected) == len(proof["originalArchiveMembers"]) == 44, "Exact 44-member manifest")
    names = {"product/" + name for name in binding["candidate"]["files"]}
    names.update(label + suffix for label in LABELS for suffix in (".receipt.json", ".log"))
    names.update(("preparation-start.json", "compiled-source-binding.json", "result.json", "rebuilt-candidate.diff"))
    require(set(expected) == names, "Exact archive member names")
    result = {}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        infos = archive.infolist()
        require(len(infos) == 44 and {item.filename for item in infos} == names, "No missing or duplicate archive members")
        require(sum(item.file_size for item in infos) <= 2 * 1024 * 1024, "Bounded original archive expansion")
        for info in infos:
            path = PurePosixPath(info.filename)
            require(not path.is_absolute() and ".." not in path.parts and not info.is_dir(), "Regular relative evidence member")
            require(((info.external_attr >> 16) & 0o170000) != 0o120000, "No archive symlink")
            value = archive.read(info)  # Reading to EOF validates the original CRC.
            wanted = expected[info.filename]
            require(len(value) == info.file_size == wanted["bytes"], "Original member byte length")
            require(info.CRC == wanted["crc32"] and sha(value) == wanted["sha256"], "Original member CRC and SHA")
            result[info.filename] = value
    for item in proof["originalProofFiles"]:
        value = result[item["path"]]
        require(len(value) == item["bytes"] and sha(value) == item["sha256"] and
                blob(value) == item["gitBlobSha"], "Exact recovered original proof bytes")
    return result

def verify_commands(content, original_binding):
    receipts = {label: json.loads(content[label + ".receipt.json"]) for label in LABELS}
    repository = receipts["fetch-baseline"]["cwd"]
    baseline = receipts["create-baseline"]["command"][4]
    candidate = receipts["create-candidate"]["command"][4]
    require(all(PurePosixPath(path).is_absolute() for path in (repository, baseline, candidate)),
            "Original command roots are absolute")
    require(len({repository, baseline, candidate}) == 3, "Three distinct original source roots")
    head = original_binding["baseline"]["commit"]
    tooling = str(PurePosixPath(repository) / "dev/perf/numeric-suffix-972-build-c563d487")
    tests = ["test/" + name for name in original_binding["qualificationFiles"]]
    expected = {
        "fetch-baseline": (repository, ["git", "fetch", "--no-tags", "origin", head]),
        "create-baseline": (repository, ["git", "worktree", "add", "--detach", baseline, head]),
        "create-candidate": (repository, ["git", "worktree", "add", "--detach", candidate, head]),
        "dependencies-baseline": (repository, ["cp", "-a", repository + "/node_modules", baseline + "/node_modules"]),
        "dependencies-candidate": (repository, ["cp", "-a", repository + "/node_modules", candidate + "/node_modules"]),
        "reproduce-baseline": (baseline, ["npm", "run", "build:dictionary-wasm", "--", "--check"]),
        "apply-check": (candidate, ["git", "apply", "--check", tooling + "/candidate.patch"]),
        "apply-patch": (candidate, ["git", "apply", tooling + "/candidate.patch"]),
        "build-native-candidate": (candidate, ["npm", "run", "build:dictionary-wasm", "--", "--write"]),
        "build-candidate-libraries": (candidate, ["npm", "run", "build:libs"]),
        "reproduce-candidate": (candidate, ["npm", "run", "build:dictionary-wasm", "--", "--check"]),
        "scoped-lint": (candidate, ["npx", "eslint"] + tests),
        "strict-main-types": (candidate, ["npm", "run", "test:ts:main"]),
        "strict-test-types": (candidate, ["npm", "run", "test:ts:test"]),
        "complete-unit-suite": (candidate, ["npm", "run", "test:unit", "--", "--maxWorkers=2"]),
        "options-unit-suite": (candidate, ["npm", "run", "test:unit:options", "--", "--maxWorkers=2"]),
        "all-dry-build-targets": (candidate, ["npm", "run", "test:build"]),
    }
    previous_end = -math.inf
    for label in LABELS:
        row = receipts[label]
        require(row["label"] == label and type(row["exitCode"]) is int and row["exitCode"] == 0,
                "Every original declared command succeeded")
        require((row["cwd"], row["command"]) == expected[label], "Exact original command and source root")
        require(row["scope"] == "Build/correctness command, not a benchmark observation", "Original command scope")
        require(sha(content[label + ".log"]) == row["logSha256"], "Original command log digest")
        start, end = row["startedEpoch"], row["finishedEpoch"]
        require(type(start) in (int, float) and type(end) in (int, float) and
                math.isfinite(start) and math.isfinite(end) and previous_end <= start <= end,
                "All 17 original commands retain sequential successful receipts")
        previous_end = end
    unit = re.sub(r"\x1b\[[0-9;]*m", "", content["complete-unit-suite.log"].decode())
    require(re.search(r"Test Files\s+671 passed\s+\(671\)", unit) is not None, "Original 671 unit files")
    require(re.search(r"Tests\s+15180 passed\s+\|\s+47 skipped\s+\(15227\)", unit) is not None,
            "Original 15180 passed and 47 skipped unit cases")
    require("test/term-bank-row-suffix-reuse.test.js (32 tests)" in unit and
            "test/term-bank-row-suffix-token-ends.test.js (9 tests)" in unit, "Both focused native regression suites ran")
    options = re.sub(r"\x1b\[[0-9;]*m", "", content["options-unit-suite.log"].decode())
    require(re.search(r"Tests\s+32 passed\s+\(32\)", options) is not None, "Original 32 options cases")
    return receipts

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binding", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(os.environ["GITHUB_WORKSPACE"]).resolve()
    output = args.output.resolve()
    stage = "new-output"
    created = False
    try:
        output.mkdir(parents=True, exist_ok=False)
        created = True
        stage = "frozen-bindings"
        binding_bytes = args.binding.read_bytes()
        require(sha(binding_bytes) == BINDING_SHA256, "Frozen correctness reuse binding")
        binding = json.loads(binding_bytes)
        here = args.binding.resolve().parent
        require(here == root / TOOL_DIRECTORY, "Exact qualification tooling directory")
        require(binding["repository"] == "ManabiIO/manabitan", "Exact repository")
        require(os.environ.get("GITHUB_RUN_ATTEMPT") == "1", "No replacement or retried full cohort")
        require(os.environ["PERF_BASELINE"] == binding["baseline"]["commit"] and
                os.environ["PERF_CANDIDATE"] == binding["candidate"]["commit"], "Frozen workflow source IDs")
        criteria_bytes = (here / binding["criteria"]["file"]).read_bytes()
        require(sha(criteria_bytes) == binding["criteria"]["sha256"], "Unchanged prospective current-base criteria")
        proof_bytes = (here / binding["recoveryProof"]["file"]).read_bytes()
        require(len(proof_bytes) == binding["recoveryProof"]["bytes"] and
                sha(proof_bytes) == binding["recoveryProof"]["sha256"] and
                blob(proof_bytes) == binding["recoveryProof"]["gitBlobSha1"], "Exact original recovery proof")
        proof = json.loads(proof_bytes)
        base, candidate = binding["baseline"]["commit"], binding["candidate"]["commit"]
        correctness = binding["originalCorrectness"]
        source_head = correctness["toolingCommit"]

        stage = "exact-git-trees"
        baseline_identity = commit_identity(root, base)
        candidate_identity = commit_identity(root, candidate)
        build_identity = commit_identity(root, source_head)
        require(baseline_identity["tree"] == binding["baseline"]["tree"], "Exact current baseline tree")
        require(candidate_identity["tree"] == binding["candidate"]["tree"] and
                candidate_identity["parents"] == [base], "Exact candidate tree and single direct parent")
        require(build_identity["tree"] == correctness["toolingTree"] and
                build_identity["parents"] == [base], "Original correctness tooling tree and parent")
        require(git_text(root, "rev-parse", "HEAD") == os.environ["GITHUB_SHA"], "Exact workflow checkout")
        workflow_changes = git_text(root, "diff", "--name-only", base, "HEAD").splitlines()
        require(all(path == WORKFLOW_PATH or path.startswith(TOOL_DIRECTORY + "/") for path in workflow_changes),
                "Qualification branch changes only its workflow and tooling")
        differences = git_text(root, "diff", "--name-status", "--no-renames", base, candidate).splitlines()
        changed = {line.split("\t")[1]: line.split("\t")[0] for line in differences}
        expected_files = binding["candidate"]["files"]
        require(len(differences) == 6 and changed == {path: item["status"] for path, item in expected_files.items()},
                "Exactly the six compiled and tested product changes")
        entries = git(root, "ls-tree", "-z", candidate, "--", *expected_files).decode().split("\0")
        actual_entries = {}
        for entry in entries:
            if entry:
                metadata, name = entry.split("\t", 1)
                mode, kind, object_id = metadata.split(" ")
                actual_entries[name] = (mode, kind, object_id)
        require(actual_entries == {name: (item["mode"], "blob", item["gitBlobSha1"])
                                   for name, item in expected_files.items()}, "Exact six regular Git blobs and modes")
        for path, item in expected_files.items():
            value = git_file(root, candidate, path)
            require(len(value) == item["bytes"] and sha(value) == item["sha256"] and
                    blob(value) == item["gitBlobSha1"], "Exact candidate product bytes")
        require(sha(git_file(root, base, "ext/js/dictionary/wasm/term-bank-parser.c")) ==
                binding["baseline"]["cSha256"], "Exact baseline C")
        require(sha(git_file(root, base, "dev/data/dictionary-wasm/term-bank-parser.wasm")) ==
                binding["baseline"]["wasmSha256"], "Exact baseline WASM")
        observer = binding["observer"]
        require(sha((root / observer["path"]).read_bytes()) == observer["sha256"], "Exact a7f7 observer")
        require(not git(root, "diff", "--name-only", base, "HEAD", "--", observer["path"], observer["helperDirectory"]).strip(),
                "Unchanged observer and all memory/receipt helpers")
        original_binding_bytes = git_file(root, source_head, correctness["toolingDirectory"] + "/binding.json")
        require(sha(original_binding_bytes) == correctness["bindingSha256"], "Exact original preparation binding")
        original_binding = json.loads(original_binding_bytes)
        for name, digest in original_binding["toolingFiles"].items():
            require(sha(git_file(root, source_head, correctness["toolingDirectory"] + "/" + name)) == digest,
                    "Exact original source, compiler workflow and reviewed preparation")
        require(sha(git_file(root, source_head, correctness["toolingDirectory"] + "/prepare-and-validate.py")) ==
                correctness["producerSha256"], "Exact original correctness producer")
        require(original_binding["baseline"] == {key: binding["baseline"][key] for key in ("commit", "cSha256", "wasmSha256")},
                "Original preparation used this exact baseline")

        stage = "original-actions-metadata"
        token = os.environ["CORRECTNESS_GITHUB_TOKEN"]
        run = api_json("actions/runs/" + str(correctness["runId"]), token)
        jobs = api_json("actions/runs/" + str(correctness["runId"]) + "/jobs?per_page=100", token)
        artifact = api_json("actions/artifacts/" + str(correctness["artifactId"]), token)
        save(output, "original-api-metadata.json", {"run": run, "jobs": jobs, "artifact": artifact})
        require(run["id"] == correctness["runId"] and run["head_sha"] == source_head and
                run["run_attempt"] == correctness["attempt"] and run["status"] == "completed" and
                run["conclusion"] == "success", "Original exact-head correctness run succeeded")
        require(jobs["total_count"] == len(jobs["jobs"]) == 1, "Original single correctness job")
        job = jobs["jobs"][0]
        require(job["id"] == correctness["jobId"] and job["run_id"] == correctness["runId"] and
                job["head_sha"] == source_head and job["run_attempt"] == correctness["attempt"] and
                job["status"] == "completed" and job["conclusion"] == "success", "Original correctness job succeeded")
        require(all(step["status"] == "completed" and step["conclusion"] == "success" for step in job["steps"]),
                "No skipped or failed original correctness workflow step")
        require(artifact["id"] == correctness["artifactId"] and artifact["size_in_bytes"] == correctness["artifactBytes"] and
                artifact["digest"] == "sha256:" + correctness["artifactSha256"] and artifact["expired"] is False and
                artifact["workflow_run"]["id"] == correctness["runId"] and
                artifact["workflow_run"]["head_sha"] == source_head, "Exact original correctness artifact metadata")

        stage = "original-archive"
        archive = download_original(correctness, token)
        (output / "original-correctness-artifact.zip").write_bytes(archive)
        content = verify_archive(archive, proof, binding)
        require(proof["originalBuildRun"] == correctness["runId"] and
                proof["originalBuildJob"] == correctness["jobId"] and
                proof["artifactId"] == correctness["artifactId"] and
                proof["artifactSha256"] == correctness["artifactSha256"], "Recovered proof identifies this archive")
        require(proof["product"]["head"] == candidate and proof["product"]["tree"] == candidate_identity["tree"] and
                proof["product"]["parent"] == base, "Recovery proof identifies the published product")
        for path in expected_files:
            require(content["product/" + path] == git_file(root, candidate, path), "Product Git bytes equal the tested artifact")

        stage = "original-correctness-proofs"
        start = json.loads(content["preparation-start.json"])
        compiled = json.loads(content["compiled-source-binding.json"])
        result = json.loads(content["result.json"])
        require(start["toolingHead"] == source_head and start["toolingTree"] == correctness["toolingTree"] and
                start["bindingSha256"] == correctness["bindingSha256"] and start["binding"] == original_binding,
                "Original start binds the exact reviewed producer and source")
        require(start["node"] == "v22.22.0" and "21.1.8" in start["compiler"] and "21.1.8" in start["linker"],
                "Original pinned compiler, linker and Node")
        product_hashes = {path: item["sha256"] for path, item in expected_files.items()}
        require(compiled["baseline"] == result["baseline"] == original_binding["baseline"] and
                compiled["productFilesSha256"] == result["productFilesSha256"] == product_hashes,
                "The same six files bound before and after all correctness gates")
        require(compiled["candidateSource"] == product_hashes["ext/js/dictionary/wasm/term-bank-parser.c"] and
                compiled["extWasmSha256"] == product_hashes["dev/data/dictionary-wasm/term-bank-parser.wasm"],
                "Compiled runtime and tracked native bytes match")
        require(compiled["rebuiltDiffSha256"] == sha(content["rebuilt-candidate.diff"]) == correctness["rebuiltDiffSha256"],
                "Original source-bound binary patch")
        native_paths = {path for path in expected_files if not path.startswith("test/")}
        require({line.strip().split(" ", 1)[1] for line in compiled["candidateTrackedChanges"].splitlines()} == native_paths,
                "Original build had exactly three tracked native changes")
        require(result["status"] == "Build and all declared correctness gates passed; no performance observations acquired" and
                result["fixedSource"] is True and result["oldBaselineGainTransferred"] is False and
                result["productPrOpened"] is False and result["performanceQualificationPending"] is True,
                "Original complete successful correctness result")
        manifest = json.loads(content["product/dev/data/dictionary-wasm/manifest.json"])
        baseline_manifest = json.loads(git_file(root, base, "dev/data/dictionary-wasm/manifest.json"))
        require(manifest["sourceDigest"] == correctness["sourceDigest"] and
                manifest["sourceFileCount"] == correctness["sourceFileCount"] == 14, "Original 14-file native source digest")
        expected_manifest = json.loads(json.dumps(baseline_manifest))
        expected_manifest["sourceDigest"] = correctness["sourceDigest"]
        targets = [item for item in expected_manifest["targets"] if item["name"] == "term-bank-parser.wasm"]
        require(len(targets) == 1, "Exactly one term parser native target")
        targets[0]["sha256"] = product_hashes["dev/data/dictionary-wasm/term-bank-parser.wasm"]
        require(manifest == expected_manifest, "All other native targets, compiler arguments and memory limits are unchanged")
        receipts = verify_commands(content, original_binding)
        for label in LABELS:
            emit("MANABITAN_ORIGINAL_CORRECTNESS_RECEIPT", receipts[label])

        stage = "complete"
        receipt = {
            "complete": True, "baseline": baseline_identity, "candidate": candidate_identity,
            "workflowHead": os.environ["GITHUB_SHA"], "originalCorrectnessHead": source_head,
            "originalRunId": correctness["runId"], "originalJobId": correctness["jobId"],
            "originalArtifactId": correctness["artifactId"], "originalArtifactSha256": correctness["artifactSha256"],
            "bindingSha256": BINDING_SHA256, "criteriaSha256": binding["criteria"]["sha256"],
            "originalRecoveryProofSha256": binding["recoveryProof"]["sha256"],
            "all44OriginalMembers": proof["originalArchiveMembers"], "all17OriginalCommandsSucceeded": True,
            "productFiles": expected_files, "sameTestedSourceTree": True,
            "originalUnitCounts": {"files": 671, "passed": 15180, "skipped": 47, "total": 15227,
                                   "suffixCases": 32, "tokenEndCases": 9, "optionsPassed": 32},
            "nativeSourceDigest": manifest["sourceDigest"], "compilerVersion": "21.1.8",
            "newCompilationExecuted": False, "newTestsExecuted": False, "benchmarkExecuted": False,
            "scope": "Correctness reuse by exact six-file source-tree and original artifact proof. The earlier workflow ran on its preparation commit, not on the later product commit.",
            "requiredExactHeadRepositoryChecksRemainRequiredBeforeMerge": True,
        }
        save(output, "correctness-reuse-receipt.json", receipt)
        (output / "correctness-reuse-binding.json").write_bytes(binding_bytes)
        (output / binding["criteria"]["file"]).write_bytes(criteria_bytes)
        (output / binding["recoveryProof"]["file"]).write_bytes(proof_bytes)
        emit("MANABITAN_CORRECTNESS_REUSE_RESULT", receipt)
    except BaseException as error:
        # Never expose HTTP exception text, signed URLs, headers or credentials.
        failure = {"complete": False, "stage": stage, "errorType": type(error).__name__,
                   "newCompilationExecuted": False, "newTestsExecuted": False, "benchmarkExecuted": False}
        if isinstance(error, ValueError):
            failure["invariant"] = str(error)
        if created:
            save(output, "correctness-reuse-failure.json", failure)
        emit("MANABITAN_CORRECTNESS_REUSE_FAILED", failure)
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
