"""Reproduce the original inline fixture hash and complete term-row count."""

import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("repository", type=Path)
parser.add_argument("fixtures", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
lock_path = args.repository / "test/perf/dictionaries.lock.json"
lock_bytes = lock_path.read_bytes()
specifications = json.loads(lock_bytes)["dictionaries"]
result = {"lockSha256": hashlib.sha256(lock_bytes).hexdigest(), "fixtures": []}

for dictionary_id in ["jmdict", "jitendex", "vndb"]:
    spec = specifications[dictionary_id]
    archive_path = args.fixtures / spec["cacheFile"]
    digest = hashlib.sha256()
    with archive_path.open("rb") as archive_file:
        for block in iter(lambda: archive_file.read(8 * 1024 * 1024), b""):
            digest.update(block)
    assert digest.hexdigest() == spec["sha256"]
    assert archive_path.stat().st_size == spec["sizeBytes"]
    with zipfile.ZipFile(archive_path) as archive:
        index = json.loads(archive.read("index.json"))
        banks = [
            entry for entry in archive.infolist()
            if re.fullmatch(r"term_bank_\d+\.json", entry.filename)
        ]
        row_count = sum(len(json.loads(archive.read(bank))) for bank in banks)
        assert row_count == spec["termRows"]
        result["fixtures"].append({
            "id": dictionary_id,
            "archivePath": str(archive_path.resolve()),
            "archiveBytes": archive_path.stat().st_size,
            "sha256": digest.hexdigest(),
            "title": index["title"],
            "revision": index["revision"],
            "termBanks": len(banks),
            "termRows": row_count,
            "termJsonBytes": sum(bank.file_size for bank in banks),
            "archiveFiles": len(archive.infolist()),
            "expectedReferencedMediaFiles": spec.get("mediaFiles"),
            "expectedReferencedMediaBytes": spec.get("mediaBytes"),
        })

args.output.write_text(json.dumps(result, indent=2) + "\n")
