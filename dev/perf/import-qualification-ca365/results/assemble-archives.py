#!/usr/bin/env python3
"""Create deterministic, byte-preserving archives of the completed import audit."""

import argparse
import lzma
import hashlib
import io
import json
from pathlib import Path
import tarfile


def collect_archive_inputs(root, sources):
    """Keep canonical files and describe duplicate replay aliases separately."""
    entries = set()
    source_directories = []
    for source in sources:
        if not source.exists():
            raise RuntimeError(f"Missing completed source: {source}")
        if source.is_symlink() or source.resolve(strict=True) != source:
            raise RuntimeError(f"Noncanonical archive source: {source}")
        if not source.is_relative_to(root):
            raise RuntimeError(f"Archive source outside workspace: {source}")
        entries.add(source)
        if source.is_dir():
            source_directories.append(source)
            entries.update(source.rglob("*"))

    aliases = sorted(path for path in entries if path.is_symlink())
    canonical_entries = {
        path for path in entries if not path.is_symlink()
        and "__pycache__" not in path.parts and path.suffix != ".pyc"
    }
    files = {path for path in canonical_entries if path.is_file()}
    directories = {path for path in canonical_entries if path.is_dir()}
    if any(path.suffix == ".zip" for path in files):
        raise RuntimeError("Unexpected unverified ZIP in archive inputs")

    alias_records = []
    preserved_directories = set()
    for alias in aliases:
        relative = alias.relative_to(root)
        if "independent-replay" not in relative.parts:
            raise RuntimeError(f"Unexpected symlink outside independent replay: {alias}")
        target = alias.resolve(strict=True)
        if not any(target.is_relative_to(source) for source in source_directories):
            raise RuntimeError(f"Replay alias target outside its archive group: {alias}")
        if target in files:
            kind = "file"
        elif target in directories:
            kind = "directory"
            preserved_directories.add(target)
        else:
            raise RuntimeError(f"Replay alias target is not preserved canonically: {alias}")
        alias_records.append({
            "path": str(relative),
            "canonicalTarget": str(target.relative_to(root)),
            "targetKind": kind,
        })
    return sorted(files), sorted(preserved_directories), alias_records


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("workspace", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    root = args.workspace.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    groups = {
        "metadata-timing": [root / "hosted-metadata-timing"],
        "native-timing": [root / "hosted-native-timing"],
        "prior-native-timing": [root / "hosted-native-current-screen-45642169759"],
        "prior-native-memory": [root / "hosted-memory/prior-run-45642179064"],
    }
    for candidate in ["metadata-witness", "native-projection"]:
        for dictionary in ["jmdict", "jitendex", "vndb"]:
            groups[f"memory-{candidate}-{dictionary}"] = [
                root / "hosted-memory" / f"{candidate}-{dictionary}-{host}"
                for host in [1, 2]
            ]
    groups["memory-audit-tooling"] = [
        path for path in (root / "hosted-memory").iterdir() if path.is_file()
    ]
    result = []
    for name, sources in groups.items():
        paths, directories, aliases = collect_archive_inputs(root, sources)
        directory_names = [str(path.relative_to(root)) for path in directories]
        inventory = []
        destination = output / f"{name}.tar.xz"
        with destination.open("wb") as target:
            with lzma.LZMAFile(target, mode="wb", format=lzma.FORMAT_XZ, preset=6) as compressed:
                with tarfile.open(fileobj=compressed, mode="w|") as archive:
                    for relative in directory_names:
                        info = tarfile.TarInfo(relative)
                        info.type = tarfile.DIRTYPE
                        info.mode = 0o755
                        info.mtime = 0
                        archive.addfile(info)
                    for path in paths:
                        if path.is_symlink() or path.resolve(strict=True) != path:
                            raise RuntimeError(f"Canonical archive file changed: {path}")
                        content = path.read_bytes()
                        relative = str(path.relative_to(root))
                        info = tarfile.TarInfo(relative)
                        info.size = len(content)
                        info.mode = 0o644
                        info.mtime = 0
                        archive.addfile(info, io.BytesIO(content))
                        inventory.append({"path": relative, "bytes": len(content),
                                          "sha256": hashlib.sha256(content).hexdigest()})
        files_by_path = {item["path"]: item for item in inventory}
        for alias in aliases:
            if (root / alias["path"]).resolve(strict=True) != root / alias["canonicalTarget"]:
                raise RuntimeError(f"Replay alias changed during archival: {alias['path']}")
            if alias["targetKind"] == "file":
                canonical_file = files_by_path[alias["canonicalTarget"]]
                alias["bytes"] = canonical_file["bytes"]
                alias["sha256"] = canonical_file["sha256"]
        entry = {
            "archive": destination.name,
            "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
            "bytes": destination.stat().st_size,
            "fileCount": len(inventory),
            "uncompressedBytes": sum(item["bytes"] for item in inventory),
            "files": inventory,
            "directories": directory_names,
            "symlinkAliases": aliases,
        }
        with tarfile.open(destination, mode="r:xz") as archive:
            members = archive.getmembers()
            directory_members = members[:len(directory_names)]
            file_members = members[len(directory_names):]
            if any(not member.isdir() for member in directory_members) or any(
                not member.isfile() for member in file_members
            ):
                raise RuntimeError("Unexpected archive member type")
            if [member.name.rstrip("/") for member in directory_members] != directory_names:
                raise RuntimeError("Archive directory inventory mismatch")
            if [member.name for member in file_members] != [item["path"] for item in inventory]:
                raise RuntimeError("Archive member inventory mismatch")
            for member, item in zip(file_members, inventory):
                content = archive.extractfile(member).read()
                if len(content) != item["bytes"] or hashlib.sha256(content).hexdigest() != item["sha256"]:
                    raise RuntimeError(f"Archive byte mismatch: {member.name}")
        result.append(entry)
        print(json.dumps({key: value for key, value in entry.items()
                          if key not in {"files", "directories", "symlinkAliases"}}), flush=True)
    (output / "archive-manifest.json").write_text(json.dumps({
        "schemaVersion": 1,
        "acquisitionCommit": "7b021ebe3e7625a56ab9dde346ae72f3cd39b770",
        "timingRun": 45647030745,
        "memoryRun": 45647030792,
        "scope": "Raw reports, source/package manifests, audits, failures, and provenance. Downloaded outer and inner release ZIPs were verified before removal; their GitHub artifact identifiers and digests are retained.",
        "archives": result,
    }, indent=4) + "\n")


if __name__ == "__main__":
    main()
