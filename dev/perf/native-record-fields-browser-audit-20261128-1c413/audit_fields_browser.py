#!/usr/bin/env python3
"""Read immutable original fields browser artifacts; never acquire a benchmark."""
import argparse
import ast
import base64
import errno
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import random
import re
import statistics
import sys
import zipfile

from audit_transport import (
    AuditError, GitHub, digest, file_digest, inspect_zip, parse_json,
    read_json, require, stream_digest, write_json,
)
from qualification_policy import (
    CELLS, POLICY, cell_qualification, frozen_schedule, independent_contrast, qualify_study,
)

PRODUCER_PREFIX = "dev/perf/native-record-fields-browser-20261128-1c413"
PRODUCER_WORKFLOW = ".github/workflows/import-native-record-fields-1c413.yml"
AUDITOR_PREFIX = "dev/perf/native-record-fields-browser-audit-20261128-1c413"
AUDITOR_WORKFLOW = ".github/workflows/native-record-fields-browser-audit-1c413.yml"
CELL_DIRECTORY = "builds/perf/native-record-fields-browser-cell"
METADATA_DIRECTORY = "builds/perf/native-record-fields-browser-metadata"
QUALIFIER = "dev/perf/import-qualification-20261125-a7f7.py"
QUALIFIER_SHA256 = "cad1b3fb25766cbd22a1c4260718a0b92353e87276751217ca18dc9eea29c6ef"
HARNESS = "test/chromium/extension-two-dictionary-import.e2e.js"
MEMORY_DIRECTORY = "dev/perf/import-memory-20261125-a7f7"
MODULE_HASHES = {
    "chromium_memory": "8044bf3f4c48a868c7e076dc5f1bef9c2663f6323fe4a4fba5c121161cada4c7",
    "protocol": "ea0e7c20bbc1273cbe81891c32ecc72658d70ed1bbf1d57cdcfae5b347d493c7",
    "qualification_receipts": "4f7b4eee4f8ff71e821c9162e57524460c48f01f409487f638523a3a27aa8f51",
    "audit_memory": "871f29b9d87c42468714263a0eda05ee9edd2f76bff269ea9cb6d6d1fe51de7c",
}
TRANSPORT_SHA256 = "1c3c6f1c180eb8512146e7999561d8fd8cfdf10efb693a54b21d805a3a2a0aa6"
ACTIVATION_SHA256 = "15c994658125015edaa4aae931ce82f122526bd4c0cc4e65286cd3975642010a"
PACKAGE_ENTRIES = [
    "js/dictionary/dictionary-database.js",
    "js/dictionary/term-record-opfs-store.js",
]
PRODUCT_PATHS = {
    "dev/bin/audit-release-packages.js", "dev/data/dictionary-wasm/manifest.json",
    "dev/data/dictionary-wasm/term-record-fields.wasm", "dev/dictionary-wasm.js",
    "eslint.config.js", "ext/js/dictionary/dictionary-database.js",
    "ext/js/dictionary/term-record-fields.js", "ext/js/dictionary/term-record-opfs-store.js",
    "ext/js/dictionary/wasm/term-record-fields.c", "test/dictionary-wasm-build.test.js",
    "test/release-package-native-assets.test.js", "test/term-record-fields-native.test.js",
    "test/term-record-import-fields.test.js",
}
CONTROL_PATHS = PRODUCT_PATHS - {
    "ext/js/dictionary/dictionary-database.js", "ext/js/dictionary/term-record-opfs-store.js",
    "test/term-record-fields-native.test.js", "test/term-record-import-fields.test.js",
}
PROVENANCE_PATHS = (
    "package-lock.json", "test/perf/dictionaries.lock.json", "dev/perf/benchmark-support.js",
    "dev/perf/dictionary-fixtures.js", "dev/perf/import-benchmark.js",
    "test/chromium/import-flags-ab-benchmark.js", HARNESS, "test/e2e/import-timing.js",
    "ext/js/pages/settings/dictionary-import-controller.js",
    "builds/manabitan-chrome-dev.zip", "builds/manabitan-chrome.zip",
)
EXPECTED_NUMERIC_GATES = json.loads(r'''{
  "jmdict": {
    "everyOriginalHost": {
      "candidateMedianChangePercentAtMost": -2,
      "strictlyFasterPairsAtLeast": 18,
      "measuredPairsExactly": 24,
      "controlPairsExactly": 8,
      "absoluteControlMedianChangePercentAtMost": 1,
      "absoluteControlEqualWorkChangePercentAtMost": 1
    },
    "requiresBothHosts": true
  },
  "jitendex": {
    "eachOriginalHost": {
      "absoluteControlMedianChangePercentAtMost": 3,
      "absoluteControlEqualWorkChangePercentAtMost": 3
    },
    "rejectIfBothOriginalHostsCandidateMedianSlowdownPercentGreaterThan": 3
  },
  "vndb": {
    "eachOriginalHost": {
      "absoluteControlMedianChangePercentAtMost": 3,
      "absoluteControlEqualWorkChangePercentAtMost": 3
    },
    "rejectIfBothOriginalHostsCandidateMedianSlowdownPercentGreaterThan": 3
  },
  "isolatedNonTargetSlowdown": "Report every non-target host result, including a single >3% slowdown; do not rerun, pool or hide it. The frozen repeatable-regression rejection uses both original hosts.",
  "memory": "Unchanged common strict scan/whole-tree validity plus, for PSS and private memory, median paired increase <=5% and maximum paired increase <=10% in each cell.",
  "semanticMediaSource": "Every one of six complete cells and all corresponding source/semantic/exhaustive-media/memory and production correctness gates must pass."
}''')
TERMINAL_CONCLUSIONS = ("success", "failure", "cancelled", "timed_out")
REQUIRED_CELL_STEPS = {
    "source": "Bind original attempt, immutable source and completed prerequisites",
    "setup": "Prepare exact Node and locked dependencies",
    "generated": "Bind generated native assets and setup document",
    "protocol": "Verify the pure activation receipt checker",
    "browser": "Install matching Chromium",
    "qualify": "Acquire the original frozen comparisons and separate media and memory checks",
    "activation": "Audit activation in every original receipt, including failures",
}
COMPONENT_AUDIT = {
    "runId": 46126612006, "jobId": 140922487765, "runAttempt": 1,
    "headSha": "b99e1a9daf7fe0885291ec25245959f731619373",
    "headBranch": "audit/native-record-fields-linker-20261128-1c413",
    "artifact": {
        "id": 15255898869,
        "name": "corrected-fields-readonly-audit-b99e1a9daf7fe0885291ec25245959f731619373",
        "sizeBytes": 16594754, "sha256": "0b9620507329ff7b4163a40035ccbdbf9dedec69d50b4c33e71961c4cd7eb164",
    },
    "result": {
        "gitBlob": "c41c034efa9021adc77c328ffc50066912e6e195",
        "bytes": 6029, "sha256": "3f2e8cd442b61ad400a329d7fe51115cffa437c378984f7bdbec8d0b9596e766",
    },
}


def same(actual, expected, label):
    if type(actual) is set or type(expected) is set:
        require(type(actual) is set and type(expected) is set and actual == expected, label + " differs")
        return
    require(json.dumps(actual, sort_keys=True, allow_nan=False) ==
            json.dumps(expected, sort_keys=True, allow_nan=False), label + " differs")


