/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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
import {deferPromise} from '../ext/js/core/utilities.js';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {encodeRawTermContentSharedGlossaryBinary, RAW_TERM_CONTENT_SHARED_GLOSSARY_DICT_NAME, RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME} from '../ext/js/dictionary/raw-term-content.js';

const encoder = new TextEncoder();
const row = {
    id: 1,
    dictionary: 'test',
    expression: 'old',
    reading: 'old',
    entryContentId: null,
    entryContentOffset: 10,
    entryContentLength: 20,
    entryContentDictName: 'raw',
    score: 1,
    sequence: 1,
};

/**
 * @param {string} value
 * @returns {Uint8Array}
 */
function content(value) {
    return encoder.encode(JSON.stringify({definitionTags: '', termTags: '', rules: '', glossary: [value]}));
}

/** @returns {{entered: import('core').DeferredPromiseDetails<void>, resume: import('core').DeferredPromiseDetails<void>}} */
function barrier() {
    return {entered: deferPromise(), resume: deferPromise()};
}

describe('database lookup generation ownership', () => {
    test.each(['ok', 'corrupt'])('does not cache or diagnose obsolete %s content after lower-level read completion', async (status) => {
        const database = new DictionaryDatabase();
        const gate = barrier();
        const read = vi.spyOn(database, '_readTermEntryContentBytesDetailed')
            .mockImplementationOnce(async () => {
                gate.entered.resolve();
                await gate.resume.promise;
                return status === 'ok' ? {status: 'ok', bytes: content('old')} : {status: 'corrupt', reason: 'obsolete corruption'};
            })
            .mockResolvedValue({status: 'ok', bytes: content('new')});
        const mark = vi.spyOn(Reflect.get(database, '_termRecordStore'), 'markDictionaryReimportRequired');
        const obsolete = database._deserializeTermRow(row);
        const settled = obsolete.then((value) => ({value, error: null}), (error) => ({value: null, error}));
        await gate.entered.promise;
        database._clearBulkImportRuntimeCaches();
        const current = await database._deserializeTermRow(row);
        expect(current.glossary).toEqual(['new']);
        gate.resume.resolve();
        const result = await settled;
        expect(result.error).toMatchObject({status: 'temporarilyUnavailable'});
        expect((await database._deserializeTermRow(row)).glossary).toEqual(['new']);
        expect(read).toHaveBeenCalledTimes(2);
        expect(mark).not.toHaveBeenCalled();
    });

    test.each([false, true])('does not parse obsolete shared glossary bytes as corruption (compressed=%s)', async (compressed) => {
        const database = new DictionaryDatabase();
        const gate = barrier();
        const shared = encodeRawTermContentSharedGlossaryBinary('', '', '', 100, 3, encoder);
        const read = vi.spyOn(database, '_readTermEntryContentBytesDetailed').mockResolvedValue({status: 'ok', bytes: content('new')});
        read.mockResolvedValueOnce({status: 'ok', bytes: shared});
        if (compressed) {
            vi.spyOn(database, '_readCompressedSharedGlossarySlice').mockImplementationOnce(async () => {
                gate.entered.resolve();
                await gate.resume.promise;
                return encoder.encode('bad');
            });
        } else {
            read.mockImplementationOnce(async () => {
                gate.entered.resolve();
                await gate.resume.promise;
                return {status: 'ok', bytes: encoder.encode('bad')};
            });
        }
        const mark = vi.spyOn(Reflect.get(database, '_termRecordStore'), 'markDictionaryReimportRequired');
        const obsolete = database._deserializeTermRow({...row, entryContentDictName: compressed ? RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME : RAW_TERM_CONTENT_SHARED_GLOSSARY_DICT_NAME});
        const settled = obsolete.then((value) => ({value, error: null}), (error) => ({value: null, error}));
        await gate.entered.promise;
        database._clearBulkImportRuntimeCaches();
        gate.resume.resolve();
        const result = await settled;
        expect(result.error).toBeInstanceOf(Error);
        expect(String(result.error)).toContain('temporarily unavailable');
        expect(mark).not.toHaveBeenCalled();
        expect((await database._deserializeTermRow(row)).glossary).toEqual(['new']);
    });

    test.each(['loading', 'records', 'warming', 'materialization'])('does not republish obsolete row IDs after %s', async (phase) => {
        const database = new DictionaryDatabase();
        const gate = barrier();
        /** @type {import('../ext/js/dictionary/term-record-opfs-store.js').TermRecord} */
        const record = {...row, entryContentOffset: -1, entryContentLength: 0};
        const contentStore = /** @type {import('../ext/js/dictionary/term-content-opfs-store.js').TermContentOpfsStore} */ (Reflect.get(database, '_termContentStore'));
        const recordStore = /** @type {import('../ext/js/dictionary/term-record-opfs-store.js').TermRecordOpfsStore} */ (Reflect.get(database, '_termRecordStore'));
        const load = vi.spyOn(contentStore, 'ensureLoadedForRead').mockResolvedValue();
        const getRecords = vi.spyOn(recordStore, 'getByIdsAsync').mockResolvedValue(new Map([[1, record]]));
        const warm = vi.spyOn(contentStore, 'warmSlices').mockResolvedValue();
        const deserialize = database._deserializeTermRow.bind(database);
        switch (phase) {
            case 'loading': {
                load.mockImplementationOnce(async () => {
                    gate.entered.resolve();
                    await gate.resume.promise;
                });

                break;
            }
            case 'records': {
                getRecords.mockImplementationOnce(async () => {
                    gate.entered.resolve();
                    await gate.resume.promise;
                    return new Map([[1, record]]);
                });

                break;
            }
            case 'warming': {
                warm.mockImplementationOnce(async () => {
                    gate.entered.resolve();
                    await gate.resume.promise;
                });

                break;
            }
            default: {
                vi.spyOn(database, '_deserializeTermRow').mockImplementationOnce(async (value) => {
                    const result = await deserialize(value);
                    gate.entered.resolve();
                    await gate.resume.promise;
                    return result;
                });
            }
        }
        const obsolete = database._fetchTermRowsByIds([1]);
        const settled = obsolete.then((value) => ({value, error: null}), (error) => ({value: null, error}));
        await gate.entered.promise;
        database._clearBulkImportRuntimeCaches();
        getRecords.mockResolvedValue(new Map([[1, {...record, expression: 'new'}]]));
        expect((await database._fetchTermRowsByIds([1])).get(1)?.expression).toBe('new');
        gate.resume.resolve();
        const result = await settled;
        expect(result.error).toMatchObject({status: 'temporarilyUnavailable'});
        expect((await database._fetchTermRowsByIds([1])).get(1)?.expression).toBe('new');
    });
});


