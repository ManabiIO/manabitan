#!/usr/bin/env python3
"""Verify retained phase2A bytes and bindings without running any import or test.

The parent Git tree supplies the trusted INVENTORY.json identity. Omitted ZIPs,
HTML, browser executables, and corpus payloads cannot be rehashed from this
checkpoint; their original verification receipts are checked for consistency.
"""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def blob(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def identity(data):
    return {"bytes": len(data), "sha256": sha(data), "gitBlobSha1": blob(data)}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def safe_name(name):
    path = PurePosixPath(name)
    require(bool(name) and not path.is_absolute() and ".." not in path.parts and "\\" not in name,
            f"Unsafe archive name: {name}")


def pack(path, files):
    """Deterministic metadata only; never transform a member's bytes."""
    with Path(path).open("xb") as output:
        with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0, compresslevel=9) as compressed:
            with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as archive:
                for name, data in sorted(files.items()):
                    safe_name(name)
                    member = tarfile.TarInfo(name)
                    member.size = len(data)
                    member.mode = 0o644
                    member.uid = member.gid = member.mtime = 0
                    member.uname = member.gname = ""
                    archive.addfile(member, io.BytesIO(data))


def check_identity(data, expected, context):
    actual = identity(data)
    for key in ("bytes", "sha256", "gitBlobSha1"):
        if key in expected:
            require(actual[key] == expected[key], f"{context}: {key} mismatch")


def read_archive(path, expected, retain=(), sorted_members=False):
    retained = {}
    names = []
    raw_bytes = 0
    with tarfile.open(path, "r|gz") as archive:
        for member in archive:
            safe_name(member.name)
            require(member.isfile(), f"Non-regular archive member: {member.name}")
            require(member.name not in names, f"Duplicate member: {member.name}")
            require(member.name in expected, f"Unlisted member: {member.name}")
            require((member.uid, member.gid, member.uname, member.gname, member.mtime, member.mode)
                    == (0, 0, "", "", 0, 0o644), f"Non-deterministic metadata: {member.name}")
            data = archive.extractfile(member).read()
            check_identity(data, expected[member.name], member.name)
            if retain is True or member.name in retain:
                retained[member.name] = data
            names.append(member.name)
            raw_bytes += len(data)
    require(set(names) == set(expected), f"Missing members in {path.name}")
    if sorted_members:
        require(names == sorted(names), "Proof archive members are not sorted")
    return retained, {"members": len(names), "uncompressedBytes": raw_bytes}


