"""Verify every candidate packed image directly against the pinned source ZIP."""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import zipfile
import zlib

parser = argparse.ArgumentParser()
parser.add_argument("--archive", required=True, type=Path)
parser.add_argument("--baseline", required=True, type=Path)
parser.add_argument("--candidate", required=True, type=Path)
parser.add_argument("--output", required=True, type=Path)
args = parser.parse_args()
baseline = json.loads(args.baseline.read_text())
candidate = json.loads(args.candidate.read_text())
for key in ("descriptor", "indexSha256", "payloadSha256", "rangeStart", "rangeReadCount", "rangeReadBytes", "compressedBytes", "uncompressedBytes"):
    assert baseline[key] == candidate[key], key
index_a = Path(str(args.baseline) + ".index.bin").read_bytes()
index = Path(str(args.candidate) + ".index.bin").read_bytes()
assert index == index_a
assert hashlib.sha256(index).hexdigest() == candidate["indexSha256"]
descriptor = candidate["descriptor"]
assert len(index) == descriptor["slotCount"] * 24
with args.archive.open("rb") as stream:
    archive_sha = hashlib.file_digest(stream, "sha256").hexdigest()
assert archive_sha == "da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792"
assert args.archive.stat().st_size == candidate["archiveBytes"] == 291705969
occupied = set()
for slot in range(descriptor["slotCount"]):
    row = index[slot * 24 : (slot + 1) * 24]
    offset, length, output_size, signature, identity, checksum = struct.unpack("<6I", row)
    assert identity == descriptor["firstId"] + slot
    assert zlib.crc32(row[:20]) == checksum
    if offset:
        occupied.add(identity)
    else:
        assert (length, output_size, signature) == (0, 0, 0)
assert len(occupied) == descriptor["count"] == 146570
verified = set()
decoded_bytes = 0
stored = 0
content_digest = hashlib.sha256()
with zipfile.ZipFile(args.archive) as archive, args.archive.open("rb") as packed:
    images = [entry for entry in archive.infolist() if entry.filename.endswith(".webp")]
    assert len(images) == 146570
    assert min(entry.header_offset for entry in images) == candidate["rangeStart"]
    for entry in images:
        name = entry.filename
        assert name.startswith(descriptor["prefix"]) and name.endswith(descriptor["suffix"])
        digits = name[len(descriptor["prefix"]) : -len(descriptor["suffix"])]
        image_id = int(digits)
        assert str(image_id) == digits and image_id in occupied and image_id not in verified
        slot = image_id - descriptor["firstId"]
        offset, length_flags, output_size, signature, _, _ = struct.unpack_from("<6I", index, slot * 24)
        length = length_flags & 0x7FFFFFFF
        assert offset > 0 and 0 < length <= descriptor["dataBytes"] - (offset - 1)
        assert output_size == entry.file_size and signature == entry.CRC
        packed.seek(candidate["rangeStart"] + offset - 1)
        payload = packed.read(length)
        assert len(payload) == length
        if length_flags & 0x80000000:
            decoder = zlib.decompressobj(-15)
            decoded = decoder.decompress(payload) + decoder.flush()
            assert decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail
        else:
            stored += 1
            decoded = payload
        expected = archive.read(entry)
        assert decoded == expected and len(decoded) == output_size and zlib.crc32(decoded) == signature
        encoded_path = name.encode("utf-8")
        content_digest.update(struct.pack("<I", len(encoded_path)))
        content_digest.update(encoded_path)
        content_digest.update(struct.pack("<Q", len(decoded)))
        content_digest.update(decoded)
        verified.add(image_id)
        decoded_bytes += len(decoded)
assert verified == occupied
assert decoded_bytes == 188131284
result = {
    "complete": True,
    "images": len(verified),
    "decodedBytes": decoded_bytes,
    "storedImages": stored,
    "deflatedImages": len(verified) - stored,
    "indexBytes": len(index),
    "indexSha256": candidate["indexSha256"],
    "packedBytes": descriptor["dataBytes"],
    "packedSha256": candidate["payloadSha256"],
    "sourceZipSha256": archive_sha,
    "allMediaContentSha256": content_digest.hexdigest(),
    "indexSlots": descriptor["slotCount"],
    "emptySlots": descriptor["slotCount"] - len(verified),
}
with args.output.open("x") as out:
    out.write(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