def git_blob(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def verify_auditor_source():
    require(sys.flags.optimize == 0, "Audit assertions must remain enabled")
    directory = Path(__file__).resolve().parent
    repository = directory.parents[2]
    binding_path = directory / "source-binding.json"
    binding = read_json(binding_path)
    expected = {AUDITOR_PREFIX + "/" + name for name in (
        "audit_transport.py", "qualification_policy.py", "test_qualification_policy.py",
        "audit_fields_browser.py", "test_audit_fields_browser.py", "manifest.json", "README.md",
    )} | {AUDITOR_WORKFLOW}
    same(set(binding["files"]), expected, "Complete independently reviewed auditor source boundary")
    checked = {}
    for relative, record in sorted(binding["files"].items()):
        path = repository / relative
        require(path.is_file() and not path.is_symlink(), "Missing regular auditor source " + relative)
        data = path.read_bytes()
        same(record, {"bytes": len(data), "gitBlob": git_blob(data)}, "Frozen auditor source " + relative)
        checked[relative] = {**record, "sha256": digest(data)}
    data = binding_path.read_bytes()
    checked[AUDITOR_PREFIX + "/source-binding.json"] = {
        "bytes": len(data), "gitBlob": git_blob(data), "sha256": digest(data),
    }
    return checked


def verify_component_prerequisite(api, output):
    """Bind the already completed independent audit; do not rerun its component."""
    output.mkdir()
    frozen = COMPONENT_AUDIT
    run = api.json("/actions/runs/" + str(frozen["runId"]), "component-audit-run")
    for key, expected in (
        ("id", frozen["runId"]), ("run_attempt", 1), ("head_sha", frozen["headSha"]),
        ("head_branch", frozen["headBranch"]), ("status", "completed"), ("conclusion", "success"),
        ("event", "push"), ("path", ".github/workflows/corrected-fields-artifact-audit-1c413.yml"),
    ):
        same(run.get(key), expected, "Completed component records-audit run " + key)
    jobs = api.json("/actions/runs/" + str(frozen["runId"]) + "/jobs?filter=all&per_page=100",
                    "component-audit-jobs")
    same(jobs["total_count"], 1, "Component records-audit job count")
    require(len(jobs["jobs"]) == 1, "Incomplete component audit job list")
    job = jobs["jobs"][0]
    for key, expected in (
        ("id", frozen["jobId"]), ("run_id", frozen["runId"]), ("run_attempt", 1),
        ("head_sha", frozen["headSha"]), ("status", "completed"), ("conclusion", "success"),
    ):
        same(job.get(key), expected, "Completed component records-audit job " + key)
    steps = {step["name"]: step for step in job["steps"]}
    for name in ("Check pure auditor logic", "Inspect the corrected records and the separate original failure"):
        require(name in steps and steps[name]["status"] == "completed" and steps[name]["conclusion"] == "success",
                "Required original component audit step failed")
    original_result = verified_blob(api, frozen["result"], "component-audit-frozen-result")
    result = parse_json(original_result)
    for name in ("auditPassed", "archiveIntegrityPassed", "sourceAndCaptureIntegrityPassed", "screenComplete",
                 "nominationGatePassed", "qualifiedForComponentNomination", "allCorrectedStudyJobsSucceeded"):
        same(result[name], True, "Completed component prerequisite " + name)
    same(result["componentOnly"], True, "Component evidence scope")
    same(result["newTimingOrImportAcquired"], False, "Records audit acquired new data")
    same(result["correctedStudyRunId"], 46123144616, "Original component study")
    same(result["artifact"], {
        "id": 15254998779, "members": 217, "sizeBytes": 4076464,
        "sha256": "e4b76382586a00d8824e85804e3a978942fd452f61c2006aedc1342c5d84d654",
    }, "Complete original component artifact")
    previous = result["previousFailedStudy"]
    same(previous["originalRunId"], 46115204690, "Separate original failed component")
    require(previous["auditPassed"] is True and previous["qualifiedForComponentNomination"] is False and
            previous["originalWarmupObservations"] == 0 and previous["originalMeasuredObservations"] == 0,
            "Original zero-observation failure was promoted or lost")
    outer, metadata = api.artifact(frozen["artifact"], frozen, output)
    extracted = output / "extracted"
    extracted.mkdir()
    inventory = []
    try:
        with zipfile.ZipFile(outer) as archive:
            for info in inspect_zip(archive):
                target = extracted.joinpath(*Path(info.filename).parts)
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    inventory.append({"path": info.filename, "directory": True, "bytes": 0})
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as stream, target.open("xb") as destination:
                    record = archive_member_digest(stream, info.file_size, destination)
                inventory.append({"path": info.filename, **record})
        final_path = extracted / "audit-evidence/final-audit.json"
        same(final_path.read_bytes().decode(), original_result.decode(),
             "Exact result bytes from completed original component audit artifact")
    finally:
        write_json(output / "outer-member-inventory.json", inventory)
    receipt = {
        "passed": True, "originalAudit": frozen, "result": result,
        "artifactMetadata": metadata, "retainedOriginalAuditZip": outer.name,
        "outerMembers": len(inventory), "resultSha256": file_digest(final_path),
        "scope": "Transitive source-bound prerequisite from the already completed independent records audit. No component/import/timing replay; every audit-artifact member is retained.",
    }
    write_json(output / "independent-prerequisite.json", receipt)
    return receipt


def validate_manifest(manifest):
    same(manifest.get("schemaVersion"), 1, "Manifest schema")
    same(manifest.get("repository"), "ManabiIO/manabitan", "Repository")
    require(manifest.get("enabled") is True, "Inert reader manifest: no original artifacts are authorized")
    upstream = manifest.get("upstream")
    require(type(upstream) is dict and set(upstream) == {"commit", "tree"} and
            all(type(value) is str and re.fullmatch(r"[0-9a-f]{40}", value) for value in upstream.values()),
            "Missing explicit immutable upstream commit/tree mapping")
    same(manifest.get("qualificationPolicy"), POLICY, "Frozen whole-import numeric policy")
    require(type(manifest.get("cleanSources")) is dict and
            set(manifest["cleanSources"]) == {"control", "candidate"}, "Missing clean product/control binding")
    for source in manifest["cleanSources"].values():
        require(type(source) is dict and set(source) == {"commit", "tree"} and all(
            type(value) is str and re.fullmatch(r"[0-9a-f]{40}", value) for value in source.values()),
            "Incomplete immutable clean source identity")
    publication = manifest.get("publication")
    require(type(publication) is dict and set(publication) == {
        "runId", "headSha", "headTree", "headBranch", "runAttempt", "event", "workflowPath",
    }, "Missing complete original study publication")
    require(type(publication["runId"]) is int and publication["runId"] > 0, "Invalid original run ID")
    for field in ("headSha", "headTree"):
        require(type(publication[field]) is str and re.fullmatch(r"[0-9a-f]{40}", publication[field]),
                "Incomplete original study " + field)
    same(publication["headBranch"], "perf/native-record-fields-browser-acquire-20261128-1c413", "Original browser branch")
    same(publication["runAttempt"], 1, "Original run attempt")
    same(publication["event"], "push", "Original run event")
    same(publication["workflowPath"], PRODUCER_WORKFLOW, "Original browser workflow")
    require(manifest.get("expectedRunConclusion") in TERMINAL_CONCLUSIONS, "Original run is not terminal")
    for field in ("study", "sourceManifest"):
        identity = manifest.get(field)
        require(type(identity) is dict and set(identity) == {"path", "gitBlob", "sha256", "bytes"},
                "Incomplete immutable " + field + " identity")
        require(type(identity["bytes"]) is int and identity["bytes"] > 0, "Invalid source byte count")
        require(re.fullmatch(r"[0-9a-f]{40}", identity["gitBlob"]) is not None and
                re.fullmatch(r"[0-9a-f]{64}", identity["sha256"]) is not None, "Invalid source digest")
    same(manifest["study"]["path"], PRODUCER_PREFIX + "/study.json", "Original study path")
    same(manifest["sourceManifest"]["path"], PRODUCER_PREFIX + "/source.json", "Original source-manifest path")
    require(type(manifest.get("correctnessPrerequisite")) is dict and
            type(manifest["correctnessPrerequisite"].get("reader")) is dict and
            type(manifest["correctnessPrerequisite"].get("manifest")) is dict,
            "Complete separately reviewed original correctness reader binding is required")
    reader = manifest["correctnessPrerequisite"]["reader"]
    require(set(reader) == {"gitBlob", "sha256", "bytes"} and
            type(reader["gitBlob"]) is str and re.fullmatch(r"[0-9a-f]{40}", reader["gitBlob"]) and
            type(reader["sha256"]) is str and re.fullmatch(r"[0-9a-f]{64}", reader["sha256"]) and
            type(reader["bytes"]) is int and 0 < reader["bytes"] <= 1024 * 1024,
            "Incomplete independently reviewed correctness-reader byte identity")
    entries = manifest.get("artifacts")
    require(type(entries) is list and len(entries) == 6, "Exactly six original comparison artifacts are required")
    same(sorted(entry["kind"] for entry in entries), sorted(CELLS), "Original artifact roles")
    require(len({entry["id"] for entry in entries}) == 6 and
            len({entry["jobId"] for entry in entries}) == 6, "Duplicate original artifact or job ID")
    for entry in entries:
        require(set(entry) == {"kind", "id", "name", "sizeBytes", "sha256", "jobId", "jobName", "expectedConclusion"},
                "Unexpected original artifact fields")
        dictionary, initial = CELLS[entry["kind"]]
        same(entry["jobName"], "Complete import (" + dictionary + ", " + initial + ")", "Original cell job name")
        for key in ("id", "jobId"):
            require(type(entry[key]) is int and entry[key] > 0, "Invalid original " + key)
        require(type(entry["sizeBytes"]) is int and 0 < entry["sizeBytes"] <= 128 * 1024 * 1024,
                "Unexpected original outer ZIP size")
        require(re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]) is not None, "Invalid original ZIP digest")
        same(entry["name"], "native-record-fields-browser-" + entry["kind"] + "-" + publication["headSha"],
             "Original comparison artifact name")
        require(entry["expectedConclusion"] in TERMINAL_CONCLUSIONS, "Original job is not terminal")
    return manifest


def validate_original_jobs(run, jobs, manifest):
    publication = manifest["publication"]
    for key, expected in (
        ("id", publication["runId"]), ("head_sha", publication["headSha"]),
        ("head_branch", publication["headBranch"]), ("run_attempt", 1), ("event", "push"),
        ("path", PRODUCER_WORKFLOW), ("status", "completed"),
        ("conclusion", manifest["expectedRunConclusion"]),
    ):
        same(run.get(key), expected, "Original browser run " + key)
    same(jobs.get("total_count"), 6, "Complete original comparison job count")
    require(type(jobs.get("jobs")) is list and len(jobs["jobs"]) == 6, "Incomplete original jobs response")
    same(sorted(job["id"] for job in jobs["jobs"]),
         sorted(item["jobId"] for item in manifest["artifacts"]), "Complete original job identities")
    by_id = {}
    for job in jobs["jobs"]:
        entry = next(item for item in manifest["artifacts"] if item["jobId"] == job["id"])
        for key, expected in (
            ("run_id", publication["runId"]), ("run_attempt", 1), ("head_sha", publication["headSha"]),
            ("name", entry["jobName"]), ("status", "completed"), ("conclusion", entry["expectedConclusion"]),
        ):
            same(job.get(key), expected, "Original cell " + key)
        by_id[job["id"]] = job
    return by_id


