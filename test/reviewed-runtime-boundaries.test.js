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

import {afterEach, describe, expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME} from '../ext/js/dictionary/raw-term-content.js';
import {DictionaryController} from '../ext/js/pages/settings/dictionary-controller.js';

const {decoder} = vi.hoisted(() => ({
    decoder: vi.fn((/** @type {Uint8Array} */ bytes) => /** @type {unknown} */ (bytes)),
}));

vi.mock('../ext/lib/zstd-wasm.js', async (importOriginal) => ({
    ...await importOriginal(),
    decompress: decoder,
}));

const inflate = /** @type {(this: DictionaryDatabase, dictionary: string) => Promise<Uint8Array>} */ (
    Reflect.get(DictionaryDatabase.prototype, '_inflateSharedGlossaryArtifact')
);
const debug = /** @type {(this: Backend, query: string, names: string[]) => Promise<unknown>} */ (
    Reflect.get(Backend.prototype, '_debugDictionaryLookupStateLocal')
);
const matchTitle = /** @type {(this: DictionaryController, title: unknown) => string} */ (
    Reflect.get(DictionaryController.prototype, '_getDictionaryTaskMatchTitle')
);

/** @returns {DictionaryDatabase} */
function glossaryDatabase() {
    const database = new DictionaryDatabase();
    Reflect.set(database, '_getSharedGlossaryArtifactMeta', () => ({
        contentOffset: 1,
        contentLength: 3,
        uncompressedLength: 3,
        contentDictName: RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME,
    }));
    Reflect.set(database, '_termContentBlockStore', {
        readDetailed: vi.fn().mockResolvedValue({status: 'ok', bytes: new Uint8Array([1, 2, 3])}),
    });
    return database;
}

describe('reviewed runtime boundaries', () => {
    afterEach(() => {
        decoder.mockReset();
    });

    test('preserves the exact decoder byte view including nonzero offsets', async () => {
        const decoded = new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4);
        decoder.mockReturnValue(decoded);
        expect(await inflate.call(glossaryDatabase(), 'fixture')).toBe(decoded);
    });

    test.each([null, {}, 'abc', new ArrayBuffer(3)])('rejects non-byte decoder output %s as a normal corruption error', async (value) => {
        decoder.mockReturnValue(value);
        await expect(inflate.call(glossaryDatabase(), 'fixture')).rejects.toThrow('Shared glossary decompression failed');
    });

    test('retains decoded-length integrity checking', async () => {
        decoder.mockReturnValue(new Uint8Array([1, 2]));
        await expect(inflate.call(glossaryDatabase(), 'fixture')).rejects.toThrow('decoded length mismatch');
    });

    test('keeps the underlying decoder failure as the error cause', async () => {
        const cause = new Error('decoder failed');
        decoder.mockImplementation(() => { throw cause; });
        await expect(inflate.call(glossaryDatabase(), 'fixture')).rejects.toMatchObject({cause});
    });

    test('returns unavailable diagnostics for a worker proxy without local hooks', async () => {
        const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
        Reflect.set(backend, '_dictionaryDatabase', {});
        await expect(debug.call(backend, '日本', ['fixture'])).resolves.toMatchObject({ok: false, reason: 'debug lookup unavailable'});
    });

    test('preserves local hook receivers and row results without optional storage diagnostics', async () => {
        const database = {
            _findDirectTermIds: vi.fn((/** @type {string} */ _name, /** @type {string} */ _query, /** @type {string} */ field) => (field === 'expression' ? [7] : [])),
            _fetchTermRowsByIds: vi.fn().mockResolvedValue(new Map([[7, {dictionary: 'fixture', expression: '日本', reading: 'にほん', glossary: ['Japan']}]])),
            _ensureDirectTermIndexesLoaded: vi.fn().mockResolvedValue(void 0),
        };
        const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
        Reflect.set(backend, '_dictionaryDatabase', database);
        await expect(debug.call(backend, '日本', ['fixture'])).resolves.toMatchObject({
            ok: true,
            rowSample: [{id: 7, expression: '日本', reading: 'にほん', glossaryLength: 1, rawContentPreview: null}],
            termContentStoreDebugState: null,
        });
        expect(database._findDirectTermIds.mock.contexts).toEqual([database, database]);
        expect(database._fetchTermRowsByIds.mock.contexts).toEqual([database]);
        expect(database._ensureDirectTermIndexesLoaded.mock.contexts).toEqual([database]);
    });

    test('does not invoke arbitrary object coercion when normalizing dictionary task titles', () => {
        const controller = /** @type {DictionaryController} */ (Object.create(DictionaryController.prototype));
        const toString = vi.fn(() => 'JMdict');
        expect(matchTitle.call(controller, {toString})).toBe('');
        expect(toString).not.toHaveBeenCalled();
        expect(matchTitle.call(controller, '  JMdict   Japanese  ')).toBe('jmdict japanese');
        expect(matchTitle.call(controller, null)).toBe('');
    });
});
