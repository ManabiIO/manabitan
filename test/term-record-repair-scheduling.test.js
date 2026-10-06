/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test, vi} from 'vitest';
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';

/**
 * @param {string[]} [names]
 * @returns {{store: TermRecordOpfsStore, repaired: Set<string>, load: import('vitest').MockInstance<TermRecordOpfsStore['_loadPersistentDictionaryIndex']>}}
 */
function fixture(names = ['Damaged', 'Healthy']) {
    const store = new TermRecordOpfsStore();
    const repaired = new Set(['Healthy']);
    Reflect.set(store, '_recordsDirectoryHandle', /** @type {FileSystemDirectoryHandle} */ ({}));
    for (const name of names) {
        const fileName = store._getShardSegmentFileName(name, 'raw', 0);
        const fileHandle = /** @type {FileSystemFileHandle} */ (/** @type {unknown} */ ({
            getFile: async () => /** @type {File} */ (new Blob([new Uint8Array([1])])),
        }));
        Reflect.get(store, '_shardStateByFileName').set(fileName, store._createShardState(fileName, fileHandle, 1));
    }
    const load = vi.spyOn(store, '_loadPersistentDictionaryIndex').mockImplementation(async (name) => {
        if (!repaired.has(name)) {
            store._recordPersistentIndexFailure(name, 'invalid', 'Damaged derived index');
            return false;
        }
        Reflect.get(store, '_persistentIndexLoadedDictionaryNames').add(name);
        Reflect.get(store, '_persistentRecordChunksByDictionary').set(name, []);
        store._setDictionaryHealth(name, 'available');
        return true;
    });
    return {store, repaired, load};
}

/** @returns {{entered: PromiseWithResolvers<void>, resume: PromiseWithResolvers<void>}} */
function barrier() {
    return {entered: Promise.withResolvers(), resume: Promise.withResolvers()};
}

