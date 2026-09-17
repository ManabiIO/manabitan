from pathlib import Path
import subprocess, json, os

out = Path(os.environ.get('THREE_OUTPUT', 'builds/compression-screen'))
out.mkdir(parents=True, exist_ok=True)
command = ['node', 'node_modules/typescript/bin/tsc', '--noEmit', '--project', 'test/jsconfig.typecheck.json']
def check(label):
    r = subprocess.run(command, text=True, capture_output=True)
    text = r.stdout + r.stderr
    (out / (label + '-test-types.log')).write_text(text)
    return r.returncode, text
candidate = check('candidate')
changed = subprocess.check_output(['git', 'diff', '--name-only'], text=True).splitlines()
assert changed and all(p.startswith(('ext/js/', 'types/ext/', 'test/')) for p in changed)
originals = {p: Path(p).read_bytes() for p in changed}
try:
    for p in changed:
        Path(p).write_bytes(subprocess.check_output(['git', 'show', 'HEAD:' + p]))
    baseline = check('baseline')
finally:
    for p, data in originals.items():
        Path(p).write_bytes(data)
assert candidate == baseline, (candidate, baseline)
assert candidate[0] == 2
lines = candidate[1].strip().splitlines()
assert len(lines) == 2
assert all('test/dictionary-importer-shared-buffer.test.js' in line for line in lines)
assert 'TS7006' in lines[0] and 'TS2502' in lines[1]
(out / 'test-types-parity.json').write_text(json.dumps({'status': 'baseline-equal', 'inheritedErrors': lines, 'newErrors': 0}, indent=2) + '\n')
print('The exact same two diagnostics reproduce on the untouched baseline; no new test-type errors')
