#!/usr/bin/env python3
"""Verify and replay the portable evidence with Python 3.11+ only."""

import argparse
import gzip
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True
from packet_lib import SCHEMA, check, derive_cell, json_bytes, safe_path, sha256


def verify(packet, output):
    started = time.monotonic()
    manifest_data = (packet / "manifest.json").read_bytes()
    manifest_sha = sha256(manifest_data)
    check((packet / "MANIFEST.sha256").read_text().split()[0] == manifest_sha, "Manifest anchor differs")
    published_anchor = Path(__file__).resolve().parent / "FULL_PACKET_MANIFEST.sha256"
    if published_anchor.is_file():
        check(published_anchor.read_text().split()[0] == manifest_sha, "Full packet differs from the published Git anchor")
    manifest = json.loads(manifest_data)
    check(manifest["schema"] == SCHEMA and manifest["cellCount"] == 20, "Wrong packet schema or cell coverage")
    for name, expected in manifest["packetFiles"].items():
        path = packet.joinpath(*safe_path(name).parts)
        check(not path.is_symlink() and path.is_file(), "Missing/nonregular packet file: " + name)
        data = path.read_bytes()
        check(len(data) == expected["bytes"] and sha256(data) == expected["sha256"], "Packet file differs: " + name)
    for name in ("verify.py", "packet_lib.py"):
        check(sha256((Path(__file__).parent / name).read_bytes()) == manifest["packetFiles"][name]["sha256"], "Verifier differs from full packet: " + name)

    def blob_bytes(digest):
        info = manifest["blobs"][digest]
        check(0 <= info["bytes"] <= 64 * 1024 * 1024, "Invalid blob size")
        path = packet.joinpath(*safe_path(info["path"]).parts)
        check(not path.is_symlink(), "Blob symlink rejected")
        compressed = path.read_bytes()
        check(len(compressed) == info["compressedBytes"] and sha256(compressed) == info["compressedSha256"], "Compressed blob differs: " + digest)
        with gzip.GzipFile(fileobj=io.BytesIO(compressed), mode="rb") as stream:
            body = stream.read(info["bytes"] + 1)
        check(len(body) == info["bytes"] and sha256(body) == digest, "Expanded blob differs: " + digest)
        return body

    for digest in manifest["blobs"]:
        blob_bytes(digest)
    output.mkdir(parents=True, exist_ok=True)
    observations, pairs, cohorts, failures, results = [], [], [], [], []
    with tempfile.TemporaryDirectory(prefix=".replay-", dir=packet) as temporary:
        temporary = Path(temporary)
        for reference in manifest["cells"]:
            cell = json.loads((packet / reference["manifest"]).read_bytes())
            evidence = temporary / cell["id"]
            evidence.mkdir(parents=True)
            for entry in cell["files"]:
                safe_path(entry["path"])
                if not entry["retained"]:
                    continue
                body = blob_bytes(entry["sha256"])
                check(len(body) == entry["bytes"], "Wrong restored member size")
                destination = evidence.joinpath(*safe_path(entry["path"]).parts)
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(body)
            audit_path = temporary / (cell["id"] + "-access.json")
            command = [sys.executable, "-I", "-S", "-B", str(packet / "guarded_replay.py"), str(evidence / cell["analyzer"]), str(evidence), str(audit_path)]
            result = subprocess.run(command, cwd=evidence, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=45, check=False)
            expected_exit = 0 if cell["expectedValid"] else 1
            check(result.returncode == expected_exit, f"{cell['id']}: expected analyzer exit {expected_exit}, got {result.returncode}: {result.stderr.decode()[-2000:]}")
            original = json.loads((evidence / "analysis.json").read_bytes())
            actual = json.loads(result.stdout)
            check(actual == original, "Archived replay changed result: " + cell["id"])
            check(actual["complete"] is cell["expectedValid"], "Original failure was reclassified")
            if not cell["expectedValid"]:
                check("RuntimeError: Invalid cohort" in result.stderr.decode(), "Unexpected failure exit")
            access = json.loads(audit_path.read_bytes())
            check(access["deniedOperations"] == [], "Replay attempted forbidden I/O")
            check(set(access["readFiles"]) == set(cell["analyzerReadFiles"]), "Archived analyzer read set changed")
            for entry in cell["files"]:
                if entry["retained"]:
                    check(sha256((evidence / entry["path"]).read_bytes()) == entry["sha256"], "Analyzer changed a restored member")
            cell["archivePaths"] = [entry["path"] for entry in cell["files"]]
            derived = derive_cell(cell, lambda name: (evidence / name).read_bytes())
            observations.extend(derived[0])
            pairs.extend(derived[1])
            cohorts.append(derived[2])
            failures.extend(derived[3])
            (output / (cell["id"] + ".stdout.json")).write_bytes(result.stdout)
            (output / (cell["id"] + ".stderr.txt")).write_bytes(result.stderr)
            (output / (cell["id"] + ".access.json")).write_bytes(json_bytes(access, True))
            results.append({"cell": cell["id"], "expectedValid": cell["expectedValid"], "actualValid": actual["complete"], "exitCode": result.returncode, "exactOriginalAnalysis": True, "observations": actual["observations"], "errors": len(actual["errors"]), "readFiles": len(access["readFiles"]), "externalDataReads": 0, "networkOperations": 0, "stdoutSha256": sha256(result.stdout), "stderrSha256": sha256(result.stderr)})
            shutil.rmtree(evidence)
            print(json.dumps({"cell": cell["id"], "expectedValid": cell["expectedValid"], "replayMatches": True}), flush=True)
    expected_summaries = {
        "summaries/observations.jsonl": b"".join(json_bytes(item) for item in observations),
        "summaries/pairs.jsonl": b"".join(json_bytes(item) for item in pairs),
        "summaries/cohorts.json": json_bytes(cohorts, True),
        "summaries/failures.json": json_bytes(failures, True),
    }
    for name, body in expected_summaries.items():
        check((packet / name).read_bytes() == body, "Independently derived summary differs: " + name)
    check(len(observations) == 576 and len(pairs) == 288 and len(failures) == 72, "Unexpected full coverage")
    check(sum(row["eligibleForPerformanceClaim"] for row in observations) == 504, "Changed qualified count")
    check(sum(cell["actualValid"] for cell in results) == 17, "Changed cell dispositions")
    receipt = {"schema": SCHEMA, "complete": True, "manifestSha256": manifest_sha, "pythonVersion": sys.version.split()[0], "elapsedSeconds": round(time.monotonic() - started, 3), "cellCount": 20, "validCells": 17, "expectedInvalidCells": 3, "observations": 576, "qualifiedObservations": 504, "invalidObservationsPreserved": 72, "pairs": 288, "allSummariesRecomputedFromRawTimers": True, "allArchivedAnalysesExactlyReproduced": True, "offlineReadOnlyAnalyzerGuard": True, "otherWorkspaceFilesReadByAnalyzers": 0, "browserRuns": 0, "networkOperations": 0, "cells": results}
    (output / "receipt.json").write_bytes(json_bytes(receipt, True))
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--packet", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    packet = args.packet.resolve()
    output = (args.output or packet / "verification").resolve()
    check(output.is_relative_to(packet), "Verification output must stay inside the full packet")
    result = verify(packet, output)
    print(json.dumps({key: value for key, value in result.items() if key != "cells"}, indent=2))


if __name__ == "__main__":
    main()
