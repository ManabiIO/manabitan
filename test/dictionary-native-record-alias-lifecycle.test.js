/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {TermContentBlockImportSession, TermContentBlockStore} from '../ext/js/dictionary/term-content-block-store.js';
import {TermContentOpfsStore} from '../ext/js/dictionary/term-content-opfs-store.js';
import {createNativeRecordFixture, createNativeRecordGate, receiveNativeRecordFixture} from './util/native-term-record-fixture.js';

/** @typedef {import('../ext/js/dictionary/term-record-opfs-store.js').TermRecordOpfsStore['appendBatchFromArtifactChunkResolvedContent']} RecordAppend */
/** @typedef {Awaited<ReturnType<DictionaryDatabase['_resolveArtifactTermContentDedup']>>} ResolvedContent */
/**
 * @typedef {{
 * database: DictionaryDatabase, events: string[], received: ReturnType<typeof receiveNativeRecordFixture>, dedupResult: ResolvedContent,
 * resolve: import('vitest').MockInstance<DictionaryDatabase['_resolveArtifactTermContentDedup']>,
 * read: import('vitest').MockInstance<DictionaryDatabase['_readTermEntryContentBytes']>,
 * alias: import('vitest').MockInstance<TermContentBlockImportSession['append']>,
 * record: import('vitest').Mock<RecordAppend>, recordCalls: Array<Parameters<RecordAppend>>, append: () => Promise<void>,
 * readStarted: ReturnType<typeof createNativeRecordGate>, aliasStarted: ReturnType<typeof createNativeRecordGate>,
 * recordStarted: ReturnType<typeof createNativeRecordGate>, dedupStarted: ReturnType<typeof createNativeRecordGate>,
 * endContent: import('vitest').Mock<() => Promise<void>>, endRecords: import('vitest').Mock<() => Promise<void>>,
 * rollbackContent: import('vitest').Mock<() => Promise<void>>, rollbackRecords: import('vitest').Mock<() => Promise<void>>,
 * exec: import('vitest').Mock<(value: unknown) => void>, root: {getFileHandle: import('vitest').Mock<() => Promise<object>>},
 * }} DatabaseFixture
 */

/**
 * @param {{read?: Promise<void>, alias?: Promise<void>, record?: Promise<void>, dedup?: Promise<void>}} [gates]
 * @returns {DatabaseFixture}
 */
