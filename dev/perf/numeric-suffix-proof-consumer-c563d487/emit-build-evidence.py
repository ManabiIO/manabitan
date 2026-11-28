#!/usr/bin/env python3
"""Emit bounded exact product/proof bytes after successful build correctness only."""
import argparse
import base64
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('output', type=Path)
args = parser.parse_args()
root = args.output.resolve()
result = json.loads((root / 'result.json').read_text())
assert result['complete'] is True and result['correctnessPass'] is True
paths = ['product/' + path for path in result['productFilesSha256']]
paths += ['preparation-start.json', 'compiled-source-binding.json', 'result.json',
          'diagnostic-build.json', 'smoke-parity.json']
paths += sorted(result['commandReceiptSha256'])
assert len(paths) == len(set(paths))
files = []
for name in paths:
    path = root / name
    assert path.is_file() and not path.is_symlink()
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if name.startswith('product/'):
        assert digest == result['productFilesSha256'][name[len('product/'):]]
    if name in result['commandReceiptSha256']:
        assert digest == result['commandReceiptSha256'][name]
    files.append({'path': name, 'bytes': len(data), 'sha256': digest,
                  'gitBlobSha1': hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest(),
                  'chunkBytes': 6144, 'chunkCount': (len(data) + 6143) // 6144})
manifest = {'schemaVersion': 1, 'scope': 'Exact existing compiled product and correctness receipts after successful gates; no rebuild or measurement.',
            'files': files, 'fileCount': len(files), 'bytes': sum(item['bytes'] for item in files),
            'sourceOrAcquisitionChanged': False}
manifest_bytes = (json.dumps(manifest, indent=2) + '\n').encode()
manifest_path = root / 'post-correctness-byte-manifest.json'
assert not manifest_path.exists(), 'Never overwrite an earlier byte-emission manifest'
manifest_path.write_bytes(manifest_bytes)
print('SUFFIX_PROOF_BUILD_BYTES_START ' + json.dumps(manifest, separators=(',', ':')), flush=True)
for item in files:
    data = (root / item['path']).read_bytes()
    assert hashlib.sha256(data).hexdigest() == item['sha256']
    print('SUFFIX_PROOF_BUILD_FILE ' + json.dumps(item, separators=(',', ':')), flush=True)
    for index, start in enumerate(range(0, len(data), 6144)):
        print('SUFFIX_PROOF_BUILD_CHUNK ' + json.dumps({'path': item['path'], 'index': index,
              'base64': base64.b64encode(data[start:start + 6144]).decode()}, separators=(',', ':')), flush=True)
print('SUFFIX_PROOF_BUILD_BYTES_COMPLETE ' + json.dumps({'schemaVersion': 1,
      'manifestSha256': hashlib.sha256(manifest_bytes).hexdigest(), 'fileCount': len(files),
      'bytes': manifest['bytes'], 'complete': True, 'sourceOrAcquisitionChanged': False}, separators=(',', ':')), flush=True)
