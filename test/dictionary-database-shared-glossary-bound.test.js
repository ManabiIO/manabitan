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
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import {describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME} from '../ext/js/dictionary/raw-term-content.js';

describe('DictionaryDatabase compressed shared-glossary bounds', () => {
    test.each([0, -1, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY])(
        'rejects invalid persisted decoded length %s before reading compressed bytes',
        async (uncompressedLength) => {
            const database = new DictionaryDatabase();
            const readDetailed = vi.fn(async () => ({status: 'ok', bytes: new Uint8Array([1, 2, 3])}));
            Reflect.set(database, '_termContentBlockStore', {readDetailed});
            Reflect.get(database, '_sharedGlossaryArtifactMetaByDictionary').set('Test', {
                contentOffset: 11,
                contentLength: 3,
                contentDictName: RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME,
                uncompressedLength,
            });

            await expect(Reflect.get(database, '_inflateSharedGlossaryArtifact').call(database, 'Test'))
                .rejects.toThrow(/decoded length is invalid/u);
            expect(readDetailed).not.toHaveBeenCalled();
        },
    );

    test('retains ordinary raw shared-glossary rows without a decoded-length contract', async () => {
        const database = new DictionaryDatabase();
        const bytes = new Uint8Array([1, 2, 3]);
        const readDetailed = vi.fn(async () => ({status: 'ok', bytes}));
        Reflect.set(database, '_termContentBlockStore', {readDetailed});
        Reflect.get(database, '_sharedGlossaryArtifactMetaByDictionary').set('Test', {
            contentOffset: 11,
            contentLength: 3,
            contentDictName: 'raw-v3',
            uncompressedLength: 0,
        });

        await expect(Reflect.get(database, '_inflateSharedGlossaryArtifact').call(database, 'Test'))
            .resolves.toBe(bytes);
        expect(readDetailed).toHaveBeenCalledExactlyOnceWith(11, 3, 'raw');
    });
});
