from pathlib import Path

ROOT = Path.cwd()

def replace(path, old, new):
    p = ROOT / path
    text = p.read_text()
    assert text.count(old) == 1, (path, old[:100], text.count(old))
    p.write_text(text.replace(old, new))

# Common current-develop correctness repair, identical in every benchmark arm.
replace(
    'ext/js/dictionary/dictionary-importer.js',
    ''' * @param {Uint8Array} bytes
 * @returns {string}
 */
function decodeUtf8Bytes(decoder, bytes) {
    const buffer = bytes.buffer;
    return (
        typeof SharedArrayBuffer === 'function' &&
        buffer instanceof SharedArrayBuffer
    ) ?
        decoder.decode(Uint8Array.from(bytes)) :
        decoder.decode(bytes);
}''',
    ''' * @param {Uint8Array|undefined} bytes
 * @returns {string}
 */
function decodeUtf8Bytes(decoder, bytes) {
    const buffer = bytes?.buffer;
    return (
        typeof SharedArrayBuffer === 'function' &&
        bytes instanceof Uint8Array &&
        buffer instanceof SharedArrayBuffer
    ) ?
        decoder.decode(Uint8Array.from(bytes)) :
        decoder.decode(bytes);
}''',
)

flags = ['experimentalCompressionWorkers2', 'experimentalCompressionWorkers3']
replace('ext/js/dictionary/term-bank-experiments.js', '    return Object.freeze({\n', '    return Object.freeze({\n' + ''.join(f'        {name}: options.{name} === true,\n' for name in flags))
replace('types/ext/dictionary-importer.d.ts', 'export type ImportExperiments = {\n', 'export type ImportExperiments = {\n' + ''.join(f'    {name}?: boolean;\n' for name in flags))
replace(
    'ext/js/dictionary/term-bank-experiments.js',
    '/**\n * Must match EXPERIMENT_* in wasm/term-bank-parser.c.',
    '''/**
 * Caps only job dispatch; the production four-worker pool stays prewarmed.
 * Conflicting opt-ins fail closed to the production worker count.
 * @param {import('dictionary-importer').ImportExperiments} options
 * @returns {number|null}
 */
export function getExperimentalCompressionWorkerLimit(options) {
    const workers2 = options.experimentalCompressionWorkers2 === true
    const workers3 = options.experimentalCompressionWorkers3 === true
    if (workers2 === workers3) { return null }
    return workers2 ? 2 : 3
}

/**
 * Must match EXPERIMENT_* in wasm/term-bank-parser.c.''',
)
replace(
    'ext/js/dictionary/dictionary-importer.js',
    "import {snapshotTermBankExperiments} from './term-bank-experiments.js';",
    "import {getExperimentalCompressionWorkerLimit, snapshotTermBankExperiments} from './term-bank-experiments.js';",
)
replace(
    'ext/js/dictionary/dictionary-importer.js',
    '''            queueTermContentWrites: !isStagedDictionaryUpdate,
            termContentBlockTargetBytes,
        };''',
    '''            queueTermContentWrites: !isStagedDictionaryUpdate,
            termContentBlockTargetBytes,
            termContentCompressionWorkerLimit: getExperimentalCompressionWorkerLimit(this._termBankExperiments),
        };''',
)
replace(
    'ext/js/dictionary/dictionary-database.js',
    " * @param {{termContentStorageMode?: 'baseline'|'raw-bytes', expectedTermContentImportBytes?: number, expectedTermRecordImportBytes?: number, artifactFixedPackMinTotalRows?: number|null, queueTermContentWrites?: boolean, termContentBlockTargetBytes?: number|null}} [options]",
    " * @param {{termContentStorageMode?: 'baseline'|'raw-bytes', expectedTermContentImportBytes?: number, expectedTermRecordImportBytes?: number, artifactFixedPackMinTotalRows?: number|null, queueTermContentWrites?: boolean, termContentBlockTargetBytes?: number|null, termContentCompressionWorkerLimit?: number|null}} [options]",
)
replace(
    'ext/js/dictionary/dictionary-database.js',
    '''        if (Object.hasOwn(options, 'termContentBlockTargetBytes')) {
            const termContentBlockTargetBytes = Number.isFinite(options.termContentBlockTargetBytes) ?
                Math.max(64 * 1024, Math.min(16 * 1024 * 1024, Math.trunc(/** @type {number} */ (options.termContentBlockTargetBytes)))) :
                TERM_CONTENT_BLOCK_TARGET_BYTES;
            this._termContentBlockStore.setBlockTargetBytes(termContentBlockTargetBytes);
        }
        this._termContentStore.setExpectedImportBytes(options.expectedTermContentImportBytes ?? null);''',
    '''        if (Object.hasOwn(options, 'termContentBlockTargetBytes')) {
            const termContentBlockTargetBytes = Number.isFinite(options.termContentBlockTargetBytes) ?
                Math.max(64 * 1024, Math.min(16 * 1024 * 1024, Math.trunc(/** @type {number} */ (options.termContentBlockTargetBytes)))) :
                TERM_CONTENT_BLOCK_TARGET_BYTES;
            this._termContentBlockStore.setBlockTargetBytes(termContentBlockTargetBytes);
        }
        this._termContentBlockStore.setCompressionWorkerLimit(options.termContentCompressionWorkerLimit ?? null);
        this._termContentStore.setExpectedImportBytes(options.expectedTermContentImportBytes ?? null);''',
)
replace(
    'ext/js/dictionary/term-content-block-store.js',
    '''        /** @type {Record<string, unknown>|null} */
        this._lastError = null;''',
    '''        /** @type {Record<string, unknown>|null} */
        this._lastError = null;
        /** @type {number|null} */
        this._compressionWorkerLimit = null;''',
)
replace(
    'ext/js/dictionary/term-content-block-store.js',
    '''    /** @returns {Record<string, unknown>} */
    getDiagnostics() {''',
    '''    /**
     * @param {number|null} value
     */
    setCompressionWorkerLimit(value) {
        if (value !== null && (!Number.isSafeInteger(value) || value < 1 || value > 4)) {
            throw new RangeError('Term content compression worker limit is invalid');
        }
        this._compressionWorkerLimit = value;
    }

    /** @returns {Record<string, unknown>} */
    getDiagnostics() {''',
)
replace(
    'ext/js/dictionary/term-content-block-store.js',
    '''            blockTargetBytes: this._blockTargetBytes,
            inFlightBlocks: this._inFlightBlocks.size,''',
    '''            blockTargetBytes: this._blockTargetBytes,
            compressionWorkerLimit: this._compressionWorkerLimit,
            inFlightBlocks: this._inFlightBlocks.size,''',
)
replace(
    'ext/js/dictionary/term-content-block-store.js',
    '''                    packed.packedChunkLengths,
                    compressionDictName,
                );''',
    '''                    packed.packedChunkLengths,
                    compressionDictName,
                    this._compressionWorkerLimit,
                );''',
)
replace(
    'ext/js/dictionary/term-content-block-store.js',
    'const result = await compressWrappedTermContentZstdBatch(packed.packedChunks, compressionDictName);',
    'const result = await compressWrappedTermContentZstdBatch(packed.packedChunks, compressionDictName, this._compressionWorkerLimit);',
)

