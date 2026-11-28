/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {registerOwnedTermContent} from '../ext/js/dictionary/term-content-ownership.js';

/** @typedef {Parameters<DictionaryDatabase['beginBulkAddArtifactTermsChunk']>[0]} Chunk */
/** @typedef {{gate: PromiseWithResolvers<void>, source: Uint8Array}} ContentJob */
/** @typedef {{gate: PromiseWithResolvers<void>, chunk: Chunk}} RecordJob */

/**
 * @param {number} seed
 * @param {{owned?: boolean, shared?: boolean, dictionary?: string}} [options]
 * @returns {Chunk}
 */
function createChunk(seed, {owned = true, shared = true, dictionary = 'JMdict'} = {}) {
    const source = new Uint8Array(shared ? new SharedArrayBuffer(16) : new ArrayBuffer(16));
    source.fill(seed);
    if (owned) { registerOwnedTermContent(source); }
    return {
        dictionary,
        dictionaryTotalRows: 4,
        rowCount: 1,
        contentRowStart: 0,
        expressionBytesList: [Uint8Array.of(97 + seed)],
        readingBytesList: [new Uint8Array(0)],
        readingEqualsExpressionList: new Uint8Array([1]),
        scoreList: new Int32Array(1),
        sequenceList: new Int32Array([-1]),
        contentBytesList: [],
        contentHash1List: new Uint32Array(0),
        contentHash2List: new Uint32Array(0),
        contentBytesBuffer: source,
        contentBytesBaseOffset: 0,
        contentMetaList: new Uint32Array([0, 16, seed + 10, seed + 20]),
        contentUniqueIndexList: new Uint32Array([0]),
        contentDedupPlan: {
            uniqueCount: 1,
            sourceRowCount: 1,
            uniqueRowIndexes: new Uint32Array([0]),
            resolvedFlags: new Uint8Array(1),
            resolvedOffsets: new Float64Array(1),
            resolvedLengths: new Uint32Array(1),
            resolvedDictNames: null,
            pendingEpochs: new Uint32Array(1),
            pendingIndexes: new Uint32Array(1),
            nextEpoch: 1,
            nextUnresolvedUniqueIndex: 0,
        },
        contentDictNameList: null,
        uniformContentDictName: 'raw-v6',
        useResolvedContentReferences: true,
        termRecordPreinternedPlan: null,
    };
}

/**
 * Builds real metadata/dedup owners with independently gated persistence.
 * @returns {{
 *   database: DictionaryDatabase,
 *   content: ContentJob[],
 *   records: RecordJob[],
 *   rollbacks: number[],
 *   appendRecords: ReturnType<typeof vi.fn>,
 *   begin: (chunk: Chunk) => import('../ext/js/dictionary/artifact-term-chunk-pipeline.js').ArtifactTermChunkAppend,
 *   meta: (seed: number) => ReturnType<DictionaryDatabase['_getTermEntryContentMetaByHashPair']>,
 *   finish: (index: number) => void,
 *   cleanup: () => Promise<void>,
 * }}
 */
