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

/** @returns {{entered: PromiseWithResolvers<void>, resume: PromiseWithResolvers<void>}} */
function barrier() {
    return {entered: Promise.withResolvers(), resume: Promise.withResolvers()};
}

describe('persistent term-record generation ownership', () => {
    test('obsolete lookup load cannot publish loaded membership after quarantine', async () => {
        const store = new TermRecordOpfsStore();
        Reflect.set(store, '_recordsDirectoryHandle', /** @type {FileSystemDirectoryHandle} */ ({}));
        const gate = barrier();
        vi.spyOn(store, '_loadPersistentDictionaryIndex').mockImplementation(async () => {
            gate.entered.resolve();
            await gate.resume.promise;
            return true;
        });

        const loading = store.ensureDictionariesLoaded(['Dictionary']);
        await gate.entered.promise;
        store.markDictionaryReimportRequired('Dictionary', 'New authoritative failure');
        gate.resume.resolve();
        await loading;

        expect(store.getDictionaryHealth('Dictionary')).toEqual({
            status: 'reimportRequired',
            reason: 'New authoritative failure',
        });
        expect(Reflect.get(store, '_loadedDictionaryNames').has('Dictionary')).toBe(false);
    });

    test('superseded repair cannot weaken a newer quarantine', async () => {
        const store = new TermRecordOpfsStore();
        Reflect.set(store, '_recordsDirectoryHandle', /** @type {FileSystemDirectoryHandle} */ ({}));
        const fileName = store._getShardSegmentFileName('Dictionary', 'raw', 0);
        const state = store._createShardState(
            fileName,
            /** @type {FileSystemFileHandle} */ ({}),
            1,
        );
        Reflect.get(store, '_shardStateByFileName').set(fileName, state);
        const gate = barrier();
        vi.spyOn(store, '_rebuildLookupIndexForShard').mockImplementation(async () => {
            gate.entered.resolve();
            await gate.resume.promise;
            return {recordCount: 1, indexBytes: 1};
        });

        const repairing = store._tryRepairPersistentDictionaryIndex('Dictionary');
        await gate.entered.promise;
        store.markDictionaryReimportRequired('Dictionary', 'New repair quarantine');
        gate.resume.resolve();

        await expect(repairing).resolves.toBe(false);
        expect(store.getDictionaryHealth('Dictionary')).toEqual({
            status: 'reimportRequired',
            reason: 'New repair quarantine',
        });
    });
});
