from pathlib import Path
import re

for p in [Path('test/fixtures/import-publication/check.mjs'), Path('test/fixtures/import-journal-snapshot/check.mjs'), Path('test/fixtures/import-journal-snapshot/node-opfs-adapter.mjs')]:
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