p = ROOT / 'ext/js/dictionary/zstd-term-content.js'
s = p.read_text()
s = s.replace('async compress(contents, dictName) {\n        return (await this._compress(contents, dictName, false)).chunks;', 'async compress(contents, dictName, workerLimit = null) {\n        return (await this._compress(contents, dictName, false, workerLimit)).chunks;')
s = s.replace('async compressWrapped(contents, dictName) {\n        const {chunks, envelopeMs} = await this._compress(contents, dictName, true);', 'async compressWrapped(contents, dictName, workerLimit = null) {\n        const {chunks, envelopeMs} = await this._compress(contents, dictName, true, workerLimit);')
s = s.replace('async compressWrappedSpans(source, sourceOffsets, sourceLengths, blockStartIndexes, blockLengths, dictName) {', 'async compressWrappedSpans(source, sourceOffsets, sourceLengths, blockStartIndexes, blockLengths, dictName, workerLimit = null) {')
s = s.replace('            blockLengths,\n            dictName,\n        ).completion;', '            blockLengths,\n            dictName,\n            workerLimit,\n        ).completion;', 1)
s = s.replace('beginCompressWrappedSpans(source, sourceOffsets, sourceLengths, blockStartIndexes, blockLengths, dictName) {', 'beginCompressWrappedSpans(source, sourceOffsets, sourceLengths, blockStartIndexes, blockLengths, dictName, workerLimit = null) {')
s = s.replace('        const envelopeMsByWorker = new Float64Array(this._workers.length);\n        const jobs = Array.from(blockLengths, (contentBytes, blockIndex) => {\n            const workerIndex = blockIndex % this._workers.length;', '        const workerCount = this._resolveWorkerCount(workerLimit);\n        const envelopeMsByWorker = new Float64Array(workerCount);\n        const jobs = Array.from(blockLengths, (contentBytes, blockIndex) => {\n            const workerIndex = blockIndex % workerCount;')
s = s.replace('                envelopeMsByWorker[blockIndex % this._workers.length] += result.envelopeMs;', '                envelopeMsByWorker[blockIndex % workerCount] += result.envelopeMs;')
s = s.replace('async _compress(contents, dictName, wrap) {', 'async _compress(contents, dictName, wrap, workerLimit = null) {')
s = s.replace('        const envelopeMsByWorker = new Float64Array(this._workers.length);\n        const chunks = await Promise.all(contents.map(async (content, index) => {\n            const workerIndex = index % this._workers.length;', '        const workerCount = this._resolveWorkerCount(workerLimit);\n        const envelopeMsByWorker = new Float64Array(workerCount);\n        const chunks = await Promise.all(contents.map(async (content, index) => {\n            const workerIndex = index % workerCount;')
needle = '''    /**
     * @param {number} workerIndex
     * @param {Record<string, unknown>} message'''
