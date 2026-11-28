#!/usr/bin/env python3
"""Read-only independent audit of the fixed 46145076480 receipt set.

This recomputes relationships between retained receipts and original oracles.
The hosted runner reread actual OPFS files before deleting its temporary root;
this audit does not claim to rerun the importer or rehash those deleted files.
"""
import argparse
import hashlib
import json
import tarfile
import zipfile
from collections import Counter
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    return json.loads(path.read_text())


def identity(path):
    data = path.read_bytes()
    return {"bytes": len(data), "sha256": digest(data)}


def without(value, keys):
    return {key: item for key, item in value.items() if key not in keys}


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--reports", type=Path, required=True)
parser.add_argument("--tooling", type=Path, required=True)
parser.add_argument("--fixture-lock", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
root = args.reports.resolve()
helper = args.tooling / "test/perf/record-reference-table-verification"
evidence = args.tooling / "builds/perf/20261128-4d9f-reference-fields-latest"
manifest_path = evidence / "verification-manifest.json"
manifest = read(manifest_path)
profile = manifest["sourceProfiles"]["B"]
commit = "85a8aa49f76fbabd2dc494aad247f74774ff2573"
assert profile["runtimeCommit"] == commit
lock = read(args.fixture_lock)
index = read(root / "artifact-index.json")
assert index["runId"] == 46145076480
assert index["toolingCommit"] == "26c5cb9ff1a19afd583f94a6c86f336dab783719"
expected_artifacts = {
    "contracts": (15263461668, 32769, "8656ab2d6d39776a6af40aeb75b4cdede5162d8e975fc6b1d31b5635bc345da2"),
    "jmdict": (15263054810, 127578, "169fe28dd94972f1aa127b00a33c213d7e8edf282e26726edcd8939ccddab232"),
    "jitendex": (15263163001, 177490, "e44b05ea5687eca3fe9e61bd59444caaeef77ba0fd29ebc81b2edc2b9400b6d2"),
    "vndb": (15263227579, 798834, "0ee3ed9d257cf2501517c79ac6080611d7b9d27465fc6e5e9e76e4b402ebab11"),
}
artifacts = []
for artifact in index["artifacts"]:
    key = artifact["key"]
    artifact_id, size, sha = expected_artifacts[key]
    archive = root / (key + ".zip")
    assert artifact["id"] == artifact_id
    assert artifact["size_in_bytes"] == size and artifact["digest"] == "sha256:" + sha
    assert artifact["workflow_run"]["head_sha"] == index["toolingCommit"]
    assert identity(archive) == {"bytes": size, "sha256": sha}
    members = {item["path"]: item for item in artifact["members"]}
    with zipfile.ZipFile(archive) as packed:
        assert packed.testzip() is None
        files = [item for item in packed.infolist() if not item.is_dir()]
        assert len(files) == len(members)
        for item in files:
            data = packed.read(item)
            expected = {"path": item.filename, "bytes": len(data), "sha256": digest(data)}
            assert members[item.filename] == expected
            assert (root / key / item.filename).read_bytes() == data
    artifacts.append({"corpus": key, "artifactId": artifact_id, "bytes": size,
                      "sha256": sha, "verifiedMembers": len(members)})

archive = evidence / "verification-oracles.tar.gz"
assert identity(archive) == {"bytes": 95475, "sha256": "7959bf4736e64ca55e2ee7176774f2c62d2802a7df968f226818f969bb642e78"}
original_oracles = {}
with tarfile.open(archive) as packed:
    assert len([item for item in packed.getmembers() if item.isfile()]) == 8
    for name, declared in manifest["oracles"].items():
        data = packed.extractfile(declared["path"]).read()
        assert {"bytes": len(data), "sha256": digest(data)} == without(declared, {"path"})
        if name.endswith("-output"):
            original_oracles[name] = data

state = {"epoch": 0, "logicalHighWater": 0, "rootId": "legacy-root-v0",
         "manifest": {"version": 1, "legacy": True, "regions": []}}
sql = {"bytes": 311296, "sha256": "9ea0a6d4f3584f9b56a05ac4da48f0d077536f98435c409b2d6107a2adaa84c0", "userVersion": 0}
results = []
for corpus, expected_groups in [("jmdict", 12), ("jitendex", 22), ("vndb", 170)]:
    directory = root / corpus / corpus
    comparison = read(directory / "comparison.json")
    assert comparison["success"] is True and comparison["timingEligible"] is False
    assert comparison["candidateCommit"] == comparison["runtimeCommit"] == commit
    assert read(directory / "complete.json")["success"] is True
    invocation = read(directory / "invocation.json")
    assert invocation["candidateCommit"] == commit
    assert invocation["driverSha256"] == identity(helper / "hosted-qualification.py")["sha256"]
    assert invocation["nodeSha256"] == manifest["recordedLinuxX64NodeSha256"]
    for exit_file in directory.glob("*.exit.json"):
        exit_result = read(exit_file)
        assert exit_result["returncode"] == 0 and exit_result["timingEligible"] is False
    arms = []
    for arm in ["A", "B"]:
        arm_directory = directory / f"{corpus}-{arm}-1"
        value = read(arm_directory / "result.json")
        assert value["success"] is True and value["timingEligible"] is False
        assert value["arm"] == arm and value["corpus"] == corpus
        source = value["source"]
        assert source["commit"] == source["runtimeProfileCommit"] == commit
        assert source["trees"] == profile["trees"]
        assert source["canonicalIdentity"] == profile["canonicalIdentity"]
        assert source["runtimeDiffSha256"] == digest(b"")
        assert value["node"] == "v22.22.0"
        assert value["runtimeIdentity"]["sha256"] == manifest["recordedLinuxX64NodeSha256"]
        assert value["execArgv"] == ["--max-old-space-size=512"]
        for name, sha in value["helperIdentity"].items():
            assert identity(helper / name)["sha256"] == sha, name
        assert value["evidenceIdentity"]["manifest"] == identity(manifest_path)
        assert value["evidenceIdentity"]["protocol"] == identity(evidence / "protocol.json")
        for name, declared in manifest["oracles"].items():
            assert value["evidenceIdentity"]["oracles"][name] == without(declared, {"path"})
        assert value["lockSha256"] == identity(args.fixture_lock)["sha256"]
        assert value["fixture"] == lock["dictionaries"][corpus]
        assert value["rows"] == value["fixture"]["termRows"]
        assert value["policy"]["capabilities"] == {"hardwareConcurrency": 4, "deviceMemory": 8}
        assert value["policy"]["parserWorkers"] == 3 and value["compression"]["codecWorkers"] == 4
        assert value["policy"]["groups"] == len(value["groupResults"]) == expected_groups
        legacy = value["legacyReadContext"]
        assert legacy["mode"] == "real-sqlite-epoch-zero-schema-v2"
        assert legacy["assetIdentity"] == manifest["legacyReadContext"]["assets"]
        assert legacy["initial"] == legacy["final"] == state
        assert legacy["sqliteInitial"] == legacy["sqliteFinal"] == sql
        assert legacy["groupStates"] == [{"group": i, "state": state} for i in range(expected_groups)]
        assert read(arm_directory / "legacy-read-context.json") == legacy
        cleanup = read(arm_directory / "legacy-read-context-cleanup.json")
        assert cleanup == {"drainResults": [{"status": "fulfilled"}] * 2,
                           "workerResults": [{"status": "fulfilled"}] * (4 + value["indexWorker"]["count"]),
                           "resourceResults": [{"status": "fulfilled"}] * 2,
                           "closedOwnedConnection": True, "closeError": None}
        launcher = read(directory / f"{corpus}-{arm}-1.launcher.json")
        assert launcher["returncode"] == 0 and launcher["terminatingSignal"] is None
        assert launcher["timingEligible"] is False
        assert launcher["launcherSha256"] == identity(helper / "launch-with-legacy-read-context.py")["sha256"]
        groups = value["groupResults"]
        chunks = value["chunks"]
        assert [entry["group"] for entry in groups] == list(range(expected_groups))
        assert sum(entry["rows"] for entry in groups) == value["rows"]
        assert sum(entry["sourceBytes"] for entry in groups) == value["totalBytes"]
        assert sum(len(entry["banks"]) for entry in groups) == value["bankCount"]
        assert sum(entry["mediaRows"] for entry in groups) == value["mediaRows"]
        assert sum(entry["fieldChunks"] for entry in groups) == len(chunks)
        assert sum(entry["count"] for entry in chunks) == value["rows"]
        assert len(value["sourceChecks"]) == len(chunks)
        next_id = 1
        for chunk, check in zip(chunks, value["sourceChecks"]):
            assert chunk["firstId"] == next_id
            next_id += chunk["count"]
            assert chunk["allRowsMatchSource"] is check["allRowsMatchSource"] is True
            assert chunk["sourceTable"] == check["sourceTable"]
            assert chunk["count"] == check["rows"] and chunk["format"] == check["format"]
            assert chunk["expandedFormat"] == 2
            assert chunk["expandedBytes"] == 16 + 4 * chunk["scoreCount"] + 8 * chunk["count"]
            if chunk["format"] == 4:
                count = chunk["referenceCount"]
                assert count == chunk["sourceTable"]["fullReferenceCount"] < 65535
                assert chunk["sourceTable"]["numericalAndSizeEligible"] is True
                assert chunk["bytes"] == 20 + 6 * count + 2 * (count % 2) + 4 * chunk["scoreCount"] + 4 * chunk["count"]
                assert chunk["bytes"] < chunk["expandedBytes"]
            else:
                assert chunk["format"] == 2 and chunk["bytes"] == chunk["expandedBytes"]
                assert chunk["fieldsSha256"] == chunk["expandedSha256"]
            assert chunk["actualSavedFieldBytes"] == chunk["expandedBytes"] - chunk["bytes"]
        summary = value["summary"]
        assert summary["chunks"] == len(chunks)
        assert summary["rows"] == value["rows"]
        assert summary["writtenFieldsBytes"] == sum(entry["bytes"] for entry in chunks)
        assert summary["expandedFieldsBytes"] == sum(entry["expandedBytes"] for entry in chunks)
        assert summary["actualSavedFieldBytes"] == sum(entry["actualSavedFieldBytes"] for entry in chunks)
        assert summary["formatCounts"] == dict(Counter(str(entry["format"]) for entry in chunks))
        assert summary["format4Chunks"] == sum(entry["format"] == 4 for entry in chunks)
        assert summary["format4Rows"] == sum(entry["count"] for entry in chunks if entry["format"] == 4)
        actual = read(arm_directory / "actual-output-oracle.json")
        expanded = read(arm_directory / "final-output-oracle.json")
        assert (arm_directory / "final-output-oracle.json").read_bytes() == original_oracles[corpus + "-output"]
        assert value["finalOracle"] == identity(arm_directory / "final-output-oracle.json")
        expanded_receipt = read(arm_directory / "expanded-file-verification.json")
        assert expanded_receipt["verifiedChunks"] == len(chunks)
        assert expanded_receipt["actualSavedIndexBytes"] == summary["actualSavedFieldBytes"]
        assert expanded_receipt["persisted"] == expanded["persisted"]
        assert actual["metadata"] == expanded["metadata"]
        assert actual["persisted"]["generationLinkageVerified"] is True
        actual_files = {item["path"]: item for item in actual["persisted"]["files"]}
        expanded_files = {item["path"]: item for item in expanded["persisted"]["files"]}
        assert len(actual_files) == len(actual["persisted"]["files"])
        assert actual_files.keys() == expanded_files.keys()
        for name, item in actual_files.items():
            if not name.endswith(".mbtr.mbti"):
                assert item == expanded_files[name]
        assert value["actualIndexBytes"] == sum(item["bytes"] for name, item in actual_files.items() if name.endswith(".mbtr.mbti"))
        assert value["actualAllFilesBytes"] == sum(item["bytes"] for item in actual_files.values())
        assert value["actualContentBytes"] == actual_files["manabitan-term-content.bin"]["bytes"]
        assert value["files"] == [{"path": item["path"], "bytes": item["bytes"]} for item in actual["persisted"]["files"]]
        if arm == "A":
            assert actual == expanded and summary["format4Chunks"] == summary["actualSavedFieldBytes"] == 0
        assert value["completeFileOracle"]["allExpandedFileBytesMatch"] is True
        assert value["completeFileOracle"]["allLogicalMetadataMatches"] is True
        assert value["completeFileOracle"]["actualFinalFilesReread"] is True
        arms.append(value)
    off, on = arms
    assert off["source"] == on["source"]
    for key in ["legacyReadContext", "fixture", "helperIdentity", "policy", "compression", "indexWorker", "signatureAllocation", "mediaRows"]:
        assert off[key] == on[key]
    for a, b in zip(off["groupResults"], on["groupResults"]):
        assert without(a, {"memory", "summary"}) == without(b, {"memory", "summary"})
    for a, b in zip(off["sourceChecks"], on["sourceChecks"]):
        assert without(a, {"format"}) == without(b, {"format"})
    for a, b in zip(off["chunks"], on["chunks"]):
        for key in ["group", "firstId", "count", "contentOffsetBase", "lookupPayloadBytes", "lookupPayloadSha256", "expandedFormat", "expandedBytes", "expandedSha256", "expandedEnvelopeSha256", "sourceTable"]:
            assert a[key] == b[key]
        if b["format"] != 4:
            assert a == b
    saved = off["summary"]["writtenFieldsBytes"] - on["summary"]["writtenFieldsBytes"]
    assert saved == comparison["actualSavedBytes"] == on["summary"]["actualSavedFieldBytes"]
    assert saved == off["actualIndexBytes"] - on["actualIndexBytes"]
    assert saved == off["actualAllFilesBytes"] - on["actualAllFilesBytes"]
    assert off["actualContentBytes"] == on["actualContentBytes"]
    assert comparison["format4Chunks"] == on["summary"]["format4Chunks"]
    assert comparison["format4Rows"] == on["summary"]["format4Rows"]
    assert comparison["rows"] == off["rows"] and comparison["groups"] == expected_groups
    fallback_counts = Counter()
    for chunk in on["chunks"]:
        if chunk["format"] == 4:
            continue
        table = chunk["sourceTable"]
        assert table["hasReferenceTable"] is True
        assert table["countRepresentable"] is True
        assert table["unsafeOffsets"] == table["wideLengths"] == 0
        assert table["numericalAndSizeEligible"] is False
        if table["proposedBytes"] >= table["existingCompactBytes"]:
            fallback_counts["no-strict-size-saving"] += 1
        if table["offsetsBeforeBase"] > 0:
            fallback_counts["unused-offset-before-split-base"] += 1
    assert dict(fallback_counts) == comparison["fallbackCounts"]
    if corpus == "vndb":
        assert off["mediaOracle"] == on["mediaOracle"]
        media = on["mediaOracle"]
        assert media["groupsMatched"] == 170 and media["allGroupsAndProjectedPathsMatch"] is True
        assert media["mediaRows"] == media["projectedPaths"] == 146725
        assert media["uniqueImagePaths"] == 146570 and media["repeatedProjectedReferences"] == 155
        assert media["uniqueImagePathsSha256"] == "be30ba4f81706cfffbe2e7d4d8d3ffefe4366f6f7de9e0f562613c4d2be5b2a3"
    results.append({"corpus": corpus, "rows": off["rows"], "groups": expected_groups,
                    "chunks": len(on["chunks"]), "format4Chunks": on["summary"]["format4Chunks"],
                    "format4Rows": on["summary"]["format4Rows"], "savedBytes": saved,
                    "off": comparison["disabled"], "on": comparison["enabled"],
                    "fallbackCounts": comparison["fallbackCounts"], "completeOriginalOracle": off["finalOracle"],
                    "initialAndFinalSqlite": sql, "everyGroupRootVerified": True,
                    "allResourcesReleased": True, "allParserAndSourceColumnsUnchanged": True,
                    "allActualFieldRowsAndFinalFileReceiptsReconciled": True})

audit = {"schemaVersion": 1, "success": True, "timingEligible": False,
         "runId": index["runId"], "toolingCommit": index["toolingCommit"], "runtimeCommit": commit,
         "auditScript": identity(Path(__file__)), "artifacts": artifacts,
         "verificationManifest": identity(manifest_path), "protocol": identity(evidence / "protocol.json"),
         "originalOracleArchive": identity(archive), "verifiedOriginalOracleMembers": 8,
         "corpora": results,
         "scope": "Independent read-only reconciliation of retained, SHA-verified hosted receipts and original output oracles; no new import acquisition.",
         "limitations": ["Actual OPFS bytes were reread and hashed by the hosted runner before its temporary root was disposed; this audit rechecks retained receipts.",
                         "Sequential production-group term sink with real unpublished epoch0 SQLite state; media projection is checked but media persistence, committed floor13, restart and browser lookup are separate browser gates.",
                         "No latency or peak-memory qualification is claimed."]}
with args.output.open("x") as output:
    json.dump(audit, output, indent=2)
    output.write("\n")
print(json.dumps({"success": True, "corpora": [{key: item[key] for key in ["corpus", "rows", "groups", "chunks", "format4Chunks", "savedBytes"]} for item in results]}))