def tree_delta(left, right):
    return sorted(path for path in set(left) | set(right) if
                  (left.get(path, {}).get("sha"), left.get(path, {}).get("mode")) !=
                  (right.get(path, {}).get("sha"), right.get(path, {}).get("mode")))


def source_identity(api, commit, path):
    data = api.source(commit, path)
    return data, {"path": path, "gitBlob": git_blob(data), "sha256": digest(data), "bytes": len(data)}


def verified_blob(api, identity, label):
    require(type(identity) is dict and set(identity) == {"gitBlob", "sha256", "bytes"} and
            type(identity["gitBlob"]) is str and re.fullmatch(r"[0-9a-f]{40}", identity["gitBlob"]) and
            type(identity["sha256"]) is str and re.fullmatch(r"[0-9a-f]{64}", identity["sha256"]) and
            type(identity["bytes"]) is int and identity["bytes"] > 0, "Invalid immutable source identity")
    raw = api.json("/git/blobs/" + identity["gitBlob"], label)
    same(raw.get("sha"), identity["gitBlob"], "Immutable blob identity")
    same(raw.get("encoding"), "base64", "Immutable blob encoding")
    data = base64.b64decode("".join(raw["content"].split()), validate=True)
    same(len(data), raw["size"], "Immutable blob API size")
    same({"gitBlob": git_blob(data), "bytes": len(data), "sha256": digest(data)}, identity,
         "Complete immutable blob bytes")
    return data


def load_pure_module(name, data, expected_sha256, directory, filename=None):
    same(digest(data), expected_sha256, "Pinned pure module " + name)
    target = directory / (filename if filename is not None else name + ".py")
    target.write_bytes(data)
    spec = importlib.util.spec_from_file_location(name, target)
    require(spec is not None and spec.loader is not None, "Cannot load pinned pure reader " + name)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def load_paired_summary(qualifier):
    same(digest(qualifier), QUALIFIER_SHA256, "Pinned qualifier")
    parsed = ast.parse(qualifier, filename=QUALIFIER)
    definitions = [node for node in parsed.body if isinstance(node, ast.FunctionDef) and node.name == "paired_summary"]
    require(len(definitions) == 1 and not definitions[0].decorator_list, "Missing unique pure paired summary")
    namespace = {"random": random, "statistics": statistics, "observations": []}
    isolated = ast.Module(body=definitions, type_ignores=[])
    # Deliberately compile one verified FunctionDef, never the qualifier module.
    exec(compile(isolated, QUALIFIER + ":paired_summary-only", "exec"), namespace)
    return namespace


def archive_member_digest(source, length, target=None):
    sha256 = hashlib.sha256()
    sha1 = hashlib.sha1(b"blob " + str(length).encode() + b"\0")
    count = 0
    for block in iter(lambda: source.read(1024 * 1024), b""):
        count += len(block)
        require(count <= length, "ZIP member exceeds declared size")
        sha256.update(block)
        sha1.update(block)
        if target is not None:
            target.write(block)
    require(count == length, "Truncated ZIP member")
    return {"bytes": count, "sha256": sha256.hexdigest(), "gitBlob": sha1.hexdigest()}


def unpack_artifact(outer, output):
    """Keep every original member and stream every nested package member once."""
    extracted = output / "extracted"
    extracted.mkdir()
    inventory, packages = [], {}
    allowed = {CELL_DIRECTORY + "/package-" + arm + ".zip": arm for arm in "AB"}
    try:
        with zipfile.ZipFile(outer) as archive:
            for info in inspect_zip(archive):
                target = extracted.joinpath(*Path(info.filename).parts)
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    inventory.append({"path": info.filename, "directory": True, "bytes": 0})
                    continue
                archive_suffix = info.filename.lower().endswith((".zip", ".gz", ".bz2", ".xz", ".tar", ".7z", ".zst"))
                require(not archive_suffix or info.filename in allowed, "Unexpected nested browser archive")
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as source, target.open("xb") as destination:
                    record = archive_member_digest(source, info.file_size, destination)
                inventory.append({"path": info.filename, **record})
                if info.filename in allowed:
                    arm = allowed[info.filename]
                    entries, members = {}, []
                    with zipfile.ZipFile(target) as package:
                        for member in inspect_zip(package):
                            if member.is_dir():
                                members.append({"path": member.filename, "directory": True, "bytes": 0})
                                continue
                            with package.open(member) as stream:
                                checked = archive_member_digest(stream, member.file_size)
                            entries[member.filename] = checked["sha256"]
                            members.append({"path": member.filename, **checked})
                    packages[arm] = {"sha256": record["sha256"], "bytes": record["bytes"],
                                     "entries": entries, "members": members}
        for path in extracted.rglob("*.json"):
            read_json(path)
        for path in extracted.rglob("*.jsonl"):
            for line in path.read_text().splitlines():
                if line:
                    parse_json(line)
        # A preflight failure may legitimately have no packages. That fact remains
        # visible; the cell source gate below requires both before qualifying.
        require(set(packages) <= set("AB"), "Unknown original package arm")
        return extracted, packages, inventory
    finally:
        write_json(output / "outer-member-inventory.json", inventory)
        write_json(output / "package-member-inventories.json", packages)


