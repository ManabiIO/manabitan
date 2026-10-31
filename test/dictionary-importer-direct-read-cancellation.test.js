/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter} from '@zip.js/zip.js';
import {describe, expect, test, vi} from 'vitest';
import {Uint8ArrayWriter as BundledUint8ArrayWriter, ZipReader} from '../ext/lib/zip.js';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryZipReadScope} from '../ext/js/dictionary/dictionary-zip-read-scope.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

/** @returns {Promise<Blob>} */
async function archive() {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {level: 0});
    await writer.add('index.json', new TextReader(JSON.stringify({title: 'Direct reads', revision: '1', format: 3})));
    await writer.add('term_bank_1.json', new TextReader(JSON.stringify([
        ['term', '', '', '', 1, [{type: 'image', path: 'a.png'}, {type: 'image', path: 'b.png'}], 1, ''],
    ])));
    for (const path of ['a.png', 'b.png']) { await writer.add(path, new Uint8ArrayReader(Uint8Array.of(1, 2, 3))); }
    return new Blob([new Uint8Array(await writer.close())]);
}

function database() {
    return {
        isPrepared: () => true,
        setImportOptimizationFlags() {},
        setTermEntryContentDedupEnabled() {},
        setImportDebugLogging() {},
        dictionaryExists: async () => false,
        addWithResult: async () => 1,
        startBulkImport: vi.fn(async () => 'direct-read-session'),
        finishBulkImport: vi.fn(async () => ({})),
        abortBulkImport: vi.fn(async () => {}),
        deleteDictionaryImportPlaceholder: vi.fn(async () => {}),
        getLastBulkAddTermsMetrics: () => null,
        queuePendingTermContentImportWrites: async () => {},
        bulkAdd: vi.fn(async () => {}),
    };
}

describe('direct dictionary ZIP read cancellation', () => {
    test.each(['index', 'fallback', 'media', 'media-sink-failure'])('aborts and joins stalled %s reads before archive close and rollback', async (stage) => {
        const bytes = await archive();
        const admitted = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        const manualCleanup = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        const decoderCleanup = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        /** @type {Array<AbortSignal|undefined>} */
        const signals = [];
        /** @type {string[]} */
        const events = [];
        const expectedReads = stage.startsWith('media') ? 2 : 1;
        const getEntries = ZipReader.prototype.getEntries;
        vi.spyOn(ZipReader.prototype, 'getEntries').mockImplementation(
            /**
             * @this {import('@zip.js/zip.js').ZipReader<unknown>}
             * @param {...unknown} args
             * @returns {Promise<import('@zip.js/zip.js').Entry[]>}
             */
            async function observedEntries(...args) {
                const entries = /** @type {import('@zip.js/zip.js').Entry[]} */ (await Reflect.apply(getEntries, this, args));
                for (const entry of entries) {
                    const selected = stage === 'index' ? entry.filename === 'index.json' : (stage === 'fallback' ? entry.filename.startsWith('term_bank_') : entry.filename.endsWith('.png'));
                    if (!selected) { continue; }
                    Reflect.set(entry, 'getData', (/** @type {unknown} */ _writer, /** @type {{signal?: AbortSignal}} */ options) => {
                        const signal = options.signal;
                        signals.push(signal);
                        if (signals.length === expectedReads) { admitted.resolve(); }
                        return new Promise((_resolve, reject) => {
                            const onAbort = () => {
                                events.push(`abort:${entry.filename}`);
                                void decoderCleanup.promise.then(() => {
                                    events.push(`settled:${entry.filename}`);
                                    signal?.removeEventListener('abort', onAbort);
                                    reject(signal?.reason);
                                });
                            };
                            signal?.addEventListener('abort', onAbort, {once: true});
                            if (signal?.aborted) { onAbort(); }
                            void manualCleanup.promise.then(() => {
                                signal?.removeEventListener('abort', onAbort);
                                reject(new Error('Manual direct-read test cleanup'));
                            });
                        });
                    });
                }
                return entries;
            },
        );
        const close = ZipReader.prototype.close;
        const closeSpy = vi.spyOn(ZipReader.prototype, 'close').mockImplementation(/** @this {import('@zip.js/zip.js').ZipReader<unknown>} */ async function closeArchive() {
            events.push('archive-close');
            await Reflect.apply(close, this, []);
        });
        const db = database();
        const sinkFailure = new Error('Term sink failed while media was pending');
        if (stage === 'media-sink-failure') {
            db.bulkAdd.mockImplementation(async () => {
                await admitted.promise;
                throw sinkFailure;
            });
        }
        db.abortBulkImport.mockImplementation(async () => { events.push('rollback'); });
        let cancelled = false;
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader(), void 0, () => cancelled);
        // Exercise the ordinary JSON fallback, independently of parser workers.
        Reflect.set(importer, '_disableTermBankWasmFastPath', true);
        vi.useFakeTimers({toFake: ['setInterval', 'clearInterval']});
        let settled = false;
        const pending = importer.importDictionary(
            /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (db)),
            bytes,
            /** @type {import('dictionary-importer').ImportDetails} */ ({skipImageMetadata: true, zipUseWebWorkers: false}),
        ).then((result) => { settled = true; return result; });
        try {
            await admitted.promise;
            expect(db.startBulkImport).toHaveBeenCalledTimes(stage === 'index' ? 0 : 1);
            expect(vi.getTimerCount()).toBe(1);
            if (stage !== 'media-sink-failure') { cancelled = true; }
            await vi.advanceTimersByTimeAsync(100);
            expect(signals.every((signal) => signal?.aborted === true)).toBe(true);
            expect(settled).toBe(false);
            expect(db.abortBulkImport).not.toHaveBeenCalled();
            expect(closeSpy).not.toHaveBeenCalled();
            decoderCleanup.resolve();
            const result = await pending;
            expect(result.result).toBeNull();
            expect(result.errors.some((error) => error.message === (stage === 'media-sink-failure' ? sinkFailure.message : 'Dictionary import was cancelled'))).toBe(true);
            expect(events.filter((event) => event.startsWith('settled:'))).toHaveLength(expectedReads);
            expect(closeSpy).toHaveBeenCalledOnce();
            expect(db.abortBulkImport).toHaveBeenCalledTimes(stage === 'index' ? 0 : 1);
            expect(db.finishBulkImport).not.toHaveBeenCalled();
            let lastSettlement = -1;
            for (const [eventIndex, event] of events.entries()) {
                if (event.startsWith('settled:')) { lastSettlement = eventIndex; }
            }
            expect(events.indexOf('archive-close')).toBeGreaterThan(lastSettlement);
            if (stage !== 'index') { expect(events.indexOf('rollback')).toBeGreaterThan(lastSettlement); }
            expect(vi.getTimerCount()).toBe(0);
            expect(Reflect.get(importer, '_directZipReads')).toBeNull();

            // Reuse the same importer after its cancelled run has fully retired.
            vi.restoreAllMocks();
            cancelled = false;
            const reused = await importer.importDictionary(
                /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (database())),
                bytes,
                /** @type {import('dictionary-importer').ImportDetails} */ ({skipMediaImport: true, zipUseWebWorkers: false}),
            );
            expect(reused.result).not.toBeNull();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            cancelled = true;
            manualCleanup.resolve();
            decoderCleanup.resolve();
            await pending;
            vi.clearAllTimers();
            vi.useRealTimers();
            vi.restoreAllMocks();
        }
    });

    test('keeps explicit source-pool signals and standalone no-signal reads under their original owners', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const getData = vi.fn(async () => Uint8Array.of(1));
        const entry = /** @type {import('@zip.js/zip.js').Entry} */ (/** @type {unknown} */ ({filename: 'media.bin', getData}));
        const writer = /** @type {import('@zip.js/zip.js').Uint8ArrayWriter} */ (/** @type {unknown} */ (new BundledUint8ArrayWriter()));
        const check = vi.fn(() => { throw new Error('Direct scope must not own this read'); });
        const scope = new DictionaryZipReadScope(check);
        try {
            await importer._getData(entry, writer);
            expect(getData).toHaveBeenLastCalledWith(writer, {useWebWorkers: true, checkSignature: true});
            Reflect.set(importer, '_directZipReads', scope);
            const controller = new AbortController();
            await importer._getData(entry, writer, controller.signal);
            expect(getData).toHaveBeenLastCalledWith(writer, {useWebWorkers: true, checkSignature: true, signal: controller.signal});
            expect(check).not.toHaveBeenCalled();
        } finally {
            Reflect.set(importer, '_directZipReads', null);
            await scope.dispose();
        }
    });
});

