#!/usr/bin/env python3
"""Check all archive members and their hashes without extracting or running them."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import tarfile


def identity(data):
    return {
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "gitBlobSha": hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest(),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("--manifest", type=Path)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text()) if args.manifest else None
    if manifest:
        observed = identity(args.archive.read_bytes())
        assert all(observed[key] == manifest["archive"][key] for key in observed), "archive identity"
    with tarfile.open(args.archive, "r:gz") as archive:
        members = archive.getmembers()
        names = [member.name for member in members]
        assert len(names) == len(set(names)), "duplicate archive members"
        for member in members:
            path = PurePosixPath(member.name)
            assert member.isfile() and not path.is_absolute() and ".." not in path.parts, member.name
        contents_bytes = archive.extractfile("CONTENTS.json").read()
        contents = json.loads(contents_bytes)
        if manifest:
            observed = identity(contents_bytes)
            assert all(observed[key] == manifest["embeddedContents"][key] for key in observed)
            assert contents["files"] == manifest["files"]
        assert set(names) == {entry["path"] for entry in contents["files"]} | {"CONTENTS.json"}
        for entry in contents["files"]:
            observed = identity(archive.extractfile(entry["path"]).read())
            assert all(observed[key] == entry[key] for key in observed), entry["path"]
        assert contents["fileCount"] == len(contents["files"])
        assert contents["totalBytes"] == sum(entry["bytes"] for entry in contents["files"])
    print(json.dumps({"verified": True, "payloadFiles": contents["fileCount"], "payloadBytes": contents["totalBytes"], "extraction": False, "experimentExecution": False}))


if __name__ == "__main__":
    main()