def verify_sources(api, manifest, output):
    require(sys.flags.optimize == 0, "Trusted memory assertions must remain enabled")
    publication = manifest["publication"]
    study_bytes, identity = source_identity(api, publication["headSha"], manifest["study"]["path"])
    same(identity, manifest["study"], "Exact original tracked study")
    study = parse_json(study_bytes)
    same(study["upstream"], manifest["upstream"], "Study upstream")
    upstream = manifest["upstream"]["commit"]
    for role in ("control", "candidate"):
        same(study[role], manifest["cleanSources"][role], "Independently frozen clean " + role)
    same(study["numericGates"], EXPECTED_NUMERIC_GATES, "Frozen prospective numeric gates")
    same(study["schedule"], {
        "measuredPairs": 24, "controlPairs": 8, "warmupPairs": 2,
        "mediaImports": 2, "memoryImports": 4, "totalReports": 74,
    }, "Complete frozen study schedule")
    same(study["armCountsPerCell"], {"A": 37, "B": 29, "C": 8}, "Study arm counts")
    same(study["expectedPackageEntries"], PACKAGE_ENTRIES, "Study package boundary")
    same(study["sharedControlPaths"], sorted(CONTROL_PATHS), "Shared inert control files")
    require(study["acquisitionEnabled"] is True and study["prerequisites"]["rootPublicationAuthorized"] is True,
            "The published study was not sealed for acquisition")
    for role in ("control", "candidate"):
        require(type(study[role]) is dict and set(study[role]) == {"commit", "tree"},
                "Incomplete immutable " + role + " identity")
        for value in study[role].values():
            require(type(value) is str and re.fullmatch(r"[0-9a-f]{40}", value), "Incomplete source digest")
    trees = {
        "upstream": api.tree(upstream, manifest["upstream"]["tree"]),
        "A": api.tree(study["control"]["commit"], study["control"]["tree"]),
        "B": api.tree(study["candidate"]["commit"], study["candidate"]["tree"]),
        "study": api.tree(publication["headSha"], publication["headTree"]),
    }
    for commit, parent in (
        (study["control"]["commit"], upstream), (study["candidate"]["commit"], upstream),
        (publication["headSha"], study["candidate"]["commit"]),
    ):
        original = api.json("/git/commits/" + commit, "ancestry-" + commit)
        same([item["sha"] for item in original["parents"]], [parent], "Exact source ancestry")
    same(tree_delta(trees["upstream"], trees["B"]), sorted(PRODUCT_PATHS), "Complete clean product source delta")
    same(tree_delta(trees["upstream"], trees["A"]), sorted(CONTROL_PATHS), "Complete inactive control delta")
    require(type(study["productFiles"]) is list and len(study["productFiles"]) == len(PRODUCT_PATHS),
            "Complete reviewed product-file inventory")
    same(sorted(item["path"] for item in study["productFiles"]), sorted(PRODUCT_PATHS), "Product file paths")
    for record in study["productFiles"]:
        path = record["path"]
        data, observed = source_identity(api, study["candidate"]["commit"], path)
        same({**observed, "mode": trees["B"][path]["mode"]}, record, "Complete product bytes " + path)
        same(trees["study"][path], trees["B"][path], "Study inherited exact product entry " + path)
        if path in CONTROL_PATHS:
            same(trees["A"][path], trees["B"][path], "Identical shared control entry " + path)
    extension_maps = {
        arm: {path: entry for path, entry in trees[arm].items() if path.startswith("ext/")}
        for arm in ("A", "B")
    }
    same(set(extension_maps["A"]), set(extension_maps["B"]), "Complete tracked extension member sets")
    same(tree_delta(extension_maps["A"], extension_maps["B"]),
         ["ext/" + path for path in PACKAGE_ENTRIES], "Only store and DB activation differ")
    for path in ("ext/js/dictionary/wasm/term-bank-parser.c",
                 "dev/data/dictionary-wasm/term-bank-parser.wasm"):
        for arm in ("A", "B", "study"):
            same(trees[arm][path], trees["upstream"][path], "Current upstream parser preserved")
    source_bytes, source_identity_record = source_identity(
        api, publication["headSha"], manifest["sourceManifest"]["path"])
    same(source_identity_record, manifest["sourceManifest"], "Exact source-manifest bytes")
    source_manifest = parse_json(source_bytes)
    records = source_manifest["files"]
    require(type(records) is dict and manifest["sourceManifest"]["path"] not in records,
            "Source manifest excludes only its own digest")
    kit_paths = tree_delta(trees["B"], trees["study"])
    same(sorted(records), sorted((set(kit_paths) | PRODUCT_PATHS) - {manifest["sourceManifest"]["path"]}),
         "Every product and isolated producer source is bound")
    require(PRODUCER_WORKFLOW in records and manifest["study"]["path"] in records and
            PRODUCER_PREFIX + "/verify-source.py" in records and
            PRODUCER_PREFIX + "/audit-activation.py" in records,
            "Missing original producer guard/workflow/activation sources")
    require(all(path == PRODUCER_WORKFLOW or path.startswith(PRODUCER_PREFIX + "/") for path in kit_paths),
            "Study changes source outside its isolated kit")
    checked_sources = {}
    for path, record in sorted(records.items()):
        data, observed = source_identity(api, publication["headSha"], path)
        require(trees["study"][path]["mode"] in ("100644", "100755"), "Nonregular producer source")
        same({key: observed[key] for key in ("gitBlob", "bytes", "sha256")} |
             {"mode": trees["study"][path]["mode"]}, record, "Producer source bytes " + path)
        checked_sources[path] = observed
    aggregate = digest("".join(path + "\0" + records[path]["sha256"] + "\n" for path in sorted(records)).encode())
    same(source_manifest["digest"], aggregate, "Complete producer source aggregate")
    checked_sources[manifest["sourceManifest"]["path"]] = source_identity_record
    protected = set(PROVENANCE_PATHS) - {"builds/manabitan-chrome-dev.zip", "builds/manabitan-chrome.zip"}
    protected |= {QUALIFIER, ".github/actions/setup/action.yml", "package.json", "dev/perf/prepare-dictionaries.js"}
    protected |= {MEMORY_DIRECTORY + "/" + name + ".py" for name in MODULE_HASHES}
    for path in protected:
        for arm in ("A", "B", "study"):
            same(trees[arm][path], trees["upstream"][path], "Protected original source " + path)
    trusted = output / "trusted-modules"
    trusted.mkdir()
    modules = {}
    for name, expected in MODULE_HASHES.items():
        modules[name] = load_pure_module(name, api.source(upstream, MEMORY_DIRECTORY + "/" + name + ".py"),
                                         expected, trusted)
    require(errno.ENOENT == 2 and errno.ESRCH == 3, "Recorded Linux gone-process errno mapping differs")
    qualifier = api.source(upstream, QUALIFIER)
    namespace = load_paired_summary(qualifier)
    activation_data = api.source(publication["headSha"], PRODUCER_PREFIX + "/audit-activation.py")
    activation = load_pure_module("fields_activation", activation_data, ACTIVATION_SHA256, trusted)
    fixtures = parse_json(api.source(upstream, "test/perf/dictionaries.lock.json"))["dictionaries"]
    for dictionary in ("jmdict", "jitendex", "vndb"):
        activation.validate_policy(study, dictionary, fixtures)
    original_repository = output / "trusted-original-repository"
    original_repository.mkdir()
    for path in protected:
        target = original_repository / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(api.source(upstream, path))
    write_json(output / "verified-original-source.json", {
        "publication": publication, "upstream": study["upstream"], "control": study["control"],
        "candidate": study["candidate"], "kitPaths": kit_paths, "sources": checked_sources,
        "productFiles": study["productFiles"], "protectedPaths": sorted(protected),
        "producerAggregate": aggregate, "packageEntries": PACKAGE_ENTRIES,
    })
    write_json(output / "trusted-module-bindings.json", {
        "modules": MODULE_HASHES, "qualifierSha256": QUALIFIER_SHA256,
        "activationSha256": ACTIVATION_SHA256,
        "qualifierExecutionScope": "Only the isolated paired_summary FunctionDef; no module top-level execution",
    })
    return {
        "study": study, "trees": trees, "modules": modules, "namespace": namespace, "fixtures": fixtures,
        "activation": activation, "originalRepository": original_repository,
        "sources": checked_sources, "sourceDigest": aggregate, "kitPaths": kit_paths,
        "studyBytes": study_bytes, "activationBytes": activation_data,
    }


def verify_packages(root, packages, api, trees, study):
    same(set(packages), set("AB"), "Complete original runtime packages")
    identities = read_json(root / "source-identities.json")
    same(set(identities["arms"]), {"A", "B"}, "Source arms")
    same(identities["controlC"], "Same A source, package, runtime, and flags under a distinct observation label",
         "Identical C control source")
    for arm, source_name in (("A", "control"), ("B", "candidate")):
        source = study[source_name]
        identity = identities["arms"][arm]
        same(identity["sha"], source["commit"], "Original clean arm source")
        same(identity["tree"], source["tree"], "Original clean arm tree")
        same(identity["entries"], packages[arm]["entries"], "Complete nested package hashes")
        same(identity["packageSha256"], packages[arm]["sha256"], "Original package SHA")
        same(set(identity["sourceHashes"]), set(PROVENANCE_PATHS), "Provenance path inventory")
        for path in PROVENANCE_PATHS:
            value = identity["sourceHashes"][path]
            if path == "builds/manabitan-chrome.zip":
                same(value, packages[arm]["sha256"], "Reported original package hash")
            elif path == "builds/manabitan-chrome-dev.zip":
                require(value is None or (type(value) is str and re.fullmatch(r"[0-9a-f]{64}", value)),
                        "Invalid optional development package provenance")
            else:
                same(value, digest(api.source(source["commit"], path)), "Original report source " + path)
        same(identity["lockSha256"], digest(api.source(source["commit"], "package-lock.json")), "Dependency lock")
        same(identity["fixtureLockSha256"], digest(api.source(source["commit"], "test/perf/dictionaries.lock.json")), "Fixture lock")
        matches, generated = [], []
        for member in packages[arm]["members"]:
            if member.get("directory"):
                continue
            path = "ext/" + member["path"]
            if path in trees[arm]:
                require(trees[arm][path]["mode"] in ("100644", "100755"), "Nonregular packaged source")
                same(member["gitBlob"], trees[arm][path]["sha"], "Actual tracked package source " + path)
                matches.append(path)
            else:
                generated.append(member["path"])
        packages[arm]["trackedSourceMatches"] = matches
        packages[arm]["generatedOrDependencyEntries"] = generated
        native = parse_json(api.source(source["commit"], "dev/data/dictionary-wasm/manifest.json"))
        same([target["name"] for target in native["targets"]],
             ["term-content-canonical-scan-v1.wasm", "term-bank-parser.wasm", "term-record-fields.wasm"],
             "Complete packaged native target inventory")
        for target in native["targets"]:
            tracked = api.source(source["commit"], "dev/data/dictionary-wasm/" + target["name"])
            same(digest(tracked), target["sha256"], "Pinned generated native artifact")
            same(packages[arm]["entries"]["lib/" + target["name"]], target["sha256"],
                 "Actual packaged native artifact " + target["name"])
    same(set(packages["A"]["entries"]), set(packages["B"]["entries"]), "Equal packaged member sets")
    changed = sorted(path for path in packages["A"]["entries"]
                     if packages["A"]["entries"][path] != packages["B"]["entries"][path])
    same(changed, PACKAGE_ENTRIES, "Exact two-entry package delta")
    same(sorted(identities["changedPackageEntries"]), changed, "Declared package delta")
    for path, expected in study["runtimeSha256"].items():
        entry = path.removeprefix("ext/")
        same(packages["B"]["entries"][entry], expected, "Actual candidate field runtime " + entry)
        if entry not in PACKAGE_ENTRIES:
            same(packages["A"]["entries"][entry], expected, "Identical inactive helper asset " + entry)
    return identities


