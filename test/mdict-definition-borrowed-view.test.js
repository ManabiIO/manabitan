/*
 * Copyright (C) 2026  Yomitan Authors
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
import {MDX} from '../ext/js/dictionary/mdx/vendor/js-mdict/mdx.js';

/**
 * @param {Uint8Array[]} blocks
 * @returns {MDX}
 */
function createContext(blocks) {
    const recordInfoList = [];
    let offset = 0;
    for (const block of blocks) {
        recordInfoList.push({
            unpackAccumulatorOffset: offset,
            unpackSize: block.byteLength,
        });
        offset += block.byteLength;
    }
    const context = /** @type {MDX} */ (Object.assign(Object.create(MDX.prototype), {
        meta: {decoder: new TextDecoder('utf-8')},
        recordInfoList,
    }));
    Reflect.set(context, '_readRecordBlock', vi.fn((index) => blocks[index]));
    return context;
}

describe('MDX borrowed record views', () => {
    test('public byte lookup remains independently owned', () => {
        const block = new TextEncoder().encode('xxdefinitionyy');
        const context = createContext([block]);
        const item = {keyText: 'word', recordStartOffset: 2, recordEndOffset: 12};
        const bytes = context.lookupRecordByKeyBlock(item);
        expect(bytes).toEqual(new TextEncoder().encode('definition'));
        expect(bytes?.buffer).not.toBe(block.buffer);
        bytes?.fill(0);
        expect(new TextDecoder().decode(block)).toBe('xxdefinitionyy');
    });

    test('internal single-block text path borrows without changing decoded strings', () => {
        const block = new TextEncoder().encode('xxdefinitionyy');
        const context = createContext([block]);
        const item = {keyText: 'word', recordStartOffset: 2, recordEndOffset: 12};
        const view = /** @type {Uint8Array} */ (
            Reflect.get(context, '_lookupRecordViewByKeyBlock').call(context, item)
        );
        expect(view.buffer).toBe(block.buffer);
        const result = context.fetch_definition(item);
        expect(result).toEqual({keyText: 'word', definition: 'definition'});
        block.fill(0);
        expect(result.definition).toBe('definition');
    });

    test('lookup and fetch use the borrowed text path', () => {
        const block = new TextEncoder().encode('definition');
        const context = createContext([block]);
        const item = {keyText: 'word', recordStartOffset: 0, recordEndOffset: block.length};
        Reflect.set(context, 'lookupKeyBlockByWord', vi.fn(() => item));
        const borrowed = vi.spyOn(
            /** @type {import('core').SafeAny} */ (context),
            '_lookupRecordViewByKeyBlock',
        );
        expect(context.lookup('word').definition).toBe('definition');
        expect(context.fetch(item).definition).toBe('definition');
        expect(borrowed).toHaveBeenCalledTimes(2);
    });

    test('records spanning blocks still return assembled owned bytes', () => {
        const first = new TextEncoder().encode('abc');
        const second = new TextEncoder().encode('def');
        const context = createContext([first, second]);
        const item = {keyText: 'word', recordStartOffset: 1, recordEndOffset: 5};
        const view = /** @type {Uint8Array} */ (
            Reflect.get(context, '_lookupRecordViewByKeyBlock').call(context, item)
        );
        expect(new TextDecoder().decode(view)).toBe('bcde');
        expect(view.buffer).not.toBe(first.buffer);
        expect(view.buffer).not.toBe(second.buffer);
    });
});
