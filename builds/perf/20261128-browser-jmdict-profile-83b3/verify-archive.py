#!/usr/bin/env python3
"""Stream-check the exact archive without extraction or code execution."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import tarfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def blob_sha(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


parser = argparse.ArgumentParser()
parser.add_argument("--manifest", type=Path, default=Path(__file__).resolve().with_name("ARCHIVE-MANIFEST.json"))
args = parser.parse_args()
manifest = json.loads(args.manifest.read_text())
archive_info = manifest["archive"]
raw = (args.manifest.parent / archive_info["path"]).read_bytes()
assert len(raw) == archive_info["bytes"] and sha(raw) == archive_info["sha256"] and blob_sha(raw) == archive_info["gitBlobSha"]
expected = {row["path"]: row for row in manifest["files"]}
assert len(expected) == len(manifest["files"]) == manifest["fileCount"]
seen, payload_bytes = set(), 0
with tarfile.open(args.manifest.parent / archive_info["path"], "r:gz") as archive:
    for member in archive:
        path = PurePosixPath(member.name)
        assert member.isfile() and not path.is_absolute() and ".." not in path.parts and "\\" not in member.name
        assert str(path) == member.name and member.name not in seen
        seen.add(member.name)
        assert member.name == "CONTENTS.json" or member.name in expected
        if member.name != "CONTENTS.json":
            assert member.size == expected[member.name]["bytes"]
        stream = archive.extractfile(member)
        assert stream is not None
        data = stream.read()
        assert len(data) == member.size
        if member.name == "CONTENTS.json":
            assert sha(data) == manifest["contentsSha256"]
            contents = json.loads(data)
            assert contents == {key: value for key, value in manifest.items() if key not in ["archive", "contentsSha256"]}
        else:
            entry = expected[member.name]
            assert sha(data) == entry["sha256"] and blob_sha(data) == entry["gitBlobSha"]
            payload_bytes += len(data)
assert seen == set(expected) | {"CONTENTS.json"}
assert payload_bytes == manifest["payloadBytes"]
print(json.dumps({"complete": True, "fileCount": len(expected), "payloadBytes": payload_bytes,
                  "archiveBytes": len(raw), "archiveSha256": sha(raw), "extracted": False}))
