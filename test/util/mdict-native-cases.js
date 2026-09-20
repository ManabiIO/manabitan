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
import {describe, test} from 'node:test';
import {MDX} from '../../ext/js/dictionary/mdx/vendor/js-mdict/mdx.js';
import {MDD} from '../../ext/js/dictionary/mdx/vendor/js-mdict/mdd.js';
import {FileScanner} from '../../ext/js/dictionary/mdx/vendor/js-mdict/scanner.js';
import {createMdxImportData} from '../../ext/js/dictionary/mdx/mdx-converter.js';
import {makeFixturePng, makeMdictFixture} from './mdict-binary-fixture.js';

/**
 * @param {Map<string, Uint8Array>} files
 * @returns {any[][]}
 */
function readRows(files) {
    return [...files.entries()]
        .filter(([path]) => /^term_bank_\d+\.json$/u.test(path))
        .sort(([a], [b]) => Number(a.match(/\d+/u)?.[0]) - Number(b.match(/\d+/u)?.[0]))
        .flatMap(([, bytes]) => JSON.parse(new TextDecoder().decode(bytes)));
}

/**
 * @param {unknown} value
 * @param {string} tag
 * @returns {Array<Record<string, any>>}
 */
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
                        {key: 'apple', value: '<p>an intentionally longer definition</p>'},
                        {key: 'zebra', value: '<div>猫と犬 🐈 é\nsecond line</div>'},
                        {key: '猫', value: '<b>ねこ</b>'},
                    ];
                    const fixture = makeMdictFixture(entries, {compression, encoding, recordBlockSize, keysPerBlock: 1});
                    for (const recordBlockCacheBytes of [0, 1024]) {
                        const mdx = new MDX('records.MDX', fixture.bytes, {recordBlockCacheBytes});
                        try {
                            for (let i = 0; i < entries.length; i += 1) {
                                const item = mdx.keywordList.find(({keyText}) => keyText === entries[i].key);
                                assert.ok(item);
                                assert.deepEqual(mdx.lookupRecordByKeyBlock(item), fixture.records[i]);
                                assert.equal(mdx.fetch_definition(item).definition, `${entries[i].value}\0`);
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
                    assert.ok(item);
                    assert.deepEqual(mdd.lookupRecordByKeyBlock(item), value);
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
            assert.deepEqual(mdx.keywordList, []);
            assert.equal(mdx.lookup('absent').definition, null);
        } finally {
            mdx.close();
        }
    });

    test('a truncated final block is rejected rather than silently shortened', () => {
        const fixture = makeMdictFixture([{key: 'entry', value: 'nonempty final record'}], {compression: 'raw'});
        const mdx = new MDX('truncated.mdx', fixture.bytes.slice(0, -1));
        try {
            assert.throws(() => mdx.fetch_definition(mdx.keywordList[0]));
        } finally {
            mdx.close();
        }
    });

    test('an unsupported record codec is rejected', () => {
        const fixture = makeMdictFixture([{key: 'entry', value: 'record'}], {compression: 'raw'});
        fixture.bytes[fixture.recordDataOffset] = 3;
        const mdx = new MDX('codec.mdx', fixture.bytes);
        try {
            assert.throws(() => mdx.fetch_definition(mdx.keywordList[0]), /compression/u);
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
        assert.equal(rows.length, 6);
        for (const expression of ['Target', 'AliasA', 'AliasB']) {
            const matching = rows.filter(([term]) => term === expression);
            assert.equal(matching.length, 2);
            assert.equal(new Set(matching.map((row) => JSON.stringify(row[5]))).size, 2);
        }
        for (const [path, bytes] of result.files) {
            if (/^term_bank_\d+\.json$/u.test(path)) {
                assert.ok(JSON.parse(new TextDecoder().decode(bytes)).length <= 2);
            }
        }
        assert.equal(result.phaseTimings.find(({phase}) => phase === 'prepare-mdx:encode-banks')?.details?.unresolvedRedirectCount, 3);
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
        assert.ok(redImage?.path);
        assert.ok(blueImage?.path);
        assert.notEqual(redImage.path, blueImage.path);
        assert.deepEqual(files.get(redImage.path), red);
        assert.deepEqual(files.get(blueImage.path), blue);
    });

    test('bare CSS URLs resolve against the MDD stylesheet directory', async () => {
        const png = makeFixturePng([10, 200, 30, 255]);
        const mdx = makeMdictFixture([{key: 'Styled', value: '<div class="entry">styled definition</div>'}]);
        const mdd = makeMdictFixture([
            {key: '\\styles\\theme.css', value: '.entry { background-image: url(images/猫.png) }'},
            {key: '\\styles\\images\\猫.png', value: png},
        ], {mdd: true, recordBlockSize: 17});
        const {files} = await createMdxImportData('styled.mdx', {}, mdx.bytes, [{name: 'styled.MDD', bytes: mdd.bytes}]);
        assert.ok(new TextDecoder().decode(files.get('styles.css')).includes('mdict-media/styles/images/猫.png'));
        assert.deepEqual(files.get('mdict-media/styles/images/猫.png'), png);
    });

    test('URI-encoded entry links search for the decoded headword', async () => {
        const fixture = makeMdictFixture([{key: 'link', value: '<a href="entry://%E7%8C%AB%26%E7%8A%AC">animals</a>'}]);
        const {files} = await createMdxImportData('links.mdx', {}, fixture.bytes, []);
        const link = nodes(readRows(files)[0][5], 'a')[0];
        assert.equal(link?.href, '?query=%E7%8C%AB%26%E7%8A%AC');
        assert.equal(new URLSearchParams(link.href.slice(1)).get('query'), '猫&犬');
    });
});

