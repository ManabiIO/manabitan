from pathlib import Path
import base64, gzip, hashlib, subprocess

TOOLS = Path(__file__).resolve().parent
patch = gzip.decompress(base64.b64decode((TOOLS / 'candidates.patch.gz.b64').read_bytes()))
assert hashlib.sha256(patch).hexdigest() == 'd07dcc888e5af0f164dfbe1417eec7a7655e826017248cd7e757db726598cb7c'
subprocess.run(['git', 'apply', '-'], input=patch, check=True)

# Keep only the generic span/envelope experiment. Compression levels and worker
# scheduling remain exactly baseline.
for name in ['ext/js/dictionary/term-bank-experiments.js', 'types/ext/dictionary-importer.d.ts']:
    p = Path(name)
    s = p.read_text()
    s = ''.join(line for line in s.splitlines(True)
                if 'experimentalCompressionWorkers2' not in line and 'experimentalZstdFast2' not in line)
    p.write_text(s)

p = Path('ext/js/dictionary/zstd-term-content.js')
s = p.read_text()
s = s.replace('export function decompressTermContentZstd(content, dictName, options) {',
              'export function decompressTermContentZstd(content, dictName) {')
worker_line = '        const workerCount = options.experimentalCompressionWorkers2 === true ? Math.min(2, this._workers.length) : this._workers.length;\n'
assert s.count(worker_line) == 2
s = s.replace(worker_line, '')
s = s.replace('new Float64Array(workerCount)', 'new Float64Array(this._workers.length)')
s = s.replace('% workerCount', '% this._workers.length')
s = s.replace("options.experimentalZstdFast2 === true ? -2 : 1", "1")
s = s.replace("options.experimentalZstdFast2 === true ? -2 : JMDICT_COMPRESSION_LEVEL", "JMDICT_COMPRESSION_LEVEL")
s = s.replace("options.experimentalZstdFast2 === true ? -2 : (dictName === 'jmdict' ? JMDICT_COMPRESSION_LEVEL : 1)",
              "(dictName === 'jmdict' ? JMDICT_COMPRESSION_LEVEL : 1)")
p.write_text(s)

p = Path('test/term-bank-experiments.test.js')
s = p.read_text().replace(
    "['experimentalZstdFast2', 'experimentalCompressionWorkers2', 'experimentalGenericSpanCompression']",
    "['experimentalGenericSpanCompression']"
)
p.write_text(s)

p = Path('test/term-content-block-store.test.js')
s = p.read_text()
s = s.replace(
    'experimentalZstdFast2: true, experimentalCompressionWorkers2: true, experimentalGenericSpanCompression: true',
    'experimentalGenericSpanCompression: true'
).replace(
    'experimentalZstdFast2: false, experimentalCompressionWorkers2: false, experimentalGenericSpanCompression: false',
    'experimentalGenericSpanCompression: false'
).replace('experimentalZstdFast2', 'experimentalGenericSpanCompression')
p.write_text(s)

p = Path('test/zstd-term-content-pool.test.js')
s = p.read_text()
marker = "\n\ndescribe('per-operation compression experiments'"
if marker in s:
    s = s[:s.index(marker)]
s += """
\n\ndescribe('per-operation generic span compression', () => {
    test('snapshots packed and shared jobs without leaking into the next call', async () => {
        const worker = new MockCompressionWorker((message) => ({compressed: Uint8Array.of(message.source ? 3 : 4).buffer, sourceConsumed: true}));
        const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ ([worker])));
        try {
            for (const enabled of [false, true, true, false]) {
                const options = {experimentalGenericSpanCompression: enabled};
                const completion = pool.compressWrapped([Uint8Array.of(1, 2)], null, options);
                options.experimentalGenericSpanCompression = !enabled;
                await expect(completion).resolves.toMatchObject({wrapped: true});
                expect(worker.calls.at(-1)?.message.compressionExperiments).toMatchObject({experimentalGenericSpanCompression: enabled});
                const operation = pool.beginCompressWrappedSpans(new Uint8Array(new SharedArrayBuffer(64)), Uint32Array.of(1), Uint32Array.of(5), Uint32Array.of(0, 1), Uint32Array.of(5), 'jmdict', {experimentalGenericSpanCompression: enabled});
                await operation.sourceConsumed;
                await expect(operation.completion).resolves.toMatchObject({wrapped: true});
                expect(worker.calls.at(-1)?.message.compressionExperiments).toMatchObject({experimentalGenericSpanCompression: enabled});
            }
        } finally { pool.close(); }
    });
});
"""
p.write_text(s)

for p in [
    *Path('ext/js/dictionary').glob('*.js'),
    Path('types/ext/dictionary-importer.d.ts'),
    Path('test/term-content-block-store.test.js'),
    Path('test/term-bank-experiments.test.js'),
    Path('test/zstd-term-content-pool.test.js'),
]:
    text = p.read_text()
    assert 'experimentalZstdFast2' not in text, str(p)
    assert 'experimentalCompressionWorkers2' not in text, str(p)

subprocess.run(['git', 'diff', '--check'], check=True)
print('Selected generic span/envelope compression only; compression levels and four-worker scheduling unchanged')
