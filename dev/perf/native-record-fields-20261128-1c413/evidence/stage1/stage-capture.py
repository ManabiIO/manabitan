"""Bind the one stock capture; no compilation or import is performed here."""
from pathlib import Path
import difflib
import hashlib
import json
import shutil
import subprocess

here = Path(__file__).resolve().parent
root = here.parent.parent
repo = root / 'manabitan'
base = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
prior = root / 'experiments/native-canonical-census'
sha = lambda data: hashlib.sha256(data).hexdigest()
assert not (here / 'capture-binding.json').exists()
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip() == base
assert subprocess.check_output(['git', 'diff', '--binary', 'HEAD'], cwd=repo) == b''
original = (prior / 'replay.mjs').read_text()
source = original

def change(before, after):
    global source
    assert source.count(before) == 1, before
    source = source.replace(before, after)

change('// One untimed current-source import with a stock-versus-shadow native oracle.', '// One untimed current-source import capturing every actual stock field call.')
change("import {installCanonicalShadow} from './shadow-observer.mjs'", "import {installRecordFieldCapture} from './capture-observer.mjs'\nimport {installRecordFieldExport} from './export-hook.mjs'")
change("new URL('./source-binding.json', import.meta.url)", "new URL('./capture-binding.json', import.meta.url)")
change("const {DictionaryDatabase} = await import(moduleUrl('ext/js/dictionary/dictionary-database.js'))", "const exportHook = installRecordFieldExport(sourceRoot, sourceBinding.recordEncoderSha256)\nconst recordModule = await import(moduleUrl('ext/js/dictionary/term-record-opfs-store.js'))\nexportHook.finish()\nconst {DictionaryDatabase} = await import(moduleUrl('ext/js/dictionary/dictionary-database.js'))")
change("const shadow = await installCanonicalShadow({getGroupIndex: () => chunks.length, getOwner: () => db, outputDirectory: pathToFileURL(outputDir + '/')})", "const capture = installRecordFieldCapture({store: db._termRecordStore, module: recordModule, outputDirectory: outputDir, getGroupIndex: () => chunks.length})")
change("    const census = await shadow.save()\n    assert.equal(census.calls.length, metricTotals.dedupNativeCallCount)\n    assert.equal(census.totals.rowsVisited, metricTotals.dedupNativeScannedRows)\n    assert.equal(census.totals.pendingOutputRows, metricTotals.dedupNativeBulkPendingRows)\n    assert.equal(census.totals.exactDescriptors, metricTotals.dedupNativeExactCandidates)\n    assert.equal(metricTotals.dedupNativeFallbackCount, 0)\n    assert(census.calls.every((call) => call.reconciled))", "    const captureTotals = capture.finish()\n    assert.equal(metricTotals.dedupNativeFallbackCount, 0)")
change("scope: 'One stock JMdict import with full private-memory diagnostic shadow equality per canonical call, exact compressed frames and references, and complete finalized payload hashes. Node workers, in-memory SQLite, test file OPFS adapter; no browser qualification.'", "scope: 'One stock JMdict import capturing every actual field encoder call, exact compressed frames and references, and complete finalized payload hashes. Node workers, in-memory SQLite, test file OPFS adapter; no browser qualification.'")
change('        censusTotals: census.totals,', '        captureTotals,\n        diagnosticExport: exportHook.receipt,')
change('censusTotals: census.totals, finalizedOutputParity: true', 'captureTotals, finalizedOutputParity: true')
change('    await shadow.save()\n', '')
change('    shadow.restore()', '    capture.restore()')
(here / 'capture.mjs').write_text(source)
(here / 'capture-harness-delta.patch').write_text(''.join(difflib.unified_diff(original.splitlines(True), source.splitlines(True), fromfile='canonical-census/replay.mjs', tofile='native-record-fields/capture.mjs')))
for name in ['retained-baseline-oracle.json', 'node-import-worker-bridge.mjs', 'compression-observer.mjs', 'runtime-identity.json']:
    shutil.copyfile(prior / name, here / name)
binding = json.loads((prior / 'source-binding.json').read_text())
binding = {key: value for key, value in binding.items() if key in ['baseline', 'stockSource', 'stockSourceSha256', 'stockWasmSha256', 'retainedBaselineOracleSha256', 'runtimeDigest', 'runtimeFiles']}
binding['recordEncoderSource'] = 'ext/js/dictionary/term-record-opfs-store.js'
record_source = subprocess.check_output(['git', 'show', base + ':' + binding['recordEncoderSource']], cwd=repo)
assert record_source == (repo / binding['recordEncoderSource']).read_bytes()
binding['recordEncoderSha256'] = sha(record_source)
names = ['README.md', 'stage-capture.py', 'export-hook.mjs', 'capture-observer.mjs', 'capture.mjs', 'capture-harness-delta.patch', 'retained-baseline-oracle.json', 'node-import-worker-bridge.mjs', 'compression-observer.mjs', 'runtime-identity.json']
binding['files'] = {name: sha((here / name).read_bytes()) for name in names}
binding['timingAcquisition'] = False
binding['productChanges'] = False
(here / 'capture-binding.json').write_text(json.dumps(binding, indent=2) + '\n')
print(json.dumps(binding, indent=2))