describe('term-record repair scheduling', () => {
    test('background returns before rebuild, deduplicates, and leaves healthy lookup ready', async () => {
        const {store, repaired, load} = fixture();
        const gate = barrier();
        const rebuild = vi.spyOn(store, '_rebuildLookupIndexForShard').mockImplementation(async () => {
            gate.entered.resolve();
            await gate.resume.promise;
            repaired.add('Damaged');
            return {recordCount: 1, indexBytes: 1};
        });
        try {
            await store.ensureDictionariesLoaded(['Damaged', 'Healthy'], {repairMode: 'background'});
            await gate.entered.promise;
            expect(store.getDictionaryHealth('Damaged').status).toBe('repairing');
            expect(store.isDictionaryAvailable('Damaged')).toBe(false);
            expect(store.isDictionaryAvailable('Healthy')).toBe(true);
            expect(store.hasPersistentTermLookupIndex('Healthy')).toBe(true);
            expect(store.findTermIds('Healthy', 'absent', 'expression')).toEqual([]);
            await Promise.all(Array.from({length: 20}, () => store.ensureDictionariesLoaded(['Damaged', 'Healthy'], {repairMode: 'background'})));
            expect(rebuild).toHaveBeenCalledTimes(1);
            expect(load.mock.calls.filter(([name]) => name === 'Damaged')).toHaveLength(1);
            expect(Reflect.get(store, '_persistentIndexRepairPromiseByDictionary').size).toBe(1);
        } finally {
            gate.resume.resolve();
            await store._awaitPersistentIndexRepairs();
        }
        expect(store.getDictionaryHealth('Damaged').status).toBe('available');
        expect(store.isDictionaryAvailable('Damaged')).toBe(true);
        expect(store.hasPersistentTermLookupIndex('Damaged')).toBe(true);
        expect(Reflect.get(store, '_loadedDictionaryNames').has('Damaged')).toBe(true);
        expect(Reflect.get(store, '_persistentIndexRepairControlByDictionary').size).toBe(0);
    });

    test.each(/** @type {const} */ (['await', 'background']))('default await joins gated %s repair and publishes lookup state', async (firstMode) => {
        const {store, repaired} = fixture();
        const gate = barrier();
        vi.spyOn(store, '_rebuildLookupIndexForShard').mockImplementation(async () => {
            gate.entered.resolve();
            await gate.resume.promise;
            repaired.add('Damaged');
            return {recordCount: 1, indexBytes: 1};
        });
        const first = store.ensureDictionariesLoaded(['Damaged'], {repairMode: firstMode});
        await gate.entered.promise;
        let complete = false;
        const awaited = store.ensureDictionariesLoaded(['Damaged']).then(() => { complete = true; });
        try {
            await Promise.resolve();
            expect(complete).toBe(false);
        } finally {
            gate.resume.resolve();
            await Promise.all([first, awaited, store._awaitPersistentIndexRepairs()]);
        }
        expect(complete).toBe(true);
        expect(store.getDictionaryHealth('Damaged').status).toBe('available');
        expect(store.hasPersistentTermLookupIndex('Damaged')).toBe(true);
    });

    test.each(['dictionary', 'global', 'deletion'])('queued obsolete %s work never starts or writes', async (invalidation) => {
        const {store, repaired} = fixture(['Damaged', 'Queued']);
        const gate = barrier();
        const rebuild = vi.spyOn(store, '_rebuildLookupIndexForShard').mockImplementation(async (state) => {
            expect(state.fileName).toContain('Damaged');
            gate.entered.resolve();
            await gate.resume.promise;
            repaired.add('Damaged');
            return {recordCount: 1, indexBytes: 1};
        });
        try {
            await store.ensureDictionariesLoaded(['Damaged', 'Queued'], {repairMode: 'background'});
            await gate.entered.promise;
            expect(store.getDictionaryHealth('Queued').status).toBe('repairPending');
            expect(store.isDictionaryAvailable('Queued')).toBe(false);
            expect(Reflect.get(store, '_persistentIndexRepairPromiseByDictionary').size).toBe(2);
            if (invalidation === 'dictionary') { store._invalidatePersistentLookupState('Queued'); }
            if (invalidation === 'global') { store._invalidateAllPersistentLookupState(); }
            if (invalidation === 'deletion') { Reflect.get(store, '_pendingDictionaryDeletionNames').add('Queued'); }
            store._setDictionaryHealth('Queued', 'available');
        } finally {
            gate.resume.resolve();
            await store._awaitPersistentIndexRepairs();
        }
        expect(rebuild).toHaveBeenCalledTimes(1);
        expect(store.getDictionaryHealth('Queued').status).toBe('available');
        expect(Reflect.get(store, '_persistentIndexRepairPromiseByDictionary').size).toBe(0);
        expect(Reflect.get(store, '_persistentIndexRepairRetryByDictionary').has('Queued')).toBe(false);
    });

    test('mutation requests cancellation, joins cleanup, and never starts queued repair', async () => {
        const {store} = fixture(['Damaged', 'Queued']);
        const gate = barrier();
        const abortGate = barrier();
        let current = () => true;
        /** @type {string[]} */
        const events = [];
        const rebuild = vi.spyOn(store, '_rebuildLookupIndexForShard').mockImplementation(async (_state, isCurrent) => {
            current = isCurrent ?? (() => true);
            gate.entered.resolve();
            await gate.resume.promise;
            expect(current()).toBe(false);
            events.push('abort-start');
            abortGate.entered.resolve();
            await abortGate.resume.promise;
            events.push('abort-settled');
            throw new Error('Cancelled');
        });
        await store.ensureDictionariesLoaded(['Damaged', 'Queued'], {repairMode: 'background'});
        await gate.entered.promise;
        const mutation = store._runExclusiveStorageMutation(async () => { events.push('mutation'); });
        try {
            await Promise.resolve();
            expect(current()).toBe(false);
            gate.resume.resolve();
            await abortGate.entered.promise;
            expect(events).toEqual(['abort-start']);
            expect(Reflect.get(store, '_persistentIndexRepairPromiseByDictionary').size).toBe(2);
        } finally {
            gate.resume.resolve();
            abortGate.resume.resolve();
            await Promise.all([mutation, store._awaitPersistentIndexRepairs()]);
        }
        expect(events).toEqual(['abort-start', 'abort-settled', 'mutation']);
        expect(rebuild).toHaveBeenCalledTimes(1);
        expect(store.getDictionaryHealth('Damaged').status).toBe('repairPending');
        expect(store.isDictionaryAvailable('Damaged')).toBe(false);
    });

    test('transient repair errors are observed, backed off, and recover in the same store', async () => {
        const {store, repaired, load} = fixture();
        let now = 100000;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        const rebuild = vi.spyOn(store, '_rebuildLookupIndexForShard').mockRejectedValue(new Error('Temporary OPFS failure'));
        try {
            for (let attempt = 0; attempt < 3; ++attempt) {
                await store.ensureDictionariesLoaded(['Damaged'], {repairMode: 'background'});
                await store._awaitPersistentIndexRepairs();
                expect(rebuild).toHaveBeenCalledTimes(attempt + 1);
                expect(store.getDictionaryHealth('Damaged').status).toBe('temporarilyUnavailable');
                expect(store.isDictionaryAvailable('Damaged')).toBe(false);
                const loads = load.mock.calls.length;
                for (let hover = 0; hover < 20; ++hover) {
                    await store.ensureDictionariesLoaded(['Damaged'], {repairMode: 'background'});
                }
                expect(rebuild).toHaveBeenCalledTimes(attempt + 1);
                expect(load).toHaveBeenCalledTimes(loads);
                now += 1000 * (2 ** attempt);
            }
            rebuild.mockImplementation(async () => {
                repaired.add('Damaged');
                return {recordCount: 1, indexBytes: 1};
            });
            await store.ensureDictionariesLoaded(['Damaged'], {repairMode: 'background'});
            await store._awaitPersistentIndexRepairs();
            expect(rebuild).toHaveBeenCalledTimes(4);
            expect(store.getDictionaryHealth('Damaged').status).toBe('available');
            expect(store.hasPersistentTermLookupIndex('Damaged')).toBe(true);
            expect(Reflect.get(store, '_persistentIndexRepairRetryByDictionary').has('Damaged')).toBe(false);
        } finally {
            await store._awaitPersistentIndexRepairs();
            clock.mockRestore();
        }
    });

    test('background authoritative corruption quarantines only the damaged dictionary', async () => {
        const {store} = fixture();
        await store.ensureDictionariesLoaded(['Damaged', 'Healthy'], {repairMode: 'background'});
        await store._awaitPersistentIndexRepairs();
        expect(store.getDictionaryHealth('Damaged').status).toBe('reimportRequired');
        expect(store.isDictionaryAvailable('Damaged')).toBe(false);
        expect(store.isDictionaryAvailable('Healthy')).toBe(true);
        const rebuild = vi.spyOn(store, '_rebuildLookupIndexForShard');
        await store.ensureDictionariesLoaded(['Damaged'], {repairMode: 'background'});
        expect(rebuild).not.toHaveBeenCalled();
    });

    test('post-repair reload failure remains owned, observed, and subject to backoff', async () => {
        const {store, repaired, load} = fixture();
        const gate = barrier();
        vi.spyOn(store, '_rebuildLookupIndexForShard').mockImplementation(async () => {
            repaired.add('Damaged');
            return {recordCount: 1, indexBytes: 1};
        });
        const originalLoad = load.getMockImplementation();
        if (typeof originalLoad === 'undefined') { throw new Error('Expected fixture loader'); }
        load.mockImplementation(async (...args) => {
            if (!repaired.has('Damaged')) { return await originalLoad(...args); }
            gate.entered.resolve();
            await gate.resume.promise;
            throw new Error('Temporary reload error');
        });
        try {
            await store.ensureDictionariesLoaded(['Damaged'], {repairMode: 'background'});
            await gate.entered.promise;
            expect(Reflect.get(store, '_persistentIndexRepairPromiseByDictionary').size).toBe(1);
        } finally {
            gate.resume.resolve();
            await store._awaitPersistentIndexRepairs();
        }
        expect(store.getDictionaryHealth('Damaged').status).toBe('temporarilyUnavailable');
        expect(Reflect.get(store, '_persistentIndexRepairRetryByDictionary').has('Damaged')).toBe(true);
        const calls = load.mock.calls.length;
        await store.ensureDictionariesLoaded(['Damaged'], {repairMode: 'background'});
        expect(load).toHaveBeenCalledTimes(calls);
    });

    test('repeated reload failures retain exponential backoff through rebuild generation changes', async () => {
        const {store} = fixture();
        let now = 100000;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        const load = vi.spyOn(store, '_tryLoadPersistentDictionaryIndex').mockResolvedValue(false);
        const rebuild = vi.spyOn(store, '_rebuildLookupIndexForShard').mockResolvedValue({recordCount: 1, indexBytes: 1});
        try {
            for (let attempt = 1; attempt <= 8; ++attempt) {
                await store.ensureDictionariesLoaded(['Damaged'], {repairMode: 'background'});
                await store._awaitPersistentIndexRepairs();
                expect(rebuild).toHaveBeenCalledTimes(attempt);
                expect(store._getPersistentLookupGeneration('Damaged')).toBe(attempt);
                const retry = Reflect.get(store, '_persistentIndexRepairRetryByDictionary').get('Damaged');
                const delay = Math.min(30000, 1000 * (2 ** (Math.min(attempt, 6) - 1)));
                expect(retry).toEqual({attempts: Math.min(attempt, 6), retryAt: now + delay});
                const calls = load.mock.calls.length;
                now += delay - 1;
                await store.ensureDictionariesLoaded(['Damaged'], {repairMode: 'background'});
                expect(load).toHaveBeenCalledTimes(calls);
                now += 1;
            }
            store._setDictionaryHealth('Damaged', 'available');
            expect(Reflect.get(store, '_persistentIndexRepairRetryByDictionary').has('Damaged')).toBe(false);
        } finally {
            await store._awaitPersistentIndexRepairs();
            clock.mockRestore();
        }
    });

    test('maintenance repair inside exclusive mutation does not join itself', async () => {
        const {store, repaired} = fixture();
        vi.spyOn(store, '_rebuildLookupIndexForShard').mockImplementation(async () => {
            repaired.add('Damaged');
            return {recordCount: 1, indexBytes: 1};
        });
        await store._runExclusiveStorageMutation(async () => {
            await expect(store._tryRepairPersistentDictionaryIndex('Damaged', true, true)).resolves.toBe(true);
            expect(store.hasPersistentTermLookupIndex('Damaged')).toBe(true);
        });
        await store._awaitPersistentIndexRepairs();
        expect(Reflect.get(store, '_persistentIndexRepairPromiseByDictionary').size).toBe(0);
        expect(Reflect.get(store, '_storageMutationActive')).toBe(false);
    });

    test('obsolete post-publication reload failure preserves newer generation health and retry ownership', async () => {
        const {store, repaired, load} = fixture();
        const gate = barrier();
        const originalLoad = load.getMockImplementation();
        if (typeof originalLoad === 'undefined') { throw new Error('Expected fixture loader'); }
        load.mockImplementation(async (...args) => {
            if (!repaired.has('Damaged')) { return await originalLoad(...args); }
            gate.entered.resolve();
            await gate.resume.promise;
            throw new Error('Obsolete reload failed');
        });
        vi.spyOn(store, '_rebuildLookupIndexForShard').mockImplementation(async () => {
            repaired.add('Damaged');
            return {recordCount: 1, indexBytes: 1};
        });
        const retries = Reflect.get(store, '_persistentIndexRepairRetryByDictionary');
        let newerRetry;
        try {
            await store.ensureDictionariesLoaded(['Damaged'], {repairMode: 'background'});
            await gate.entered.promise;
            expect(store._getPersistentLookupGeneration('Damaged')).toBe(1);
            store._invalidatePersistentLookupState('Damaged');
            store._setDictionaryHealth('Damaged', 'temporarilyUnavailable', 'New generation transient failure');
            store._deferPersistentIndexRepair('Damaged');
            newerRetry = retries.get('Damaged');
        } finally {
            gate.resume.resolve();
            await store._awaitPersistentIndexRepairs();
        }
        expect(store._getPersistentLookupGeneration('Damaged')).toBe(2);
        expect(store.getDictionaryHealth('Damaged')).toEqual({status: 'temporarilyUnavailable', reason: 'New generation transient failure'});
        expect(retries.get('Damaged')).toBe(newerRetry);
        expect(Reflect.get(store, '_persistentIndexRepairPromiseByDictionary').size).toBe(0);
        expect(Reflect.get(store, '_persistentIndexRepairControlByDictionary').size).toBe(0);
    });

    test('per-dictionary invalidation clears loaded markers without evicting a healthy sibling', async () => {
        const {store, repaired} = fixture();
        repaired.add('Damaged');
        await store.ensureDictionariesLoaded(['Damaged', 'Healthy']);
        Reflect.set(store, '_allShardContentsLoaded', true);
        const globalGeneration = Reflect.get(store, '_persistentLookupGeneration');
        store._invalidatePersistentLookupState('Damaged');
        expect(Reflect.get(store, '_loadedDictionaryNames').has('Damaged')).toBe(false);
        expect(store.hasPersistentTermLookupIndex('Damaged')).toBe(false);
        expect(Reflect.get(store, '_allShardContentsLoaded')).toBe(false);
        expect(Reflect.get(store, '_persistentLookupGeneration')).toBe(globalGeneration);
        expect(Reflect.get(store, '_loadedDictionaryNames').has('Healthy')).toBe(true);
        expect(store.hasPersistentTermLookupIndex('Healthy')).toBe(true);
    });

    test('obsolete corruption cannot quarantine a newer dictionary generation', async () => {
        const {store} = fixture();
        const gate = barrier();
        const original = store._rebuildLookupIndexForShard.bind(store);
        vi.spyOn(store, '_rebuildLookupIndexForShard').mockImplementation(async (state) => {
            gate.entered.resolve();
            await gate.resume.promise;
            return await original(state);
        });
        try {
            await store.ensureDictionariesLoaded(['Damaged'], {repairMode: 'background'});
            await gate.entered.promise;
            store._invalidatePersistentLookupState('Damaged');
            store._setDictionaryHealth('Damaged', 'available');
        } finally {
            gate.resume.resolve();
            await store._awaitPersistentIndexRepairs();
        }
        expect(store.getDictionaryHealth('Damaged').status).toBe('available');
        expect(Reflect.get(store, '_persistentIndexRepairRetryByDictionary').has('Damaged')).toBe(false);
    });

    test('invalid repair modes fail explicitly', async () => {
        const store = new TermRecordOpfsStore();
        await expect(store.ensureDictionariesLoaded([], {repairMode: /** @type {'await'} */ ('invalid')})).rejects.toThrow('Invalid dictionary repair mode');
    });
});
