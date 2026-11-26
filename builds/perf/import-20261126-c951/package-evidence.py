#!/usr/bin/env python3
"""Verify the original c951 artifacts and retain all evidence except release ZIPs."""

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile
import zipfile


BASELINE = "0143e9596cd8f790d5e166d4ba6a2425fbc57f14"
CANDIDATE = "5a667ed90e2f92a8d7140ec751ee63e34b40b500"
TOOLING = "7e6dda05470da6e29af2b06bc50dde26f14633fb"
RUN_ID = 45862057912
EXPECTED_CHANGE = ["js/dictionary/dictionary-database.js"]
CELLS = {f"{dictionary}-{order}" for dictionary in ("jmdict", "jitendex", "vndb") for order in ("AB", "BA")}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def safe_members(archive):
    members = [item for item in archive.infolist() if not item.is_dir()]
    names = [item.filename for item in members]
    require(len(names) == len(set(names)), "Duplicate ZIP member")
    for name in names:
        path = PurePosixPath(name)
        require(not path.is_absolute() and ".." not in path.parts, f"Unsafe member: {name}")
    return members


def write_archive(output, name, members):
    path = output / name
    manifest = [{"path": key, "bytes": len(data), "sha256": sha(data)} for key, data in sorted(members.items())]
    with path.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as archive:
                for item in manifest:
                    info = tarfile.TarInfo(item["path"])
                    info.size = item["bytes"]
                    info.mode = 0o644
                    info.mtime = 0
                    archive.addfile(info, io.BytesIO(members[item["path"]]))
    with tarfile.open(path, "r:gz") as archive:
        require(archive.getnames() == [item["path"] for item in manifest], f"Archive inventory mismatch: {name}")
        for item in manifest:
            data = archive.extractfile(item["path"]).read()
            require(len(data) == item["bytes"] and sha(data) == item["sha256"], f"Archive content mismatch: {item['path']}")
    return {"path": name, "bytes": path.stat().st_size, "sha256": sha(path.read_bytes()), "members": manifest}