function createFixture(gates = {}) {
    const {source, rawBytes} = createNativeRecordFixture();
    const received = receiveNativeRecordFixture(source);
    const database = new DictionaryDatabase();
    /** @type {string[]} */
    const events = [];
    const readStarted = createNativeRecordGate();
    const aliasStarted = createNativeRecordGate();
    const recordStarted = createNativeRecordGate();
    const dedupStarted = createNativeRecordGate();
    const plan = /** @type {NonNullable<typeof source.contentDedupPlan>} */ (source.contentDedupPlan);
    /** @type {ResolvedContent} */
    const dedupResult = {
        contentOffsets: new Float64Array(0),
        contentLengths: new Uint32Array(0),
        pendingContentBytes: [],
        pendingContentHash1s: [],
        pendingContentHash2s: [],
        pendingContentDictNames: null,
        pendingRowToUniqueIndex: null,
        pendingContentCount: 0,
        pendingContentSpans: null,
        uniformContentDictName: 'raw-v6',
        pendingHitCount: 0,
        persistedHitCount: source.rowCount,
        exactFallbackCount: 0,
        contentDedupPlan: plan,
        pendingPlanUniqueIndexes: [],
        pendingPlanUniqueStart: null,
        resolvedContentDictNames: /** @type {string[]} */ (plan.resolvedDictNames),
    };
    const resolve = vi.spyOn(database, '_resolveArtifactTermContentDedup').mockImplementation(async () => {
        dedupStarted.resolve();
        if (typeof gates.dedup !== 'undefined') { await gates.dedup; }
        return dedupResult;
    });
    const read = vi.spyOn(database, '_readTermEntryContentBytes').mockImplementation(async () => {
        events.push('read-start');
        readStarted.resolve();
        if (typeof gates.read !== 'undefined') { await gates.read; }
        events.push('read-end');
        return rawBytes;
    });
    const session = new TermContentBlockImportSession(new TermContentBlockStore(new TermContentOpfsStore()));
    Reflect.get(session, '_blockEnabledDictionaries').add(source.dictionary);
    const alias = vi.spyOn(session, 'append').mockImplementation(async (_dictionary, bytes) => {
        events.push('alias-start');
        aliasStarted.resolve();
        if (typeof gates.alias !== 'undefined') { await gates.alias; }
        events.push('alias-end');
        return {
            contentOffsets: new Float64Array([10000]),
            contentLengths: Uint32Array.from(bytes, (entry) => entry.length),
            contentDictName: 'raw-block-v2',
            compressedBytes: 5,
            uncompressedBytes: rawBytes.length,
            packMs: 0,
            compressMs: 0,
            envelopeMs: 0,
            referenceMs: 0,
            opfsAppendMs: 0,
        };
    });
    /** @type {Array<Parameters<RecordAppend>>} */
    const recordCalls = [];
    /** @type {RecordAppend} */
    const appendRecords = async (...args) => {
        recordCalls.push(args);
        events.push('record-start');
        recordStarted.resolve();
        if (typeof gates.record !== 'undefined') { await gates.record; }
        events.push('record-end');
        return {buildRecordsMs: 0, encodeMs: 0, appendWriteMs: 0, validationMs: 0, recordFieldEncodeMs: 0, lookupIndexEncodeMs: 0};
    };
    const record = vi.fn(appendRecords);
    const endContent = vi.fn(async () => { events.push('content-close'); });
    const endRecords = vi.fn(async () => { events.push('record-close'); });
    const rollbackContent = vi.fn(async () => { events.push('content-rollback'); });
    const rollbackRecords = vi.fn(async () => { events.push('record-rollback'); });
    const exec = vi.fn((/** @type {unknown} */ value) => {
        if (value === 'COMMIT') { events.push('commit'); }
        if (value === 'ROLLBACK') { events.push('sql-rollback'); }
    });
    Reflect.set(database, '_db', {exec, close: () => { events.push('database-close'); }});
    Reflect.set(database, '_bulkImportState', 'active');
    Reflect.set(database, '_bulkImportTransactionOpen', true);
    Reflect.set(database, '_bulkImportJournalRecord', {
        version: 1, sessionId: 'native-record-alias', contentCheckpoint: {segments: []}, recordCheckpoint: {shards: []}, createdAt: 0,
    });
    Reflect.set(database, '_enableTermEntryContentDedup', true);
    Reflect.set(database, '_termContentZstdInitialized', true);
    Reflect.set(database, '_termContentBlockImportSession', session);
    Reflect.set(database, '_termContentStore', {
        endImportSession: endContent, rollbackImportSession: rollbackContent, getLastEndImportSessionMetrics: () => null,
    });
    Reflect.set(database, '_termRecordStore', {
        appendBatchFromArtifactChunkResolvedContent: record,
        endImportSession: endRecords,
        rollbackImportSession: rollbackRecords,
        getLastEndImportSessionMetrics: () => null,
    });
    Reflect.set(database, '_importJournal', {clear: async () => { events.push('journal-clear'); }});
    vi.spyOn(database, '_invalidateGlossarySearchIndex').mockImplementation(() => {});
    vi.spyOn(database, '_invalidateTermLookupCaches').mockImplementation(() => {});
    vi.spyOn(database, '_applyRuntimePragmas').mockImplementation(() => {});
    vi.spyOn(database, '_clearBulkImportRuntimeCaches').mockImplementation(() => {});
    vi.spyOn(database, '_createIndexesSql').mockReturnValue([]);
    vi.spyOn(database, '_syncTermsVirtualTableFromRecordStore').mockResolvedValue(void 0);
    vi.spyOn(database, '_rollbackGenerationMedia').mockResolvedValue(void 0);
    const root = {
        getFileHandle: vi.fn(async () => { events.push('purge-marker'); return {}; }),
    };
    vi.spyOn(database, '_getDictionaryPurgeRoot').mockResolvedValue(/** @type {FileSystemDirectoryHandle} */ (/** @type {unknown} */ (root)));
    vi.spyOn(database, '_finishPersistentDictionaryPurge').mockImplementation(async () => {
        events.push('purge');
        return true;
    });
    vi.spyOn(database, '_prepareOnce').mockResolvedValue(void 0);
    const append = () => database.bulkAddArtifactTermsChunk(received.chunk, received.lease);
    return {database, events, received, dedupResult, resolve, read, alias, record, recordCalls, append, readStarted, aliasStarted, recordStarted, dedupStarted, endContent, endRecords, rollbackContent, rollbackRecords, exec, root};
}

