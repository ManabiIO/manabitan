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

from binding import ARTIFACT_PREFIX, BASELINE, HEAD, READER_SHA256, RUN_ATTEMPT, RUN_ID, read_binding


def sha(data):
    return hashlib.sha256(data).hexdigest()


def blob_sha(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


parser = argparse.ArgumentParser()
parser.add_argument("--staging", required=True, type=Path)
parser.add_argument("--cell", required=True, choices=["jmdict-AB", "jmdict-BA", "jitendex-AB", "vndb-AB"])
parser.add_argument("--repo", required=True, type=Path)
parser.add_argument("--reader", required=True, type=Path)
parser.add_argument("--output", required=True, type=Path)
args = parser.parse_args()
api_file = args.staging / (args.cell + "-artifact-api.json")
api, identity_binding = read_binding(args.staging, args.cell)
outer = args.staging / (args.cell + "-artifact.zip")
outer_digest = hashlib.sha256()
with outer.open("rb") as stream:
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        outer_digest.update(chunk)
assert outer.stat().st_size == api["size_in_bytes"]
assert api["digest"] == "sha256:" + outer_digest.hexdigest()
assert api["workflow_run"]["id"] == RUN_ID
assert api["workflow_run"]["head_sha"] == HEAD
assert api["name"] == ARTIFACT_PREFIX + "-" + args.cell
extraction_file = args.staging / args.cell / "extraction-manifest.json"
extraction = json.loads(extraction_file.read_text())
assert extraction["complete"] and extraction["cell"] == args.cell and extraction["artifactId"] == api["id"]
assert extraction["artifact"]["sha256"] == outer_digest.hexdigest()
assert extraction["identityBinding"] == identity_binding
assert extraction["runId"] == RUN_ID and extraction["runAttempt"] == RUN_ATTEMPT and extraction["headSha"] == HEAD
source_members = {entry["path"]: entry for entry in extraction["files"]}
assert len(source_members) == len(extraction["files"])
report_file = args.staging / (args.cell + "-independent-analysis.json")
report = json.loads(report_file.read_text())
assert report["cell"] == args.cell and report["runId"] == RUN_ID
assert report["baseline"] == BASELINE and report["candidate"] == HEAD
reader = args.reader.resolve()
assert sha(reader.read_bytes()) == report["analyzerSha256"] == READER_SHA256
tools_root = Path(__file__).resolve().parent
assert extraction["extractorSha256"] == sha((tools_root / "extract-artifact.py").read_bytes())
frozen_file = tools_root / "frozen-repo-inputs.json"
assert sha(frozen_file.read_bytes()) == "b6827e71b38ad2b69f5c58411e610d51a996bd866fdb233ca3aecbcceba9524b"
frozen = json.loads(frozen_file.read_text())
assert frozen["baseline"] == BASELINE and frozen["readerSha256"] == READER_SHA256
frozen_files = {row["path"]: row for row in frozen["files"]}
assert len(frozen_files) == len(frozen["files"]) == 14
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
                    if member.filename in [ARTIFACT_PREFIX + "/package-A.zip", ARTIFACT_PREFIX + "/package-B.zip"]:
                        continue
                    assert not member.filename.endswith(".zip"), "Unexpected omitted package"
                    data = source.read(member)
                    assert len(data) == expected["bytes"] and sha(data) == expected["sha256"]
                    add(archive, "artifact/" + member.filename, data)
            add(archive, "source-artifact-api.json", api_file.read_bytes())
            add(archive, "extraction-manifest.json", extraction_file.read_bytes())
            add(archive, "independent-analysis.json", report_file.read_bytes())
            for name in identity_binding["inputFiles"]:
                data = (args.staging / name).read_bytes()
                expected = identity_binding["inputFiles"][name]
                assert len(data) == expected["bytes"] and sha(data) == expected["sha256"]
                add(archive, "transport/" + name, data)
            add(archive, "transport/identity-binding.json", (json.dumps(identity_binding, indent=2, sort_keys=True) + "\n").encode())
            add(archive, "tools/analyze-cell.py", reader.read_bytes())
            for name in ["extract-artifact.py", "package-cell.py", "binding.py", "frozen-repo-inputs.json"]:
                add(archive, "tools/" + name, (tools_root / name).read_bytes())
            prefix = str(args.repo.resolve()) + "/"
            reported_repo_inputs = {}
            for name, expected in sorted(report["inputFiles"].items()):
                if name.startswith(prefix):
                    relative = name[len(prefix):]
                    assert relative in frozen_files
                    assert expected == {key: frozen_files[relative][key] for key in ("bytes", "sha256")}
                    reported_repo_inputs[relative] = expected
            for name, expected in sorted(frozen_files.items()):
                source = args.repo / name
                assert source.is_file() and not source.is_symlink()
                data = source.read_bytes()
                assert len(data) == expected["bytes"] and sha(data) == expected["sha256"]
                add(archive, "frozen-repo/" + name, data)
            contents = {"schemaVersion": 1, "complete": True, "newAcquisition": False,
                        "cell": args.cell, "runId": RUN_ID, "runAttempt": RUN_ATTEMPT, "sourceArtifactId": api["id"],
                        "identityBinding": identity_binding, "readerObservedRepoInputCount": len(reported_repo_inputs),
                        "sourceArtifactBytes": outer.stat().st_size, "sourceArtifactSha256": outer_digest.hexdigest(),
                        "allRequiredGatesPassed": report["allRequiredGatesPassed"],
                        "completeTimingScheduleVerified": report["completeTimingScheduleVerified"],
                        "timingClaim": False, "hostPooling": False, "controlSubtraction": False,
                        "fileCount": len(entries), "payloadBytes": sum(row["bytes"] for row in entries), "files": entries,
                        "exclusions": ["Only original package-A.zip and package-B.zip payloads, when present. Their outer member hashes remain; the independent report records whether complete inner-member verification succeeded."],
                        "meaningOfComplete": "Evidence archive construction completed; qualification failures and incomplete jobs remain separate.",
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
