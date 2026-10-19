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
import {createAnkiNoteNativeDuplicateSearchDetails} from '../ext/js/data/anki-note-query-util.js';

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
    Reflect.set(result, '_checkVersion', vi.fn().mockResolvedValue(Reflect.get(result, '_connectionGeneration')));
    Reflect.set(result, '_invoke', invoke);
    return result;
}

describe('Anki batched duplicate search integration', () => {
    test('preserves fork deck scopes, repeated note positions and nested API keys', async () => {
        const first = note('猫');
        const second = note('犬');
        const invalid = {...note(''), fields: {}};
        const queries = [first, second].map((value) => createAnkiNoteNativeDuplicateSearchDetails(value, [101])?.query);
        const invoke = vi.fn()
            .mockResolvedValueOnce({Basic: 101})
            .mockResolvedValueOnce([11, 22])
            .mockResolvedValueOnce([[11], [22]]);
        expect(await client(invoke).findNoteIds([first, invalid, second, first])).toEqual([[11], [], [22], [11]]);
        expect(invoke).toHaveBeenNthCalledWith(1, 'modelNamesAndIds', {}, expect.any(Number));
        expect(invoke).toHaveBeenNthCalledWith(2, 'findNotes', {query: queries.map((query) => `(${query})`).join(' or ')}, expect.any(Number));
        expect(invoke).toHaveBeenNthCalledWith(3, 'multi', {actions: queries.map((query) => ({action: 'findNotes', key: 'test-key', params: {query: `nid:11,22 (${query})`}}))}, expect.any(Number));
        expect(invoke.mock.calls[0][2]).toBe(invoke.mock.calls[2][2]);
    });

    test('returns ordinary misses without an additional multi request', async () => {
        const invoke = vi.fn().mockResolvedValueOnce({Basic: 101}).mockResolvedValueOnce([]);
        expect(await client(invoke).findNoteIds([note('猫'), note('犬')])).toEqual([[], []]);
        expect(invoke).toHaveBeenCalledTimes(2);
    });

    test('single unique query keeps the direct batched path', async () => {
        const value = note('猫');
        const invoke = vi.fn().mockResolvedValueOnce({Basic: 101}).mockResolvedValueOnce([[11]]);
        expect(await client(invoke).findNoteIds([value, value])).toEqual([[11], [11]]);
        expect(invoke).toHaveBeenCalledWith('multi', {actions: [{action: 'findNotes', key: 'test-key', params: {query: createAnkiNoteNativeDuplicateSearchDetails(value, [101])?.query}}]}, expect.any(Number));
        expect(invoke).toHaveBeenCalledTimes(2);
    });

    test('uses every validated model ID in all-model mode and returns misses when metadata is absent', async () => {
        const source = note('Alpha');
        const value = {...source, options: {...source.options, duplicateScopeOptions: {...source.options.duplicateScopeOptions, checkAllModels: true}}};
        const invoke = vi.fn().mockResolvedValueOnce({Basic: 101, Other: 202, Invalid: Infinity}).mockResolvedValueOnce([[31]]);
        expect(await client(invoke).findNoteIds([value])).toEqual([[31]]);
        expect(invoke).toHaveBeenNthCalledWith(2, 'multi', {actions: [{action: 'findNotes', key: 'test-key', params: {query: '"deck:Japanese" -"deck:Japanese::*" ("dupe:101,Alpha" or "dupe:202,Alpha")'}}]}, expect.any(Number));

        const missing = vi.fn().mockResolvedValue({});
        expect(await client(missing).findNoteIds([value])).toEqual([[]]);
        expect(missing).toHaveBeenCalledOnce();
    });

    test('does not search when the exact source model is missing or model metadata fails', async () => {
        const missingModel = vi.fn().mockResolvedValue({Other: 202});
        expect(await client(missingModel).findNoteIds([note('Alpha')])).toEqual([[]]);
        expect(missingModel).toHaveBeenCalledOnce();

        const failure = vi.fn().mockRejectedValue(new Error('metadata transport failed'));
        await expect(client(failure).findNoteIds([note('Alpha')])).rejects.toThrow('metadata transport failed');
        expect(failure).toHaveBeenCalledOnce();
    });
});
