#!/usr/bin/env python3
"""Acquire immutable VNDB input and run one fixed raw-alias component cohort.
No product source is patched, and no failed cohort is retried.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import time
import traceback
import urllib.request

HERE = Path(__file__).resolve().parent
BASELINE = "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2"
BASELINE_TREE = "d99ea4d04658f7ec1c76acdc5f3684594212a471"
ROUTE = "569d56dd9e4fb94ef3c33561f43439d61c2858ab360116d9657a1bcfe9a74a82"
SEED_SHA = "f50a48e23056054a13f90dfa7aad53ba3a80a6f6e7125289a5ad52dc2f9f686e"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(filename):
    value = hashlib.sha256()
    with Path(filename).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def write_json(filename, value):
    filename = Path(filename)
    temporary = filename.with_name(filename.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(filename)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    repository = args.repository.resolve()
    workspace = args.workspace.resolve()
    output = args.output.resolve()
    workspace.mkdir(parents=True, exist_ok=False)
    output.mkdir(parents=True, exist_ok=False)
    report = {
        "schemaVersion": 1, "complete": False,
        "scope": "Standalone immutable captured-input storage component, not a complete import or browser measurement.",
        "baselineCommit": BASELINE, "baselineTree": BASELINE_TREE,
        "workflowSha": os.environ.get("GITHUB_SHA"),
        "runId": os.environ.get("GITHUB_RUN_ID"),
        "runAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
        "phases": [], "observations": [], "failure": None,
    }
    write_json(output / "setup.json", report)

    def checked(label, command, cwd=repository, env=None, timeout=1800):
        phase = {
            "label": label, "command": [str(part) for part in command],
            "cwd": str(cwd), "startedUnixSeconds": time.time(),
        }
        report["phases"].append(phase)
        write_json(output / "setup.json", report)
        log_path = output / (label + ".log")
        print(json.dumps({"event": "phase-start", **phase}), flush=True)
        try:
            with log_path.open("wb") as stream:
                result = subprocess.run(command, cwd=cwd, env=env, stdout=stream,
                                        stderr=subprocess.STDOUT, timeout=timeout, check=False)
            phase.update({
                "returnCode": result.returncode,
                "shellEquivalentExitCode": result.returncode if result.returncode >= 0 else 128 - result.returncode,
            })
        except BaseException as error:
            phase["failure"] = {"type": type(error).__name__, "message": str(error)}
            raise
        finally:
            phase["endedUnixSeconds"] = time.time()
            if log_path.exists():
                phase["log"] = log_path.name
                phase["logSha256"] = file_sha(log_path)
            write_json(output / "setup.json", report)
        print(json.dumps({"event": "phase", **phase}), flush=True)
        if result.returncode != 0:
            raise RuntimeError(label + " exited " + str(result.returncode))
        return log_path.read_text(errors="replace").strip()

    try:
        identity_bytes = (HERE / "source-manifest.json").read_bytes()
        identity = json.loads(identity_bytes)
        protocol_bytes = (HERE / "protocol.json").read_bytes()
        protocol = json.loads(protocol_bytes)
        if digest(protocol_bytes) != identity["protocolSha256"]:
            raise RuntimeError("Prospective protocol identity differs")
        protocol_blob = hashlib.sha1(b"blob " + str(len(protocol_bytes)).encode("ascii") + b"\0" + protocol_bytes).hexdigest()
        if protocol_blob != identity["protocolBlob"] or protocol_blob != "83930b97ad2fc05697dbf83455229fe148962010":
            raise RuntimeError("Exact protocol Git blob differs")
        if protocol["baselineCommit"] != BASELINE or protocol["baselineTree"] != BASELINE_TREE:
            raise RuntimeError("Frozen source identity differs")
        report["sourceManifestSha256"] = digest(identity_bytes)
        report["protocolSha256"] = digest(protocol_bytes)
        report["protocolBlob"] = protocol_blob
        for filename, expected in identity["harnessHashes"].items():
            candidate = HERE / filename
            if file_sha(candidate) != expected:
                raise RuntimeError("Frozen harness source differs: " + filename)
            shutil.copyfile(candidate, output / filename)
        shutil.copyfile(HERE / "source-manifest.json", output / "source-manifest.json")
        shutil.copyfile(HERE / "protocol.json", output / "protocol.json")
        workflow_path = repository / identity["workflowPath"]
        if file_sha(workflow_path) != identity["workflowSha256"]:
            raise RuntimeError("Exact workflow bytes differ")
        research_head = checked("research-head", ["git", "rev-parse", "HEAD"])
        research_tree = checked("research-tree", ["git", "rev-parse", "HEAD^{tree}"])
        expected_head = os.environ.get("GITHUB_SHA")
        if expected_head is not None and research_head != expected_head:
            raise RuntimeError("Research checkout HEAD differs from GITHUB_SHA")
        experiment_relative = str(HERE.relative_to(repository))
        tracked_paths = [identity["workflowPath"], experiment_relative + "/source-manifest.json",
                         experiment_relative + "/protocol.json"] + [
                             experiment_relative + "/" + name for name in identity["harnessHashes"]]
        checked("research-inputs-tracked", ["git", "ls-files", "--error-unmatch", "--", *tracked_paths])
        checked("research-inputs-clean", ["git", "diff", "--exit-code", "HEAD", "--", *tracked_paths])
        committed_protocol_blob = checked("research-protocol-blob", [
            "git", "rev-parse", "HEAD:" + experiment_relative + "/protocol.json"])
        if committed_protocol_blob != protocol_blob:
            raise RuntimeError("Committed protocol blob differs from read bytes")
        report["researchBinding"] = {
            "commit": research_head, "tree": research_tree, "githubSha": expected_head,
            "workflowPath": identity["workflowPath"], "workflowSha256": identity["workflowSha256"],
            "protocolBlob": protocol_blob, "protocolSha256": digest(protocol_bytes),
        }
        write_json(output / "setup.json", report)
        node_version = checked("node-version", ["node", "--version"])
        if node_version != "v22.22.0":
            raise RuntimeError("Expected exact Node22.22.0")
        report["node"] = node_version
        report["freeBytesBeforeAcquisition"] = shutil.disk_usage(output).free
        if report["freeBytesBeforeAcquisition"] < 2 * 1024**3:
            raise RuntimeError("Less than fixed2GiB output capacity")
        for filename in identity["harnessHashes"]:
            if filename.endswith(".mjs"):
                checked("syntax-" + Path(filename).stem, ["node", "--check", str(HERE / filename)])
        checked("node-opfs-adapter-tests", [
            "node", str(HERE / "raw-alias-node-opfs.test.mjs"),
            str(HERE / "raw-alias-node-opfs.mjs"),
        ])

        checked("synthetic-advance-gate-tests", ["node", str(HERE / "raw-alias-analysis.test.mjs")])

        originals = workspace / "originals"
        originals.mkdir()
        extracted = {}
        for archive_spec in identity["archives"]:
            archive_path = repository / archive_spec["path"]
            if file_sha(archive_path) != archive_spec["sha256"]:
                raise RuntimeError("Evidence archive identity differs: " + archive_spec["path"])
            with tarfile.open(archive_path, "r:gz") as archive:
                members = {member.name: member for member in archive.getmembers()}
                for expected in archive_spec["members"]:
                    member = members.get(expected["path"])
                    if member is None or not member.isfile():
                        raise RuntimeError("Evidence member is not a regular file: " + expected["path"])
                    with archive.extractfile(member) as stream:
                        data = stream.read()
                    if len(data) != expected["bytes"] or digest(data) != expected["sha256"]:
                        raise RuntimeError("Evidence member identity differs: " + expected["path"])
                    destination = originals / expected["path"]
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(data)
                    extracted[expected["path"]] = destination

        baseline = workspace / "baseline"
        checked("checkout-baseline", ["git", "worktree", "add", "--no-checkout", "--detach", str(baseline), BASELINE])
        checked("sparse-baseline", ["git", "sparse-checkout", "set", "--no-cone", "/*", "!/builds/perf/"], cwd=baseline)
        checked("materialize-baseline", ["git", "checkout", "--detach", BASELINE], cwd=baseline)
        if checked("baseline-commit", ["git", "rev-parse", "HEAD"], cwd=baseline) != BASELINE:
            raise RuntimeError("Baseline commit differs")
        if checked("baseline-tree", ["git", "rev-parse", "HEAD^{tree}"], cwd=baseline) != BASELINE_TREE:
            raise RuntimeError("Baseline tree differs")
        if (baseline / "package-lock.json").read_bytes() != (repository / "package-lock.json").read_bytes():
            raise RuntimeError("Installed package lock differs from baseline")
        (baseline / "node_modules").symlink_to(repository / "node_modules", target_is_directory=True)
        checked("baseline-libraries", ["npm", "run", "build:libs"], cwd=baseline)
        checked("baseline-source-clean", ["git", "diff", "--exit-code", "--", "ext/js", "types"], cwd=baseline)
        for relative, expected in identity["sourceHashes"].items():
            if expected is not None and file_sha(baseline / relative) != expected:
                raise RuntimeError("Frozen runtime source differs: " + relative)

        source_manifest_path = extracted["profiling/compression-groups/vndb/manifest.json"]
        source_manifest = json.loads(source_manifest_path.read_bytes())
        if not source_manifest["complete"] or source_manifest["gitSha"] != BASELINE:
            raise RuntimeError("Original native capture manifest provenance differs")
        for relative, expected in source_manifest["sourceHashes"].items():
            if file_sha(baseline / relative) != expected:
                raise RuntimeError("Native capture source differs: " + relative)
        if file_sha(baseline / "test/perf/dictionaries.lock.json") != source_manifest["lockSha256"]:
            raise RuntimeError("Dictionary lock differs")
        fixture = json.loads((baseline / "test/perf/dictionaries.lock.json").read_bytes())["dictionaries"]["vndb"]
        if fixture != source_manifest["fixture"] or fixture != identity["fixture"]:
            raise RuntimeError("Pinned VNDB fixture metadata differs")
        # Freeze companion identities before network acquisition or corpus work.
        report["preAcquisitionBinding"] = {
            "complete": True, "fixture": fixture,
            "research": report["researchBinding"], "protocolBlob": protocol_blob,
            "sourceHashes": identity["sourceHashes"], "harnessHashes": identity["harnessHashes"],
            "packageLockSha256": file_sha(baseline / "package-lock.json"),
            "dictionaryLockSha256": source_manifest["lockSha256"],
            "originalSourceManifestSha256": file_sha(source_manifest_path),
            "protocolSha256": digest(protocol_bytes),
        }
        write_json(output / "pre-acquisition-binding.json", report["preAcquisitionBinding"])
        write_json(output / "setup.json", report)
        fixtures = workspace / "fixtures"
        fixtures.mkdir()
        fixture_path = fixtures / fixture["cacheFile"]
        partial = fixture_path.with_name(fixture_path.name + ".partial")
        with urllib.request.urlopen(fixture["url"], timeout=120) as response, partial.open("xb") as stream:
            shutil.copyfileobj(response, stream, length=1024 * 1024)
        if partial.stat().st_size != fixture["sizeBytes"] or file_sha(partial) != fixture["sha256"]:
            raise RuntimeError("Pinned ZIP size/SHA differs")
        partial.rename(fixture_path)
        report["fixtureVerified"] = True

        # The route module imports the preserved loader and worker bridge locally.
        # Create an isolated helper directory; original archived bytes stay intact.
        helper = workspace / "capture-helpers"
        helper.mkdir()
        for filename in ["raw-alias-capture.mjs", "raw-alias-capture-route.mjs"]:
            shutil.copyfile(HERE / filename, helper / filename)
        for filename in ["production-group-loader.mjs", "compression-worker-node-bridge.mjs"]:
            shutil.copyfile(extracted["profiling/" + filename], helper / filename)
        capture_directory = output / "capture"
        route_output = output / "new-route-receipt.json"
        environment = dict(os.environ)
        environment.update({
            "MANABITAN_ALIAS_BASELINE": str(baseline),
            "MANABITAN_ALIAS_SOURCE_MANIFEST": str(source_manifest_path),
            "MANABITAN_ALIAS_FIXTURES": str(fixtures),
            "MANABITAN_ALIAS_TEMP": str(workspace / "route-opfs"),
            "MANABITAN_ALIAS_CAPTURE": str(capture_directory),
            "MANABITAN_ALIAS_ORIGINAL_ROUTE": str(extracted["profiling/vndb-record-route-full.json"]),
        })
        checked("native-route-and-capture", [
            "node", "--expose-gc", str(helper / "raw-alias-capture-route.mjs"),
            "--groups", "170", "--out", str(route_output),
        ], env=environment)
        route_receipt = json.loads(route_output.read_bytes())
        captured_bytes = (capture_directory / "manifest.json").read_bytes()
        captured = json.loads(captured_bytes)
        if not route_receipt["complete"] or route_receipt["failures"] or route_receipt["routeWitnessSha256"] != ROUTE:
            raise RuntimeError("New native route proof failed")
        if not captured["complete"] or captured["failures"]:
            raise RuntimeError("New immutable capture is incomplete")
        retained_bytes = sum(filename.stat().st_size for filename in capture_directory.iterdir() if filename.is_file())
        proof_metadata_bytes = route_output.stat().st_size + source_manifest_path.stat().st_size + extracted["profiling/vndb-record-route-full.json"].stat().st_size
        if retained_bytes + proof_metadata_bytes > 64 * 1024 * 1024:
            raise RuntimeError("Complete retained capture including proof metadata exceeds64MiB")
        if file_sha(capture_directory / "manabitan-term-content.bin") != SEED_SHA:
            raise RuntimeError("Captured completed content prefix differs")
        shutil.copyfile(source_manifest_path, output / "original-source-manifest.json")
        shutil.copyfile(extracted["profiling/vndb-record-route-full.json"], output / "original-route-receipt.json")
        report["capture"] = {
            "manifestSha256": digest(captured_bytes), "retainedBytes": retained_bytes,
            "proofMetadataBytes": proof_metadata_bytes, "totalRetainedCaptureAndProofBytes": retained_bytes + proof_metadata_bytes,
            "routeWitnessSha256": ROUTE, "seedSha256": SEED_SHA,
            "rows": sum(group["rows"] for group in captured["groups"]),
            "groups": [group["index"] for group in captured["groups"]],
            "newIdentity": True,
        }
        write_json(output / "setup.json", report)

        binding = {
            "baselineCommit": BASELINE, "protocolPath": str(HERE / "protocol.json"),
            "researchBinding": report["researchBinding"], "protocolBlob": protocol_blob,
            "protocolSha256": digest(protocol_bytes),
            "sourceHashes": identity["sourceHashes"], "harnessHashes": identity["harnessHashes"],
            "captureManifestSha256": digest(captured_bytes),
        }
        observed = []
        observation_root = output / "observations"
        observation_root.mkdir()
        config_root = output / "configs"
        config_root.mkdir()
        ordinal = 0
        for block, order in enumerate(protocol["schedule"]["permutations"]):
            for arm in order:
                observation_directory = observation_root / (f"{ordinal:02d}-{arm}")
                config = {
                    **binding, "root": str(baseline), "captureDirectory": str(capture_directory),
                    "arm": arm, "block": block, "ordinal": ordinal,
                    "outputDirectory": str(observation_directory),
                    "aliasLimits": {"maximumUniqueEntries": 64, "maximumInputBytes": 65536},
                }
                config_path = config_root / (f"{ordinal:02d}-{arm}.json")
                write_json(config_path, config)
                checked(f"observation-{ordinal:02d}-{arm}", [
                    "node", "--expose-gc", str(HERE / "raw-alias-arm.mjs"), str(config_path),
                ])
                observation = json.loads((observation_directory / "observation.json").read_bytes())
                if not observation["complete"]:
                    raise RuntimeError("Fresh child did not complete its semantic gates")
                observed.append(observation)
                report["observations"].append({
                    "ordinal": ordinal, "block": block, "arm": arm,
                    "file": str((observation_directory / "observation.json").relative_to(output)),
                    "sha256": file_sha(observation_directory / "observation.json"),
                    "elapsedMs": observation["elapsedMs"],
                })
                write_json(output / "setup.json", report)
                ordinal += 1
        if ordinal != 36:
            raise RuntimeError("Prescribed observation count differs")
        analysis_input = output / "analysis-input.json"
        write_json(analysis_input, {"observations": observed, "protocol": protocol, "binding": binding})
        checked("fixed-analysis", [
            "node", str(HERE / "raw-alias-analysis.mjs"), str(analysis_input), str(output / "analysis.json"),
        ])
        analysis = json.loads((output / "analysis.json").read_bytes())
        if not analysis["complete"]:
            raise RuntimeError("Cohort analysis is incomplete")
        for relative, expected in identity["sourceHashes"].items():
            if expected is not None and file_sha(baseline / relative) != expected:
                raise RuntimeError("Runtime source changed after cohort: " + relative)
        for filename, expected in identity["harnessHashes"].items():
            if file_sha(HERE / filename) != expected:
                raise RuntimeError("Harness changed after cohort: " + filename)
        checked("baseline-source-clean-after", ["git", "diff", "--exit-code", "--", "ext/js", "types"], cwd=baseline)
        report["complete"] = True
        report["analysisSha256"] = file_sha(output / "analysis.json")
        report["advance"] = analysis["advance"]
        print("RAW_ALIAS_COMPONENT_SUMMARY " + json.dumps(analysis), flush=True)
    except BaseException as error:
        report["failure"] = {"type": type(error).__name__, "message": str(error), "traceback": traceback.format_exc()}
        raise
    finally:
        write_json(output / "setup.json", report)
        print("RAW_ALIAS_SETUP_RESULT " + json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
