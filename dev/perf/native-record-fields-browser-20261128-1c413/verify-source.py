#!/usr/bin/env python3
"""Bind the prospective field study; staging is inert and launch fails closed."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
KIT = "dev/perf/native-record-fields-browser-20261128-1c413"
SOURCE_PATH = KIT + "/source.json"
STUDY_PATH = KIT + "/study.json"
WORKFLOW_PATH = ".github/workflows/import-native-record-fields-1c413.yml"
REPOSITORY = "ManabiIO/manabitan"
BASELINE = "f28c2801fcfd9416f220b46b9cbafeee901c1cb2"
BASELINE_TREE = "b428d0c9fa18e4956f3e2b182cae934de78e8f63"
PRODUCT = "8982dd89fac525100bdcaca7507bfff7feb2c842"
PRODUCT_TREE = "76f8a0cbe2b3820b5e33d16b5f3a4f836ef0860d"
CONTROL = "c34c272357fb8af463d32ab781bcbc640ba1bd3d"
CONTROL_TREE = "4c916a995f996afe56cecf0714c20d5b7e5ef346"
EXPECTED_SCHEDULE = {
    "measuredPairs": 24, "controlPairs": 8, "warmupPairs": 2,
    "mediaImports": 2, "memoryImports": 4, "totalReports": 74,
}
EXPECTED_PACKAGED_DELTA = [
    "js/dictionary/dictionary-database.js",
    "js/dictionary/term-record-opfs-store.js",
]
EXPECTED_NUMERIC_GATES = json.loads("{\"jmdict\":{\"everyOriginalHost\":{\"candidateMedianChangePercentAtMost\":-2,\"strictlyFasterPairsAtLeast\":18,\"measuredPairsExactly\":24,\"controlPairsExactly\":8,\"absoluteControlMedianChangePercentAtMost\":1,\"absoluteControlEqualWorkChangePercentAtMost\":1},\"requiresBothHosts\":true},\"jitendex\":{\"eachOriginalHost\":{\"absoluteControlMedianChangePercentAtMost\":3,\"absoluteControlEqualWorkChangePercentAtMost\":3},\"rejectIfBothOriginalHostsCandidateMedianSlowdownPercentGreaterThan\":3},\"vndb\":{\"eachOriginalHost\":{\"absoluteControlMedianChangePercentAtMost\":3,\"absoluteControlEqualWorkChangePercentAtMost\":3},\"rejectIfBothOriginalHostsCandidateMedianSlowdownPercentGreaterThan\":3},\"isolatedNonTargetSlowdown\":\"Report every non-target host result, including a single >3% slowdown; do not rerun, pool or hide it. The frozen repeatable-regression rejection uses both original hosts.\",\"memory\":\"Unchanged common strict scan/whole-tree validity plus, for PSS and private memory, median paired increase <=5% and maximum paired increase <=10% in each cell.\",\"semanticMediaSource\":\"Every one of six complete cells and all corresponding source/semantic/exhaustive-media/memory and production correctness gates must pass.\"}")
EXPECTED_NATIVE_NAMES = [
    "term-content-canonical-scan-v1.wasm", "term-bank-parser.wasm", "term-record-fields.wasm",
]


def require(value, message):
    if not value:
        raise RuntimeError(message)


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "Duplicate JSON key: " + key)
            result[key] = value
        return result

    def invalid(value):
        raise ValueError("Nonfinite JSON value: " + value)

    def finite_float(value):
        number = float(value)
        require(math.isfinite(number), "Nonfinite JSON float")
        return number

    return json.loads(data, object_pairs_hook=pairs, parse_constant=invalid, parse_float=finite_float)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def same(actual, expected, message):
    require(json.dumps(actual, sort_keys=True, allow_nan=False) ==
            json.dumps(expected, sort_keys=True, allow_nan=False), message)



def verify_fixture_metadata(lock_dictionaries, study_dictionaries):
    """Compare the three selected fixtures while retaining a separately bound full lock."""
    names = ("jmdict", "jitendex", "vndb")
    require(type(lock_dictionaries) is dict and type(study_dictionaries) is dict,
            "Fixture dictionaries must be objects")
    require(set(study_dictionaries) == set(names), "Study fixture key set changed")
    require(all(name in lock_dictionaries for name in names), "Selected fixture missing from lock")
    same({name: lock_dictionaries[name] for name in names}, study_dictionaries,
         "Pinned selected fixture metadata changed")

def full_sha(value, length=40):
    require(type(value) is str and re.fullmatch("[0-9a-f]{" + str(length) + "}", value),
            "Expected a complete immutable digest")
    return value


def positive(value):
    require(type(value) is int and 0 < value < 2 ** 53, "Expected a positive original API identity")
    return value


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def canonical(path):
    require(type(path) is str and path and "\\" not in path and "\x00" not in path,
            "Invalid source path")
    value = PurePosixPath(path)
    require(bool(value.parts) and not value.is_absolute() and str(value) == path and
            all(part not in ("", ".", "..") for part in value.parts), "Noncanonical source path")
    return path


def tree_files(commit):
    result = {}
    for entry in git("ls-tree", "-r", "-z", commit).split(b"\0"):
        if not entry:
            continue
        header, raw_path = entry.split(b"\t", 1)
        mode, kind, blob = header.decode().split()
        path = canonical(raw_path.decode())
        require(path not in result, "Duplicate tracked path")
        result[path] = {"mode": mode, "type": kind, "gitBlob": blob}
    return result


def changed(left, right):
    return sorted(path for path in set(left) | set(right) if left.get(path) != right.get(path))


def bytes_identity(data, entry):
    require(entry["type"] == "blob" and entry["mode"] in ("100644", "100755"),
            "Only exact regular Git file modes are accepted")
    return {"gitBlob": entry["gitBlob"], "mode": entry["mode"], "sha256": sha(data), "bytes": len(data)}


def working_identity(path, entries):
    canonical(path)
    require(path in entries, "Missing tracked source: " + path)
    data = git("cat-file", "blob", entries[path]["gitBlob"])
    target = ROOT / path
    require(stat.S_ISREG(target.lstat().st_mode) and not target.is_symlink(),
            "Expected a regular source file: " + path)
    require(target.read_bytes() == data, "Working source differs from Git: " + path)
    return bytes_identity(data, entries[path])


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise RuntimeError("Unexpected GitHub metadata redirect")


def github_json(endpoint):
    require(endpoint.startswith("/") and ".." not in endpoint and "://" not in endpoint,
            "Unexpected metadata endpoint")
    token = os.environ.get("FIELD_AUDIT_TOKEN")
    require(bool(token), "Read-only GitHub token is required for sealed prerequisite metadata")
    request = urllib.request.Request(
        "https://api.github.com/repos/" + REPOSITORY + endpoint,
        headers={"Accept": "application/vnd.github+json",
                 "Authorization": "Bearer " + token,
                 "X-GitHub-Api-Version": "2022-11-28",
                 "User-Agent": "native-record-fields-source-preflight"},
        method="GET",
    )
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
        require(response.status == 200, "Prerequisite metadata request failed")
        return strict_json(response.read())


def verify_original_job(proof, label):
    require(type(proof) is dict, "Missing prerequisite: " + label)
    run_id, job_id = positive(proof["runId"]), positive(proof["jobId"])
    full_sha(proof["headSha"])
    require(proof["attempt"] == 1, "Prerequisite must be its first original attempt")
    artifact = proof["artifact"]
    require(type(artifact) is dict and set(artifact) == {"id", "name", "bytes", "sha256"},
            "Missing exact original artifact metadata: " + label)
    positive(artifact["id"])
    positive(artifact["bytes"])
    full_sha(artifact["sha256"], 64)
    require(type(artifact["name"]) is str and bool(artifact["name"]), "Missing original artifact name")
    run = github_json("/actions/runs/" + str(run_id))
    job = github_json("/actions/jobs/" + str(job_id))
    require(run["id"] == run_id and run["head_sha"] == proof["headSha"] and
            run["run_attempt"] == 1 and run["status"] == "completed",
            "Original prerequisite run changed: " + label)
    require(job["id"] == job_id and job["run_id"] == run_id and
            job["status"] == "completed" and job["conclusion"] == "success",
            "Original prerequisite job did not pass: " + label)
    artifacts = github_json("/actions/runs/" + str(run_id) + "/artifacts?per_page=100")
    require(type(artifacts["artifacts"]) is list and artifacts["total_count"] <= 100,
            "Prerequisite artifact list is incomplete")
    matches = [value for value in artifacts["artifacts"] if value["id"] == artifact["id"]]
    require(len(matches) == 1, "Missing unique original artifact: " + label)
    observed = matches[0]
    require(observed["name"] == artifact["name"] and observed["size_in_bytes"] == artifact["bytes"] and
            observed["digest"] == "sha256:" + artifact["sha256"] and observed["expired"] is False and
            observed["workflow_run"]["id"] == run_id and observed["workflow_run"]["head_sha"] == proof["headSha"],
            "Original prerequisite artifact identity changed: " + label)
    return {"run": run_id, "job": job_id, "head": proof["headSha"], "attempt": 1,
            "jobConclusion": job["conclusion"], "runConclusion": run["conclusion"],
            "artifact": artifact, "steps": job.get("steps", []),
            "scope": "Original metadata plus previously sealed records audit; no archive or product is executed here."}


def verify_policy(study, workflow, phase):
    same(study["upstream"], {"commit": BASELINE, "tree": BASELINE_TREE}, "Upstream changed")
    same(study["candidate"], {"commit": PRODUCT, "tree": PRODUCT_TREE}, "Clean product changed")
    same(study["control"], {"commit": CONTROL, "tree": CONTROL_TREE}, "Inactive control changed")
    require(study["schemaVersion"] == 1, "Unknown study schema")
    same(study["schedule"], EXPECTED_SCHEDULE, "Prospective schedule changed")
    same(study["armCountsPerCell"], {"A": 37, "B": 29, "C": 8}, "Original arm counts changed")
    same(study["expectedPackageEntries"], EXPECTED_PACKAGED_DELTA, "Package boundary changed")
    same(study["numericGates"], EXPECTED_NUMERIC_GATES, "Prospective numeric gates changed")
    environment = study["environment"]
    require(environment["runner"] == "ubuntu-26.04" and environment["node"] == "22.22.0" and
            environment["timeoutMinutesPerCell"] == 120 and environment["parallelFailFast"] is False and
            environment["originalAttemptOnly"] == 1 and environment["flags"] == {},
            "Frozen runtime or empty flags changed")
    require([(cell["dictionary"], cell["initialOrder"]) for cell in study["cells"]] ==
            [(dictionary, order) for dictionary in ("jmdict", "jitendex", "vndb") for order in ("AB", "BA")],
            "Original six cells changed")
    for cell in study["cells"]:
        require(cell["measuredPairs"] == 24 and cell["controlPairs"] == 8 and
                cell["warmupPairs"] == 2 and cell["exhaustiveMediaImports"] == 2 and
                cell["memoryImports"] == 4 and cell["totalReports"] == 74,
                "Cell schedule changed")
        same(cell["vndbSahAllocationUnits"], [37, 37] if cell["dictionary"] == "vndb" else None,
             "VNDB allocation policy changed")
    require("--pairs 24" in workflow and "--expected-workers" not in workflow and "--workers" not in workflow and
            '--baseline "$FIELD_CONTROL" --candidate "$FIELD_PRODUCT"' in workflow and
            "cancel-in-progress: false" in workflow and "fail-fast: false" in workflow and
            "if: always()" in workflow, "Workflow acquisition boundary changed")
    disabled = "    if: $" + "{{ false }}"
    if phase == "staged":
        require(study["acquisitionEnabled"] is False and study["activation"]["sealed"] is False and
                study["activation"]["perCorpus"] == {"jmdict": None, "jitendex": None, "vndb": None} and
                disabled in workflow, "Staged study must remain inert")
        return {}
    require(study["acquisitionEnabled"] is True and disabled not in workflow,
            "Acquisition is not enabled by the frozen source")
    prerequisites = study["prerequisites"]
    require(prerequisites["rootPublicationAuthorized"] is True, "Publication authorization is not sealed")
    for name in ("component", "validation", "corpus", "productionEvidenceAudit"):
        require(prerequisites[name]["sealed"] is True and prerequisites[name]["passed"] is True,
                "Incomplete prerequisite: " + name)
    for name in ("validation", "corpus"):
        proof = prerequisites[name]
        require(proof["productCommit"] == PRODUCT, "Correctness belongs to a different product")
        full_sha(proof["sourceTree"])
        full_sha(proof["sourceDigest"], 64)
        full_sha(proof["receiptSha256"], 64)
    full_sha(prerequisites["productionEvidenceAudit"]["resultSha256"], 64)
    required = ["source", "setup", "generated", "toolchain", "native", "lint", "unit",
                "options", "main_types", "dev_types", "test_types", "builds"]
    same(prerequisites["validation"]["requiredGates"], required, "Complete validation gate changed")
    same(prerequisites["corpus"]["requiredCorpora"], ["jmdict", "jitendex", "vndb"],
         "Required corpus inventory changed")
    require(prerequisites["corpus"]["normalReadiness"] is True, "Readiness was forced")
    # This reviewed module defines only pure readers/checks. No product is loaded.
    module_path = ROOT / KIT / "audit-activation.py"
    spec = importlib.util.spec_from_file_location("field_activation_policy", module_path)
    require(spec is not None and spec.loader is not None, "Cannot load pure policy checker")
    checker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checker)
    checker.validate_policy(study, "jmdict", study["fixtures"]["dictionaries"])
    evidence = {
        name: verify_original_job(prerequisites[name], name)
        for name in ("component", "validation", "corpus", "productionEvidenceAudit")
    }
    evidence["componentRecordsAudit"] = verify_original_job(
        prerequisites["component"]["recordsAudit"], "component records audit")
    return evidence


def verify(head, phase):
    full_sha(head)
    require(git("rev-parse", "HEAD").decode().strip() == head, "Wrong study checkout")
    same(git("rev-list", "--parents", "-n", "1", head).decode().split(),
         [head, PRODUCT], "Study must have the clean product as its sole parent")
    for commit, tree in ((BASELINE, BASELINE_TREE), (PRODUCT, PRODUCT_TREE), (CONTROL, CONTROL_TREE)):
        require(git("rev-parse", commit + "^{tree}").decode().strip() == tree,
                "Immutable source tree changed")
    for commit in (PRODUCT, CONTROL):
        same(git("rev-list", "--parents", "-n", "1", commit).decode().split(),
             [commit, BASELINE], "Clean product/control ancestry changed")
    generated = phase == "generated"
    working_changes = set(git("diff", "--name-only", "HEAD", "--").decode().splitlines())
    require(working_changes <= ({"ext/legal-npm.html"} if generated else set()),
            "Unexpected tracked working change")
    entries = tree_files(head)
    baseline, product, control = (tree_files(value) for value in (BASELINE, PRODUCT, CONTROL))
    source_identity = working_identity(SOURCE_PATH, entries)
    source = strict_json((ROOT / SOURCE_PATH).read_bytes())
    require(source["schemaVersion"] == 1 and source["kind"] == "prospective-native-record-fields-browser",
            "Unknown source manifest")
    same(source["upstream"], {"commit": BASELINE, "tree": BASELINE_TREE}, "Manifest upstream changed")
    same(source["candidate"], {"commit": PRODUCT, "tree": PRODUCT_TREE}, "Manifest product changed")
    same(source["control"], {"commit": CONTROL, "tree": CONTROL_TREE}, "Manifest control changed")
    files = source["files"]
    require(type(files) is dict and SOURCE_PATH not in files and
            all(path in files for path in (STUDY_PATH, WORKFLOW_PATH, KIT + "/verify-source.py",
                                           KIT + "/audit-activation.py", KIT + "/test-activation.py")),
            "Incomplete source manifest")
    same(changed(baseline, entries), sorted(set(files) | {SOURCE_PATH}), "Complete source boundary changed")
    identities = {SOURCE_PATH: source_identity}
    for path, expected in sorted(files.items()):
        require(set(expected) == {"gitBlob", "mode", "sha256", "bytes"}, "Invalid file identity fields")
        actual = working_identity(path, entries)
        same(actual, expected, "Bound source changed: " + path)
        identities[path] = actual
    aggregate = sha("".join(path + "\0" + identities[path]["sha256"] + "\n" for path in sorted(files)).encode())
    require(aggregate == source["digest"], "Source aggregate changed")
    study = strict_json((ROOT / STUDY_PATH).read_bytes())
    product_paths = [item["path"] for item in study["productFiles"]]
    require(len(product_paths) == len(set(product_paths)) == 13, "Unexpected product boundary")
    same(changed(baseline, product), sorted(product_paths), "Clean product delta changed")
    for item in study["productFiles"]:
        path = item["path"]
        expected = {key: item[key] for key in ("gitBlob", "mode", "sha256", "bytes")}
        same(identities[path], expected, "Product binding changed")
        same(entries[path], product[path], "Study modified clean product source")
    research = set(files) | {SOURCE_PATH}
    research -= set(product_paths)
    same(changed(product, entries), sorted(research), "Study changed a product file")
    require(all(path == WORKFLOW_PATH or path.startswith(KIT + "/") for path in research),
            "Study files escaped isolated prefix")
    excluded = {"ext/js/dictionary/dictionary-database.js", "ext/js/dictionary/term-record-opfs-store.js",
                "test/term-record-fields-native.test.js", "test/term-record-import-fields.test.js"}
    shared = sorted(set(product_paths) - excluded)
    require(len(shared) == 9, "Unexpected inert control boundary")
    same(sorted(study["sharedControlPaths"]), shared, "Control inventory changed")
    same(changed(baseline, control), shared, "Control changed an unapproved path")
    for path in shared:
        same(product[path], control[path], "Shared control asset/source changed")
    same(sorted(path for path in product if path.startswith("ext/")),
         sorted(path for path in control if path.startswith("ext/")), "Tracked runtime member sets differ")
    same([path for path in changed(control, product) if path.startswith("ext/")],
         ["ext/" + path for path in EXPECTED_PACKAGED_DELTA], "Tracked runtime delta changed")
    protected = {}
    for path, entry in baseline.items():
        if path in product_paths:
            continue
        if path.startswith(("dev/perf/", "test/e2e/", "test/chromium/")) or path in (
            "package.json", "package-lock.json", ".github/actions/setup/action.yml",
            "test/perf/dictionaries.lock.json", "dev/bin/build-dictionary-wasm.js",
            "dev/data/dictionary-wasm/term-bank-parser.wasm",
            "dev/data/dictionary-wasm/term-content-canonical-scan-v1.wasm",
        ):
            for state in (entries, product, control):
                same(state.get(path), entry, "Protected baseline Git entry changed: " + path)
            protected[path] = working_identity(path, entries)
    for expected in study["commonMachinery"]:
        actual = protected[expected["path"]]
        same({key: actual[key] for key in ("gitBlob", "sha256", "bytes")},
             {key: expected[key] for key in ("gitBlob", "sha256", "bytes")}, "Common qualifier changed")
    lock_path = study["fixtures"]["lock"]["path"]
    require(protected[lock_path]["sha256"] == study["fixtures"]["lock"]["sha256"], "Fixture lock changed")
    verify_fixture_metadata(strict_json((ROOT / lock_path).read_bytes())["dictionaries"],
                            study["fixtures"]["dictionaries"])
    for path, expected in study["runtimeSha256"].items():
        source_path = "dev/data/dictionary-wasm/term-record-fields.wasm" if path.startswith("ext/lib/") else path
        require(identities[source_path]["sha256"] == expected, "Field runtime digest changed")
    workflow = (ROOT / WORKFLOW_PATH).read_text()
    prerequisite_evidence = verify_policy(study, workflow, phase)
    assets = {}
    if generated:
        require(subprocess.check_output(["node", "--version"], cwd=ROOT).decode().strip() == "v22.22.0",
                "Unexpected Node runtime")
        native = strict_json((ROOT / "dev/data/dictionary-wasm/manifest.json").read_bytes())
        same([item["name"] for item in native["targets"]], EXPECTED_NATIVE_NAMES, "Native target inventory changed")
        for target in native["targets"]:
            path = "ext/lib/" + target["name"]
            local = ROOT / path
            require(stat.S_ISREG(local.lstat().st_mode) and not local.is_symlink(), "Generated asset is not regular")
            data = local.read_bytes()
            require(data == (ROOT / "dev/data/dictionary-wasm" / target["name"]).read_bytes() and
                    sha(data) == target["sha256"], "Generated native bytes differ")
            assets[path] = {"sha256": sha(data), "bytes": len(data)}
    return {
        "schemaVersion": 1, "passed": True, "phase": phase,
        "studyHead": head, "studyTree": git("rev-parse", "HEAD^{tree}").decode().strip(),
        "sourceManifest": source_identity, "sourceDigest": aggregate,
        "upstream": study["upstream"], "candidate": study["candidate"], "control": study["control"],
        "sources": identities, "protected": protected, "generatedAssets": assets,
        "setupGeneratedDocuments": {
            path: {"sha256": sha((ROOT / path).read_bytes()),
                   "committedSha256": sha(git("show", head + ":" + path))}
            for path in sorted(working_changes)
        },
        "treeBoundaries": {"productPaths": sorted(product_paths), "controlPaths": shared,
                           "studyPaths": sorted(research),
                           "trackedRuntimeDelta": ["ext/" + path for path in EXPECTED_PACKAGED_DELTA]},
        "runtimeSha256": study["runtimeSha256"], "schedule": study["schedule"],
        "numericGates": study["numericGates"], "prerequisiteMetadata": prerequisite_evidence,
        "acquisitionEnabled": study["acquisitionEnabled"], "timingAcquired": False, "productExecuted": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--head", required=True)
    parser.add_argument("--phase", choices=("staged", "launch", "generated"), required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    require(not args.output.exists(), "Refusing to replace an original source receipt")
    try:
        result = verify(args.head, args.phase)
    except BaseException as error:
        result = {"schemaVersion": 1, "passed": False, "phase": args.phase,
                  "studyHead": args.head, "error": repr(error), "timingAcquired": False, "productExecuted": False}
        args.output.write_text(json.dumps(result, indent=2, sort_keys=True, allow_nan=False) + "\n")
        print(json.dumps(result, sort_keys=True, allow_nan=False))
        raise
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True, allow_nan=False) + "\n")
    print(json.dumps(result, sort_keys=True, allow_nan=False))


if __name__ == "__main__":
    main()
