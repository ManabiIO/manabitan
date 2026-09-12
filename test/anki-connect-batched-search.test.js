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
import {AnkiConnect} from '../ext/js/comm/anki-connect.js';
import {createAnkiNoteDuplicateSearchDetails} from '../ext/js/data/anki-note-query-util.js';

/**
 * @param {string} term
 * @returns {import('anki').Note}
 */
function note(term) {
    return {
        fields: {Expression: term},
        tags: [],
        deckName: 'Japanese',
        modelName: 'Basic',
        options: {allowDuplicate: false, duplicateScope: 'deck', duplicateScopeOptions: {deckName: 'Japanese', checkChildren: false, checkAllModels: false}},
    };
}

/**
 * @param {ReturnType<typeof vi.fn>} invoke
 * @returns {AnkiConnect}
 */
function client(invoke) {
    const result = new AnkiConnect();
    result.enabled = true;
    result.apiKey = 'test-key';
    Reflect.set(result, '_checkVersion', vi.fn().mockResolvedValue(6));
    Reflect.set(result, '_invoke', invoke);
    return result;
}

describe('Anki batched duplicate search integration', () => {
    test('preserves fork deck scopes, repeated note positions and nested API keys', async () => {
        const first = note('猫');
        const second = note('犬');
        const invalid = {...note(''), fields: {}};
        const queries = [first, second].map((value) => createAnkiNoteDuplicateSearchDetails(value)?.query);
        const invoke = vi.fn().mockResolvedValueOnce([11, 22]).mockResolvedValueOnce([[11], [22]]);
        expect(await client(invoke).findNoteIds([first, invalid, second, first])).toEqual([[11], [], [22], [11]]);
        expect(invoke).toHaveBeenNthCalledWith(1, 'findNotes', {query: queries.map((query) => `(${query})`).join(' or ')});
        expect(invoke).toHaveBeenNthCalledWith(2, 'multi', {actions: queries.map((query) => ({action: 'findNotes', key: 'test-key', params: {query: `nid:11,22 (${query})`}}))});
    });

    test('returns ordinary misses without an additional multi request', async () => {
        const invoke = vi.fn().mockResolvedValue([]);
        expect(await client(invoke).findNoteIds([note('猫'), note('犬')])).toEqual([[], []]);
        expect(invoke).toHaveBeenCalledOnce();
    });

    test('single unique query keeps the direct batched path', async () => {
        const value = note('猫');
        const invoke = vi.fn().mockResolvedValue([[11]]);
        expect(await client(invoke).findNoteIds([value, value])).toEqual([[11], [11]]);
        expect(invoke).toHaveBeenCalledWith('multi', {actions: [{action: 'findNotes', key: 'test-key', params: {query: createAnkiNoteDuplicateSearchDetails(value)?.query}}]});
        expect(invoke).toHaveBeenCalledOnce();
    });
});
