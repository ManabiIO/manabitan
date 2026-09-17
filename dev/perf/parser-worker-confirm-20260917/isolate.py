from pathlib import Path
import sys

candidate=sys.argv[1]
assert candidate in {'w3','w4'}
selected='experimentalParserWorkers3' if candidate=='w3' else 'experimentalParserWorkers4'
rejected='experimentalParserWorkers4' if candidate=='w3' else 'experimentalParserWorkers3'
count=3 if candidate=='w3' else 4

def edit(name,old,new,count_expected=1):
    p=Path(name)
    text=p.read_text()
    assert text.count(old)==count_expected,(name,old[:100],text.count(old),count_expected)
    p.write_text(text.replace(old,new))

edit('ext/js/dictionary/term-bank-experiments.js',f'        {rejected}: options.{rejected} === true,\n','')
edit('types/ext/dictionary-importer.d.ts',f'    {rejected}?: boolean;\n','')
old='''    const workers3 = options.experimentalParserWorkers3 === true;
    const workers4 = options.experimentalParserWorkers4 === true;
    if (workers3 === workers4 || rawHardwareConcurrency < 4) { return baseline; }
    return Math.max(baseline, workers4 ? 4 : 3);'''
new=f'''    if (options.{selected} !== true || rawHardwareConcurrency < 4) {{ return baseline; }}
    return Math.max(baseline, {count});'''
edit('ext/js/dictionary/term-bank-wasm-parser.js',old,new)
edit('test/term-bank-parser-worker-policy.test.js',"const names = /** @type {Array<keyof Experiments>} */ (['experimentalParserWorkers3', 'experimentalParserWorkers4'])",f"const names = /** @type {{Array<keyof Experiments>}} */ (['{selected}'])")
# The discovery-only conflict check has no meaning once the losing flag is removed.
edit('test/term-bank-parser-worker-policy.test.js',"        expect(getParallelTermBankParserWorkerCount({experimentalParserWorkers3: true, experimentalParserWorkers4: true})).toBe(2)\n",'')
# Keep the selected flag's four-core/high-capability/constrained assertions and
# remove the rejected flag's corresponding assertions.
for expected in [3 if rejected.endswith('3') else 4, 5, 2]:
    # Values vary by block; remove any exact line containing rejected instead of relying on expected.
    pass
p=Path('test/term-bank-parser-worker-policy.test.js')
lines=[]
for line in p.read_text().splitlines(True):
    if rejected in line and 'const names' not in line:
        continue
    lines.append(line)
p.write_text(''.join(lines))
assert rejected not in Path('ext/js/dictionary/term-bank-experiments.js').read_text()
assert rejected not in Path('types/ext/dictionary-importer.d.ts').read_text()
assert rejected not in Path('ext/js/dictionary/term-bank-wasm-parser.js').read_text()
assert rejected not in Path('test/term-bank-parser-worker-policy.test.js').read_text()
assert selected in Path('ext/js/dictionary/term-bank-wasm-parser.js').read_text()
print(f'Isolated {selected} at {count} workers; rejected worker-count flag removed from exact confirmation source')
