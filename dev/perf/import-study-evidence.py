#!/usr/bin/env python3
"""Preserve complete browser-study artifact payloads with per-file hashes."""

import argparse
import fnmatch
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile
import zipfile


INDEX = "evidence-index.json"


def checked(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def json_bytes(value):
    return (json.dumps(value, indent=2, allow_nan=False) + "\n").encode()


def safe_name(value):
    name = PurePosixPath(value)
    checked(value and not name.is_absolute() and ".." not in name.parts and "\\" not in value,
            f"Unsafe archive name: {value}")
    checked(str(name) == value and value != INDEX, f"Noncanonical or reserved name: {value}")
    return value


def mapping(value):
    name, separator, path = value.partition("=")
    checked(separator and path, "Expected ARCHIVE_NAME=LOCAL_PATH")
    return safe_name(name), Path(path)


def add_bytes(archive, name, data):
    entry = tarfile.TarInfo(name)
    entry.size = len(data)
    entry.mode = 0o644
    entry.mtime = 0
    archive.addfile(entry, io.BytesIO(data))


def pack(args):
    output = args.output
    sidecar = output.with_name(output.name + ".json")
    checked(not output.exists() and not sidecar.exists(), "Refusing to replace existing evidence")
    output.parent.mkdir(parents=True, exist_ok=True)
    files = {}
    sources = []
    temporary = output.with_name(output.name + ".tmp")
    checked(not temporary.exists(), "An earlier incomplete archive exists")

    with tarfile.open(temporary, "w:xz", preset=6) as archive:
        def add(name, data, source):
            safe_name(name)
            checked(name not in files, f"Duplicate archive path: {name}")
            files[name] = {"bytes": len(data), "sha256": digest(data), "source": source}
            add_bytes(archive, name, data)

        for value in args.zip:
            prefix, path = mapping(value)
            identity = {"kind": "zip", "path": str(path.resolve()), "prefix": prefix,
                        "bytes": path.stat().st_size, "sha256": file_digest(path)}
            sources.append(identity)
            with zipfile.ZipFile(path) as original:
                names = set()
                for entry in original.infolist():
                    checked(entry.filename not in names, "Duplicate original ZIP member")
                    names.add(entry.filename)
                    if entry.is_dir():
                        continue
                    # ZIP.read verifies each original member's CRC. Retain every file,
                    # including failed commands, logs, raw reports and slow observations.
                    add(prefix + "/" + safe_name(entry.filename), original.read(entry),
                        {"zip": prefix, "entry": entry.filename, "crc32": entry.CRC})

        for value in args.directory:
            prefix, path = mapping(value)
            checked(path.is_dir() and not path.is_symlink(), f"Expected ordinary directory: {path}")
            sources.append({"kind": "directory", "path": str(path.resolve()), "prefix": prefix})
            for item in sorted(path.rglob("*")):
                name = prefix + "/" + item.relative_to(path).as_posix()
                if any(fnmatch.fnmatchcase(name, pattern) for pattern in args.exclude):
                    continue
                checked(not item.is_symlink(), f"Refusing evidence symlink: {item}")
                if item.is_file():
                    checked(item.resolve() not in (output.resolve(), sidecar.resolve(), temporary.resolve()),
                            "Archive must not include its own outputs")
                    add(name, item.read_bytes(), {"directory": prefix})

        for value in args.file:
            name, path = mapping(value)
            checked(path.is_file() and not path.is_symlink(), f"Expected ordinary file: {path}")
            add(name, path.read_bytes(), {"file": str(path.resolve())})

        index = {"schemaVersion": 1, "sources": sources, "exclusions": args.exclude, "files": files,
                 "preservation": "Every original ZIP file payload is included byte-for-byte. ZIP container metadata is not reconstructed; original ZIP SHA256 identities are retained."}
        add_bytes(archive, INDEX, json_bytes(index))

    temporary.replace(output)
    receipt = {"schemaVersion": 1, "archive": output.name, "archiveBytes": output.stat().st_size,
               "archiveSha256": file_digest(output), "indexMember": INDEX,
               "payloadFiles": len(files), "payloadBytes": sum(item["bytes"] for item in files.values()),
               "sourceZips": [item for item in sources if item["kind"] == "zip"],
               "verification": "Use this script's verify command; it reads every payload and rejects missing, extra, duplicate or changed files."}
    sidecar.write_bytes(json_bytes(receipt))
    print(json.dumps(receipt))


def verify(args):
    receipt = json.loads(args.archive.with_name(args.archive.name + ".json").read_text())
    checked(args.archive.stat().st_size == receipt["archiveBytes"] and
            file_digest(args.archive) == receipt["archiveSha256"], "Archive identity differs")
    with tarfile.open(args.archive, "r:xz") as archive:
        entries = archive.getmembers()
        names = [entry.name for entry in entries]
        checked(len(set(names)) == len(names), "Duplicate tar member")
        checked(all(entry.isfile() for entry in entries), "Non-file tar member")
        index = json.load(archive.extractfile(INDEX))
        checked(set(names) == set(index["files"]) | {INDEX}, "Missing or extra archive members")
        for name, expected in index["files"].items():
            safe_name(name)
            data = archive.extractfile(name).read()
            checked(len(data) == expected["bytes"] and digest(data) == expected["sha256"], f"Changed payload: {name}")
        checked(len(index["files"]) == receipt["payloadFiles"] and
                sum(item["bytes"] for item in index["files"].values()) == receipt["payloadBytes"], "Incorrect receipt totals")
    print(json.dumps({"verified": True, "archiveSha256": receipt["archiveSha256"], "files": receipt["payloadFiles"]}))


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    writer = commands.add_parser("pack")
    writer.add_argument("--output", type=Path, required=True)
    writer.add_argument("--zip", action="append", default=[])
    writer.add_argument("--directory", action="append", default=[])
    writer.add_argument("--file", action="append", default=[])
    writer.add_argument("--exclude", action="append", default=[])
    reader = commands.add_parser("verify")
    reader.add_argument("archive", type=Path)
    args = parser.parse_args()
    (pack if args.command == "pack" else verify)(args)


if __name__ == "__main__":
    main()
