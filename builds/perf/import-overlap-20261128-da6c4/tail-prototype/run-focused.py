import hashlib
import json
from pathlib import Path
import subprocess

root = Path('/tmp/manabitan-da6c4-owned-current-integration')
output = Path(__file__).resolve().parent
source_path = Path('ext/js/dictionary/term-bank-wasm-parser.js')
test_path = Path('test/term-bank-pipeline-completion.test.js')
candidate = (root / source_path).read_bytes()
previous = subprocess.check_output(['git', 'show', ':' + str(source_path)], cwd=root)
command = ['npm', 'run', 'test:unit', '--', str(test_path), '--maxWorkers=1']
receipt = {'scope': 'Untimed extracted production pipeline control-flow regression; deterministic fake worker transport',
           'base': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
           'priorRuntime': 'Exact 54844293 owned-overlap changes integrated onto base before tail admission',
           'command': command, 'attempts': []}
for name, data in [('previous-parser.js', previous), ('candidate-parser.js', candidate),
                   ('candidate-test.js', (root / test_path).read_bytes())]:
    (output / name).write_bytes(data)
    receipt[name] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
try:
    for name, data in [('before', previous), ('after', candidate)]:
        (root / source_path).write_bytes(data)
        with (output / (name + '.log')).open('wb') as stream:
            completed = subprocess.run(command, cwd=root, stdout=stream, stderr=subprocess.STDOUT, timeout=60)
        receipt['attempts'].append({'name': name, 'exitCode': completed.returncode,
                                    'logSha256': hashlib.sha256((output / (name + '.log')).read_bytes()).hexdigest()})
        (output / 'focused-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print(name, completed.returncode, flush=True)
finally:
    (root / source_path).write_bytes(candidate)
print(json.dumps(receipt, indent=2))
