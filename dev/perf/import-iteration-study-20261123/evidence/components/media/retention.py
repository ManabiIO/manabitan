import json
import os
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent
arms = {
    'A': '/workspace/scratch/71149a79699f/manabitan',
    'B': '/workspace/scratch/71149a79699f/manabitan-media-iteration2',
}
rows = []
for index, arm in enumerate('ABBAAB'):
    output = subprocess.check_output(
        ['node', '--expose-gc', str(root / 'replay.mjs'), arms[arm]],
        text=True,
        env={**os.environ, 'NODE_OPTIONS': '--max-old-space-size=1536'},
    )
    row = {'index': index, 'arm': arm, **json.loads(output)}
    rows.append(row)
    (root / 'retention.json').write_text(json.dumps(rows, indent=2) + '\n')
    print(json.dumps({key: row[key] for key in [
        'arm', 'retainedDiagnosticArenas', 'retainedKeyBuffers',
        'retainedKeyBufferBytes', 'retainedSpanBufferBytes', 'retainedProcessMemory',
    ]}), flush=True)