def prerequisite_metadata(api, proof, label):
    """Independently reconstruct the metadata-only guard receipt for a sealed proof."""
    run_id, job_id = proof["runId"], proof["jobId"]
    require(type(run_id) is int and run_id > 0 and type(job_id) is int and job_id > 0,
            "Invalid prerequisite API identity")
    same(proof["attempt"], 1, "Original prerequisite attempt")
    run = api.json("/actions/runs/" + str(run_id), "prerequisite-run-" + str(run_id))
    job = api.json("/actions/jobs/" + str(job_id), "prerequisite-job-" + str(job_id))
    for key, expected in (
        ("id", run_id), ("run_attempt", 1), ("head_sha", proof["headSha"]), ("status", "completed"),
    ):
        same(run.get(key), expected, label + " original run " + key)
    for key, expected in (
        ("id", job_id), ("run_id", run_id), ("run_attempt", 1), ("head_sha", proof["headSha"]),
        ("status", "completed"), ("conclusion", "success"),
    ):
        same(job.get(key), expected, label + " original job " + key)
    artifact = proof["artifact"]
    metadata = api.json("/actions/artifacts/" + str(artifact["id"]), "prerequisite-artifact-" + str(artifact["id"]))
    for key, expected in (
        ("id", artifact["id"]), ("name", artifact["name"]), ("size_in_bytes", artifact["bytes"]),
        ("digest", "sha256:" + artifact["sha256"]), ("expired", False),
    ):
        same(metadata.get(key), expected, label + " original artifact " + key)
    same(metadata["workflow_run"]["id"], run_id, label + " artifact run")
    same(metadata["workflow_run"]["head_sha"], proof["headSha"], label + " artifact source")
    return {
        "run": run_id, "job": job_id, "head": proof["headSha"], "attempt": 1,
        "jobConclusion": job["conclusion"], "runConclusion": run["conclusion"],
        "artifact": artifact, "steps": job.get("steps", []),
        "scope": "Original metadata plus previously sealed records audit; no archive or product is executed here.",
    }


def verify_metadata(extracted, job, cell, api, context, manifest):
    study, trees = context["study"], context["trees"]
    publication = manifest["publication"]
    metadata_root = extracted / METADATA_DIRECTORY
    # Every uploaded study source is checked against the independently retrieved
    # immutable Git bytes. Additional original logs and partial evidence remain.
    source_entries = {}
    for path in context["sources"]:
        data = api.source(publication["headSha"], path)
        if path == PRODUCER_WORKFLOW or path.startswith(PRODUCER_PREFIX + "/"):
            target = extracted / path
            require(target.is_file(), "Missing original uploaded study source " + path)
            require(target.read_bytes() == data, "Original uploaded study source bytes differ: " + path)
        source_entries[path] = {
            "gitBlob": git_blob(data), "mode": trees["study"][path]["mode"],
            "sha256": digest(data), "bytes": len(data),
        }
    protected = {}
    for path, entry in trees["upstream"].items():
        if path in PRODUCT_PATHS:
            continue
        if path.startswith(("dev/perf/", "test/e2e/", "test/chromium/")) or path in (
            "package.json", "package-lock.json", ".github/actions/setup/action.yml",
            "test/perf/dictionaries.lock.json", "dev/bin/build-dictionary-wasm.js",
            "dev/data/dictionary-wasm/term-bank-parser.wasm",
            "dev/data/dictionary-wasm/term-content-canonical-scan-v1.wasm",
        ):
            for arm in ("A", "B", "study"):
                same(trees[arm][path], entry, "Complete protected baseline tree entry " + path)
            data = api.source(context["study"]["upstream"]["commit"], path)
            protected[path] = {
                "gitBlob": git_blob(data), "mode": entry["mode"], "sha256": digest(data), "bytes": len(data),
            }
    prerequisites = study["prerequisites"]
    expected_prerequisites = {
        name: prerequisite_metadata(api, prerequisites[name], name)
        for name in ("component", "validation", "corpus", "productionEvidenceAudit")
    }
    expected_prerequisites["componentRecordsAudit"] = prerequisite_metadata(
        api, prerequisites["component"]["recordsAudit"], "component records audit")
    native = parse_json(api.source(study["candidate"]["commit"], "dev/data/dictionary-wasm/manifest.json"))
    generated_assets = {}
    for target in native["targets"]:
        data = api.source(study["candidate"]["commit"], "dev/data/dictionary-wasm/" + target["name"])
        generated_assets["ext/lib/" + target["name"]] = {"bytes": len(data), "sha256": digest(data)}
    original_legal = digest(api.source(publication["headSha"], "ext/legal-npm.html"))
    proofs = {}
    for filename, phase in (("source-before-setup.json", "launch"), ("source-after-setup.json", "generated")):
        proof = read_json(metadata_root / filename)
        common = {
            "schemaVersion": 1, "passed": True, "phase": phase, "studyHead": publication["headSha"],
            "studyTree": publication["headTree"],
            "sourceManifest": source_entries[manifest["sourceManifest"]["path"]],
            "sourceDigest": context["sourceDigest"],
            "upstream": study["upstream"], "candidate": study["candidate"], "control": study["control"],
            "sources": source_entries, "protected": protected,
            "generatedAssets": generated_assets if phase == "generated" else {},
            "treeBoundaries": {
                "productPaths": sorted(PRODUCT_PATHS), "controlPaths": sorted(CONTROL_PATHS),
                "studyPaths": context["kitPaths"],
                "trackedRuntimeDelta": ["ext/" + path for path in PACKAGE_ENTRIES],
            },
            "runtimeSha256": study["runtimeSha256"], "schedule": study["schedule"],
            "numericGates": study["numericGates"], "prerequisiteMetadata": expected_prerequisites,
            "acquisitionEnabled": True, "timingAcquired": False, "productExecuted": False,
        }
        documents = proof.get("setupGeneratedDocuments")
        require(type(documents) is dict, "Missing setup document receipt")
        if phase == "launch":
            same(documents, {}, "Pre-setup source is exactly clean")
        else:
            require(set(documents) <= {"ext/legal-npm.html"}, "Unexpected root setup document delta")
            for document in documents.values():
                require(set(document) == {"sha256", "committedSha256"} and
                        re.fullmatch(r"[0-9a-f]{64}", document["sha256"]) is not None,
                        "Incomplete setup document identity")
                same(document["committedSha256"], original_legal, "Root setup document original bytes")
        same(proof, {**common, "setupGeneratedDocuments": documents}, "Entire original source guard " + phase)
        proofs[phase] = {"bytes": (metadata_root / filename).stat().st_size, "sha256": file_digest(metadata_root / filename)}
    outcome = read_json(metadata_root / "step-outcomes.json")
    same(outcome["required"], list(REQUIRED_CELL_STEPS), "All original cell gates")
    same(outcome["runAttempt"], "1", "Original step outcome attempt")
    dictionary, initial = CELLS[cell["kind"]]
    same((outcome["dictionary"], outcome["initialOrder"]), (dictionary, initial), "Original step outcome role")
    same(outcome["numericQualificationDecided"], False, "Producer did not replace independent numeric gate")
    original_steps = {step["name"]: step for step in job["steps"]}
    require(len(original_steps) == len(job["steps"]), "Duplicate original job step name")
    failed = []
    for key, name in REQUIRED_CELL_STEPS.items():
        require(name in original_steps and key in outcome["steps"], "Missing original cell gate " + key)
        step = original_steps[name]
        recorded = outcome["steps"][key]
        same(step["status"], "completed", "Original cell gate did not finish")
        same(recorded["conclusion"], step["conclusion"], "Original recorded step conclusion")
        # The producer has no continue-on-error acquisition step. Its outcome and
        # conclusion therefore agree, including failure, cancellation or skipped.
        same(recorded["outcome"], step["conclusion"], "Original recorded step outcome")
        if recorded["outcome"] != "success":
            failed.append(key)
    same(outcome["failed"], failed, "Complete original failed-step list")
    same(outcome["cellComplete"], not failed, "Original cell completion gate")
    return {
        "sourceProofs": proofs, "stepOutcomesSha256": file_digest(metadata_root / "step-outcomes.json"),
        "allRequiredStepsSucceeded": not failed, "originalFailedSteps": failed,
        "prerequisiteMetadata": expected_prerequisites,
    }


def corpus_comparisons_by_dictionary(comparisons):
    require(type(comparisons) is list, "Original corpus comparisons must be a list")
    same(sorted(item["dictionary"] for item in comparisons), sorted(("jmdict", "jitendex", "vndb")),
         "Complete independently verified corpus comparisons for startup budgets")
    return {item["dictionary"]: item for item in comparisons}


