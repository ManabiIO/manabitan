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

for (const [entryCount, keysPerBlock] of [[4096, 4], [131072, 131072]]) {
    test(`MDict key assembly preserves ${entryCount} records in ${keysPerBlock}-key blocks`, () => {
        const entries = Array.from({length: entryCount}, (_, index) => ({
            key: `key-${String(index).padStart(6, '0')}`,
            value: `definition-${index}`,
        }));
        const {bytes} = makeMdictFixture(entries, {keysPerBlock, recordBlockSize: 32768});
        const mdx = new MDX('key-assembly.mdx', bytes, {recordBlockCacheBytes: 65536});
        try {
            assert.equal(mdx.keywordList.length, entries.length);
            let offset = 0;
            for (let index = 0; index < entries.length; ++index) {
                const item = mdx.keywordList[index];
                assert.equal(item.keyText, entries[index].key);
                assert.equal(item.keyBlockIdx, Math.floor(index / keysPerBlock));
                assert.equal(item.recordStartOffset, offset);
                offset += entries[index].value.length + 1;
                assert.equal(item.recordEndOffset, offset);
            }
            for (const index of [0, keysPerBlock - 1, Math.min(keysPerBlock, entryCount - 1), entryCount - 1]) {
                assert.equal(mdx.lookup(entries[index].key).definition, `${entries[index].value}\0`);
            }
        } finally {
            mdx.close();
        }
    });
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

for (const compression of /** @type {const} */ (['raw', 'zlib'])) {
    for (const keysPerBlock of [1, 2, 16]) {
        test(`MDX prefix includes every matching key across ${compression}/${keysPerBlock}-key blocks`, () => {
            const {bytes} = makeMdictFixture([
                {key: 'Tea', value: 'tea'},
                {key: 'Tart', value: 'tart'},
                {key: 'Zoo', value: 'zoo'},
                {key: 'Tango', value: 'tango'},
                {key: 'Target', value: 'target'},
            ], {compression, keysPerBlock, recordBlockSize: 3, keyCaseSensitive: 'No', stripKey: 'Yes'});
            const mdx = new MDX('prefix-blocks.mdx', bytes);
            try {
                const original = [...mdx.keywordList];
                for (const prefix of ['ta', 'TA', 't-a']) {
                    const matches = mdx.prefix(prefix);
                    assert.deepEqual(matches.map(({keyText}) => keyText), ['Tango', 'Target', 'Tart']);
                    for (const item of matches) {
                        assert.equal(mdx.fetch_definition(item).definition, `${item.keyText.toLowerCase()}\0`);
                    }
                }
                assert.deepEqual(mdx.keywordList, original);
            } finally {
                mdx.close();
            }
        });
    }
}

test('MDX prefix keeps case-sensitive and punctuation-preserving header rules across blocks', () => {
    const {bytes} = makeMdictFixture([
        {key: 'Tango', value: 'upper'},
        {key: 'tango', value: 'lower'},
        {key: 'T-art', value: 'hyphenated'},
        {key: 'Tart', value: 'plain'},
    ], {keysPerBlock: 1, keyCaseSensitive: 'Yes', stripKey: 'No'});
    const mdx = new MDX('prefix-sensitive.mdx', bytes);
    try {
        assert.deepEqual(mdx.prefix('Ta').map(({keyText}) => keyText), ['Tango', 'Tart']);
        assert.deepEqual(mdx.prefix('ta').map(({keyText}) => keyText), ['tango']);
        assert.deepEqual(mdx.prefix('T-').map(({keyText}) => keyText), ['T-art']);
        assert.deepEqual(mdx.prefix('TA'), []);
    } finally {
        mdx.close();
    }
});

test('MDX prefix honors explicit case and stripping overrides across blocks', () => {
    const {bytes} = makeMdictFixture([
        {key: 'A-bacus', value: 'punctuated'},
        {key: 'abandon', value: 'plain'},
        {key: 'ABate', value: 'upper'},
    ], {keysPerBlock: 1, keyCaseSensitive: 'Yes', stripKey: 'No'});
    const mdx = new MDX('prefix-overrides.mdx', bytes, {isCaseSensitive: false, isStripKey: true});
    try {
        assert.deepEqual(mdx.prefix('a-b').map(({keyText}) => keyText).sort(), ['A-bacus', 'ABate', 'abandon']);
    } finally {
        mdx.close();
    }
});

test('MDX prefix preserves duplicate records and handles empty and absent prefixes', () => {
    const {bytes} = makeMdictFixture([
        {key: 'Alpha', value: 'first sense'},
        {key: 'Alpha', value: 'second sense'},
        {key: 'Alpine', value: 'mountain'},
        {key: 'Beta', value: 'other'},
    ], {keysPerBlock: 1});
    const mdx = new MDX('prefix-homographs.mdx', bytes);
    try {
        const matches = mdx.prefix('al');
        assert.deepEqual(matches.map(({keyText}) => keyText), ['Alpha', 'Alpha', 'Alpine']);
        assert.deepEqual(matches.map((item) => mdx.fetch_definition(item).definition), ['first sense\0', 'second sense\0', 'mountain\0']);
        assert.deepEqual(mdx.prefix(''), mdx.keywordList);
        for (const prefix of ['0', 'alz', 'zzz']) {
            assert.deepEqual(mdx.prefix(prefix), []);
        }
    } finally {
        mdx.close();
    }
});

test('MDX prefix spans UTF-16 key blocks without losing original Unicode spellings', () => {
    const {bytes} = makeMdictFixture([
        {key: '猫', value: 'cat'},
        {key: '猫目', value: 'eyes'},
        {key: '犬', value: 'dog'},
        {key: '猫足', value: 'paws'},
    ], {keysPerBlock: 1, encoding: 'utf16le', recordBlockSize: 3});
    const mdx = new MDX('prefix-unicode.mdx', bytes);
    try {
        assert.deepEqual(mdx.prefix('猫').map(({keyText}) => keyText).sort(), ['猫', '猫目', '猫足']);
        assert.deepEqual(mdx.prefix('空'), []);
    } finally {
        mdx.close();
    }
});
