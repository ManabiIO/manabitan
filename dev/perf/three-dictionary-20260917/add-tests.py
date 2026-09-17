from pathlib import Path

helper = '''/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import {describe, expect, test} from 'vitest'
import {copyStableImportBytes} from '../ext/js/core/import-byte-copy.js'

describe('stable shared import byte copies', () => {
    test.each([false, true])('matches native set at every alignment and boundary, shared=%s', (shared) => {
        for (let start = 0; start < 8; start++) {
            for (let destinationOffset = 0; destinationOffset < 8; destinationOffset++) {
                for (const length of [0, 1, 7, 8, 31, 1023, 1024, 1025, 2049, 16000]) {
                    const backing = shared ? new SharedArrayBuffer(start + length) : new ArrayBuffer(start + length)
                    const source = new Uint8Array(backing, start, length)
                    for (let i = 0; i < length; i++) { source[i] = (i * 71 + 31) & 255 }
                    const original = source.slice()
                    const actual = new Uint8Array(length + 32).fill(0xa7)
                    const expected = actual.slice()
                    expected.subarray(3).set(source, destinationOffset)
                    copyStableImportBytes(actual.subarray(3), source, destinationOffset)
                    expect(actual).toEqual(expected)
                    expect(source).toEqual(original)
                }
            }
        }
    })
    test('rejects invalid destinations before any mutation', () => {
        for (const offset of [-1, 0.5, NaN, Infinity, 8, 100]) {
            const target = new Uint8Array(8).fill(9)
            expect(() => copyStableImportBytes(target, new Uint8Array(2), offset)).toThrow(RangeError)
            expect(target).toEqual(new Uint8Array(8).fill(9))
        }
    })
    test.each([false, true])('retains overlapping native-set semantics, shared=%s', (shared) => {
        for (const destination of [0, 1, 7, 8, 15, 31]) {
            const actual = new Uint8Array(shared ? new SharedArrayBuffer(2048) : new ArrayBuffer(2048))
            for (let i = 0; i < actual.length; i++) { actual[i] = i & 255 }
            const expected = actual.slice()
            expected.set(expected.subarray(8, 1800), destination)
            copyStableImportBytes(actual, actual.subarray(8, 1800), destination)
            expect(actual).toEqual(expected)
        }
    })
    test('owns copied source bytes after the source is reused', () => {
        const source = new Uint8Array(new SharedArrayBuffer(8199), 7).fill(49)
        const target = new Uint8Array(source.length)
        copyStableImportBytes(target, source, 0)
        source.fill(0)
        expect(target).toEqual(new Uint8Array(target.length).fill(49))
    })
})
'''
Path('test/import-byte-copy.test.js').write_text(helper)

with Path('test/term-bank-experiments.test.js').open('a') as f:
    f.write('''

describe('full-buffer inflation experiment', () => {
    test.each(['experimentalLibdeflate', 'experimentalAlignedImportCopies'])('defaults off and requires literal true: %s', (key) => {
        const name = /** @type {keyof Experiments} */ (key)
        expect(snapshotTermBankExperiments()[name]).toBe(false)
        for (const value of [false, 0, 1, null, undefined, 'true', {}]) {
            const options = /** @type {Experiments} */ (/** @type {unknown} */ ({[name]: value}))
            expect(snapshotTermBankExperiments(options)[name]).toBe(false)
        }
        expect(snapshotTermBankExperiments({[name]: true})[name]).toBe(true)
    })
    test.each([false, true])('preserves exact keys, content, hints and hashes with spans=%s', async (experimentalTermBankSpans) => {
        const sources = [JSON.stringify([row('日本語', [{type: 'structured-content', content: {tag: 'div', content: 'long'.repeat(4096)}}])]), JSON.stringify([row('tail'), row('duplicate')])]
        const baseline = await parse(sources, {experimentalTermBankSpans}, true)
        for (const enabled of [false, true, true, false]) {
            const candidate = await parse(sources, {experimentalLibdeflate: enabled, experimentalTermBankSpans}, true)
            expect(candidate.rows).toEqual(baseline.rows)
        }
    })
    test.each([false, true])('rejects corrupt compressed sources and recovers, spans=%s', async (experimentalTermBankSpans) => {
        const source = compressed(JSON.stringify([row('validated')]), 8)
        const flags = {experimentalLibdeflate: true, experimentalTermBankSpans}
        await expect(inflateCompressedTermBankSourcesWasm([{...source, signature: (source.signature ^ 1) >>> 0}], flags)).rejects.toThrow()
        await expect(inflateCompressedTermBankSourcesWasm([{...source, bytes: source.bytes.subarray(0, -1), compressedSize: source.compressedSize - 1}], flags)).rejects.toThrow()
        await expect(inflateCompressedTermBankSourcesWasm([{...source, uncompressedSize: source.uncompressedSize - 1}], flags)).rejects.toThrow()
        const sources = [JSON.stringify([row('after failure')]), JSON.stringify([row('second bank')])]
        expect((await parse(sources, flags, true)).rows).toEqual((await parse(sources, {experimentalTermBankSpans}, true)).rows)
    })
})
''')

with Path('test/zstd-term-content-pool.test.js').open('a') as f:
    f.write('''

describe('per-job shared-copy experiment', () => {
    test('passes independent flag snapshots without changing source-consumed ordering', async () => {
        const worker = new MockCompressionWorker((message) => ({
            compressed: Uint8Array.of(/** @type {number} */ (message.contentBytes)).buffer,
            sourceConsumed: true,
        }));
        const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ ([worker])));
        const source = new Uint8Array(new SharedArrayBuffer(4096));
        try {
            for (const enabled of [false, true, true, false]) {
                const operation = pool.beginCompressWrappedSpans(source, Uint32Array.of(1, 2049), Uint32Array.of(1024, 1024), Uint32Array.of(0, 1, 2), Uint32Array.of(1024, 1024), 'jmdict', enabled);
                await expect(operation.sourceConsumed).resolves.toBeUndefined();
                await expect(operation.completion).resolves.toMatchObject({wrapped: true});
                for (const {message, transfer} of worker.calls.slice(-2)) {
                    expect(message.alignedImportCopies).toBe(enabled);
                    expect(message.source).toBe(source);
                    expect(transfer).not.toContain(source.buffer);
                }
            }
        } finally { pool.close(); }
    });
});
''')

with Path('test/term-content-block-store.test.js').open('a') as f:
    f.write('''

describe('import copy setting isolation', () => {
    test('resets the database and block store at the next import', () => {
        const database = new DictionaryDatabase();
        expect(database._alignedImportCopies).toBe(false);
        expect(database._termContentBlockStore._alignedImportCopies).toBe(false);
        database.setImportOptimizationFlags({experimentalAlignedImportCopies: true});
        expect(database._alignedImportCopies).toBe(true);
        expect(database._termContentBlockStore._alignedImportCopies).toBe(true);
        database.setImportOptimizationFlags();
        expect(database._alignedImportCopies).toBe(false);
        expect(database._termContentBlockStore._alignedImportCopies).toBe(false);
    });
});
''')
print('Added copy boundary, inflation parity/recovery and flag isolation regressions')