describe('zero-term dictionary lookup state', () => {
    test('does not treat a metadata-only dictionary as a missing term-record shard', async () => {
        const database = new DictionaryDatabase();
        const db = {
            selectObjects: vi.fn(() => [{
                title: 'Web Frequency',
                summaryJson: JSON.stringify({counts: {terms: {total: 0}}}),
            }]),
        };
        vi.spyOn(database, '_requireDb').mockReturnValue(/** @type {ReturnType<DictionaryDatabase['_requireDb']>} */ (/** @type {unknown} */ (db)));
        const recordStore = /** @type {import('../ext/js/dictionary/term-record-opfs-store.js').TermRecordOpfsStore} */ (Reflect.get(database, '_termRecordStore'));
        const load = vi.spyOn(recordStore, 'ensureDictionariesLoaded').mockResolvedValue();
        const generation = Reflect.get(database, '_directTermIndexGeneration');

        await database._ensureDirectTermIndexesLoaded(['Web Frequency']);

        expect(load).not.toHaveBeenCalled();
        expect(Reflect.get(database, '_directTermIndexLoadedDictionaryNames').has('Web Frequency')).toBe(true);
        expect(Reflect.get(database, '_directTermIndexGeneration')).toBe(generation);

        db.selectObjects.mockClear();
        await database._ensureDirectTermIndexesLoaded(['Web Frequency']);
        expect(db.selectObjects).not.toHaveBeenCalled();
        expect(load).not.toHaveBeenCalled();
    });

    test('retains fail-closed shard loading when summary term count is unavailable', async () => {
        const database = new DictionaryDatabase();
        const db = {
            selectObjects: vi.fn(() => [{title: 'Legacy', summaryJson: JSON.stringify({})}]),
        };
        vi.spyOn(database, '_requireDb').mockReturnValue(/** @type {ReturnType<DictionaryDatabase['_requireDb']>} */ (/** @type {unknown} */ (db)));
        const recordStore = /** @type {import('../ext/js/dictionary/term-record-opfs-store.js').TermRecordOpfsStore} */ (Reflect.get(database, '_termRecordStore'));
        const load = vi.spyOn(recordStore, 'ensureDictionariesLoaded').mockResolvedValue();
        vi.spyOn(recordStore, 'isDictionaryAvailable').mockReturnValue(false);

        await database._ensureDirectTermIndexesLoaded(['Legacy']);

        expect(load).toHaveBeenCalledWith(['Legacy']);
    });
});


