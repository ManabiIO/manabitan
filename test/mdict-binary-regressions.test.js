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

import {describe, expect, test} from 'vitest';
import {MDX} from '../ext/js/dictionary/mdx/vendor/js-mdict/mdx.js';
import {MDD} from '../ext/js/dictionary/mdx/vendor/js-mdict/mdd.js';
import {createMdxImportData} from '../ext/js/dictionary/mdx/mdx-converter.js';
import {makeFixturePng, makeMdictFixture} from './util/mdict-binary-fixture.js';

/** @param {Map<string, Uint8Array>} files @returns {any[][]} */
function readRows(files) {
    return [...files.entries()]
        .filter(([path]) => /^term_bank_\d+\.json$/u.test(path))
        .sort(([a], [b]) => Number(a.match(/\d+/u)?.[0]) - Number(b.match(/\d+/u)?.[0]))
        .flatMap(([, bytes]) => JSON.parse(new TextDecoder().decode(bytes)));
}

/** @param {unknown} value @param {string} tag @returns {Array<Record<string, any>>} */
function nodes(value, tag) {
    /** @type {Array<Record<string, any>>} */
    const found = [];
    const pending = [value];
    while (pending.length > 0) {
        const next = pending.pop();
        if (Array.isArray(next)) {
            pending.push(...next);
        } else if (typeof next === 'object' && next !== null) {
            const record = /** @type {Record<string, any>} */ (next);
            if (record.tag === tag) { found.push(record); }
            pending.push(...Object.values(record));
        }
    }
    return found;
}

// No parser, codec or HTML mocks. These exercise native bytes through conversion,
// but are not OPFS persistence or popup-rendering qualification.
describe('MDict v2 binary records', () => {
    for (const compression of /** @type {const} */ (['raw', 'zlib'])) {
        for (const encoding of /** @type {const} */ (['utf8', 'utf16le'])) {
            for (const recordBlockSize of [1, 7, 64]) {
                test(`${compression}/${encoding}/${recordBlockSize}-byte blocks preserve whole records`, () => {
                    const entries = [
                        {key: 'zebra', value: '<div>猫と犬 🐈 é\nsecond line</div>'},
                        {key: 'apple', value: '<p>an intentionally longer definition</p>'},
                        {key: '猫', value: '<b>ねこ</b>'},
                    ];
                    const fixture = makeMdictFixture(entries, {compression, encoding, recordBlockSize, keysPerBlock: 1});
                    for (const recordBlockCacheBytes of [0, 1024]) {
                        const mdx = new MDX('records.MDX', fixture.bytes, {recordBlockCacheBytes});
                        try {
                            for (let i = 0; i < entries.length; i += 1) {
                                const item = mdx.keywordList.find(({keyText}) => keyText === entries[i].key);
                                expect(item).toBeDefined();
                                expect(mdx.lookupRecordByKeyBlock(item)).toStrictEqual(fixture.records[i]);
                                expect(mdx.fetch_definition(item).definition).toBe(`${entries[i].value}\0`);
                            }
                        } finally {
                            mdx.close();
                        }
                    }
                });
            }
        }
    }

    for (const compression of /** @type {const} */ (['raw', 'zlib'])) {
        test(`${compression} uppercase MDD uses UTF-16 keys and preserves binary records`, () => {
            const entries = [
                {key: '\\images\\猫.png', value: makeFixturePng([200, 10, 30, 255])},
                {key: '\\audio\\read.mp3', value: Uint8Array.from({length: 260}, (_, i) => i & 255)},
            ];
            const fixture = makeMdictFixture(entries, {mdd: true, compression, recordBlockSize: 11, keysPerBlock: 1});
            const mdd = new MDD('assets.MDD', fixture.bytes);
            try {
                for (const {key, value} of entries) {
                    const item = mdd.keywordList.find(({keyText}) => keyText === key);
                    expect(item).toBeDefined();
                    expect(mdd.lookupRecordByKeyBlock(item)).toStrictEqual(value);
                }
            } finally {
                mdd.close();
            }
        });
    }

    test('a valid empty dictionary has no keyword or lookup result', () => {
        const fixture = makeMdictFixture([]);
        const mdx = new MDX('empty.mdx', fixture.bytes);
        try {
            expect(mdx.keywordList).toStrictEqual([]);
            expect(mdx.lookup('absent').definition).toBeNull();
        } finally {
            mdx.close();
        }
    });

    test('a truncated final block is rejected rather than silently shortened', () => {
        const fixture = makeMdictFixture([{key: 'entry', value: 'nonempty final record'}], {compression: 'raw'});
        const mdx = new MDX('truncated.mdx', fixture.bytes.slice(0, -1));
        try {
            expect(() => mdx.fetch_definition(mdx.keywordList[0])).toThrow();
        } finally {
            mdx.close();
        }
    });

    test('an unsupported record codec is rejected', () => {
        const fixture = makeMdictFixture([{key: 'entry', value: 'record'}], {compression: 'raw'});
        fixture.bytes[fixture.recordDataOffset] = 3;
        const mdx = new MDX('codec.mdx', fixture.bytes);
        try {
            expect(() => mdx.fetch_definition(mdx.keywordList[0])).toThrow(/compression/u);
        } finally {
            mdx.close();
        }
    });
});