def derive_readiness_budget(comparison, fixture, activation):
    """Use the first complete original source group as the frozen startup allowance."""
    require(comparison.get("passed") is True, "Readiness budget lacks a passing original corpus")
    plan = comparison["sourceGroupFieldPlan"]
    groups = plan["groups"]
    require(type(groups) is list and groups and len(groups) == plan["groupCount"],
            "Readiness budget lacks the complete original source-group plan")
    same(digest(json.dumps(plan, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()),
         comparison["sourceGroupFieldPlanSha256"], "Original source-group plan identity")
    total_calls, total_rows = plan["fieldCallCount"], plan["termRows"]
    require(type(total_calls) is int and total_calls > 1 and type(total_rows) is int and total_rows > 1,
            "Invalid complete corpus coverage")
    same(total_calls, comparison["fieldCalls"], "Original source-group encoder-call total")
    same(total_rows, fixture["termRows"], "Original source-group row total")
    same(sum(item["rowCount"] for item in groups), total_rows, "Every source-group row")
    first = groups[0]
    same(first["firstBank"], 1, "Readiness budget must use the first source group")
    call_rows = first["fieldCallRows"]
    require(type(call_rows) is list and call_rows and all(type(value) is int and value > 0 for value in call_rows),
            "Invalid first source-group field rows")
    startup_calls, startup_rows = len(call_rows), sum(call_rows)
    same(first["fieldCallOrdinals"], list(range(startup_calls)), "Complete first-group field-call prefix")
    same(first["rowCount"], startup_rows, "Complete first-group row allowance")
    require(startup_calls < total_calls and startup_rows < total_rows,
            "Readiness allowance cannot admit zero native work")
    return {
        "fixtureSha256": fixture["sha256"], "termRows": total_rows, "expectedCalls": total_calls,
        "minimumNativeCalls": total_calls - startup_calls, "minimumNativeRows": total_rows - startup_rows,
        "maximumReadinessJavascriptCalls": startup_calls,
        "allowedDeclineMaximums": {reason: 0 for reason in activation.ALLOWED_DECLINES},
    }


def load_correctness_reader(reader_bytes, reader_identity, activation_bytes, trusted):
    """Retain the reviewed standalone reader's exact three neighboring files."""
    trusted.mkdir()
    if "transport" in sys.modules:
        require(sys.modules["transport"] is sys.modules["audit_transport"], "Conflicting transport module")
    else:
        sys.modules["transport"] = sys.modules["audit_transport"]
    # The standalone reader hashes these exact filenames using its __file__.
    dependencies = (
        ("transport.py", Path(__file__).with_name("audit_transport.py").read_bytes(), TRANSPORT_SHA256),
        ("field_activation.py", activation_bytes, ACTIVATION_SHA256),
    )
    for filename, data, expected_sha256 in dependencies:
        same(digest(data), expected_sha256, "Exact correctness reader dependency " + filename)
        (trusted / filename).write_bytes(data)
    return load_pure_module("fields_correctness_records", reader_bytes, reader_identity["sha256"],
                            trusted, filename="audit.py")


def verify_prerequisites(api, manifest, context, output):
    """Reinspect original prerequisite records without executing any product."""
    study = context["study"]
    component = verify_component_prerequisite(api, output / "component-prerequisite")
    definition = manifest["correctnessPrerequisite"]
    require(set(definition) == {"reader", "manifest"}, "Unexpected correctness reader binding")
    reader_identity = definition["reader"]
    require(type(reader_identity) is dict and set(reader_identity) == {"gitBlob", "sha256", "bytes"},
            "Missing exact independently reviewed correctness reader source")
    reader_bytes = verified_blob(api, reader_identity, "correctness-reader-source")
    reader = load_correctness_reader(reader_bytes, reader_identity, context["activationBytes"],
                                     output / "trusted-correctness-reader")
    require(callable(getattr(reader, "audit_correctness", None)), "Missing pure correctness audit entry point")
    # Let that reader own a separate API instance/output namespace. This prevents
    # its original-run labels from overwriting this browser audit's API evidence.
    result = reader.audit_correctness(definition["manifest"], output / "correctness-prerequisite")
    write_json(output / "correctness-prerequisite-result.json", result)
    require(result.get("auditCompleted") is True and result.get("correctnessPassed") is True,
            "Original production correctness reader did not finish successfully")
    proof = result.get("browserPrerequisite")
    require(type(proof) is dict and proof.get("passed") is True,
            "Original production correctness/corpus evidence did not pass completely")
    same(proof["product"], study["candidate"], "Correctness proof belongs to the exact clean product")
    same(proof["runtimeSha256"], study["runtimeSha256"], "Correctness proof runtime bytes differ")
    prerequisites = study["prerequisites"]
    for role in ("validation", "corpus"):
        expected, observed = prerequisites[role], proof[role]
        require(expected["sealed"] is True and expected["passed"] is True, "Incomplete sealed " + role)
        for key in ("runId", "attempt", "jobId", "headSha", "receiptSha256"):
            same(observed[key], expected[key], "Independently audited original " + role + " " + key)
        artifact = observed["artifact"]
        same({"id": artifact["id"], "name": artifact["name"], "bytes": artifact["sizeBytes"],
              "sha256": artifact["sha256"]}, expected["artifact"], "Audited original " + role + " archive")
        same(expected["productCommit"], study["candidate"]["commit"], "Sealed correctness product")
    same(set(proof["perCorpus"]), {"jmdict", "jitendex", "vndb"}, "Every original correctness corpus")
    corpus = proof["corpus"]
    comparisons = corpus_comparisons_by_dictionary(result["corpus"]["comparisons"])
    readiness_budgets = {}
    for dictionary in ("jmdict", "jitendex", "vndb"):
        observed = proof["perCorpus"][dictionary]
        sealed_policy = study["activation"]["perCorpus"][dictionary]
        comparison = comparisons[dictionary]
        budget = derive_readiness_budget(comparison, context["fixtures"][dictionary], context["activation"])
        same({key: value for key, value in sealed_policy.items() if key != "proof"}, budget,
             "Sealed first-source-group startup budget for " + dictionary)
        readiness_budgets[dictionary] = {
            "policy": budget, "sourceGroupFieldPlanSha256": comparison["sourceGroupFieldPlanSha256"],
            "scope": "Prospective engineering coverage allowance, not a source-guaranteed readiness deadline.",
        }
        expected = sealed_policy["proof"]
        same(expected, {
            "runId": corpus["runId"], "attempt": corpus["attempt"], "headSha": corpus["headSha"],
            "artifactId": corpus["artifact"]["id"], "artifactSha256": corpus["artifact"]["sha256"],
            "comparisonSha256": observed["comparisonSha256"],
            "candidateReportSha256": observed["candidateReportSha256"],
            "fieldCallsSha256": observed["fieldCallsSha256"],
            "completeTermByteParity": observed["completeTermByteParity"], "runtimeSha256": proof["runtimeSha256"],
        }, "Sealed activation provenance equals original audited " + dictionary + " bytes")
        require(observed["completeTermByteParity"] is True, "Incomplete original field/final-term parity")
    return {
        "passed": True, "component": component, "productionCorrectness": result,
        "correctnessReader": reader_identity, "independentlyDerivedReadinessBudgets": readiness_budgets,
        "scope": "Independent inspection of original prerequisite records only; no reimport, replay timing, helper readiness wait or runtime execution.",
    }


def audit_recorded_memory(memory_root, modules, dictionary, replication, semantic_failures):
    same(read_json(memory_root / "semantic-failures.json"), semantic_failures,
         "Independently reproduced original memory semantic failures")
    memory_observations = read_json(memory_root / "observations.json")
    protocol = modules["protocol"]
    comparison = protocol.memory_comparison(memory_observations, dictionary, replication, protocol.schedule)
    same(comparison, read_json(memory_root / "memory-comparison.json"), "Independently recomputed memory comparison")
    audited_memory = None
    audit_error = None
    try:
        audited_memory = modules["audit_memory"].audit_cell(memory_root)
    except Exception as error:
        audit_error = {"type": type(error).__name__, "message": str(error)}
    if audit_error is None:
        require(not (memory_root / "memory-audit-failure.json").exists(), "Unexpected original memory audit failure")
        same(audited_memory, read_json(memory_root / "memory-audit.json"), "Original raw-memory audit")
    else:
        require(not (memory_root / "memory-audit.json").exists(), "Conflicting original memory audit receipts")
        same(audit_error, read_json(memory_root / "memory-audit-failure.json"), "Exact original memory audit failure")
    return {
        "observations": memory_observations, "comparison": comparison,
        "audit": audited_memory, "auditFailure": audit_error,
        "semanticFailures": semantic_failures,
        "passed": bool(comparison["passesProspectiveMemoryScreen"] and not semantic_failures and audit_error is None),
    }


def audit_browser(extracted, packages, cell, job, api, context, manifest, output, prerequisites_passed):
    dictionary, initial = CELLS[cell["kind"]]
    study, modules = context["study"], context["modules"]
    root = extracted / CELL_DIRECTORY
    metadata_root = extracted / METADATA_DIRECTORY
    metadata = verify_metadata(extracted, job, cell, api, context, manifest)
    identities = verify_packages(root, packages, api, context["trees"], study)
    write_json(output / "package-source-binding.json", packages)
    sequence = frozen_schedule(initial)
    protocol = modules["protocol"]
    replication = 1 if initial == "AB" else 2
    memory_schedule = protocol.schedule(replication)
    allocation = {"unitBytes": 4096, "rangeUnits": [37, 37], "origin": "explicit"} if dictionary == "vndb" else None
    expected_plan = {
        "baseline": study["control"]["commit"], "candidate": study["candidate"]["commit"], "dictionary": dictionary,
        "initialOrder": initial, "pairs": 24, "flags": {}, "schedule": sequence,
        "mediaCheck": "sample per timed observation; separate all-media verification after timing",
        "failurePolicy": "Stop on first failed observation; retain all completed and failed evidence",
        "memoryPolicy": "Separate instrumented A/B observations after all timing and media verification",
        "sourceBoundary": "Each revision built independently before timing; no product or harness overlays",
        "expectedPackageEntries": PACKAGE_ENTRIES, "expectedWorkers": None,
        "vndbSahAllocationPolicy": allocation, "memorySchedule": memory_schedule,
        "statistics": "Per-host paired median and equal-work ratios; descriptive percentile bootstrap interval of paired median, 10000 complete-pair resamples, seed 897. No pooling hosts or timing from instrumented runs.",
    }
    same(read_json(root / "registered-plan.json"), expected_plan, "Entire original frozen plan")
    original_harness = api.source(study["upstream"]["commit"], HARNESS).decode()
    instrumented_harness = protocol.memory_overlay(original_harness)
    memory_root = root / "memory"
    integrity_failures = []
    observation_failures = []
    browser = read_json(root / "browser-identity.json")
    require(type(browser["sha256"]) is str and re.fullmatch(r"[0-9a-f]{64}", browser["sha256"]), "Invalid original browser hash")
    require(type(browser["version"]) is str and re.fullmatch(r"\d+\.\d+\.\d+\.\d+", browser["version"]),
            "Invalid original browser version")
    require(browser["version"] in browser["versionOutput"], "Original browser version output differs")
    rows = [(item["id"], item["arm"], "sample", False, item) for item in sequence]
    rows += [("exhaustive-media-" + arm, arm, "all", False, None) for arm in initial]
    rows += [("memory/" + item["name"], item["arm"], "sample", True, None) for item in memory_schedule]
    expected_locations = [row[0] for row in rows]
    inventory = {}
    for filename in ("summary.json", "run-1.json"):
        actual = sorted(str(path.parent.relative_to(root)) for path in root.rglob(filename))
        missing = sorted(set(expected_locations) - set(actual))
        unexpected = sorted(set(actual) - set(expected_locations))
        inventory[filename] = {"actual": actual, "missing": missing, "unexpected": unexpected}
        if missing or unexpected or len(actual) != 74:
            integrity_failures.append({"stage": "original-report-inventory", "filename": filename,
                                       "missing": missing, "unexpected": unexpected, "actualCount": len(actual)})
    write_json(output / "complete-report-inventory.json", inventory)
    receipts = modules["qualification_receipts"]
    reference, media_reference = None, None
    details, reconstructed, semantic_failures, canonical_locations = [], [], [], []
    for location, label, media_mode, is_memory, scheduled in rows:
        role = scheduled["kind"] if scheduled is not None else ("memory" if is_memory else "full-media")
        row = {
            "path": location, "arm": label, "role": role, "order": len(details) + 1,
            "pair": scheduled["pair"] if scheduled is not None else None,
            "mediaCheck": media_mode, "memory": is_memory, "includedInContrasts": False,
            "recordedTotalImportMs": None, "semanticPassed": False, "failures": [],
            "timingUse": ("Separate instrumented memory; excluded from contrasts" if is_memory else
                          "Separate full-media verification; excluded from contrasts" if media_mode == "all" else
                          "Original warmup; excluded from contrasts" if role == "warmup" else
                          "Original uninstrumented paired observation, eligible only after complete source/semantic checks"),
        }
        folder = root / location
        summary = report = None
        for filename, key in (("summary.json", "summarySha256"), ("run-1.json", "rawReportSha256")):
            try:
                value = read_json(folder / filename)
                row[key] = file_digest(folder / filename)
                if filename == "summary.json":
                    summary = value
                else:
                    report = value
            except Exception as error:
                row["failures"].append({"stage": "original-report-read", "filename": filename,
                                        "type": type(error).__name__, "error": str(error)})
        duration = None
        if summary is not None:
            try:
                duration = summary["runs"][0]["totalImportMs"]
                require(type(duration) in (int, float) and math.isfinite(duration) and duration > 0,
                        "Invalid original complete-import duration")
                row["recordedTotalImportMs"] = duration
            except Exception as error:
                row["failures"].append({"stage": "original-duration", "type": type(error).__name__, "error": str(error)})
        if summary is not None and report is not None:
            arm = "B" if label == "B" else "A"
            identity = identities["arms"][arm]
            source_hashes = identity["sourceHashes"].copy()
            if is_memory:
                source_hashes[HARNESS] = digest(instrumented_harness.encode())
            receipt = None
            semantic_error = None
            try:
                receipt = receipts.validate_import_summary(
                    summary, report, dictionary=dictionary, fixture=context["fixtures"][dictionary],
                    source_sha=identity["sha"], package_sha256=identity["packageSha256"],
                    browser_version=browser["version"], import_flags=None, source_hashes=source_hashes,
                    source_dirty=is_memory, media_check=media_mode,
                    vndb_sah_allocation_units=[37, 37] if dictionary == "vndb" else None,
                )
            except Exception as error:
                semantic_error = str(error)
            if receipt is not None:
                try:
                    same(receipt, read_json(folder / "canonical-receipt.json"), "Original canonical receipt " + location)
                    row["canonicalReceiptSha256"] = file_digest(folder / "canonical-receipt.json")
                    canonical_locations.append(location)
                except Exception as error:
                    row["failures"].append({"stage": "canonical-integrity", "type": type(error).__name__, "error": str(error)})
                try:
                    if reference is None:
                        reference = receipt
                    else:
                        receipts.require_matching_receipts(reference, receipt, compare_media=media_mode != "all")
                    if media_mode == "all":
                        if media_reference is None:
                            media_reference = receipt
                        else:
                            receipts.require_matching_receipts(media_reference, receipt)
                except Exception as error:
                    semantic_error = str(error)
            row["semanticFailure"] = semantic_error
            row["semanticPassed"] = semantic_error is None and receipt is not None and not row["failures"]
            if semantic_error is not None:
                row["failures"].append({"stage": "original-semantics", "error": semantic_error})
                if is_memory:
                    semantic_failures.append({"name": folder.name, "error": semantic_error})
            if scheduled is not None and row["semanticPassed"] and duration is not None:
                reconstructed.append({**scheduled, "totalImportMs": duration})
                row["includedInContrasts"] = role in ("candidate", "control")
        row["passed"] = not row["failures"]
        if row["failures"]:
            observation_failures.append({"path": location, "failures": row["failures"]})
        details.append(row)
        write_json(output / "validated-observations.json", details)
    actual_canonical = sorted(str(path.parent.relative_to(root)) for path in root.rglob("canonical-receipt.json"))
    if actual_canonical != sorted(canonical_locations):
        integrity_failures.append({"stage": "canonical-inventory", "actual": actual_canonical,
                                   "validated": sorted(canonical_locations)})
    try:
        recorded = read_json(root / "observations.json")
        same(recorded, reconstructed, "Every original accepted duration and acquisition order")
        same([{key: item[key] for key in ("id", "kind", "pair", "arm")} for item in recorded],
             sequence[:len(recorded)], "Accepted originals form the exact unmodified schedule prefix")
    except Exception as error:
        integrity_failures.append({"stage": "original-observations", "type": type(error).__name__, "error": str(error)})
    candidate = controls = None
    contrast_failures = []
    namespace = context["namespace"]
    namespace["observations"] = reconstructed
    for kind, right, label in (("candidate", "B", "candidateVsBaseline"), ("control", "C", "identicalCodeControl")):
        try:
            independent = independent_contrast(reconstructed, kind, "A", right)
            same(namespace["paired_summary"](kind, "A", right), independent, "Unchanged and independent " + label)
            if kind == "candidate":
                candidate = independent
            else:
                controls = independent
        except Exception as error:
            contrast_failures.append({"contrast": label, "type": type(error).__name__, "error": str(error)})
    memory_result = None
    try:
        same((memory_root / "harness-original.js").read_text(), original_harness, "Original memory harness")
        same((memory_root / "harness-instrumented.js").read_text(), instrumented_harness, "Exact unchanged memory marker overlay")
        same(read_json(memory_root / "plan.json"), {
            "schedule": memory_schedule, "replication": replication, "dictionary": dictionary,
            "authoritativeTiming": False, "sourceHashes": identities["arms"],
            "overlaySha256": digest(instrumented_harness.encode()),
        }, "Entire original memory plan")
        memory_result = audit_recorded_memory(memory_root, modules, dictionary, replication, semantic_failures)
    except Exception as error:
        integrity_failures.append({"stage": "original-memory-evidence", "type": type(error).__name__, "error": str(error)})
    memory_passed = memory_result is not None and memory_result["passed"]
    if candidate is not None and controls is not None and memory_result is not None:
        expected_analysis = {
            "status": "correctness-memory-passed" if memory_passed else "memory-or-semantics-failed",
            "candidateVsBaseline": candidate, "identicalCodeControl": controls, "memoryPassed": memory_passed,
            "timingInterpretation": "Descriptive paired comparison only. A passing correctness/memory status is not a latency or speedup claim.",
            "timingScope": "File input change through post-UI completion; fresh profile per observation",
            "limits": "One host/cohort only; independent opposite-order replication required. Memory observations remain separate.",
        }
        try:
            same(read_json(root / "analysis.json"), expected_analysis, "Entire original descriptive analysis")
        except Exception as error:
            integrity_failures.append({"stage": "original-analysis", "type": type(error).__name__, "error": str(error)})
    activation = context["activation"]
    try:
        activation_result = activation.audit(study, root, dictionary, initial, context["originalRepository"], modules)
    except Exception as error:
        activation_result = {
            "schemaVersion": 1, "passed": False, "observations": [],
            "failure": {"type": type(error).__name__, "error": str(error)},
            "scope": "No acquisition; disabled/unsealed or incomplete original evidence fails closed",
        }
    activation_result["studyFile"] = {"bytes": len(context["studyBytes"]), "sha256": digest(context["studyBytes"])}
    activation_result["checkerFile"] = {"bytes": len(context["activationBytes"]), "sha256": digest(context["activationBytes"])}
    try:
        same(read_json(metadata_root / "activation.json"), activation_result, "Every original activation row and failure")
    except Exception as error:
        integrity_failures.append({"stage": "original-activation-receipt", "type": type(error).__name__, "error": str(error)})
    write_json(output / "recomputed-activation.json", activation_result)
    activation_by_path = {item["path"]: item for item in activation_result["observations"]}
    for row in details:
        item = activation_by_path.get(row["path"])
        row["activationAudit"] = item
    write_json(output / "validated-observations.json", details)
    semantics_passed = len(details) == 74 and all(row["semanticPassed"] for row in details)
    complete = (not integrity_failures and not contrast_failures and len(reconstructed) == 68 and
                candidate is not None and controls is not None and memory_result is not None)
    qualification = cell_qualification(
        dictionary, candidate, controls, prerequisites_passed, memory_passed,
        semantics_passed and complete, activation_result["passed"],
        cell["expectedConclusion"] == "success" and metadata["allRequiredStepsSucceeded"],
    )
    result = {
        "evidenceValidated": complete, "dictionary": dictionary, "initialOrder": initial,
        "originalArtifactId": cell["id"], "originalJobId": cell["jobId"],
        "originalJobConclusion": cell["expectedConclusion"], "metadata": metadata,
        "reportsExpected": 74, "reportRowsRetained": len(details),
        "semanticReceiptsPassed": sum(row["semanticPassed"] for row in details),
        "allOriginalObservations": details, "acceptedTimingObservations": reconstructed,
        "candidateVsBaseline": candidate, "identicalCodeControl": controls,
        "contrastFailures": contrast_failures, "integrityFailures": integrity_failures,
        "observationFailures": observation_failures, "activation": activation_result,
        "memory": {key: value for key, value in memory_result.items() if key != "observations"} if memory_result is not None else None,
        "memoryScanSummary": [{
            "name": item["name"], "arm": item["arm"], "pair": item["pair"],
            "allObservedSampleCount": item["allObservedSampleCount"],
            "stableFullyReadImportSampleCount": item["stableFullyReadImportSampleCount"],
            "qualifiedForWholeTreePss": item["qualifiedForWholeTreePss"],
            "qualificationFailures": item["qualificationFailures"],
            "maxSampledPssKiB": item["maxSampledPssKiB"], "maxSampledPrivateKiB": item["maxSampledPrivateKiB"],
        } for item in memory_result["observations"]] if memory_result is not None else [],
        "browserIdentity": browser, "changedPackageEntries": PACKAGE_ENTRIES,
        "qualification": qualification,
        "limits": [
            "Only original recorded browser durations contribute; this audit host acquires no timing.",
            "Every missing/failed report remains an ordered row. A partial cohort cannot qualify or be replaced.",
            "Strict original semantic/memory/activation failures remain disqualifying even when faithfully reproduced.",
            "Each host is reported separately without pooling, subtraction, trimming, replacement or threshold tuning.",
            "The optional development-package hash is bound as recorded provenance; actual Chrome runtime packages receive complete member verification.",
            "Component qualification is only a prerequisite and does not substitute for complete browser-import gains.",
        ],
    }
    write_json(output / "independent-audit.json", result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    require(not args.output.exists() and not args.output.is_symlink(), "The reader requires a fresh output root")
    args.output.mkdir(parents=True, exist_ok=False)
    result = {
        "schemaVersion": 1, "auditKind": "Independent original 74-report native-fields browser records",
        "authoritativeTiming": False, "cells": [], "errors": [], "evidenceValidated": False,
        "acquisition": "None: no browser, dictionary import, native execution, readiness wait, process sampling or new timing.",
    }
    prerequisites_passed = False
    try:
        require(args.manifest.resolve() == Path(__file__).resolve().with_name("manifest.json"),
                "Use the immutable adjacent original-artifact manifest")
        sources = verify_auditor_source()
        write_json(args.output / "auditor-source-identities.json", sources)
        repository_root = Path(__file__).resolve().parents[3]
        snapshot = args.output / "auditor-source-files"
        snapshot.mkdir()
        for relative in sources:
            target = snapshot / ("workflow.yml" if relative.startswith(".github/") else Path(relative).name)
            require(not target.exists(), "Duplicate visible source snapshot")
            target.write_bytes((repository_root / relative).read_bytes())
        manifest = read_json(args.manifest)
        write_json(args.output / "frozen-original-artifact-manifest.json", manifest)
        validate_manifest(manifest)
        publication = manifest["publication"]
        result["originalPublication"] = publication
        api = GitHub(manifest["repository"], args.output)
        run = api.json("/actions/runs/" + str(publication["runId"]), "browser-original-run")
        jobs = api.json("/actions/runs/" + str(publication["runId"]) + "/jobs?filter=all&per_page=100",
                        "browser-original-jobs")
        by_id = validate_original_jobs(run, jobs, manifest)
        result["originalRunConclusion"] = run["conclusion"]
        result["originalJobConclusions"] = {item["kind"]: item["expectedConclusion"] for item in manifest["artifacts"]}
        listing = api.json("/actions/runs/" + str(publication["runId"]) + "/artifacts?per_page=100",
                           "browser-original-artifacts")
        same(listing["total_count"], 6, "Original comparison artifact count")
        same(sorted(item["id"] for item in listing["artifacts"]),
             sorted(item["id"] for item in manifest["artifacts"]), "Every original comparison artifact")
        context = verify_sources(api, manifest, args.output)
        result["source"] = {
            "upstream": context["study"]["upstream"], "control": context["study"]["control"],
            "candidate": context["study"]["candidate"], "producerSourceDigest": context["sourceDigest"],
            "runtimeSha256": context["study"]["runtimeSha256"],
        }
        try:
            prerequisites = verify_prerequisites(api, manifest, context, args.output)
            prerequisites_passed = prerequisites["passed"]
            result["prerequisites"] = prerequisites
        except Exception as error:
            failure = {"stage": "original-prerequisites", "type": type(error).__name__,
                       "error": str(error), "retry": False}
            result["errors"].append(failure)
            write_json(args.output / "prerequisite-failure.json", failure)
        for cell in sorted(manifest["artifacts"], key=lambda item: item["kind"]):
            destination = args.output / cell["kind"]
            destination.mkdir()
            try:
                outer, metadata = api.artifact(cell, publication, destination)
                write_json(destination / "verified-outer-artifact.json", {
                    "id": cell["id"], "bytes": outer.stat().st_size, "sha256": file_digest(outer),
                    "metadata": metadata, "retainedEntireOriginalZip": True,
                })
                extracted, packages, inventory = unpack_artifact(outer, destination)
                audit = audit_browser(
                    extracted, packages, cell, by_id[cell["jobId"]], api, context, manifest,
                    destination, prerequisites_passed,
                )
                result["cells"].append(audit)
                if not audit["evidenceValidated"]:
                    result["errors"].append({
                        "stage": "partial-original-cell", "kind": cell["kind"],
                        "originalArtifactId": cell["id"], "originalJobConclusion": cell["expectedConclusion"],
                        "qualificationPassed": False, "retry": False,
                        "details": "Every readable or missing original remains in the retained ordered cell result.",
                    })
            except Exception as error:
                failure = {
                    "stage": "original-cell-audit", "kind": cell["kind"],
                    "originalArtifactId": cell["id"], "originalJobConclusion": cell["expectedConclusion"],
                    "evidenceValidated": False, "qualificationPassed": False,
                    "type": type(error).__name__, "error": str(error), "retry": False,
                    "allDownloadedOriginalBytesRetained": True,
                }
                partial = destination / "validated-observations.json"
                if partial.exists():
                    failure["retainedPartialObservations"] = read_json(partial)
                write_json(destination / "audit-failure.json", failure)
                result["errors"].append(failure)
            write_json(args.output / "audit-result.json", result)
        result["evidenceValidated"] = (
            not result["errors"] and prerequisites_passed and len(result["cells"]) == 6 and
            all(cell["evidenceValidated"] for cell in result["cells"])
        )
    except Exception as error:
        result["errors"].append({"stage": "reader-preflight", "type": type(error).__name__,
                                 "error": str(error), "retry": False})
    result["qualification"] = qualify_study(
        result["cells"], prerequisites_passed, prerequisites_passed, bool(result["errors"]),
    )
    hashes = {}
    for path in sorted(args.output.rglob("*.json")):
        relative = path.relative_to(args.output)
        if "extracted" in relative.parts or str(relative) in ("audit-result.json", "audit-file-manifest.json"):
            continue
        hashes[str(relative)] = {"bytes": path.stat().st_size, "sha256": file_digest(path)}
    write_json(args.output / "audit-file-manifest.json", hashes)
    result["auditEvidenceHashes"] = hashes
    result["auditFileManifestSha256"] = file_digest(args.output / "audit-file-manifest.json")
    write_json(args.output / "audit-result.json", result)
    print(json.dumps(result, sort_keys=True, allow_nan=False))
    return 0 if result["evidenceValidated"] else 1


if __name__ == "__main__":
    sys.exit(main())
