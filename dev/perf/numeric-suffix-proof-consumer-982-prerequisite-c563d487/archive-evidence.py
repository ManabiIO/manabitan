#!/usr/bin/env python3
"""Preserve all original non-package evidence after acquisition; never change observations."""
import argparse
import base64
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys
import zipfile

PREFIX = "MANABITAN_EVIDENCE_ARCHIVE_"
EXCLUDED_NAMES = {"package-A.zip", "package-B.zip"}
CHUNK_BYTES = 6144  # Every full base64 chunk is exactly 8192 characters.

def emit(kind, value):
    print(PREFIX + kind + " " + json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False), flush=True)

def digest_file(path):
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1048576), b""):
            size += len(block)
            digest.update(block)
    return {"bytes": size, "sha256": digest.hexdigest()}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    root = args.evidence.resolve()
    archive_path = root.parent / (root.name + ".raw-evidence.zip")
    manifest_path = root.parent / (root.name + ".raw-evidence-manifest.json")
    stage = "original-inventory"
    try:
        if not root.is_dir():
            raise ValueError("Original evidence directory is absent")
        if archive_path.exists() or manifest_path.exists():
            raise ValueError("Never overwrite an earlier archive or manifest")
        paths = sorted(root.rglob("*"))
        members, excluded = [], []
        regular = []
        for path in paths:
            if path.is_symlink():
                raise ValueError("Unexpected evidence symlink")
            if path.is_dir():
                continue
            if not path.is_file():
                raise ValueError("Unexpected non-regular evidence member")
            relative = path.relative_to(root).as_posix()
            if PurePosixPath(relative).is_absolute() or ".." in PurePosixPath(relative).parts:
                raise ValueError("Unexpected member path")
            if relative in EXCLUDED_NAMES:
                excluded.append({"path": relative, **digest_file(path),
                                 "reason": "Reproducible release-package copy; complete source/package-entry maps remain included"})
            else:
                regular.append((path, relative))
        stage = "lossless-archive"
        # Both outputs are siblings of the input directory, so neither can include itself.
        with zipfile.ZipFile(archive_path, mode="x", compression=zipfile.ZIP_DEFLATED) as archive:
            for path, relative in regular:
                before_size = path.stat().st_size
                info = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                digest = hashlib.sha256()
                size = 0
                with path.open("rb") as source, archive.open(info, "w") as target:
                    for block in iter(lambda: source.read(1048576), b""):
                        target.write(block)
                        digest.update(block)
                        size += len(block)
                if size != before_size or path.stat().st_size != before_size:
                    raise ValueError("Original evidence member changed during postprocessing")
                members.append({"path": relative, "bytes": size, "sha256": digest.hexdigest()})
        stage = "archive-roundtrip"
        with zipfile.ZipFile(archive_path) as archive:
            if archive.namelist() != [item["path"] for item in members]:
                raise ValueError("Archive member inventory differs")
            for item in members:
                digest = hashlib.sha256()
                size = 0
                with archive.open(item["path"]) as stream:
                    for block in iter(lambda: stream.read(1048576), b""):
                        size += len(block)
                        digest.update(block)
                if size != item["bytes"] or digest.hexdigest() != item["sha256"]:
                    raise ValueError("Archive member bytes differ")
        archive_identity = digest_file(archive_path)
        git_blob_digest = hashlib.sha1(b"blob " + str(archive_identity["bytes"]).encode("ascii") + b"\0")
        with archive_path.open("rb") as stream:
            for block in iter(lambda: stream.read(1048576), b""):
                git_blob_digest.update(block)
        archive_identity["gitBlobSha1"] = git_blob_digest.hexdigest()
        chunks = (archive_identity["bytes"] + CHUNK_BYTES - 1) // CHUNK_BYTES
        manifest = {
            "schemaVersion": 1, "complete": True,
            "scope": "Lossless post-acquisition archive. Every original regular evidence member is included except exactly the two root release-package copies.",
            "sourceDirectory": root.name, "archiveFile": archive_path.name,
            "archive": archive_identity, "members": members, "excluded": excluded,
            "memberCount": len(members), "excludedNames": sorted(EXCLUDED_NAMES),
            "chunkBytes": CHUNK_BYTES, "chunkCount": chunks,
            "acquisitionOrObservationsChanged": False,
        }
        manifest_bytes = (json.dumps(manifest, indent=2, allow_nan=False) + "\n").encode()
        with manifest_path.open("xb") as target:
            target.write(manifest_bytes)
        stage = "bounded-log-emission"
        header = {key: value for key, value in manifest.items() if key not in ("members", "excluded")}
        header["manifestSha256"] = hashlib.sha256(manifest_bytes).hexdigest()
        emit("START", header)
        for member in members:
            emit("MEMBER", member)
        for member in excluded:
            emit("EXCLUDED", member)
        with archive_path.open("rb") as stream:
            for index in range(chunks):
                block = stream.read(CHUNK_BYTES)
                if not block:
                    raise ValueError("Archive ended before declared chunk count")
                emit("CHUNK", {"index": index, "data": base64.b64encode(block).decode("ascii")})
            if stream.read(1):
                raise ValueError("Archive exceeded declared chunk count")
        emit("COMPLETE", {"complete": True, "archive": archive_identity, "chunkCount": chunks,
                          "memberCount": len(members), "excludedCount": len(excluded),
                          "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
                          "acquisitionOrObservationsChanged": False})
    except BaseException as error:
        emit("FAILED", {"complete": False, "stage": stage, "errorType": type(error).__name__,
                        "acquisitionOrObservationsChanged": False})
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
