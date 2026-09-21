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

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MDX} from '../../ext/js/dictionary/mdx/vendor/js-mdict/mdx.js';
import {makeMdictFixture} from './mdict-binary-fixture.js';

/**
 * @returns {MDX}
 */
function makeLookupDictionary() {
    const {bytes} = makeMdictFixture([
        {key: 'Alpha', value: 'first'},
        {key: 'Beta', value: 'second'},
    ]);
    return new MDX('lookup-lifetime.mdx', bytes);
}

test('MDict normalized lookup index stays lazy and preserves the import iterator', () => {
    const mdx = makeLookupDictionary();
    try {
        const source = mdx.keywordList;
        const originalKeys = source.map(({keyText}) => keyText);
        assert.equal(mdx._lookupKeywordList, null);
        assert.match(mdx.fetch_definition(source[0]).definition ?? '', /first/u);
        assert.equal(mdx._lookupKeywordList, null);
        assert.equal(mdx.lookupKeyBlockByWord('alpha')?.keyText, 'Alpha');
        const lookupIndex = mdx._lookupKeywordList;
        assert.notEqual(lookupIndex, null);
        assert.notEqual(lookupIndex, source);
        assert.equal(mdx.lookupKeyBlockByWord('beta')?.keyText, 'Beta');
        assert.equal(mdx._lookupKeywordList, lookupIndex);
        assert.equal(mdx.keywordList, source);
        assert.deepEqual(source.map(({keyText}) => keyText), originalKeys);
    } finally {
        mdx.close();
    }
});

test('MDict close releases the normalized lookup index and cannot return stale keys', () => {
    const mdx = makeLookupDictionary();
    assert.equal(mdx.lookupKeyBlockByWord('alpha')?.keyText, 'Alpha');
    mdx.close();
    assert.equal(mdx._lookupKeywordList, null);
    assert.deepEqual(mdx.keywordList, []);
    assert.equal(mdx.lookupKeyBlockByWord('alpha'), undefined);
    assert.equal(mdx.lookup('Alpha').definition, null);
    assert.deepEqual(mdx.prefix('a'), []);
    mdx.close();
    assert.equal(mdx._lookupKeywordList, null);
});

test('MDict close is idempotent before any direct lookup', () => {
    const mdx = makeLookupDictionary();
    mdx.close();
    mdx.close();
    assert.equal(mdx._lookupKeywordList, null);
    assert.deepEqual(mdx.keywordList, []);
});
