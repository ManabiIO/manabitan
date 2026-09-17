from pathlib import Path
ROOT = Path.cwd()
TOOLS = Path(__file__).resolve().parent

def replace(name, old, new):
    p = ROOT / name
    text = p.read_text()
    assert text.count(old) == 1, (name, old[:80], text.count(old))
    p.write_text(text.replace(old, new))

(ROOT / 'ext/js/dictionary/term-bank-group-policy.js').write_text((TOOLS / 'term-bank-group-policy.js').read_text())
flags = ['experimentalParserGroups16MiB', 'experimentalParserGroups32MiB', 'experimentalParserGroups48MiB']
replace('ext/js/dictionary/term-bank-experiments.js', '    return Object.freeze({\n', '    return Object.freeze({\n' + ''.join(f'        {f}: options.{f} === true,\n' for f in flags))
replace('types/ext/dictionary-importer.d.ts', 'export type ImportExperiments = {\n', 'export type ImportExperiments = {\n' + ''.join(f'    {f}?: boolean;\n' for f in flags))
p = 'ext/js/dictionary/term-bank-wasm-parser.js'
text = (ROOT / p).read_text()
line = next(line for line in text.splitlines(True) if "from './term-bank-experiments.js'" in line)
replace(p, line, line + "import {getTermBankGroupPolicy} from './term-bank-group-policy.js';\n")
replace(p, 'const LAZY_PARALLEL_SOURCE_TARGET_GROUP_BYTES = 24 * 1024 * 1024;\n', '')
replace(p, '    const pipelineGroupsPerWorker = getParallelSourcePipelineGroupsPerWorker(options);', '    const defaultGroupsPerWorker = getParallelSourcePipelineGroupsPerWorker(options);\n    const {groupsPerWorker: pipelineGroupsPerWorker, targetGroupBytes} = getTermBankGroupPolicy(\n        defaultGroupsPerWorker, lazy, options,\n    );')
replace(p, 'Math.ceil(totalBytes / LAZY_PARALLEL_SOURCE_TARGET_GROUP_BYTES)', 'Math.ceil(totalBytes / targetGroupBytes)')
(ROOT / 'test/term-bank-group-policy.test.js').write_text((TOOLS / 'test-group-policy.js').read_text())
print('Installed three independent default-off group policies; native algorithms and validation are unchanged')
