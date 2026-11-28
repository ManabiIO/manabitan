#!/usr/bin/env python3
"""Preserve complete existing cell evidence, excluding only the two product ZIP payloads."""

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile
import zipfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def blob_sha(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


parser = argparse.ArgumentParser()
parser.add_argument("--staging", required=True, type=Path)
parser.add_argument("--cell", required=True, choices=["jmdict-AB", "jmdict-BA", "jitendex-AB", "vndb-AB"])
parser.add_argument("--repo", required=True, type=Path)
parser.add_argument("--output", required=True, type=Path)
args = parser.parse_args()
api_file = args.staging / (args.cell + "-artifact-api.json")
api = json.loads(api_file.read_text())
outer = args.staging / (args.cell + "-artifact.zip")
outer_digest = hashlib.sha256()
with outer.open("rb") as stream:
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        outer_digest.update(chunk)
assert outer.stat().st_size == api["size_in_bytes"]
assert api["digest"] == "sha256:" + outer_digest.hexdigest()
assert api["workflow_run"]["id"] == 46103918280
assert api["workflow_run"]["head_sha"] == "f65f4ef97ebf2f37a5b1b79ca7733d7b362ec963"
assert api["name"] == "import-owned-columns-83b3-" + args.cell
extraction_file = args.staging / args.cell / "extraction-manifest.json"
extraction = json.loads(extraction_file.read_text())
assert extraction["complete"] and extraction["cell"] == args.cell and extraction["artifactId"] == api["id"]
assert extraction["artifact"]["sha256"] == outer_digest.hexdigest()
source_members = {entry["path"]: entry for entry in extraction["files"]}
assert len(source_members) == len(extraction["files"])
report_file = args.staging / (args.cell + "-independent-analysis.json")
report = json.loads(report_file.read_text())
assert report["cell"] == args.cell and report["runId"] == 46103918280
reader = Path(__file__).resolve().with_name("analyze-cell.py")
assert sha(reader.read_bytes()) == report["analyzerSha256"] == "8c80a2ea267f4430d937efb56d4456bb6f11e60ea0465aa5bb3c2aead15239d9"
args.output.mkdir(parents=True, exist_ok=False)
archive_path = args.output / "evidence.tar.gz"
entries, names = [], set()


def add(archive, name, data):
    path = PurePosixPath(name)
    assert str(path) == name and not path.is_absolute() and ".." not in path.parts and "\\" not in name
    assert name not in names
    names.add(name)
    header = tarfile.TarInfo(name)
    header.size, header.mode, header.mtime = len(data), 0o644, 0
    header.uid = header.gid = 0
    archive.addfile(header, io.BytesIO(data))
    entries.append({"path": name, "bytes": len(data), "sha256": sha(data), "gitBlobSha": blob_sha(data)})


with archive_path.open("xb") as output:
    with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as archive:
            with zipfile.ZipFile(outer) as source:
                assert len(source.namelist()) == len(set(source.namelist()))
                for member in sorted(source.infolist(), key=lambda member: member.filename):
                    if member.is_dir():
                        continue
                    expected = source_members[member.filename]
                    if member.filename in ["import-owned-columns-83b3/package-A.zip", "import-owned-columns-83b3/package-B.zip"]:
                        continue
                    assert not member.filename.endswith(".zip"), "Unexpected omitted package"
                    data = source.read(member)
                    assert len(data) == expected["bytes"] and sha(data) == expected["sha256"]
                    add(archive, "artifact/" + member.filename, data)
            add(archive, "source-artifact-api.json", api_file.read_bytes())
            add(archive, "extraction-manifest.json", extraction_file.read_bytes())
            add(archive, "independent-analysis.json", report_file.read_bytes())
            add(archive, "workflow-job.log", (args.staging / args.cell / "workflow-job.log").read_bytes())
            for name in ["analyze-cell.py", "extract-artifact.py", "package-cell.py"]:
                add(archive, "tools/" + name, reader.with_name(name).read_bytes())
            prefix = str(args.repo.resolve()) + "/"
            source_count = 0
            for name, expected in sorted(report["inputFiles"].items()):
                if not name.startswith(prefix):
                    continue
                data = Path(name).read_bytes()
                assert len(data) == expected["bytes"] and sha(data) == expected["sha256"]
                add(archive, "frozen-repo/" + name[len(prefix):], data)
                source_count += 1
            assert source_count == 28
            contents = {"schemaVersion": 1, "complete": True, "newAcquisition": False,
                        "cell": args.cell, "runId": 46103918280, "sourceArtifactId": api["id"],
                        "sourceArtifactBytes": outer.stat().st_size, "sourceArtifactSha256": outer_digest.hexdigest(),
                        "allRequiredGatesPassed": report["allRequiredGatesPassed"],
                        "completeTimingScheduleVerified": report["completeTimingScheduleVerified"],
                        "timingClaim": False, "hostPooling": False, "controlSubtraction": False,
                        "fileCount": len(entries), "payloadBytes": sum(row["bytes"] for row in entries), "files": entries,
                        "exclusions": ["Only original package-A.zip and package-B.zip payloads. Their exact outer-artifact member hashes and complete inner member inventories remain preserved."],
                        "scope": "All original non-package artifact members including HTML, diagnostic trace if present, every raw timing/media/memory/source receipt, all tails, workflow log, independent readback and its exact frozen local inputs"}
            contents_bytes = (json.dumps(contents, indent=2, sort_keys=True) + "\n").encode()
            header = tarfile.TarInfo("CONTENTS.json")
            header.size, header.mode, header.mtime = len(contents_bytes), 0o644, 0
            archive.addfile(header, io.BytesIO(contents_bytes))
archive_bytes = archive_path.read_bytes()
manifest = {**contents, "contentsSha256": sha(contents_bytes), "archive": {
    "path": "evidence.tar.gz", "bytes": len(archive_bytes), "sha256": sha(archive_bytes), "gitBlobSha": blob_sha(archive_bytes)}}
(args.output / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
print(json.dumps({"cell": args.cell, "fileCount": len(entries), "payloadBytes": contents["payloadBytes"], "archive": manifest["archive"]}))
