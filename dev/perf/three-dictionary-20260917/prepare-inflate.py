from pathlib import Path
import base64, gzip, hashlib, re, subprocess

root = Path.cwd()
tools = Path(__file__).parent
raw = (tools / 'candidates.patch.gz.b64').read_text().replace('h2Obf6Hf6H+', 'h2Obf6H+')
patch = gzip.decompress(base64.b64decode(raw))
assert hashlib.sha256(patch).hexdigest() == 'c2f362dbe7512af4723c73a499a8a6c0548c8d8ba98750abead38cd711ddba0f'
paths = ['dev/build-libs.js', 'ext/js/dictionary/wasm/term-bank-parser.c', 'ext/js/dictionary/term-bank-wasm-parser.js', 'ext/js/dictionary/term-bank-experiments.js', 'types/ext/dictionary-importer.d.ts']
subprocess.run(['git', 'apply', *['--include=' + p for p in paths], '-'], input=patch, check=True)
for filename, line in [
    ('ext/js/dictionary/term-bank-experiments.js', '        experimentalAlignedImportCopies: options.experimentalAlignedImportCopies === true,\n'),
    ('types/ext/dictionary-importer.d.ts', '    experimentalAlignedImportCopies?: boolean;\n'),
]:
    p = root / filename
    text = p.read_text()
    assert text.count(line) == 1
    p.write_text(text.replace(line, ''))
subprocess.run(['python3', str(tools / 'add-tests.py')], check=True)
(root / 'test/import-byte-copy.test.js').unlink()
subprocess.run(['git', 'restore', '--source=HEAD', '--', 'test/term-content-block-store.test.js', 'test/zstd-term-content-pool.test.js'], check=True)
p = root / 'test/term-bank-experiments.test.js'
text = p.read_text()
old = "['experimentalLibdeflate', 'experimentalAlignedImportCopies']"
assert text.count(old) == 1
p.write_text(text.replace(old, "['experimentalLibdeflate']"))
# The retained conformance suite must exercise libdeflate, not merely miniz's
# compatible default path. The separate wrapper tests compare both arms.
p = root / 'test/term-bank-inflater.test.js'
text = p.read_text()
old = '1, output, size, spans)'
assert text.count(old) == 1
p.write_text(text.replace(old, '1, output, size, spans, 1)'))
# Preserve the measured driver's timing, checks and plan. Only optional source
# identities are narrowed to this isolated source; reject unknown flags.
text = (tools / 'abba.mjs').read_text()
text = text.replace('openSync, closeSync}', 'openSync, closeSync, existsSync}')
text, count = re.subn(r'const files = (\[.*\])\n', r'const files = \1.filter(p => existsSync(p))\n', text)
assert count == 1
needle = "const selected = (process.argv[2] ?? 'control,inflate,copies,both').split(',')"
assert text.count(needle) == 1
text = text.replace(needle, "const selected = (process.argv[2] ?? 'control,inflate').split(',')")
needle = 'const plan = []\n'
assert text.count(needle) == 1
text = text.replace(needle, "const {snapshotTermBankExperiments} = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/term-bank-experiments.js')).href)\nfor (const id of selected) for (const [key, value] of Object.entries(variants[id])) assert.equal(snapshotTermBankExperiments(variants[id])[key], value, `Unrecognized experiment ${key}`)\nconst plan = []\n")
(tools / 'inflate-abba.mjs').write_text(text)
original = (tools / 'check.mjs').read_text()
text = original[:original.index("const {copyStableImportBytes}")]
text += 'let inflations = 0, rejections = 0\n'
text += original[original.index('const parser = await load'):original.index('const zstd = await load')]
text += "const receipt = {status: 'success', inflations, rejections, note: 'Actual miniz/libdeflate WASM, exact bytes, CRC/size/trailing-byte rejection and recovery'}\nwriteFileSync(process.env.THREE_CHECK_OUTPUT ?? 'builds/three-check.json', JSON.stringify(receipt, null, 2) + '\\n')\nconsole.log(JSON.stringify(receipt))\n"
(tools / 'inflate-check.mjs').write_text(text)
assert not (root / 'ext/js/core/import-byte-copy.js').exists()
for filename in paths:
    assert 'experimentalAlignedImportCopies' not in (root / filename).read_text()
subprocess.run(['git', 'diff', '--check'], check=True)
print('Isolated default-off libdeflate; copy experiment excluded; conformance tests explicitly select native backend 1')