describe('native record alias database lifetime', () => {
    test('uses the private reference overlay while preserving canonical dedup references', async () => {
        const fixture = createFixture();
        const plan = /** @type {NonNullable<typeof fixture.received.chunk.contentDedupPlan>} */ (fixture.received.chunk.contentDedupPlan);
        const originalOffsets = new Float64Array(plan.resolvedOffsets);
        await fixture.append();
        const recordChunk = fixture.recordCalls[0][0];
        const names = fixture.recordCalls[0][3];
        expect(names).toBe('raw-block-v2');
        expect(recordChunk.preparedLookupIndexes).toBe(fixture.received.chunk.preparedLookupIndexes);
        expect(recordChunk.resolvedContentReferences?.offsets).toStrictEqual(new Float64Array([10000, 108]));
        expect(plan.resolvedOffsets).toStrictEqual(originalOffsets);
        expect(plan.resolvedDictNames).toStrictEqual(['raw-v6', 'raw-block-v2']);
        expect(fixture.database.getLastBulkAddTermsMetrics()).toMatchObject({contentAliasCount: 1, contentAliasInputBytes: 8, dedupUniqueCount: 0});
        expect(Reflect.get(fixture.database, '_nativeTermRecordAppends').size).toBe(0);
    });

    test('keeps a generic mutable factory caller on the existing mixed route', async () => {
        const fixture = createFixture();
        await fixture.database.bulkAddArtifactTermsChunk(fixture.received.chunk);
        expect(fixture.read).not.toHaveBeenCalled();
        expect(fixture.alias).not.toHaveBeenCalled();
        expect(fixture.recordCalls[0][3]).toEqual(['raw-v6', 'raw-block-v2']);
        expect(Reflect.get(fixture.database, '_nativeTermRecordAppends').size).toBe(0);
    });

    test('abort cancels a delayed raw read and joins the owner before rollback', async () => {
        const gate = createNativeRecordGate();
        const fixture = createFixture({read: gate.promise});
        const append = fixture.append();
        const appendRejected = expect(append).rejects.toThrow('cancelled by database cleanup');
        await fixture.readStarted.promise;
        const abort = fixture.database.abortBulkImport();
        await vi.waitFor(() => { expect(Reflect.get(fixture.database, '_bulkImportState')).toBe('finalizing'); });
        expect(fixture.rollbackContent).not.toHaveBeenCalled();
        gate.resolve();
        await appendRejected;
        await abort;
        expect(fixture.alias).not.toHaveBeenCalled();
        expect(fixture.record).not.toHaveBeenCalled();
        expect(fixture.events.indexOf('content-rollback')).toBeGreaterThan(fixture.events.indexOf('read-end'));
    });

    test.each(['close', 'purge'])('%s joins an already-started alias write before touching storage', async (action) => {
        const gate = createNativeRecordGate();
        const fixture = createFixture({alias: gate.promise});
        const appendRejected = expect(fixture.append()).rejects.toThrow('cancelled by database cleanup');
        await fixture.aliasStarted.promise;
        const cleanup = action === 'close' ? fixture.database.close() : fixture.database.purge();
        await vi.waitFor(() => { expect(Reflect.get(fixture.database, '_bulkImportState')).toBe('finalizing'); });
        expect(fixture.rollbackContent).not.toHaveBeenCalled();
        expect(fixture.events).not.toContain('database-close');
        expect(fixture.events).not.toContain('purge');
        gate.resolve();
        await appendRejected;
        await cleanup;
        expect(fixture.record).not.toHaveBeenCalled();
        const mutation = fixture.events.indexOf(action === 'close' ? 'content-rollback' : 'purge');
        expect(mutation).toBeGreaterThan(fixture.events.indexOf('alias-end'));
    });

    test('finish holds the lease through record append and rejects competing finalizers and new private admission', async () => {
        const gate = createNativeRecordGate();
        const fixture = createFixture({record: gate.promise});
        const append = fixture.append();
        await fixture.recordStarted.promise;
        const finish = fixture.database.finishBulkImport();
        await vi.waitFor(() => { expect(Reflect.get(fixture.database, '_bulkImportState')).toBe('finalizing'); });
        expect(fixture.endRecords).not.toHaveBeenCalled();
        const next = receiveNativeRecordFixture(createNativeRecordFixture().source);
        await expect(fixture.database.bulkAddArtifactTermsChunk(next.chunk, next.lease)).rejects.toThrow('admission is closed');
        await expect(fixture.database.abortBulkImport()).rejects.toThrow('finalization is already active');
        await expect(fixture.database.close()).rejects.toThrow('finalization is already active');
        gate.resolve();
        await append;
        await finish;
        expect(fixture.events.indexOf('record-close')).toBeGreaterThan(fixture.events.indexOf('record-end'));
        expect(fixture.events.indexOf('commit')).toBeGreaterThan(fixture.events.indexOf('record-close'));
    });

    test.each([false, true])('finish rolls back a failed append whether it starts before or after settlement (%s)', async (finishAfterSettlement) => {
        const gate = createNativeRecordGate();
        const fixture = createFixture({alias: gate.promise});
        const appendRejected = expect(fixture.append()).rejects.toThrow('write failed');
        await fixture.aliasStarted.promise;
        let finish;
        if (!finishAfterSettlement) {
            finish = expect(fixture.database.finishBulkImport()).rejects.toThrow('write failed');
        }
        gate.reject(new Error('write failed'));
        await appendRejected;
        if (finishAfterSettlement) {
            finish = expect(fixture.database.finishBulkImport()).rejects.toThrow('write failed');
        }
        await finish;
        expect(fixture.exec).not.toHaveBeenCalledWith('COMMIT');
        expect(fixture.rollbackContent).toHaveBeenCalledOnce();
        expect(fixture.rollbackRecords).toHaveBeenCalledOnce();
        expect(Reflect.get(fixture.database, '_bulkImportState')).toBe('idle');
    });

    test('adopts staged dedup rollback state before observing cancellation after resolution', async () => {
        const gate = createNativeRecordGate();
        const fixture = createFixture({dedup: gate.promise});
        const staged = {indexes: new Int32Array([1]), active: true};
        fixture.dedupResult.pendingContentCount = 1;
        fixture.dedupResult.pendingPlanUniqueStart = 0;
        Reflect.set(fixture.dedupResult, 'stagedContentMetadata', staged);
        const stagedRollback = vi.spyOn(fixture.database, '_rollbackStagedArtifactTermContentMetadata').mockImplementation(() => { fixture.events.push('staged-rollback'); });
        const planRollback = vi.spyOn(fixture.database, '_rollbackArtifactTermContentDedupPlan').mockImplementation(() => { fixture.events.push('plan-rollback'); });
        const appendRejected = expect(fixture.append()).rejects.toThrow('cancelled by database cleanup');
        await fixture.dedupStarted.promise;
        const abort = fixture.database.abortBulkImport();
        await vi.waitFor(() => { expect(Reflect.get(fixture.database, '_bulkImportState')).toBe('finalizing'); });
        gate.resolve();
        await appendRejected;
        await abort;
        expect(stagedRollback).toHaveBeenCalledWith(staged);
        expect(planRollback).toHaveBeenCalledWith(expect.objectContaining({count: 1, start: 0}));
        expect(fixture.events.indexOf('content-rollback')).toBeGreaterThan(fixture.events.indexOf('plan-rollback'));
    });

    test('a failed purge marker leaves an admitted private append resumable', async () => {
        const gate = createNativeRecordGate();
        const fixture = createFixture({read: gate.promise});
        fixture.root.getFileHandle.mockRejectedValueOnce(new Error('marker failed'));
        const append = fixture.append();
        await fixture.readStarted.promise;
        await expect(fixture.database.purge()).rejects.toThrow('marker failed');
        expect(Reflect.get(fixture.database, '_bulkImportState')).toBe('active');
        expect(fixture.rollbackContent).not.toHaveBeenCalled();
        gate.resolve();
        await append;
        await fixture.database.finishBulkImport();
        expect(fixture.exec).toHaveBeenCalledWith('COMMIT');
        expect(fixture.rollbackContent).not.toHaveBeenCalled();
    });
});
