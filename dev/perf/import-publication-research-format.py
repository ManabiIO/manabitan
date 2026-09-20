from pathlib import Path
import re
import subprocess

paths = [Path('test/fixtures/import-publication/check.mjs'), Path('test/fixtures/import-journal-snapshot/check.mjs'), Path('test/fixtures/import-journal-snapshot/node-opfs-adapter.mjs')]
for p in paths:
    text = p.read_text()
    text = re.sub(r'new Promise\(\((\w+)\) => setImmediate\(\1\)\)', r'new Promise((\1) => { setImmediate(\1) })', text)
    text = text.replace(r'/[\/\\]/', r'/[/\\]/')
    if p.parent.name == 'import-publication':
        text = text.replace('passed: cases.filter', 'diagnostics, passed: cases.filter')
    lines = []
    for line in text.splitlines():
        if 'await import(pathToFileURL' in line:
            lines.append('// eslint-disable-next-line no-unsanitized/method -- The test runner imports production source from the explicitly supplied checkout path.')
        lines.append(line)
    p.write_text('\n'.join(lines) + '\n')
# The repository intentionally ignores JavaScript in Prettier; format only these
# new test fixtures, then subject them to the normal repository ESLint rules.
subprocess.run(['npx', 'prettier', *map(str, paths), '--write', '--ignore-path', '/dev/null', '--no-semi', '--print-width', '200'], check=True)