describe('direct ZIP read scope', () => {
    test('shares one observer, releases completed jobs, and preserves an independent healthy peer', async () => {
        const healthy = /** @type {PromiseWithResolvers<string>} */ (Promise.withResolvers());
        const failure = new Error('Read failed independently');
        const check = vi.fn();
        const scope = new DictionaryZipReadScope(check);
        /** @type {AbortSignal[]} */
        const signals = [];
        vi.useFakeTimers({toFake: ['setInterval', 'clearInterval']});
        const pending = scope.read(async (signal) => {
            signals.push(signal);
            return await healthy.promise;
        });
        try {
            await expect(scope.read(async (signal) => {
                signals.push(signal);
                throw failure;
            })).rejects.toBe(failure);
            expect(signals.every((signal) => !signal.aborted)).toBe(true);
            expect(vi.getTimerCount()).toBe(1);
            healthy.resolve('healthy');
            await expect(pending).resolves.toBe('healthy');
            expect(vi.getTimerCount()).toBe(0);
            const pool = Reflect.get(scope, '_pool');
            expect(Reflect.get(pool, '_reads').size).toBe(0);
            expect(Reflect.get(pool, '_pendingReads').size).toBe(0);
        } finally {
            healthy.resolve('cleanup');
            await pending;
            await scope.dispose();
            vi.useRealTimers();
        }
    });

    test.each([new Error('Predicate failed'), undefined])('preserves cancellation predicate failure %s while draining all decoders', async (failure) => {
        const cleanup = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        let cancelled = false;
        const scope = new DictionaryZipReadScope(() => {
            if (cancelled) { throw failure; }
        });
        /** @type {AbortSignal[]} */
        const signals = [];
        vi.useFakeTimers({toFake: ['setInterval', 'clearInterval']});
        const reads = Array.from({length: 3}, () => scope.read(async (signal) => {
            signals.push(signal);
            await new Promise((resolve) => { signal.addEventListener('abort', resolve, {once: true}); });
            await cleanup.promise;
            throw signal.reason;
        }));
        let settled = false;
        const outcomes = Promise.allSettled(reads).then((results) => {
            settled = true;
            return results;
        });
        try {
            expect(vi.getTimerCount()).toBe(1);
            cancelled = true;
            await vi.advanceTimersByTimeAsync(100);
            expect(signals.every((signal) => signal.aborted)).toBe(true);
            expect(settled).toBe(false);
            cleanup.resolve();
            for (const result of await outcomes) {
                expect(result.status).toBe('rejected');
                if (result.status === 'rejected') { expect(result.reason).toBe(failure); }
            }
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            cleanup.resolve();
            await scope.dispose();
            await outcomes;
            vi.useRealTimers();
        }
    });
});