describe('actual binary MDX/MDD conversion', () => {
    test('preserves homograph senses, multi-hop aliases, bank bounds and diagnostics', async () => {
        const fixture = makeMdictFixture([
            {key: 'AliasA', value: '@@@LINK=AliasB'},
            {key: 'AliasB', value: '@@@LINK=Target'},
            {key: 'Target', value: '<div>first sense</div>'},
            {key: 'Target', value: '<div>second sense</div>'},
            {key: 'Orphan', value: '@@@LINK=Missing'},
            {key: 'CycleA', value: '@@@LINK=CycleB'},
            {key: 'CycleB', value: '@@@LINK=CycleA'},
        ], {recordBlockSize: 7, keysPerBlock: 1});
        const result = await createMdxImportData('aliases.mdx', {termBankSize: 2}, fixture.bytes, []);
        const rows = readRows(result.files);
        expect(rows).toHaveLength(6);
        for (const expression of ['Target', 'AliasA', 'AliasB']) {
            const matching = rows.filter(([term]) => term === expression);
            expect(matching).toHaveLength(2);
            expect(new Set(matching.map((row) => JSON.stringify(row[5]))).size).toBe(2);
        }
        for (const [path, bytes] of result.files) {
            if (/^term_bank_\d+\.json$/u.test(path)) {
                expect(JSON.parse(new TextDecoder().decode(bytes)).length).toBeLessThanOrEqual(2);
            }
        }
        expect(result.phaseTimings.find(({phase}) => phase === 'prepare-mdx:encode-banks')?.details?.unresolvedRedirectCount).toBe(3);
    });

    test('distinct embedded images in distinct entries retain their own bytes', async () => {
        const red = makeFixturePng([255, 0, 0, 255]);
        const blue = makeFixturePng([0, 0, 255, 255]);
        const fixture = makeMdictFixture([
            {key: 'Red', value: `<img src="data:image/png;base64,${Buffer.from(red).toString('base64')}" alt="red">`},
            {key: 'Blue', value: `<img src="data:image/png;base64,${Buffer.from(blue).toString('base64')}" alt="blue">`},
        ], {recordBlockSize: 13});
        const {files} = await createMdxImportData('images.mdx', {}, fixture.bytes, []);
        const rows = readRows(files);
        const redImage = nodes(rows.find(([term]) => term === 'Red')?.[5], 'img')[0];
        const blueImage = nodes(rows.find(([term]) => term === 'Blue')?.[5], 'img')[0];
        expect(redImage?.path).toBeDefined();
        expect(blueImage?.path).toBeDefined();
        expect(redImage.path).not.toBe(blueImage.path);
        expect(files.get(redImage.path)).toStrictEqual(red);
        expect(files.get(blueImage.path)).toStrictEqual(blue);
    });

    test('bare CSS URLs resolve against the MDD stylesheet directory', async () => {
        const png = makeFixturePng([10, 200, 30, 255]);
        const mdx = makeMdictFixture([{key: 'Styled', value: '<div class="entry">styled definition</div>'}]);
        const mdd = makeMdictFixture([
            {key: '\\styles\\theme.css', value: '.entry { background-image: url(images/猫.png) }'},
            {key: '\\styles\\images\\猫.png', value: png},
        ], {mdd: true, recordBlockSize: 17});
        const {files} = await createMdxImportData('styled.mdx', {}, mdx.bytes, [{name: 'styled.MDD', bytes: mdd.bytes}]);
        expect(new TextDecoder().decode(files.get('styles.css'))).toContain('mdict-media/styles/images/猫.png');
        expect(files.get('mdict-media/styles/images/猫.png')).toStrictEqual(png);
    });

    test('URI-encoded entry links search for the decoded headword', async () => {
        const fixture = makeMdictFixture([{key: 'link', value: '<a href="entry://%E7%8C%AB%26%E7%8A%AC">animals</a>'}]);
        const {files} = await createMdxImportData('links.mdx', {}, fixture.bytes, []);
        const link = nodes(readRows(files)[0][5], 'a')[0];
        expect(link?.href).toBe('?query=%E7%8C%AB%26%E7%8A%AC');
        expect(new URLSearchParams(link.href.slice(1)).get('query')).toBe('猫&犬');
    });
});