describe.each(['indexes', 'rows'])('public lookup generation after %s', (phase) => {
    test.each(['exact', 'prefix', 'exact-pair', 'sequence'])('rejects obsolete %s results', async (kind) => {
        const database = new DictionaryDatabase();
        const gate = barrier();
        const recordStore = /** @type {import('../ext/js/dictionary/term-record-opfs-store.js').TermRecordOpfsStore} */ (Reflect.get(database, '_termRecordStore'));
        const db = /** @type {ReturnType<DictionaryDatabase['_requireDb']>} */ ({});
        vi.spyOn(database, '_requireDb').mockReturnValue(db);
        vi.spyOn(recordStore, 'isDictionaryAvailable').mockReturnValue(true);
        vi.spyOn(recordStore, 'findTermIdMatchesForDictionaries').mockReturnValue([{expression: [1], reading: []}]);
        vi.spyOn(recordStore, 'findTermPrefixIdMatchesForDictionaries').mockReturnValue([{expression: [{id: 1, exact: true}], reading: []}]);
        vi.spyOn(database, '_findDirectTermIds').mockReturnValue([1]);
        vi.spyOn(database, '_findDirectTermIdsBySequence').mockReturnValue([1]);
        const indexes = vi.spyOn(database, '_ensureDirectTermIndexesLoaded').mockResolvedValue();
        const rows = vi.spyOn(database, '_fetchTermRowsByIds').mockResolvedValue(new Map());
        if (phase === 'indexes') {
            indexes.mockImplementationOnce(async () => {
                gate.entered.resolve();
                await gate.resume.promise;
            });
        } else {
            rows.mockImplementationOnce(async () => {
                gate.entered.resolve();
                await gate.resume.promise;
                return new Map();
            });
        }
        const dictionaries = new Set(['test']);
        const request = kind === 'exact-pair' ?
database.findTermsExactBulk([{term: 'old', reading: 'old'}], dictionaries) :
            (kind === 'sequence' ?
database.findTermsBySequenceBulk([{dictionary: 'test', query: 1}]) :
                database.findTermsBulk(['old'], dictionaries, kind === 'exact' ? 'exact' : 'prefix'));
        const settled = request.then((value) => ({value, error: null}), (error) => ({value: null, error}));
        await gate.entered.promise;
        database._clearBulkImportRuntimeCaches();
        gate.resume.resolve();
        expect((await settled).error).toMatchObject({status: 'temporarilyUnavailable'});
    });
});
