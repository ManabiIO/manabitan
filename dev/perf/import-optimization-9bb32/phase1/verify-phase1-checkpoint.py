#!/usr/bin/env python3
"""Verify this evidence archive and optionally reproduce its deterministic bytes."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_archive(files, output):
    with gzip.GzipFile(filename="", mode="wb", fileobj=output, compresslevel=9, mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as archive:
            for name in sorted(files):
                value = files[name]
                data = value.read_bytes() if isinstance(value, Path) else value
                info = tarfile.TarInfo(name)
                info.size = len(data)
                info.mtime = 0
                info.mode = 0o644
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                archive.addfile(info, io.BytesIO(data))


def verify(path, repack=None):
    files = {}
    with tarfile.open(path, "r:gz") as archive:
        for member in archive:
            if not member.isfile() or member.name in files:
                raise ValueError(f"Unexpected or repeated member: {member.name}")
            if member.name.startswith("/") or ".." in Path(member.name).parts:
                raise ValueError(f"Unsafe member path: {member.name}")
            if (member.mtime, member.uid, member.gid, member.mode, member.uname, member.gname) != (0, 0, 0, 0o644, "", ""):
                raise ValueError(f"Noncanonical metadata: {member.name}")
            files[member.name] = archive.extractfile(member).read()
    inventory = json.loads(files["INVENTORY.json"])
    expected = {entry["path"]: entry for entry in inventory["files"]}
    if set(files) != set(expected) | {"INVENTORY.json"}:
        raise ValueError("Archive membership differs from inventory")
    for name, entry in expected.items():
        data = files[name]
        if len(data) != entry["bytes"] or digest(data) != entry["sha256"]:
            raise ValueError(f"Evidence bytes differ: {name}")
    result = {"verifiedMembers": len(files), "rawBytes": sum(map(len, files.values())),
              "archiveBytes": path.stat().st_size, "archiveSha256": digest(path.read_bytes()),
              "inventorySha256": digest(files["INVENTORY.json"])}
    if repack is not None:
        with repack.open("wb") as output:
            write_archive(files, output)
        result["repackedSha256"] = digest(repack.read_bytes())
        result["byteIdenticalRepack"] = result["repackedSha256"] == result["archiveSha256"]
        if not result["byteIdenticalRepack"]:
            raise ValueError("Deterministic repack differs")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--repack", type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.archive, args.repack), indent=2))