def package_cell(acquisition, artifact, output):
    cell = artifact["name"].removeprefix("private-content-reservations-").removesuffix("-c951")
    require(cell in CELLS, f"Unexpected cell: {cell}")
    require(artifact["name"] == f"private-content-reservations-{cell}-c951", "Unexpected artifact name")
    require(artifact["workflow_run"]["id"] == RUN_ID and artifact["workflow_run"]["head_sha"] == TOOLING, "Wrong acquisition")
    source = acquisition / f"{cell}.zip"
    source_bytes = source.read_bytes()
    require(len(source_bytes) == artifact["size_in_bytes"], f"Artifact size mismatch: {cell}")
    require("sha256:" + sha(source_bytes) == artifact["digest"], f"Artifact digest mismatch: {cell}")
    retained = {}
    excluded = []
    with zipfile.ZipFile(io.BytesIO(source_bytes)) as original:
        members = safe_members(original)
        require(original.testzip() is None, f"Artifact CRC failure: {cell}")
        identities = json.loads(original.read("source-identities.json"))
        plan = json.loads(original.read("registered-plan.json"))
        require(plan["baseline"] == BASELINE and plan["candidate"] == CANDIDATE, "Wrong product source")
        require(plan["flags"] == {} and plan["expectedWorkers"] is None and plan["pairs"] == 6, "Changed experiment settings")
        require(f"{plan['dictionary']}-{plan['initialOrder']}" == cell, "Cell identity mismatch")
        require(identities["changedPackageEntries"] == EXPECTED_CHANGE, "Unexpected package difference")
        actual_entries = {}
        for arm, expected_sha in (("A", BASELINE), ("B", CANDIDATE)):
            identity = identities["arms"][arm]
            require(identity["sha"] == expected_sha, "Incorrect arm identity")
            name = f"package-{arm}.zip"
            data = original.read(name)
            require(sha(data) == identity["packageSha256"], f"Product package hash mismatch: {cell}/{arm}")
            with zipfile.ZipFile(io.BytesIO(data)) as package:
                entries = safe_members(package)
                require(package.testzip() is None, f"Product package CRC failure: {cell}/{arm}")
                actual = {item.filename: sha(package.read(item)) for item in entries}
                require(actual == identity["entries"], f"Product package entry mismatch: {cell}/{arm}")
                actual_entries[arm] = actual
            excluded.append({"path": name, "bytes": len(data), "sha256": sha(data), "verifiedEntryCount": len(actual), "entryHashesPath": "source-identities.json", "reason": "Rebuildable release ZIP; every entry and full ZIP independently verified before exclusion"})
        require(actual_entries["A"].keys() == actual_entries["B"].keys(), "Package entry set differs")
        changes = sorted(key for key in actual_entries["A"] if actual_entries["A"][key] != actual_entries["B"][key])
        require(changes == EXPECTED_CHANGE, "Actual product changes exceed allowlist")
        for item in members:
            if item.filename not in ("package-A.zip", "package-B.zip"):
                retained[item.filename] = original.read(item)
    log = acquisition / "job-logs" / f"{cell}.log"
    require(log.is_file(), f"Missing outer failure/completion log: {cell}")
    require("github-job.log" not in retained and "package-verification.json" not in retained, "Reserved evidence name collision")
    retained["github-job.log"] = log.read_bytes()
    retained["package-verification.json"] = json_bytes({"excluded": excluded, "changedPackageEntries": changes, "originalArtifact": artifact})
    archive = write_archive(output, f"{cell}.tar.gz", retained)
    return {"cell": cell, "originalArtifact": artifact, "excludedReleasePackages": excluded, "archive": archive}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("acquisition", type=Path, help="Original downloaded ZIPs, acquisition-metadata.json and job-logs/")
    parser.add_argument("components", type=Path, help="Prepared source census, independent audits and withdrawn-candidate evidence")
    parser.add_argument("output", type=Path, help="Output directory; no observations are acquired or changed")
    args = parser.parse_args()
    metadata_bytes = (args.acquisition / "acquisition-metadata.json").read_bytes()
    metadata = json.loads(metadata_bytes)
    require(metadata["acquisitionRunId"] == RUN_ID and metadata["acquisitionToolingCommit"] == TOOLING, "Incorrect acquisition metadata")
    names = {item["name"].removeprefix("private-content-reservations-").removesuffix("-c951") for item in metadata["artifacts"]}
    require(names == CELLS and len(metadata["artifacts"]) == 6, "All six original cells, including failures, are required")
    args.output.mkdir(parents=True, exist_ok=True)
    cells = [package_cell(args.acquisition, artifact, args.output) for artifact in sorted(metadata["artifacts"], key=lambda item: item["name"])]
    components = {str(path.relative_to(args.components)): path.read_bytes() for path in sorted(args.components.rglob("*")) if path.is_file()}
    require(components, "Missing component evidence")
    require("acquisition-metadata.json" not in components or components["acquisition-metadata.json"] == metadata_bytes, "Reserved component name collision")
    components["acquisition-metadata.json"] = metadata_bytes
    manifest = {
        "schemaVersion": 1,
        "acquisitionRunId": RUN_ID,
        "acquisitionToolingCommit": TOOLING,
        "acquisitionMetadataSha256": sha(metadata_bytes),
        "baseline": BASELINE,
        "runtimeQualificationCandidate": CANDIDATE,
        "finalProductCommit": "23e8574a70543e1590eedf3d63cb4f09d0084878",
        "unchangedProductBlob": "ddd25b9e4001d69d0822b56d721b3c2301f2fae2",
        "finalHeadDifference": "Test mock byte copy only; product runtime bytes unchanged",
        "sourcePullRequest": 936,
        "evidencePullRequest": 945,
        "withdrawnPullRequest": 949,
        "replacementObservations": False,
        "releasePackageBytesRetained": False,
        "releasePackageLimit": "Original release ZIPs were verified completely, then excluded. Committed evidence retains their hashes and all entry hashes but cannot rehash the excluded ZIP bytes after original Actions artifacts expire.",
        "components": write_archive(args.output, "component-evidence.tar.gz", components),
        "cells": cells,
    }
    (args.output / "evidence-manifest.json").write_bytes(json_bytes(manifest))
    print(json.dumps({"status": "verified", "cells": len(cells), "retainedMembers": sum(len(cell["archive"]["members"]) for cell in cells) + len(manifest["components"]["members"]), "archiveBytes": sum(cell["archive"]["bytes"] for cell in cells) + manifest["components"]["bytes"]}))


if __name__ == "__main__":
    main()
