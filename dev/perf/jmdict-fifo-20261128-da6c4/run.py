#!/usr/bin/env python3
"""Regenerate fixed JMdict inputs and run one prospectively registered FIFO cohort."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import time
import traceback
import urllib.request

SCRIPT_DIRECTORY = Path(__file__).resolve().parent


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path, value):
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    repository = args.repository.resolve()
    workspace = args.workspace.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    workspace.mkdir(parents=True, exist_ok=False)

    plan_bytes = (SCRIPT_DIRECTORY / "plan.json").read_bytes()
    plan = json.loads(plan_bytes)
    report = {
        "schemaVersion": 1,
        "complete": False,
        "studyId": plan["studyId"],
        "planSha256": sha(plan_bytes),
        "captureCommit": plan["captureCommit"],
        "runtimeCommit": plan["runtimeCommit"],
        "workflowSha": os.environ.get("GITHUB_SHA"),
        "runId": os.environ.get("GITHUB_RUN_ID"),
        "runAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
        "node": None,
        "phases": [],
        "failure": None,
    }
    write_json(output / "setup.json", report)
    for name in ("plan.json", "local-attempts.json", "run.py", "component.mjs", "dispatcher-tests.mjs"):
        shutil.copyfile(SCRIPT_DIRECTORY / name, output / name)

    def checked(label, command, cwd=repository, env=None):
        entry = {"label": label, "command": [str(part) for part in command],
                 "cwd": str(cwd), "startedUnixSeconds": time.time()}
        report["phases"].append(entry)
        write_json(output / "setup.json", report)
        log_path = output / (label + ".log")
        with log_path.open("wb") as log:
            result = subprocess.run(command, cwd=cwd, env=env,
                                    stdout=log, stderr=subprocess.STDOUT, check=False)
        entry.update({
            "endedUnixSeconds": time.time(),
            "returnCode": result.returncode,
            "shellEquivalentExitCode": result.returncode if result.returncode >= 0 else 128 - result.returncode,
            "log": log_path.name,
            "logSha256": file_sha(log_path),
        })
        write_json(output / "setup.json", report)
        print(json.dumps({"event": "phase", **entry}), flush=True)
        if result.returncode != 0:
            raise RuntimeError(f"{label} failed with return code {result.returncode}")
        return log_path.read_text(errors="replace").strip()

    try:
        report["node"] = checked("node-version", ["node", "--version"])
        if report["node"] != plan["nodeVersion"]:
            raise RuntimeError(f"Unexpected Node version: {report['node']}")
        checked("component-syntax", ["node", "--check", str(SCRIPT_DIRECTORY / "component.mjs")])

        archive_path = repository / plan["evidenceArchive"]
        if archive_path.stat().st_size != plan["evidenceArchiveBytes"] or file_sha(archive_path) != plan["evidenceArchiveSha256"]:
            raise RuntimeError("Preserved evidence archive identity differs")
        originals = workspace / "original-evidence"
        originals.mkdir()
        extracted = {}
        with tarfile.open(archive_path, "r:gz") as archive:
            members = {member.name: member for member in archive.getmembers()}
            for expected in plan["evidenceMembers"]:
                name = expected["path"]
                member = members.get(name)
                if member is None or not member.isfile():
                    raise RuntimeError(f"Missing regular evidence member: {name}")
                stream = archive.extractfile(member)
                if stream is None:
                    raise RuntimeError(f"Unreadable evidence member: {name}")
                data = stream.read()
                if len(data) != expected["bytes"] or sha(data) != expected["sha256"]:
                    raise RuntimeError(f"Evidence member identity differs: {name}")
                destination = originals / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(data)
                extracted[name] = destination
        report["evidenceMembers"] = plan["evidenceMembers"]
        write_json(output / "setup.json", report)

        baseline = workspace / "baseline"
        runtime = workspace / "startup-experiment"
        checked("checkout-baseline", ["git", "worktree", "add", "--detach", str(baseline), plan["captureCommit"]])
        checked("checkout-runtime", ["git", "worktree", "add", "--detach", str(runtime), plan["runtimeCommit"]])
        for name, tree, expected in (("baseline", baseline, plan["captureCommit"]),
                                     ("runtime", runtime, plan["runtimeCommit"])):
            observed = checked(name + "-commit", ["git", "rev-parse", "HEAD"], cwd=tree)
            if observed != expected:
                raise RuntimeError(f"{name} commit differs")
            checked(name + "-tree", ["git", "rev-parse", "HEAD^{tree}"], cwd=tree)
            if (tree / "package-lock.json").read_bytes() != (repository / "package-lock.json").read_bytes():
                raise RuntimeError(f"{name} package-lock differs from installed dependencies")
            (tree / "node_modules").symlink_to(repository / "node_modules", target_is_directory=True)
            checked(name + "-libraries", ["npm", "run", "build:libs"], cwd=tree)
            checked(name + "-source-clean", ["git", "diff", "--exit-code", "--", "ext/js", "types"], cwd=tree)

        checked("dispatcher-tests", ["node", str(SCRIPT_DIRECTORY / "dispatcher-tests.mjs"),
                                     str(runtime), str(SCRIPT_DIRECTORY / "component.mjs")])

        fixtures = workspace / "fixtures"
        fixtures.mkdir()
        lock = json.loads((baseline / "test/perf/dictionaries.lock.json").read_bytes())
        fixture = lock["dictionaries"]["jmdict"]
        if fixture != plan["fixture"]:
            raise RuntimeError("Pinned JMdict fixture metadata differs")
        fixture_path = fixtures / fixture["cacheFile"]
        temporary = fixture_path.with_name(fixture_path.name + ".partial")
        with urllib.request.urlopen(fixture["url"], timeout=120) as response, temporary.open("xb") as stream:
            shutil.copyfileobj(response, stream, length=1024 * 1024)
        if temporary.stat().st_size != fixture["sizeBytes"] or file_sha(temporary) != fixture["sha256"]:
            raise RuntimeError("Pinned JMdict ZIP size or SHA256 differs")
        temporary.rename(fixture_path)
        report["fixture"] = {**fixture, "verified": True}

        profiling = workspace / "profiling"
        profiling.mkdir()
        for name in ("capture-compression-groups.mjs", "compression-scheduling-replay.mjs", "compression-worker-node-bridge.mjs"):
            shutil.copyfile(extracted["profiling/" + name], profiling / name)
        replanner_original = extracted["profiling/replan-production-blocks.mjs"].read_text()
        old_root = "const root='/workspace/scratch/da6c4dbd0097';"
        if replanner_original.count(old_root) != 1:
            raise RuntimeError("Expected sole replanner workspace-root statement is absent")
        replanner_source = replanner_original.replace(old_root, "const root=" + json.dumps(str(workspace)) + ";")
        replanner_path = profiling / "replan-production-blocks.mjs"
        replanner_path.write_text(replanner_source)
        report["replannerAdaptation"] = {
            "originalSha256": sha(replanner_original.encode()),
            "adaptedSha256": sha(replanner_source.encode()),
            "replacementCount": 1,
            "scope": "Only the literal workspace root changes; exact production planner and1MiB configuration remain unchanged.",
        }
        write_json(output / "setup.json", report)

        expected_manifest_path = extracted["profiling/compression-groups/jmdict/manifest-db-1m.json"]
        expected_manifest = json.loads(expected_manifest_path.read_bytes())
        for relative, expected in expected_manifest["sourceHashes"].items():
            if file_sha(baseline / relative) != expected:
                raise RuntimeError(f"Baseline capture source differs: {relative}")
        if file_sha(baseline / "test/perf/dictionaries.lock.json") != expected_manifest["lockSha256"]:
            raise RuntimeError("Baseline dictionary lock hash differs")
        if expected_manifest["gitSha"] != plan["captureCommit"] or not expected_manifest["complete"]:
            raise RuntimeError("Preserved capture provenance differs")

        checked("capture", [
            "node", "--expose-gc", str(profiling / "capture-compression-groups.mjs"),
            "--root", str(baseline), "--cache", str(fixtures),
            "--out", str(profiling / "compression-groups"), "--workers", "3", "jmdict",
        ])
        checked("replan", ["node", str(replanner_path)])
        manifest_path = profiling / "compression-groups/jmdict/manifest-db-1m.json"
        manifest = json.loads(manifest_path.read_bytes())
        expected = plan["expected"]
        for key in ("gitSha", "sourceHashes", "lockSha256", "fixture", "workers", "sourceBanks",
                    "totalSourceBytes", "totalRows", "rowWitnessSha256", "blockTargetBytes", "blockPlanOrigin"):
            if manifest[key] != expected_manifest[key]:
                raise RuntimeError(f"Regenerated manifest field differs: {key}")
        if not manifest["complete"] or manifest["totalRows"] != expected["rows"]:
            raise RuntimeError("Regenerated capture is incomplete")
        if len(manifest["groups"]) != expected["groups"]:
            raise RuntimeError("Regenerated group count differs")
        if [len(group["blockLengths"]) for group in manifest["groups"]] != expected["blocksPerGroup"]:
            raise RuntimeError("Regenerated1MiB block count differs")
        for actual_group, expected_group in zip(manifest["groups"], expected_manifest["groups"], strict=True):
            for key in ("index", "firstBank", "lastBank", "rows", "sourceZipUncompressedBytes",
                        "sourceZipCompressedBytes", "sourceBytes", "sourceSha256", "offsetsSha256",
                        "lengthsSha256", "uniqueContentCount", "uniqueContentBytes", "blockLengths",
                        "blockStartIndexes", "inputBlockSha256"):
                if actual_group[key] != expected_group[key]:
                    raise RuntimeError(f"Regenerated group{actual_group['index']} field differs: {key}")
        if sum(group["uniqueContentBytes"] for group in manifest["groups"]) != expected["uniqueInputBytes"]:
            raise RuntimeError("Regenerated unique input byte count differs")

        runtime_files = [
            "ext/js/dictionary/zstd-term-content.js",
            "ext/js/dictionary/zstd-term-content-compression-worker.js",
            "ext/js/dictionary/term-content-block-envelope.js",
            "ext/js/dictionary/term-entry-content-hash.js",
            "ext/js/dictionary/term-bank-experiments.js",
            "ext/lib/zstd.wasm", "ext/lib/zstd-wasm.js", "ext/lib/zstd-dicts/jmdict.zdict",
        ]
        runtime_hashes = {relative: file_sha(runtime / relative) for relative in runtime_files}
        for relative in ("ext/lib/zstd.wasm", "ext/lib/zstd-wasm.js", "ext/lib/zstd-dicts/jmdict.zdict"):
            if runtime_hashes[relative] != expected_manifest["sourceHashes"][relative]:
                raise RuntimeError(f"Runtime codec asset differs from proven oracle: {relative}")
        for relative in ("ext/js/dictionary/zstd-term-content-compression-worker.js",
                         "ext/js/dictionary/term-content-block-envelope.js",
                         "ext/js/dictionary/term-entry-content-hash.js",
                         "ext/js/dictionary/term-bank-experiments.js"):
            if (runtime / relative).read_bytes() != (baseline / relative).read_bytes():
                raise RuntimeError(f"Runtime codec dependency differs from baseline: {relative}")
        for name, tree in (("baseline", baseline), ("runtime", runtime)):
            checked(name + "-source-clean-before-timing", ["git", "diff", "--exit-code", "--", "ext/js", "types"], cwd=tree)

        config = {
            "schemaVersion": 1,
            "plan": plan,
            "planSha256": sha(plan_bytes),
            "root": str(runtime),
            "runtimeSourceHashes": runtime_hashes,
            "manifestPath": str(manifest_path),
            "manifestSha256": file_sha(manifest_path),
            "oraclePath": str(extracted["profiling/compression-scheduling-db-1m-replication.json"]),
            "oracleSha256": file_sha(extracted["profiling/compression-scheduling-db-1m-replication.json"]),
            "bridgePath": str(profiling / "compression-worker-node-bridge.mjs"),
            "bridgeSha256": file_sha(profiling / "compression-worker-node-bridge.mjs"),
            "scriptSha256": file_sha(SCRIPT_DIRECTORY / "component.mjs"),
            "outputPath": str(output / "observations.json"),
            "compressedOutputDirectory": str(output / "compressed-outputs"),
            "minimumFreeOutputBytes": 768 * 1024 * 1024,
        }
        write_json(output / "component-config.json", config)
        shutil.copyfile(manifest_path, output / "regenerated-manifest-db-1m.json")
        shutil.copyfile(expected_manifest_path, output / "reference-manifest-db-1m.json")
        shutil.copyfile(replanner_path, output / "adapted-replan-production-blocks.mjs")
        report["preTimingInputProof"] = {
            "complete": True, "groups": expected["groups"], "rows": expected["rows"],
            "blocks": expected["blocks"], "inputBytes": expected["uniqueInputBytes"],
            "manifestSha256": config["manifestSha256"],
            "referenceManifestSha256": file_sha(expected_manifest_path),
            "runtimeSourceHashes": runtime_hashes,
            "packageLockSha256": file_sha(baseline / "package-lock.json"),
            "derivedUnusedReplaySha256": file_sha(profiling / "compression-scheduling-db-1m-replay.mjs"),
        }
        write_json(output / "setup.json", report)
        checked("component", ["node", "--expose-gc", str(SCRIPT_DIRECTORY / "component.mjs"),
                              str(output / "component-config.json")])
        component = json.loads((output / "observations.json").read_bytes())
        if not component["complete"]:
            raise RuntimeError("Component returned without complete semantic proof")
        checked("runtime-source-clean-after-timing", ["git", "diff", "--exit-code", "--", "ext/js", "types"], cwd=runtime)
        report["complete"] = True
        report["componentSummary"] = component["analysis"]
        print("FIFO_COMPONENT_SUMMARY " + json.dumps(component["analysis"]), flush=True)
    except BaseException as error:
        report["failure"] = {"type": type(error).__name__, "message": str(error),
                             "traceback": traceback.format_exc()}
        raise
    finally:
        write_json(output / "setup.json", report)
        print("FIFO_SETUP_RESULT " + json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