describe('native parser controls and key metadata', () => {
    for (const compression of /** @type {const} */ (['raw', 'zlib'])) {
        test(`${compression} single-block control and owned output`, () => {
            const fixture = makeMdictFixture([{key: 'control', value: 'unchanged control definition'}], {compression, recordBlockSize: 4096});
            const mdx = new MDX('control.mdx', fixture.bytes, {recordBlockCacheBytes: 4096});
            try {
                const first = mdx.lookupRecordByKeyBlock(mdx.keywordList[0]);
                assert.deepEqual(first, fixture.records[0]);
                first.fill(0);
                assert.deepEqual(mdx.lookupRecordByKeyBlock(mdx.keywordList[0]), fixture.records[0]);
            } finally {
                mdx.close();
            }
        });
    }

    for (const version of ['1.2', '2.1']) {
        for (const encoding of /** @type {const} */ (['utf8', 'utf16le'])) {
            test(`${version}/${encoding} numeric and key-info layout`, () => {
                const fixture = makeMdictFixture([{key: '猫', value: 'versioned definition'}], {version, encoding, recordBlockSize: 5});
                const mdx = new MDX('version.mdx', fixture.bytes);
                try {
                    assert.equal(mdx.keywordList[0].keyText, '猫');
                    assert.deepEqual(mdx.lookupRecordByKeyBlock(mdx.keywordList[0]), fixture.records[0]);
                } finally {
                    mdx.close();
                }
            });
        }
    }

    test('key-block advertised decoded length must match bytes', () => {
        const fixture = makeMdictFixture([{key: 'a', value: 'definition'}], {keyBlockUnpackSizeDelta: 1});
        assert.throws(() => new MDX('key-length.mdx', fixture.bytes), /key.*size/iu);
    });

    test('key-info text must have its declared terminator', () => {
        const fixture = makeMdictFixture([{key: 'a', value: 'definition'}], {keyInfoTerminatorByte: 1});
        assert.throws(() => new MDX('key-terminator.mdx', fixture.bytes), /terminator/iu);
    });

    test('per-block entry counts are enforced even when their sum is correct', () => {
        const fixture = makeMdictFixture([{key: 'a', value: 'first'}, {key: 'b', value: 'second'}], {keysPerBlock: 1, keyBlockEntryCounts: [2, 0]});
        assert.throws(() => new MDX('key-counts.mdx', fixture.bytes), /key.*entr/iu);
    });

    test('key-info entry totals must equal the header', () => {
        const fixture = makeMdictFixture([{key: 'a', value: 'definition'}], {keyBlockEntryCounts: [2]});
        assert.throws(() => new MDX('key-total.mdx', fixture.bytes), /key.*entr/iu);
    });

    test('trailing key-info bytes are not silently discarded', () => {
        const fixture = makeMdictFixture([{key: 'a', value: 'definition'}], {keyInfoTrailer: Uint8Array.of(1, 2)});
        assert.throws(() => new MDX('key-trailer.mdx', fixture.bytes), /key.*info/iu);
    });

    test('scanner rejects invalid sources and releases its input on close', () => {
        assert.throws(() => new FileScanner(/** @type {any} */ ({})), TypeError);
        const scanner = new FileScanner(Uint8Array.of(1, 2, 3));
        assert.deepEqual(scanner.readBuffer(0, 2), Uint8Array.of(1, 2));
        scanner.close();
        assert.deepEqual(scanner.readBuffer(0, 0), new Uint8Array(0));
        assert.throws(() => scanner.readBuffer(0, 1), /available file data/iu);
        assert.throws(() => scanner.readBuffer(/** @type {any} */ ('0'), 0), /available file data/iu);
    });
});
