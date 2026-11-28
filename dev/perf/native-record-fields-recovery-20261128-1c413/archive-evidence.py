#!/usr/bin/env python3
"""Preserve original correctness evidence without following or extracting links."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import tarfile


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def canonical(value):
    value = str(value)
    path = PurePosixPath(value)
    require(value and bool(path.parts) and "\\" not in value and "\x00" not in value and
            not path.is_absolute() and str(path) == value and
            all(part not in ("", ".", "..") for part in path.parts),
            "Expected a canonical relative evidence path")
    return path


def scoped_path(repository, value):
    relative = canonical(value)
    path = repository.joinpath(*relative.parts)
    parent = path.parent
    while parent != repository:
        require(not parent.is_symlink(), "Evidence ancestor is a symlink: " + str(parent))
        parent = parent.parent
    return path


def hash_stream(stream):
    result = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b""):
        result.update(block)
    return result.hexdigest()


def open_regular(path):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        require(stat.S_ISREG(os.fstat(descriptor).st_mode), "Expected a regular evidence file")
        return os.fdopen(descriptor, "rb")
    except BaseException:
        os.close(descriptor)
        raise


def file_identity(path):
    with open_regular(path) as stream:
        size = os.fstat(stream.fileno()).st_size
        return {"bytes": size, "sha256": hash_stream(stream)}


def inventory(repository, roots):
    members = {}
    missing = []

    def visit(path):
        info = path.lstat()
        name = path.relative_to(repository).as_posix()
        require(name not in members, "Duplicate evidence root/member: " + name)
        if stat.S_ISLNK(info.st_mode):
            members[name] = {"kind": "symlink", "target": os.readlink(path)}
        elif stat.S_ISDIR(info.st_mode):
            members[name] = {"kind": "directory"}
            for child in sorted(path.iterdir()):
                visit(child)
        elif stat.S_ISREG(info.st_mode):
            members[name] = {"kind": "file", **file_identity(path)}
        else:
            raise RuntimeError("Unsupported evidence member type: " + name)

    for relative in roots:
        path = scoped_path(repository, relative)
        try:
            path.lstat()
        except FileNotFoundError:
            missing.append(str(canonical(relative)))
            continue
        visit(path)
    return members, missing


def verify_archive(archive, members):
    verified = {}
    with tarfile.open(archive, "r:gz") as source:
        for item in source:
            require(item.name not in verified and item.name in members,
                    "Unexpected or duplicate archived member: " + item.name)
            expected = members[item.name]
            if item.isdir() and expected["kind"] == "directory":
                value = {"kind": "directory"}
            elif item.issym() and expected["kind"] == "symlink":
                value = {"kind": "symlink", "target": item.linkname}
                require(item.size == 0, "A symlink must have no payload")
            elif item.isfile() and expected["kind"] == "file":
                stream = source.extractfile(item)
                require(stream is not None, "Missing regular archive payload")
                with stream:
                    value = {"kind": "file", "bytes": item.size, "sha256": hash_stream(stream)}
            else:
                raise RuntimeError("Unexpected archived member type: " + item.name)
            require(value == expected, "Archived evidence identity changed: " + item.name)
            verified[item.name] = value
    require(verified == members, "Archive member inventory differs")
    return verified


def archive_evidence(repository, roots, archive_path, receipt_path):
    repository = Path(repository).resolve(strict=True)
    require(repository.is_dir(), "Evidence repository is not a directory")
    roots = [str(canonical(value)) for value in roots]
    require(roots and len(roots) == len(set(roots)), "Expected unique evidence roots")
    archive = scoped_path(repository, archive_path)
    receipt_file = scoped_path(repository, receipt_path)
    require(archive != receipt_file, "Archive and receipt must be distinct")
    for output in (archive, receipt_file):
        require(not output.exists() and not output.is_symlink(), "Refusing to replace existing evidence")
        for relative in roots:
            root = repository / relative
            require(output != root and not output.is_relative_to(root),
                    "Archive outputs cannot be inside an evidence root")
        output.parent.mkdir(parents=True, exist_ok=True)
    members, missing = inventory(repository, roots)
    with tarfile.open(archive, "w:gz", format=tarfile.PAX_FORMAT, dereference=False) as target:
        for name, expected in sorted(members.items()):
            path = scoped_path(repository, name)
            info = target.gettarinfo(path, arcname=name)
            if expected["kind"] == "symlink":
                require(info.issym() and info.linkname == expected["target"],
                        "Evidence symlink changed before archiving")
                target.addfile(info)
            elif expected["kind"] == "directory":
                require(info.isdir(), "Evidence directory type changed")
                target.addfile(info)
            else:
                # A hardlinked ordinary file is stored as its own complete bytes.
                require(info.isfile() or info.islnk(), "Evidence regular-file type changed")
                info.type = tarfile.REGTYPE
                info.linkname = ""
                info.size = expected["bytes"]
                with open_regular(path) as stream:
                    require(os.fstat(stream.fileno()).st_size == expected["bytes"], "Evidence file size changed")
                    target.addfile(info, stream)
    verify_archive(archive, members)
    identity = file_identity(archive)
    receipt = {
        "kind": "complete-corpus-evidence-archive",
        "archive": archive.name,
        "archiveBytes": identity["bytes"],
        "archiveSha256": identity["sha256"],
        "members": members,
        "missingRequestedRoots": missing,
        "verified": True,
        "symlinkPolicy": "Preserve type and raw target only; never follow, materialize or extract.",
        "hardlinkPolicy": "Regularize each ordinary-file payload; no hardlink members.",
        "performanceMeasurements": False,
    }
    receipt_file.write_text(json.dumps(receipt, indent=2, sort_keys=True, allow_nan=False) + "\n")
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True, type=Path)
    parser.add_argument("--root", action="append", required=True)
    parser.add_argument("--archive", required=True)
    parser.add_argument("--receipt", required=True)
    args = parser.parse_args()
    result = archive_evidence(args.repository, args.root, args.archive, args.receipt)
    print(json.dumps({key: result[key] for key in (
        "kind", "archive", "archiveBytes", "archiveSha256",
        "missingRequestedRoots", "verified", "symlinkPolicy", "hardlinkPolicy",
    )} | {"memberCount": len(result["members"])}, sort_keys=True))


if __name__ == "__main__":
    main()