function createHarness() {
    const database = new DictionaryDatabase();
    Reflect.set(database, '_bulkImportState', 'active');
    Reflect.set(database, '_bulkImportTransactionOpen', true);
    Reflect.set(database, '_bulkImportJournalRecord', {sessionId: 'test-owner'});
    Reflect.set(database, '_deferTermsVirtualTableSync', true);
    Reflect.set(database, '_termContentZstdInitialized', true);
    Reflect.set(database, '_enableTermEntryContentDedup', true);
    /** @type {ContentJob[]} */
    const content = [];
    /** @type {RecordJob[]} */
    const records = [];
    /** @type {number[]} */
    const rollbacks = [];
    let cleaning = false;
    const rollback = Reflect.get(database, '_rollbackStagedArtifactTermContentMetadata').bind(database);
    vi.spyOn(database, '_rollbackStagedArtifactTermContentMetadata').mockImplementation((staged) => {
        if (staged !== null && staged.active) {
            const index = staged.indexes.find((value) => value >= 0);
            if (typeof index === 'number') {
                rollbacks.push(Reflect.get(database, '_termEntryContentMetaHash1Table')[index]);
            }
        }
        rollback(staged);
    });
    const appendRecords = vi.fn(async (/** @type {Chunk} */ chunk) => {
        /** @type {PromiseWithResolvers<void>} */
        const gate = Promise.withResolvers();
        const index = records.length;
        records.push({gate, chunk});
        if (cleaning) { gate.resolve(); }
        await gate.promise;
        return {
            buildRecordsMs: 10 + index,
            encodeMs: 20 + index,
            appendWriteMs: 30 + index,
        };
    });
    Reflect.set(database, '_termRecordStore', {appendBatchFromArtifactChunkResolvedContent: appendRecords});
    Reflect.set(database, '_termContentBlockImportSession', {
        tryBeginAppendSpans: vi.fn((
            /** @type {string} */ dictionary,
            /** @type {Uint8Array} */ source,
            /** @type {Uint32Array} */ offsets,
            /** @type {Uint32Array} */ lengths,
        ) => {
            /** @type {PromiseWithResolvers<void>} */
            const gate = Promise.withResolvers();
            const index = content.length;
            content.push({gate, source});
            if (cleaning) { gate.resolve(); }
            const storage = {
                contentOffsets: Float64Array.from(lengths, (_, i) => 1000 + index * 100 + i * 16),
                contentLengths: new Uint32Array(lengths),
                contentDictName: 'raw-block-v2:jmdict',
            };
            return {
                storage: Promise.resolve(storage),
                sourceConsumed: Promise.resolve(),
                initialSelection: index === 0,
                completion: gate.promise.then(() => ({
                    ...storage,
                    packMs: 1,
                    compressMs: 40 + index,
                    envelopeMs: 2,
                    referenceMs: 3,
                    opfsAppendMs: 4,
                })),
            };
        }),
    });
    const begin = (/** @type {Chunk} */ chunk) => database.beginBulkAddArtifactTermsChunk(chunk, 'test-owner');
    const meta = (/** @type {number} */ seed) => Reflect.get(database, '_getTermEntryContentMetaByHashPair').call(database, seed + 10, seed + 20);
    const finish = (/** @type {number} */ index) => {
        content[index]?.gate.resolve();
        records[index]?.gate.resolve();
    };
    const cleanup = async () => {
        cleaning = true;
        for (const {gate} of content) { gate.resolve(); }
        for (const {gate} of records) { gate.resolve(); }
        const pipeline = Reflect.get(database, '_artifactTermChunkPipeline');
        if (pipeline !== null) { await pipeline.close().catch(() => {}); }
    };
    return {database, content, records, rollbacks, appendRecords, begin, meta, finish, cleanup};
}

