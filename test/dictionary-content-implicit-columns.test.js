/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {TERM_CONTENT_SIGNATURE1_MBR6 as MBR6} from '../ext/js/dictionary/term-content-metadata-arena.js';

/**
 * @param {number} [id]
 * @param {number} [signature1]
 * @param {string} [dictName]
 * @returns {Parameters<DictionaryDatabase['_setTermEntryContentMetaByHashPair']>[2]}
 */
function metadata(id = 0, signature1 = MBR6, dictName = 'codec') {
    return {id, offset: 100, length: 12, dictName, signature1, signature2: 22, signature3: 33};
}

/**
 * @param {DictionaryDatabase} database
 * @returns {import('../ext/js/dictionary/term-content-metadata-arena.js').TermContentMetadataArena}
 */
function arenaOf(database) {
    const arena = Reflect.get(database, '_termContentMetadataArena');
    if (arena === null) { throw new Error('Expected allocated metadata'); }
    return arena;
}

describe('combined implicit content metadata columns', () => {
    test('keeps zero IDs, MBR6 signatures and a uniform dictionary prefix implicit through growth', () => {
        const database = new DictionaryDatabase();
        database._setTermEntryContentMetaByHashPair(10, 20, metadata());
        database._setTermEntryContentMetaByHashPair(11, 21, metadata());
        database._ensureTermEntryContentMetaDenseCapacity(4096);
        expect(database._termEntryContentMetaIdTable.byteLength).toBe(0);
        expect(arenaOf(database).signature1).toBeNull();
        expect(database._termEntryContentMetaDictNameIdTable).toBeNull();
        expect(database._termEntryContentMetaDictNameIdPrefixEnd).toBe(2);
        for (const [hash1, hash2] of [[10, 20], [11, 21]]) {
            expect(database._getTermEntryContentMetaByHashPair(hash1, hash2)).toMatchObject(metadata());
        }
        expect(database._readTermEntryContentMetaHashPairIndex(2).id).toBe(0);
        expect(database._readTermEntryContentMetaDictNameId(2)).toBe(0);
        expect(database._readTermContentSignature1(2)).toBe(0);
    });

    test.each([7, -0])('materializes all three exceptional columns while preserving ID %s', (id) => {
        const database = new DictionaryDatabase();
        database._setTermEntryContentMetaByHashPair(10, 20, metadata());
        database._setTermEntryContentMetaByHashPair(11, 21, metadata(id, 1234, 'other'));
        expect(database._termEntryContentMetaIdTable.length).toBe(database._termEntryContentMetaStateTable.length);
        expect(arenaOf(database).signature1).toBeInstanceOf(Uint32Array);
        expect(database._termEntryContentMetaDictNameIdTable).toBeInstanceOf(Uint32Array);
        expect(database._getTermEntryContentMetaByHashPair(10, 20)).toMatchObject(metadata());
        expect(Object.is(database._getTermEntryContentMetaByHashPair(11, 21)?.id, id)).toBe(true);
        expect(database._getTermEntryContentMetaByHashPair(11, 21)).toMatchObject({dictName: 'other', signature1: 1234});
        database._ensureTermEntryContentMetaDenseCapacity(4096);
        expect(Object.is(database._getTermEntryContentMetaByHashPair(11, 21)?.id, id)).toBe(true);
    });

    test.each(['id', 'signature', 'dictionary'])('a %s allocation failure cannot publish a new ID column or replace the entry', (stage) => {
        const database = new DictionaryDatabase();
        database._setTermEntryContentMetaByHashPair(10, 20, metadata());
        const previous = database._getTermEntryContentMetaByHashPair(10, 20);
        const idTable = database._termEntryContentMetaIdTable;
        const states = new Uint8Array(database._termEntryContentMetaStateTable);
        const signatures = new Uint8Array(database._termEntryContentMetaSignaturePresentTable);
        const failure = new RangeError(`injected ${stage} allocation failure`);
        /** @type {() => void} */
        let restore;
        if (stage === 'id') {
            vi.stubGlobal('Float64Array', new Proxy(Float64Array, {
                construct() { throw failure; },
            }));
            restore = () => { vi.unstubAllGlobals(); };
        } else {
            const method = stage === 'signature' ? '_materializeTermContentSignature1' : '_materializeTermEntryContentMetaDictNameIds';
            const fault = vi.spyOn(database, method).mockImplementationOnce(() => { throw failure; });
            restore = () => { fault.mockRestore(); };
        }
        try {
            expect(() => database._setTermEntryContentMetaByHashPair(10, 20, metadata(7, 1234, 'other'))).toThrow(failure);
        } finally { restore(); }
        expect(database._getTermEntryContentMetaByHashPair(10, 20)).toEqual(previous);
        expect(database._termEntryContentMetaIdTable).toBe(idTable);
        expect(database._termEntryContentMetaIdTable.byteLength).toBe(0);
        expect(database._termEntryContentMetaDictNameIdTable).toBeNull();
        expect(database._termEntryContentMetaStateTable).toEqual(states);
        expect(database._termEntryContentMetaSignaturePresentTable).toEqual(signatures);
        // Earlier optional allocation may remain, but its logical words and
        // presence markers cannot change when the later allocation fails.
        expect(arenaOf(database).signature1 === null).toBe(stage !== 'dictionary');
        database._setTermEntryContentMetaByHashPair(10, 20, metadata(7, 1234, 'other'));
        expect(database._getTermEntryContentMetaByHashPair(10, 20)).toMatchObject(metadata(7, 1234, 'other'));
    });

    test('captures signature words before direct insertion clears an aliased physical ID slot', () => {
        const database = new DictionaryDatabase();
        database._setTermEntryContentMetaByHashPair(10, 20, metadata(7));
        database._rollbackStagedArtifactTermContentMetadata({indexes: Int32Array.of(0), active: true});
        const idTable = database._termEntryContentMetaIdTable;
        const bytes = new Uint8Array(idTable.buffer, idTable.byteOffset, 12);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        view.setUint32(0, MBR6, true);
        view.setUint32(4, 22, true);
        view.setUint32(8, 33, true);
        const dictNameId = database._internTermEntryContentMetaDictName('codec');
        database._insertTermEntryContentMetaByHashPairFast(11, 21, 200, 12, 'codec', dictNameId, bytes);
        expect(database._getTermEntryContentMetaByHashPair(11, 21)).toMatchObject({
            id: 0, tableIndex: 0, signature1: MBR6, signature2: 22, signature3: 33,
        });
        expect(view.getUint32(0, true)).toBe(0);
        expect(view.getUint32(4, true)).toBe(0);
    });
});
