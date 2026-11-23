import argparse
import json
import os
from pathlib import Path
import subprocess

directory = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--baseline', default='/workspace/scratch/71149a79699f/manabitan')
parser.add_argument('--candidate', default='/workspace/scratch/71149a79699f/manabitan-media-iteration2')
parser.add_argument('--fixture', default='/workspace/scratch/fcfffdc555c8/fixtures/vndb_characters_by_bee.zip')
parser.add_argument('--capture', default='/workspace/scratch/71149a79699f/media-diagnostics-study-20261123/native-media-chunks.bin')
parser.add_argument('--wasm', default='/workspace/scratch/71149a79699f/manabitan/ext/lib/term-bank-parser.wasm')
args = parser.parse_args()
rows = {}
for arm, checkout, requirement_type in [
    ('baseline', args.baseline, 'structured-content-image'),
    ('candidate', args.candidate, 'image-reference'),
]:
    output = subprocess.check_output([
        'node', str(directory / 'run-arm.mjs'), checkout, requirement_type,
        args.fixture, args.capture, args.wasm,
    ], text=True, env={**os.environ, 'NODE_OPTIONS': '--max-old-space-size=1536'})
    rows[arm] = json.loads(output)
    (directory / f'{arm}.json').write_text(json.dumps(rows[arm], indent=2) + '\n')
    print(json.dumps({'arm': arm, 'head': rows[arm]['head'], 'type': requirement_type, 'images': rows[arm]['records'], 'blobSha256': rows[arm]['blobSha256']}), flush=True)

keys = [
    'caps', 'totalRequirements', 'uniqueRequirements', 'allArchiveImagesCovered',
    'pathsSha256', 'recordsSha256', 'blobSha256', 'perImagePackedPayloadsSha256',
    'records', 'compressedBytes', 'uncompressedBytes', 'blobBytes',
    'rangeReadCount', 'rangeReadBytes', 'compressionMethods',
    'descriptor', 'indexSha256', 'checkedIndexSlots',
    'checkedOccupiedIndexEntries', 'checkedIndexHoles', 'missingErrors', 'corruptError',
]
for key in keys:
    if rows['baseline'][key] != rows['candidate'][key]:
        raise AssertionError('Full media parity mismatch: ' + key)
for key in ['fixture', 'capture', 'wasm']:
    if rows['baseline'][key] != rows['candidate'][key]:
        raise AssertionError('Input identity mismatch: ' + key)
common_sources = [
    'ext/js/dictionary/term-bank-source-pipeline.js',
    'ext/js/dictionary/term-bank-wasm-parser.js',
    'ext/js/dictionary/dictionary-generation-media-store.js',
]
for path in common_sources:
    if rows['baseline']['sourceHashes'][path] != rows['candidate']['sourceHashes'][path]:
        raise AssertionError('Unexpected shared runtime difference: ' + path)
result = {
    'correctnessOnly': True,
    'fullPayloadParity': True,
    'allIndexEntriesChecked': True,
    'missingAndCorruptErrorParity': True,
    'comparedKeys': keys,
    'baselineHead': rows['baseline']['head'],
    'candidateHead': rows['candidate']['head'],
    'candidatePublishedRuntimeHead': '7272ea938fd3de01bd40efcd4ee838c3249d0587',
    'images': rows['baseline']['records'],
    'blobBytes': rows['baseline']['blobBytes'],
    'scope': rows['baseline']['scope'],
}
(directory / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result), flush=True)
