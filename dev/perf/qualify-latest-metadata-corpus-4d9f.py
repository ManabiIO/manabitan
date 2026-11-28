#!/usr/bin/env python3
"""Freeze exact source/tooling identities and acquire one locked corpus."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tarfile
import traceback
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
for name in ("tooling", "source-a", "source-b", "corpus", "cache", "reports", "expected-tooling-commit"):
    parser.add_argument("--" + name, required=True)
args = parser.parse_args()
tooling = Path(args.tooling).resolve()
evidence = tooling / "builds/perf/20261128-4d9f-latest-metadata"
reports = Path(args.reports).resolve()
cache = Path(args.cache).resolve()
reports.mkdir(parents=True, exist_ok=True)
cache.mkdir(parents=True, exist_ok=True)
receipt = {"schemaVersion": 1, "timingEligible": False, "status": "preparing", "corpus": args.corpus}

def digest(data):
    return hashlib.sha256(data).hexdigest()

def read_json(path):
    return json.loads(path.read_bytes())

def git(root, *arguments):
    return subprocess.check_output(["git", "-C", str(root), *arguments], text=True).strip()

def save(name, value):
    with (reports / name).open("x") as output:
        json.dump(value, output, indent=2)
        output.write("\n")

try:
    assert args.corpus in ("jmdict", "jitendex", "vndb")
    receipt["toolingCommit"] = git(tooling, "rev-parse", "HEAD")
    assert receipt["toolingCommit"] == args.expected_tooling_commit
    receipt["toolingTree"] = git(tooling, "rev-parse", "HEAD^{tree}")
    manifest_bytes = (evidence / "verification-manifest.json").read_bytes()
    protocol_bytes = (evidence / "protocol.json").read_bytes()
    transition = read_json(evidence / "source-profile-transition.json")
    manifest = json.loads(manifest_bytes)
    assert digest(manifest_bytes) == transition["latestManifestSha256"]
    assert digest(protocol_bytes) == transition["latestProtocolSha256"]
    receipt["manifestSha256"] = digest(manifest_bytes)
    receipt["protocolSha256"] = digest(protocol_bytes)
    receipt["transitionSha256"] = digest((evidence / "source-profile-transition.json").read_bytes())
    receipt["orchestratorSha256"] = digest(Path(__file__).read_bytes())
    receipt["workflowSha256"] = digest((tooling / ".github/workflows/qualify-latest-metadata-corpus-4d9f.yml").read_bytes())
    receipt["source"] = {}
    for arm, location in (("A", args.source_a), ("B", args.source_b)):
        root = Path(location).resolve()
        actual = {"commit": git(root, "rev-parse", "HEAD"), "tree": git(root, "rev-parse", "HEAD^{tree}")}
        expected = transition["source"][arm]
        assert actual == {"commit": expected["commit"], "tree": expected["tree"]}, (arm, actual)
        assert actual["commit"] == manifest["sourceProfiles"][arm]["runtimeCommit"]
        receipt["source"][arm] = actual
    receipt["helperFiles"] = []
    for entry in transition["helperFiles"]:
        file = tooling / entry["path"]
        data = file.read_bytes()
        assert len(data) == entry["bytes"], entry["path"]
        assert digest(data) == entry["sha256"], entry["path"]
        assert git(tooling, "rev-parse", "HEAD:" + entry["path"]) == entry["sha"], entry["path"]
        receipt["helperFiles"].append({"path": entry["path"], "gitBlob": entry["sha"], "sha256": digest(data)})
    node = Path(shutil.which("node")).resolve()
    assert subprocess.check_output([str(node), "--version"], text=True).strip() == manifest["recordedNodeVersion"]
    node_sha = digest(node.read_bytes())
    assert node_sha == manifest["recordedLinuxX64NodeSha256"]
    receipt["node"] = {"version": manifest["recordedNodeVersion"], "sha256": node_sha, "path": str(node)}
    index = read_json(evidence / "verification-oracles-index.json")
    archive = evidence / index["archive"]
    archive_bytes = archive.read_bytes()
    assert len(archive_bytes) == index["bytes"]
    assert digest(archive_bytes) == index["sha256"] == transition["oracleArchive"]["sha256"]
    assert index["memberCount"] == len(index["members"]) == transition["oracleArchive"]["members"]
    with tarfile.open(archive, "r:gz") as package:
        members = package.getmembers()
        assert len(members) == index["memberCount"]
        assert {member.name for member in members} == set(index["members"])
        total = 0
        for member in members:
            name = PurePosixPath(member.name)
            assert member.isfile() and not member.issym() and not member.islnk()
            assert not name.is_absolute() and len(name.parts) == 2 and name.parts[0] == "oracles"
            assert all(part not in ("", ".", "..") for part in name.parts)
            expected = index["members"][member.name]
            assert member.size == expected["bytes"]
            data = package.extractfile(member).read()
            assert len(data) == expected["bytes"] and digest(data) == expected["sha256"], member.name
            target = evidence / member.name
            assert not target.exists(), "Do not replace extracted oracle members"
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as output:
                output.write(data)
            total += len(data)
        assert total == index["uncompressedMemberBytes"]
    receipt["oracleArchive"] = index
    lock_path = Path(args.source_a) / "test/perf/dictionaries.lock.json"
    lock_bytes = lock_path.read_bytes()
    assert digest(lock_bytes) == transition["dictionaryLock"]["sha256"]
    assert (Path(args.source_b) / "test/perf/dictionaries.lock.json").read_bytes() == lock_bytes
    fixture = json.loads(lock_bytes)["dictionaries"][args.corpus]
    receipt["fixture"] = fixture
    target = cache / fixture["cacheFile"]
    partial = Path(str(target) + ".partial")
    assert not target.exists() and not partial.exists(), "Use a fresh pinned-archive directory"
    request = urllib.request.Request(fixture["url"], headers={"User-Agent": "Manabitan-exact-corpus-verifier"})
    acquired = hashlib.sha256()
    count = 0
    with urllib.request.urlopen(request, timeout=120) as response, partial.open("xb") as output:
        while True:
            data = response.read(1024 * 1024)
            if not data:
                break
            count += len(data)
            assert count <= fixture["sizeBytes"], "Archive exceeds declared size"
            acquired.update(data)
            output.write(data)
    assert count == fixture["sizeBytes"]
    assert acquired.hexdigest() == fixture["sha256"]
    partial.rename(target)
    receipt["archive"] = {"bytes": count, "sha256": acquired.hexdigest()}
    receipt["status"] = "verified"
    for name in ("verification-manifest.json", "protocol.json", "source-profile-transition.json", "verification-oracles-index.json"):
        shutil.copyfile(evidence / name, reports / name)
    save("preflight.json", receipt)
    print(json.dumps({"status": receipt["status"], "corpus": args.corpus, "toolingCommit": receipt["toolingCommit"], "archive": receipt["archive"]}))
except BaseException as error:
    receipt["status"] = "failed"
    receipt["exception"] = {"type": type(error).__name__, "message": str(error), "traceback": traceback.format_exc()}
    save("preflight-failure.json", receipt)
    raise