def verify(folder, repack=None, phase1=None):
    folder = Path(folder)
    inventory = json.loads((folder / "INVENTORY.json").read_bytes())
    declared = {item["name"]: item for item in inventory["files"]}
    require(len(declared) == len(inventory["files"]), "Duplicate outer inventory name")
    for name, item in declared.items():
        safe_name(name)
        path = folder / name
        require(path.is_file() and not path.is_symlink(), f"Missing regular publication item: {name}")
        check_identity(path.read_bytes(), item, name)

    proof_inventory_data = (folder / "PROOF-INVENTORY.json").read_bytes()
    proof_inventory = json.loads(proof_inventory_data)
    expected = {item["path"]: item for item in proof_inventory["files"]}
    require(len(expected) == len(proof_inventory["files"]), "Duplicate proof inventory name")
    expected["PROOF-INVENTORY.json"] = identity(proof_inventory_data)
    proofs, proof_summary = read_archive(folder / "proofs-and-sources.tar.gz", expected, retain=True,
                                         sorted_members=True)
    for name in ("README.md", "STATUS.json", "CELL-INDEX.json", "EXCLUSIONS.json",
                 "PHASE1-DEPENDENCIES.json", "build-phase2a-checkpoint.py", "verify-phase2a-checkpoint.py"):
        require(proofs[name] == (folder / name).read_bytes(), f"Outer/inner metadata differs: {name}")

    status = json.loads(proofs["STATUS.json"])
    require(status["fingerprint"]["decision"] == "SHELVE; no reproducible full-import gain; no PR",
            "Fingerprint decision changed")
    require(status["pullRequestsCreatedByThisTask"] == 0, "Unexpected PR claim")
    published = json.loads(proofs["profiling/long-keyword-correctness-phase2/published-source-identity.json"])
    require(published["remote"]["commit"] == status["wideKeyword"]["source"], "Wide source pin mismatch")
    require(published["sameCompleteTree"] is True, "Wide source tree equality absent")
    for item in published["local"]["files"]:
        name = "source-snapshots/wide-keyword/" + item["path"]
        check_identity(proofs[name], item, name)
    qa = json.loads(proofs["profiling/minsize-hosted-qa.json"])
    require(qa["sourceSha"] == status["minsize"]["source"] and qa["conclusion"] == "success",
            "Minsize source QA binding failed")

    cells = []
    cell_index = json.loads(proofs["CELL-INDEX.json"])
    require(len(cell_index["cells"]) == 6, "Expected six fingerprint cells")
    for cell in cell_index["cells"]:
        prefix = "profiling/hosted-qualification/fingerprint/" + cell["cell"] + "/"
        retention_bytes = proofs[prefix + "retention-manifest.json"]
        retention = json.loads(retention_bytes)
        github = json.loads(proofs[prefix + "github-artifact.json"])
        analysis = json.loads(proofs[prefix + "audit-and-stage-analysis.json"])
        audit = json.loads(proofs[prefix + "independent-semantics-memory-audit.json"])
        source = retention["sourceArtifact"]
        require(source["id"] == github["id"] and source["bytes"] == github["size_in_bytes"],
                f"{cell['cell']}: original artifact identity differs")
        require("sha256:" + source["sha256"] == github["digest"], "Original artifact digest differs")
        require(source["runId"] == github["workflow_run"]["id"] == status["fingerprint"]["qualificationRun"],
                "Original run identity differs")
        require(github["workflow_run"]["head_sha"] == status["fingerprint"]["workflowCommit"],
                "Workflow source differs")
        require(source == cell["sourceArtifact"], "Cell-index original artifact differs")
        archive_path = folder / cell["publicationName"]
        check_identity(archive_path.read_bytes(), retention["retainedArchive"], cell["cell"])
        retained_expected = {**retention["included"], **retention["derived"]}
        require(len(retention["included"]) == 269 and len(retention["derived"]) == 1,
                "Unexpected retained raw-file counts")
        retained, raw_summary = read_archive(archive_path, retained_expected,
                                            retain={"registered-plan.json", "source-identities.json", "derived-package-audit.json"})
        require(raw_summary["members"] == retention["retainedArchive"]["verifiedFileCount"] == 270,
                "Unexpected raw archive member count")
        plan = json.loads(retained["registered-plan.json"])
        original_identity = json.loads(retained["source-identities.json"])
        packages = json.loads(retained["derived-package-audit.json"])
        require(packages["passes"] is True, "Original package rehash did not pass")
        require(plan["baseline"] == status["baselineCommit"] and plan["candidate"] == status["fingerprint"]["source"],
                "Cell source pins differ")
        require(plan["dictionary"] + "-" + plan["initialOrder"] == cell["cell"], "Cell plan label differs")
        require(plan["pairs"] == 12 and len(plan["schedule"]) == 36, "Frozen schedule differs")
        omitted = retention["omittedRedundant"]
        require(len(omitted) == 44 and sum(name.endswith(".html") for name in omitted) == 42,
                "Unexpected omitted HTML count")
        require({name for name in omitted if not name.endswith(".html")} == {"package-A.zip", "package-B.zip"},
                "Unexpected omitted payloads")
        for arm, source_pin in (("A", plan["baseline"]), ("B", plan["candidate"])):
            packaged = packages["arms"][arm]
            identified = original_identity["arms"][arm]
            require(packaged["sourceSha"] == identified["sha"] == source_pin, "Nested package source differs")
            require(packaged["entries"] == identified["entries"], "Nested member map differs")
            require(packaged["entryCount"] == len(packaged["entries"]) == 554, "Nested member count differs")
            require(packaged["packageSha256"] == identified["packageSha256"] == omitted[f"package-{arm}.zip"]["sha256"],
                    "Omitted original package digest differs")
        arm_a, arm_b = packages["arms"]["A"]["entries"], packages["arms"]["B"]["entries"]
        require(arm_a.keys() == arm_b.keys(), "Package name sets differ")
        changed = sorted(name for name, digest in arm_a.items() if digest != arm_b[name])
        require(changed == sorted(plan["expectedPackageEntries"]) == sorted(packages["changedPackageEntries"])
                == sorted(original_identity["changedPackageEntries"]) and len(changed) == 5,
                "Prospective package delta differs")
        require(analysis["checksPassed"] and analysis["allImportCount"] == 42 and analysis["checkCount"] == 585,
                "Cell source/native/stage audit did not pass")
        require(audit["passed"] and audit["failedChecks"] == [] and audit["semanticSummary"]["observations"] == 42,
                "Independent semantic/memory audit did not pass")
        require(audit["archiveSha256"] == retention["retainedArchive"]["sha256"]
                and audit["retentionManifestSha256"] == sha(retention_bytes), "Independent audit binding differs")
        require(audit["memorySummary"]["everyObservationQualified"]
                and audit["memorySummary"]["passesProspectiveMemoryScreen"], "Independent memory qualification failed")
        require(audit["sourceArtifact"] == source, "Independent original artifact binding differs")
        cells.append({"cell": cell["cell"], **raw_summary, "allImportCount": 42,
                      "sourceNativeStageChecks": analysis["checkCount"], "independentChecks": audit["checkCount"],
                      "rawMemoryScans": audit["memorySummary"]["rawScanCount"],
                      "omittedPayloadsRehashedByThisVerifier": False})

    deps = json.loads(proofs["PHASE1-DEPENDENCIES.json"])
    prior_inventory_bytes = proofs["prior-checkpoint/phase1-INVENTORY.json"]
    check_identity(prior_inventory_bytes, deps["inventory"], "Phase1 inventory")
    prior_inventory = {item["path"]: item for item in json.loads(prior_inventory_bytes)["files"]}
    for item in deps["members"]:
        require(prior_inventory[item["path"]] == item["phase1InventoryEntry"], "Phase1 dependency locator differs")
    prior_verification = "Not supplied; immutable phase1 inventory locators verified only"
    if phase1 is not None:
        phase1 = Path(phase1)
        check_identity(phase1.read_bytes(), deps["archive"], "Immutable phase1 archive")
        wanted = {item["path"]: item["phase1InventoryEntry"] for item in deps["members"]}
        seen = set()
        with tarfile.open(phase1, "r|gz") as archive:
            for member in archive:
                if member.name in wanted:
                    check_identity(archive.extractfile(member).read(), wanted[member.name], member.name)
                    seen.add(member.name)
        require(seen == set(wanted), "Missing immutable phase1 dependencies")
        prior_verification = {"archiveVerified": True, "dependencyMembersVerified": len(seen)}

    repack_equal = None
    if repack is not None:
        pack(repack, proofs)
        repack_equal = sha(Path(repack).read_bytes()) == sha((folder / "proofs-and-sources.tar.gz").read_bytes())
        require(repack_equal, "Deterministic proof repack differs")
    return {"passed": True, "scope": "Retained-byte integrity and receipt binding; no new import, test, timing, or omitted-payload rehash",
            "outerFilesVerified": len(declared), "proofArchive": proof_summary,
            "proofSha256": sha((folder / "proofs-and-sources.tar.gz").read_bytes()),
            "cells": cells, "rawArchiveMembersVerified": sum(c["members"] for c in cells),
            "originalImportReceiptsBound": sum(c["allImportCount"] for c in cells),
            "phase1": prior_verification, "deterministicRepackEqual": repack_equal,
            "unlistedOuterFiles": sorted(p.name for p in folder.iterdir() if p.is_file()
                                         and p.name not in declared and p.name != "INVENTORY.json")}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, nargs="?", default=Path(__file__).resolve().parent)
    parser.add_argument("--repack", type=Path, help="Create one new deterministic proof archive at this absent path")
    parser.add_argument("--phase1", type=Path, help="Optionally verify the immutable phase1 archive and dependency bytes")
    args = parser.parse_args()
    print(json.dumps(verify(args.directory, args.repack, args.phase1), indent=2, sort_keys=True))
