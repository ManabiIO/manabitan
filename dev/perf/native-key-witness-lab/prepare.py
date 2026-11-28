#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Build bounded compressed-source manifests from integrity-checked locked ZIPs."""
from pathlib import Path
import hashlib
import json
import struct
import sys
import zipfile

root, out, *names = map(Path, sys.argv[1:])
out.mkdir(parents=True, exist_ok=True)
lock_bytes = (root / "test/perf/dictionaries.lock.json").read_bytes()
lock = json.loads(lock_bytes)["dictionaries"]
for name_path in names:
    name = str(name_path)
    spec = lock[name]
    archive = (root / "builds/e2e-dictionary-cache" / spec["cacheFile"]).resolve()
    with archive.open("rb") as file:
        digest = hashlib.file_digest(file, "sha256").hexdigest()
    if digest != spec["sha256"] or archive.stat().st_size != spec["sizeBytes"]:
        raise ValueError("Pinned archive identity mismatch: " + name)
    entries = []
    with zipfile.ZipFile(archive) as reader, archive.open("rb") as file:
        for info in reader.infolist():
            if not (info.filename.startswith("term_bank_") and info.filename.endswith(".json")
                    and info.filename[10:-5].isdigit()):
                continue
            file.seek(info.header_offset)
            header = file.read(30)
            if header[:4] != b"PK\x03\x04":
                raise ValueError("Invalid local header")
            filename_bytes, extra_bytes = struct.unpack_from("<HH", header, 26)
            if info.compress_type not in (0, 8):
                raise ValueError("Unsupported fixture compression")
            entries.append(dict(filename=info.filename,
                                offset=info.header_offset + 30 + filename_bytes + extra_bytes,
                                compressedSize=info.compress_size, uncompressedSize=info.file_size,
                                signature=info.CRC, compressionMethod=info.compress_type))
    entries.sort(key=lambda item: int(item["filename"][10:-5]))
    result = dict(dictionary=name, archivePath=str(archive), archiveSha256=digest,
                  lockSha256=hashlib.sha256(lock_bytes).hexdigest(),
                  termRows=spec["termRows"], entries=entries,
                  sourceBytes=sum(entry["uncompressedSize"] for entry in entries))
    (out / (name + "-sources.json")).write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({key: result[key] for key in ("dictionary", "archiveSha256", "termRows", "sourceBytes")}))
