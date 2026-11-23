import json
import pathlib
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parents[1]
directory = root / 'qualification/vndb-timing'
plan = json.loads((directory / 'plan.json').read_text())
node = root / 'runtime/node-v22.22.0-linux-x64/bin/node'
harness = root / 'qualification/vndb-component.mjs'
for run in plan['runs']:
    label = f"triple-{run['triple']}-{run['position']}-{run['arm']}"
    source = plan['baselineRoot'] if run['arm'] == 'baseline' else plan['candidateRoot']
    command = [str(node), str(harness), 'measure', source, source,
               str(root / 'fixtures/vndb_characters_by_bee.zip'), str(directory / f'{label}.json')]
    with (directory / f'{label}.log').open('w') as log:
        result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
    print(f'{label}: exit={result.returncode}', flush=True)
    if result.returncode:
        sys.exit(result.returncode)
