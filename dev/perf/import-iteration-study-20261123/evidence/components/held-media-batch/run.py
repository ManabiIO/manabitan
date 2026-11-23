import json
import os
from pathlib import Path
import statistics
import subprocess

root = Path(__file__).resolve().parent
arms = {
    'A': '/workspace/scratch/71149a79699f/manabitan-plan-scratch-base',
    'B': '/workspace/scratch/71149a79699f/manabitan-media-iteration2',
}
env = {**os.environ, 'NODE_OPTIONS': '--max-old-space-size=1536'}
observations = []
schedule = [('warmup', 0, arm) for arm in 'AB']
for pair in range(4):
    schedule += [('candidate', pair, arm) for arm in ('AB' if pair % 2 == 0 else 'BA')]
for kind, pair, arm in schedule:
    output = subprocess.check_output(['node', str(root / 'run-arm.mjs'), arms[arm]], text=True, env=env)
    result = {'kind': kind, 'pair': pair, 'arm': arm, **json.loads(output)}
    observations.append(result)
    (root / 'observations.json').write_text(json.dumps(observations, indent=2) + '\n')
    print(json.dumps({key: result[key] for key in ['kind', 'pair', 'arm', 'elapsedMs', 'readMs', 'validationMs', 'rangeReadCount', 'rangeReadBytes']}), flush=True)
for key in ['descriptor', 'indexSha256', 'recordsSha256', 'blobSha256', 'records', 'compressedBytes', 'uncompressedBytes', 'blobBytes']:
    if len({json.dumps(item[key], sort_keys=True) for item in observations}) != 1:
        raise ValueError('Output mismatch: ' + key)
errors = []
for arm, checkout in arms.items():
    output = subprocess.check_output(['node', str(root / 'run-arm.mjs'), checkout, 'crc-error'], text=True, env=env)
    errors.append({'arm': arm, **json.loads(output)})
if len({(item['errorName'], item['error']) for item in errors}) != 1:
    raise ValueError('CRC error mismatch')
(root / 'errors.json').write_text(json.dumps(errors, indent=2) + '\n')
pairs = []
for pair in range(4):
    rows = {item['arm']: item for item in observations if item['kind'] == 'candidate' and item['pair'] == pair}
    a = rows['A']['elapsedMs']
    b = rows['B']['elapsedMs']
    pairs.append({'pair': pair, 'baselineMs': a, 'candidateMs': b, 'changePercent': 100 * (b / a - 1)})
summary = {'pairs': pairs, 'medianChangePercent': statistics.median(item['changePercent'] for item in pairs), 'outputParity': True, 'crcErrorParity': True}
(root / 'results.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary), flush=True)
