#!/usr/bin/env python3
"""Independently compare every packed media record with the pinned source ZIP."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import zipfile
import zlib

parser = argparse.ArgumentParser()
parser.add_argument('--archive', required=True, type=Path)
parser.add_argument('--evidence', required=True, type=Path)
args = parser.parse_args()
metadata = json.loads((args.evidence / 'oracle-input.json').read_text())
fixture = metadata['fixture']
descriptor = metadata['descriptor']
index_a = (args.evidence / 'A-index.bin').read_bytes()
index = (args.evidence / 'B-index.bin').read_bytes()
assert index == index_a
assert hashlib.sha256(index).hexdigest() == metadata['indexSha256']
assert len(index) == descriptor['slotCount'] * 24
packed_path = args.evidence / 'packed-media.bin'
assert packed_path.stat().st_size == descriptor['dataBytes'] == metadata['blobIdentity']['bytes']
with packed_path.open('rb') as stream:
    assert hashlib.file_digest(stream, 'sha256').hexdigest() == metadata['blobIdentity']['sha256']
with args.archive.open('rb') as stream:
    assert hashlib.file_digest(stream, 'sha256').hexdigest() == fixture['sha256']
assert args.archive.stat().st_size == fixture['sizeBytes']
occupied = set()
for slot in range(descriptor['slotCount']):
    row = index[slot * 24:(slot + 1) * 24]
    offset, length, output_size, signature, identity, checksum = struct.unpack('<6I', row)
    assert identity == descriptor['firstId'] + slot
    assert zlib.crc32(row[:20]) == checksum
    if offset:
        occupied.add(identity)
    else:
        assert (length, output_size, signature) == (0, 0, 0)
assert len(occupied) == descriptor['count'] == fixture['mediaFiles']
verified = set()
media_bytes = 0
stored = 0
content_digest = hashlib.sha256()
with zipfile.ZipFile(args.archive) as archive, packed_path.open('rb') as packed:
    images = [entry for entry in archive.infolist() if re.search(r'\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)$', entry.filename, re.I)]
    assert len(images) == fixture['mediaFiles']
    for entry in images:
        path = entry.filename
        assert path.startswith(descriptor['prefix']) and path.endswith(descriptor['suffix'])
        digits = path[len(descriptor['prefix']):-len(descriptor['suffix'])]
        image_id = int(digits)
        assert str(image_id) == digits and image_id in occupied and image_id not in verified
        slot = image_id - descriptor['firstId']
        offset, length_flags, output_size, signature, _, _ = struct.unpack_from('<6I', index, slot * 24)
        length = length_flags & 0x7fffffff
        assert offset > 0 and 0 < length <= descriptor['dataBytes'] - (offset - 1)
        assert output_size == entry.file_size and signature == entry.CRC
        packed.seek(offset - 1)
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
        encoded_path = path.encode('utf-8')
        content_digest.update(struct.pack('<I', len(encoded_path)))
        content_digest.update(encoded_path)
        content_digest.update(struct.pack('<Q', len(decoded)))
        content_digest.update(decoded)
        verified.add(image_id)
        media_bytes += len(decoded)
assert verified == occupied
assert media_bytes == fixture['mediaBytes']
result = {'complete': True, 'images': len(verified), 'decodedBytes': media_bytes, 'storedImages': stored, 'deflatedImages': len(verified) - stored, 'indexBytes': len(index), 'indexSha256': metadata['indexSha256'], 'packedBytes': descriptor['dataBytes'], 'packedSha256': metadata['blobIdentity']['sha256'], 'sourceZipSha256': fixture['sha256'], 'allMediaContentSha256': content_digest.hexdigest(), 'indexSlots': descriptor['slotCount'], 'emptySlots': descriptor['slotCount'] - len(verified)}
(args.evidence / 'media-verification.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