assert s.count(needle) == 1
s = s.replace(needle, '''    /**
     * @param {number|null} workerLimit
     * @returns {number}
     */
    _resolveWorkerCount(workerLimit) {
        return Number.isSafeInteger(workerLimit) ?
            Math.max(1, Math.min(this._workers.length, /** @type {number} */ (workerLimit))) :
            this._workers.length;
    }

''' + needle)
s = s.replace('export async function compressWrappedTermContentZstdBatch(contents, dictName) {', 'export async function compressWrappedTermContentZstdBatch(contents, dictName, workerLimit = null) {')
s = s.replace('return await pool.compressWrapped(contents, dictName);', 'return await pool.compressWrapped(contents, dictName, workerLimit);')
s = s.replace('    dictName,\n) {\n    return await beginCompressWrappedTermContentZstdSpansBatch(', '    dictName,\n    workerLimit = null,\n) {\n    return await beginCompressWrappedTermContentZstdSpansBatch(', 1)
s = s.replace('        blockLengths,\n        dictName,\n    ).completion;', '        blockLengths,\n        dictName,\n        workerLimit,\n    ).completion;', 1)
# Second public span function.
marker = 'export function beginCompressWrappedTermContentZstdSpansBatch('
pos = s.index(marker)
pos2 = s.index('    dictName,\n) {', pos)
s = s[:pos2] + '    dictName,\n    workerLimit = null,\n) {' + s[pos2 + len('    dictName,\n) {'):]
call = '''            blockLengths,
            dictName,
        );'''
