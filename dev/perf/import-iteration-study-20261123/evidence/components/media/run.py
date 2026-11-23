import json
import os
from pathlib import Path
import statistics
import subprocess

root = Path(__file__).resolve().parent
arms = {
    'A': '/workspace/scratch/71149a79699f/manabitan',
    'B': '/workspace/scratch/71149a79699f/manabitan-media-iteration2',
}
env = {**os.environ, 'NODE_OPTIONS': '--max-old-space-size=1536'}
observations = []
schedule = [('warmup', 0, arm) for arm in 'AB']
for pair in range(2):
    schedule += [('control-before', pair, arm) for arm in 'AA']
for pair in range(6):
    schedule += [('candidate', pair, arm) for arm in ('AB' if pair % 2 == 0 else 'BA')]
for pair in range(2):
    schedule += [('control-after', pair, arm) for arm in 'AA']
for kind, pair, arm in schedule:
    output = subprocess.check_output(['node', str(root / 'replay.mjs'), arms[arm]], text=True, env=env)
    result = {'kind': kind, 'pair': pair, 'arm': arm, **json.loads(output)}
    observations.append(result)
    (root / 'observations.json').write_text(json.dumps(observations, indent=2) + '\n')
    print(json.dumps({key: result[key] for key in ['kind', 'pair', 'arm', 'elapsedMs', 'decoderCalls', 'references', 'retainedKeyBufferBytes']}), flush=True)
for key in ['referencesSha256', 'diagnosticSamples', 'references']:
    if len({json.dumps(item[key], sort_keys=True) for item in observations}) != 1:
        raise ValueError('Output mismatch: ' + key)
summary = {'outputParity': True, 'scope': observations[0]['scope']}
for kind in ['candidate', 'control-before', 'control-after']:
    pairs = []
    for pair in sorted({item['pair'] for item in observations if item['kind'] == kind}):
        rows = [item for item in observations if item['kind'] == kind and item['pair'] == pair]
        if kind == 'candidate':
            a = next(item for item in rows if item['arm'] == 'A')['elapsedMs']
            b = next(item for item in rows if item['arm'] == 'B')['elapsedMs']
        else:
            a, b = [item['elapsedMs'] for item in rows]
        pairs.append({'pair': pair, 'baselineMs': a, 'comparisonMs': b, 'changePercent': 100 * (b / a - 1)})
    summary[kind] = {'pairs': pairs, 'medianChangePercent': statistics.median(item['changePercent'] for item in pairs)}
(root / 'results.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary), flush=True)
