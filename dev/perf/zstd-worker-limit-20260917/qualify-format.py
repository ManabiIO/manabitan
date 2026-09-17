from pathlib import Path

ROOT = Path.cwd()

def replace(path, old, new, count=1):
    p = ROOT / path
    text = p.read_text()
    assert text.count(old) == count, (path, old[:120], text.count(old), count)
    p.write_text(text.replace(old, new))

p = 'ext/js/dictionary/zstd-term-content.js'
# Public/pool methods gained only an optional scheduling cap. Keep the
# documentation explicit so qualification does not rely on lint auto-rewrites.
for old in [
    '''     * @param {string|null} dictName\n     * @returns {Promise<Uint8Array[]>}''',
    '''     * @param {string|null} dictName\n     * @returns {Promise<{chunks: Uint8Array[], envelopeMs: number, wrapped: true}>}''',
    '''     * @param {string|null} dictName\n     * @returns {{sourceConsumed: Promise<void>, completion: Promise<{chunks: Uint8Array[], envelopeMs: number, wrapped: true}>}}''',
    '''     * @param {string|null} dictName\n     * @param {boolean} wrap\n     * @returns {Promise<{chunks: Uint8Array[], envelopeMs: number}>}''',
]:
    new = old.replace('     * @returns', '     * @param {number|null} [workerLimit]\n     * @returns')
    replace(p, old, new)

# There are two span-method docs with the same return form; both need the cap.
old = '''     * @param {string|null} dictName\n     * @returns {Promise<{chunks: Uint8Array[], envelopeMs: number, wrapped: true}>}'''
# The first identical occurrence was already consumed above if present. Handle
# any remaining exact occurrence once.
text = (ROOT / p).read_text()
if old in text:
    replace(p, old, old.replace('     * @returns', '     * @param {number|null} [workerLimit]\n     * @returns'))

# Exported wrapper docs use unindented JSDoc.
for returns in [
    'Promise<{chunks: Uint8Array[], envelopeMs: number, wrapped: boolean}>',
    'Promise<{chunks: Uint8Array[], envelopeMs: number, wrapped: true}>',
    '{sourceConsumed: Promise<void>, completion: Promise<{chunks: Uint8Array[], envelopeMs: number, wrapped: true}>}',
]:
    old = f''' * @param {{string|null}} dictName\n * @returns {{{returns}}}'''
    text = (ROOT / p).read_text()
    if old in text:
        replace(p, old, f''' * @param {{string|null}} dictName\n * @param {{number|null}} [workerLimit]\n * @returns {{{returns}}}''')

replace(
    'ext/js/dictionary/term-content-block-store.js',
    '''    /**\n     * @param {number|null} value\n     */\n    setCompressionWorkerLimit(value) {''',
    '''    /**\n     * @param {number|null} value\n     * @throws {RangeError} If the limit is outside the prewarmed worker pool.\n     */\n    setCompressionWorkerLimit(value) {''',
)
replace(
    'test/zstd-term-content-pool.test.js',
    '''        for (const worker of workers.slice(0, limit)) {\n            for (const {message} of worker.calls) expect(message.source).toBe(source);\n        }''',
    '''        for (const worker of workers.slice(0, limit)) {\n            for (const {message} of worker.calls) { expect(message.source).toBe(source); }\n        }''',
)
print('Added JSDoc/brace-only qualification edits; worker routing expressions unchanged')