idx = s.index(call, pos)
s = s[:idx] + '''            blockLengths,
            dictName,
            workerLimit,
        );''' + s[idx + len(call):]
p.write_text(s)

# Add focused dispatch-isolation coverage using the existing mock workers.
with (ROOT / 'test/zstd-term-content-pool.test.js').open('a') as f:
    f.write('''

describe('TermContentCompressionPool worker limits', () => {
    test.each([2, 3])('limits packed dispatch to the first %i prewarmed workers', async (limit) => {
        const workers = Array.from({length: 4}, () => new MockCompressionWorker((message) => ({
            compressed: Uint8Array.from(/** @type {Uint8Array} */ (message.content)).buffer,
            envelopeMs: 1,
        })));
        const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ (workers)));
        const result = await pool.compressWrapped(Array.from({length: 12}, (_, i) => Uint8Array.of(i)), null, limit);
        expect(result.chunks.map((bytes) => bytes[0])).toStrictEqual(Array.from({length: 12}, (_, i) => i));
        expect(workers.slice(limit).every(({calls}) => calls.length === 0)).toBe(true);
        expect(workers.slice(0, limit).every(({calls}) => calls.length > 0)).toBe(true);
        pool.close();
    });

    test.each([2, 3])('limits shared-span dispatch without changing order or ownership, limit=%i', async (limit) => {
        const workers = Array.from({length: 4}, () => new MockCompressionWorker((message) => ({
            compressed: Uint8Array.of(/** @type {number} */ (message.contentBytes)).buffer,
            sourceConsumed: true,
        })));
        const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ (workers)));
        const source = new Uint8Array(new SharedArrayBuffer(128));
        const offsets = Uint32Array.of(0, 5, 10, 15, 20, 25);
        const lengths = Uint32Array.of(5, 5, 5, 5, 5, 5);
        const starts = Uint32Array.of(0, 1, 2, 3, 4, 5, 6);
        const blockLengths = Uint32Array.of(5, 5, 5, 5, 5, 5);
        const operation = pool.beginCompressWrappedSpans(source, offsets, lengths, starts, blockLengths, 'jmdict', limit);
        await expect(operation.sourceConsumed).resolves.toBeUndefined();
        const result = await operation.completion;
        expect(result.chunks.map((bytes) => bytes[0])).toStrictEqual([...blockLengths]);
        expect(workers.slice(limit).every(({calls}) => calls.length === 0)).toBe(true);
        for (const worker of workers.slice(0, limit)) {
            for (const {message} of worker.calls) expect(message.source).toBe(source);
        }
        pool.close();
    });

    test('invalid/conflicting limits fail closed before the pool boundary', () => {
        expect(getExperimentalCompressionWorkerLimit(snapshotTermBankExperiments())).toBeNull();
        expect(getExperimentalCompressionWorkerLimit(snapshotTermBankExperiments({experimentalCompressionWorkers2: true}))).toBe(2);
        expect(getExperimentalCompressionWorkerLimit(snapshotTermBankExperiments({experimentalCompressionWorkers3: true}))).toBe(3);
        expect(getExperimentalCompressionWorkerLimit(snapshotTermBankExperiments({experimentalCompressionWorkers2: true, experimentalCompressionWorkers3: true}))).toBeNull();
    });
});
''')
# Ensure test imports helper functions.
replace(
    'test/zstd-term-content-pool.test.js',
    "import {TermContentCompressionPool} from '../ext/js/dictionary/zstd-term-content.js';",
    "import {getExperimentalCompressionWorkerLimit, snapshotTermBankExperiments} from '../ext/js/dictionary/term-bank-experiments.js';\nimport {TermContentCompressionPool} from '../ext/js/dictionary/zstd-term-content.js';",
)
print('Staged 2/3-worker dispatch limits; all four compression workers remain prewarmed and pool lifetime is unchanged')