describe('ordered artifact term chunk persistence', () => {
    test('prepares one successor but publishes it only after both predecessor owners complete', async () => {
        const h = createHarness();
        const first = h.begin(createChunk(1));
        try {
            await first.published;
            const second = h.begin(createChunk(2));
            let secondPublished = false;
            void second.published.then(() => { secondPublished = true; });
            await vi.waitFor(() => expect(h.content).toHaveLength(2));
            expect(h.records).toHaveLength(1);
            expect(h.meta(1)).toMatchObject({offset: 1000, length: 16});
            expect(h.meta(2)).toBeUndefined();
            expect(() => h.begin(createChunk(3))).toThrow('already owns one successor');

            h.content[0].gate.resolve();
            await Promise.resolve();
            expect(secondPublished).toBe(false);
            expect(h.records).toHaveLength(1);
            h.records[0].gate.resolve();
            const firstMetrics = await first.completion;
            await second.published;
            expect(h.records).toHaveLength(2);
            expect(h.meta(2)).toMatchObject({offset: 1100, length: 16});
            h.finish(1);
            const secondMetrics = await second.completion;
            expect(firstMetrics).toMatchObject({termRecordBuildMs: 10, contentCompressMs: 40});
            expect(secondMetrics).toMatchObject({termRecordBuildMs: 11, contentCompressMs: 41});
            expect(firstMetrics).not.toBe(secondMetrics);
        } finally {
            await h.cleanup();
        }
    });

    test.each(['content', 'record'])('drains a failed predecessor %s and rolls the successor back first', async (owner) => {
        const h = createHarness();
        const firstChunk = createChunk(1);
        const secondChunk = createChunk(2);
        const first = h.begin(firstChunk);
        const failure = new Error('injected predecessor failure');
        try {
            await first.published;
            const second = h.begin(secondChunk);
            void second.published.catch(() => {});
            await vi.waitFor(() => expect(h.content).toHaveLength(2));
            if (owner === 'content') {
                h.content[0].gate.reject(failure);
            } else {
                h.records[0].gate.reject(failure);
            }
            await vi.waitFor(() => expect(() => h.begin(createChunk(3))).toThrow(failure));
            expect(h.rollbacks).toEqual([]);
            h.finish(0);
            await Promise.resolve();
            expect(h.rollbacks).toEqual([]);
            h.content[1].gate.resolve();
            await expect(second.completion).rejects.toBe(failure);
            await expect(first.completion).rejects.toBe(failure);
            expect(h.rollbacks).toEqual([12, 11]);
            expect(h.records).toHaveLength(1);
            expect(h.meta(1)).toBeUndefined();
            expect(h.meta(2)).toBeUndefined();
            expect(firstChunk.contentDedupPlan?.resolvedFlags).toEqual(new Uint8Array([0]));
            expect(secondChunk.contentDedupPlan?.resolvedFlags).toEqual(new Uint8Array([0]));
            expect(Reflect.get(h.database, '_termEntryContentMetaHashPairPendingCount')).toBe(0);
        } finally {
            await h.cleanup();
        }
    });

    test('keeps predecessor metadata alive while the successor resolver still owns reservations', async () => {
        const h = createHarness();
        const first = h.begin(createChunk(1));
        /** @type {PromiseWithResolvers<void>} */
        const releaseResolver = Promise.withResolvers();
        /** @type {PromiseWithResolvers<void>} */
        const resolverStarted = Promise.withResolvers();
        const failure = new Error('failed during successor resolution');
        try {
            await first.published;
            const resolve = h.database._resolveArtifactTermContentDedup.bind(h.database);
            vi.spyOn(h.database, '_resolveArtifactTermContentDedup').mockImplementation(async (chunk, reserve) => {
                const result = await resolve(chunk, reserve);
                resolverStarted.resolve();
                await releaseResolver.promise;
                return result;
            });
            const second = h.begin(createChunk(2));
            void second.published.catch(() => {});
            await resolverStarted.promise;
            h.content[0].gate.reject(failure);
            h.records[0].gate.resolve();
            await vi.waitFor(() => expect(() => h.begin(createChunk(3))).toThrow(failure));
            expect(h.rollbacks).toEqual([]);
            expect(h.meta(1)).toBeDefined();
            releaseResolver.resolve();
            await expect(second.completion).rejects.toBe(failure);
            await expect(first.completion).rejects.toBe(failure);
            expect(h.content).toHaveLength(1);
            expect(h.rollbacks).toEqual([12, 11]);
            expect(h.meta(1)).toBeUndefined();
        } finally {
            releaseResolver.resolve();
            await h.cleanup();
        }
    });

    test.each(['unwitnessed', 'private', 'borrowed', 'partial', 'other-dictionary'])(
        'waits for completion before preparing an ineligible %s successor',
        async (kind) => {
            const h = createHarness();
            const first = h.begin(createChunk(1));
            const next = createChunk(2, {
                owned: kind !== 'unwitnessed',
                shared: kind !== 'private',
                dictionary: kind === 'other-dictionary' ? 'other' : 'JMdict',
            });
            if (kind === 'borrowed') { next.releaseBorrowedContent = vi.fn(); }
            if (kind === 'partial' && next.contentDedupPlan) { next.contentDedupPlan.sourceRowCount = 2; }
            vi.spyOn(h.database, '_persistArtifactTermContent').mockResolvedValue({
                pendingOffsets: [2000],
                pendingLengths: [16],
                pendingResolvedDictNames: 'raw-v6',
                blockProfile: null,
            });
            const resolve = vi.spyOn(h.database, '_resolveArtifactTermContentDedup');
            try {
                await first.published;
                const callsBefore = resolve.mock.calls.length;
                const second = h.begin(next);
                for (let i = 0; i < 12; ++i) { await Promise.resolve(); }
                expect(resolve).toHaveBeenCalledTimes(callsBefore);
                expect(h.records).toHaveLength(1);
                h.finish(0);
                await first.completion;
                await vi.waitFor(() => expect(h.records).toHaveLength(2));
                for (const {gate} of h.content) { gate.resolve(); }
                h.records[1].gate.resolve();
                await second.completion;
                expect(resolve).toHaveBeenCalledTimes(callsBefore + 1);
            } finally {
                await h.cleanup();
            }
        },
    );

    test('keeps an all-duplicate successor completion-only', async () => {
        const h = createHarness();
        const first = h.begin(createChunk(1));
        try {
            await first.published;
            const second = h.begin(createChunk(1));
            let published = false;
            void second.published.then(() => { published = true; });
            for (let i = 0; i < 20; ++i) { await Promise.resolve(); }
            expect(h.content).toHaveLength(1);
            expect(h.records).toHaveLength(1);
            h.finish(0);
            await first.completion;
            await vi.waitFor(() => expect(h.records).toHaveLength(2));
            expect(published).toBe(false);
            h.records[1].gate.resolve();
            const metrics = await second.completion;
            expect(metrics.dedupUniqueCount).toBe(0);
            expect(metrics.dedupPersistedHitCount).toBe(1);
        } finally {
            await h.cleanup();
        }
    });

    test('serializes a legacy write that starts before the first two-phase begin', async () => {
        const h = createHarness();
        const first = h.database.bulkAddArtifactTermsChunk(createChunk(1));
        try {
            await vi.waitFor(() => expect(h.records).toHaveLength(1));
            const second = h.begin(createChunk(2));
            for (let i = 0; i < 12; ++i) { await Promise.resolve(); }
            expect(h.content).toHaveLength(1);
            h.finish(0);
            await expect(first).resolves.toBeUndefined();
            await second.published;
            expect(h.content).toHaveLength(2);
            h.finish(1);
            await second.completion;
        } finally {
            await h.cleanup();
        }
    });

    test('fences empty finalization and resets admission only for a new lifecycle', async () => {
        const h = createHarness();
        expect(await h.database._closeArtifactTermChunkPipeline(false)).toEqual([]);
        expect(() => h.begin(createChunk(1))).toThrow('finalizing');
        await expect(h.database.bulkAddArtifactTermsChunk(createChunk(1))).rejects.toThrow('finalizing');
        expect(h.content).toHaveLength(0);
        h.database._endBulkImportLifecycle();
        h.database._beginBulkImportLifecycle();
        Reflect.set(h.database, '_bulkImportJournalRecord', {sessionId: 'next-owner'});
        expect(() => h.begin(createChunk(1))).toThrow('ownership changed');
        const next = h.database.beginBulkAddArtifactTermsChunk(createChunk(1), 'next-owner');
        try {
            await next.published;
            h.finish(0);
            await next.completion;
        } finally {
            await h.cleanup();
        }
    });

    test('shares cleanup cancellation and filters it without inventing ownership errors', async () => {
        const h = createHarness();
        const first = h.begin(createChunk(1));
        try {
            await first.published;
            Reflect.set(h.database, '_bulkImportState', 'finalizing');
            const a = h.database._closeArtifactTermChunkPipeline(true);
            const b = h.database._closeArtifactTermChunkPipeline(true);
            h.finish(0);
            await expect(first.completion).rejects.toThrow('was cancelled');
            await expect(a).resolves.toEqual([]);
            await expect(b).resolves.toEqual([]);
            expect(h.meta(1)).toBeUndefined();
        } finally {
            await h.cleanup();
        }
    });

    test('preserves a real storage failure that arrives after cleanup cancellation', async () => {
        const h = createHarness();
        const first = h.begin(createChunk(1));
        const failure = new Error('disk failed during cancellation');
        try {
            await first.published;
            const closing = h.database._closeArtifactTermChunkPipeline(true);
            h.content[0].gate.reject(failure);
            h.records[0].gate.resolve();
            await expect(first.completion).rejects.toBe(failure);
            await expect(closing).resolves.toEqual([failure]);
            expect(h.meta(1)).toBeUndefined();
        } finally {
            await h.cleanup();
        }
    });

    test('restores an admitted import after purge preflight fails without admitting a new writer', async () => {
        const h = createHarness();
        const first = h.begin(createChunk(1));
        /** @type {PromiseWithResolvers<void>} */
        const preflight = Promise.withResolvers();
        const failure = new Error('purge root unavailable');
        vi.spyOn(h.database, '_getDictionaryPurgeRoot').mockImplementation(async () => {
            await preflight.promise;
            throw failure;
        });
        try {
            await first.published;
            const purging = h.database.purge();
            void purging.catch(() => {});
            await vi.waitFor(() => expect(Reflect.get(h.database, '_bulkImportState')).toBe('finalizing'));
            expect(() => h.begin(createChunk(2))).toThrow('not active');
            await expect(h.database.bulkAddArtifactTermsChunk(createChunk(2))).rejects.toThrow('finalizing');
            h.finish(0);
            await first.completion;
            preflight.resolve();
            await expect(purging).rejects.toBe(failure);
            expect(Reflect.get(h.database, '_bulkImportState')).toBe('active');
            const second = h.begin(createChunk(2));
            await second.published;
            h.finish(1);
            await second.completion;
        } finally {
            preflight.resolve();
            await h.cleanup();
        }
    });

    test('aggregates real append and abort failures after draining both append owners', async () => {
        const h = createHarness();
        const first = h.begin(createChunk(1));
        const storageFailure = new Error('append storage failure');
        const abortFailure = new Error('abort storage failure');
        vi.spyOn(h.database, '_requireDb').mockReturnValue(
            /** @type {ReturnType<DictionaryDatabase['_requireDb']>} */ (/** @type {unknown} */ ({})),
        );
        const rollback = vi.spyOn(h.database, '_rollbackBulkImport').mockImplementation(async (_db, errors) => {
            expect(h.rollbacks).toEqual([11]);
            errors.push(abortFailure);
            return false;
        });
        vi.spyOn(h.database, '_restoreRuntimeAfterBulkImportFailure').mockImplementation(() => {});
        vi.spyOn(h.database, '_quarantineBulkImportConnection').mockImplementation(() => {});
        try {
            await first.published;
            const aborting = h.database.abortBulkImport('test-owner');
            h.content[0].gate.reject(storageFailure);
            h.records[0].gate.resolve();
            await expect(first.completion).rejects.toBe(storageFailure);
            await expect(aborting).rejects.toMatchObject({errors: [storageFailure, abortFailure]});
            expect(rollback).toHaveBeenCalledOnce();
            expect(Reflect.get(h.database, '_bulkImportState')).toBe('idle');
        } finally {
            await h.cleanup();
        }
    });

    test.each([false, true])('rolls back a late append failure observed by finish, cleanupFailure=%s', async (cleanupFails) => {
        const h = createHarness();
        const first = h.begin(createChunk(1));
        const storageFailure = new Error('late append failure');
        const cleanupFailure = new Error('finalization cleanup failure');
        vi.spyOn(h.database, '_requireDb').mockReturnValue(
            /** @type {ReturnType<DictionaryDatabase['_requireDb']>} */ (/** @type {unknown} */ ({})),
        );
        const rollback = vi.spyOn(h.database, '_rollbackBulkImport').mockImplementation(async (_db, errors) => {
            expect(h.rollbacks).toEqual([11]);
            if (cleanupFails) { errors.push(cleanupFailure); }
            Reflect.set(h.database, '_bulkImportTransactionOpen', false);
            Reflect.set(h.database, '_bulkImportJournalRecord', null);
            return true;
        });
        vi.spyOn(h.database, '_restoreRuntimeAfterBulkImportFailure').mockImplementation(() => {});
        try {
            await first.published;
            const finishing = h.database.finishBulkImport(null, null, 'test-owner');
            void finishing.catch(() => {});
            h.content[0].gate.reject(storageFailure);
            h.records[0].gate.resolve();
            await expect(first.completion).rejects.toBe(storageFailure);
            await (cleanupFails ?
                expect(finishing).rejects.toMatchObject({errors: [storageFailure, cleanupFailure]}) :
                expect(finishing).rejects.toBe(storageFailure));
            expect(rollback).toHaveBeenCalledOnce();
            expect(Reflect.get(h.database, '_bulkImportState')).toBe('idle');
            expect(Reflect.get(h.database, '_bulkImportTransactionOpen')).toBe(false);
            expect(Reflect.get(h.database, '_artifactTermChunkPipeline')).toBeNull();
        } finally {
            await h.cleanup();
        }
    });

    test('reserves finalization before draining admitted owners and rejects competing cleanup', async () => {
        const h = createHarness();
        const first = h.begin(createChunk(1));
        try {
            await first.published;
            const second = h.begin(createChunk(2));
            await vi.waitFor(() => expect(h.content).toHaveLength(2));
            const db = {exec: vi.fn(), close: vi.fn()};
            const contentEnd = vi.fn().mockResolvedValue(void 0);
            const recordEnd = vi.fn().mockResolvedValue(void 0);
            Reflect.set(h.database, '_db', db);
            Reflect.set(h.database, '_termContentStore', {
                endImportSession: contentEnd,
                getLastEndImportSessionMetrics: vi.fn(() => null),
            });
            Object.assign(Reflect.get(h.database, '_termRecordStore'), {
                endImportSession: recordEnd,
                getLastEndImportSessionMetrics: vi.fn(() => null),
            });
            Object.assign(Reflect.get(h.database, '_termContentBlockImportSession'), {close: vi.fn()});
            Reflect.set(h.database, '_importJournal', {clear: vi.fn().mockResolvedValue(void 0)});
            vi.spyOn(h.database, '_syncTermsVirtualTableFromRecordStore').mockResolvedValue();
            vi.spyOn(h.database, '_applyRuntimePragmas').mockImplementation(() => {});
            const purgeRoot = vi.spyOn(h.database, '_getDictionaryPurgeRoot');
            const finishing = h.database.finishBulkImport(null, null, 'test-owner');
            void finishing.catch(() => {});
            await Promise.resolve();
            expect(Reflect.get(h.database, '_bulkImportState')).toBe('finalizing');
            expect(contentEnd).not.toHaveBeenCalled();
            expect(recordEnd).not.toHaveBeenCalled();
            expect(() => h.begin(createChunk(3))).toThrow('finalizing');
            await expect(h.database.close()).rejects.toThrow('Dictionary bulk import finalization is already active');
            await expect(h.database.purge()).rejects.toThrow('Dictionary bulk import finalization is already active');
            await expect(h.database.abortBulkImport('test-owner')).rejects.toThrow('Dictionary bulk import finalization is already active');
            await expect(h.database.finishBulkImport(null, null, 'test-owner')).rejects.toThrow('Dictionary bulk import finalization is already active');
            expect(purgeRoot).not.toHaveBeenCalled();
            expect(db.close).not.toHaveBeenCalled();

            h.finish(0);
            await first.completion;
            await second.published;
            expect(h.records).toHaveLength(2);
            expect(contentEnd).not.toHaveBeenCalled();
            h.finish(1);
            await second.completion;
            await expect(finishing).resolves.toMatchObject({published: true, housekeepingErrors: []});
            expect(contentEnd).toHaveBeenCalledOnce();
            expect(recordEnd).toHaveBeenCalledOnce();
            expect(db.exec).toHaveBeenCalledWith('COMMIT');
            expect(Reflect.get(h.database, '_bulkImportState')).toBe('idle');
        } finally {
            await h.cleanup();
        }
    });

    test.each(['abort', 'finish'])('rejects a stale %s owner after the append drain', async (operation) => {
        const h = createHarness();
        Reflect.set(h.database, '_db', {exec: vi.fn()});
        vi.spyOn(h.database, '_closeArtifactTermChunkPipeline').mockImplementation(async () => {
            h.database._endBulkImportLifecycle();
            h.database._beginBulkImportLifecycle();
            Reflect.set(h.database, '_bulkImportJournalRecord', {sessionId: 'replacement-owner'});
            return [];
        });
        const finalizing = operation === 'abort' ?
            h.database.abortBulkImport('test-owner') :
            h.database.finishBulkImport(null, null, 'test-owner');
        await expect(finalizing).rejects.toThrow('ownership changed');
        expect(Reflect.get(h.database, '_bulkImportState')).toBe('active');
    });
});
