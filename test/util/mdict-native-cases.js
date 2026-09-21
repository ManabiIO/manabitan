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
import mdictCommon from '../../ext/js/dictionary/mdx/vendor/js-mdict/utils.js';
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


describe('MDict header encoding and encryption metadata', () => {
    const gb18030Bytes = new Map([
        ['😀', '9439fc36'],
        ['<p>定义😀</p>', '3c703eb6a8d2e59439fc363c2f703e'],
        ['猫', 'c3a8'],
        ['<p>定义</p>', '3c703eb6a8d2e53c2f703e'],
    ]);
    /**
     * @param {string} value
     * @returns {Uint8Array}
     */
    const encodeGb18030 = (value) => {
        const hex = gb18030Bytes.get(value);
        if (typeof hex === 'undefined') { throw new Error(`Missing GB18030 test vector for ${value}`); }
        return new Uint8Array(Buffer.from(hex, 'hex'));
    };

    test('explicit GB18030 preserves four-byte keys and definitions', () => {
        const definition = '<p>定义😀</p>';
        const fixture = makeMdictFixture([{key: '😀', value: definition}], {
            encodingLabel: 'GB18030',
            textEncoder: encodeGb18030,
        });
        const mdx = new MDX('gb18030.mdx', fixture.bytes);
        try {
            assert.equal(mdx.keywordList[0]?.keyText, '😀');
            assert.equal(mdx.lookup('😀').definition, `${definition}\0`);
        } finally {
            mdx.close();
        }
    });

    for (const encodingLabel of ['gbk', 'gB2312']) {
        test(`${encodingLabel} header alias uses GB18030-compatible decoding`, () => {
            const definition = '<p>定义</p>';
            const fixture = makeMdictFixture([{key: '猫', value: definition}], {
                encodingLabel,
                textEncoder: encodeGb18030,
            });
            const mdx = new MDX('gb-alias.mdx', fixture.bytes);
            try {
                assert.equal(mdx.keywordList[0]?.keyText, '猫');
                assert.equal(mdx.lookup('猫').definition, `${definition}\0`);
            } finally {
                mdx.close();
            }
        });
    }

    test('unsupported encoding labels are rejected instead of silently decoded as UTF-8', () => {
        const fixture = makeMdictFixture([{key: 'entry', value: 'definition'}], {encodingLabel: 'x-mdict-unknown'});
        assert.throws(() => new MDX('unknown-encoding.mdx', fixture.bytes), /unsupported mdict encoding/iu);
    });

    for (const encrypted of ['bogus', '4', '-1']) {
        test(`invalid encryption metadata ${encrypted} is rejected`, () => {
            const fixture = makeMdictFixture([{key: 'entry', value: 'definition'}], {encrypted});
            assert.throws(() => new MDX('invalid-encryption.mdx', fixture.bytes), /encryption flag/iu);
        });
    }

    test('encryptType zero explicitly overrides an encrypted header', () => {
        const fixture = makeMdictFixture([{key: 'entry', value: 'definition'}], {encrypted: 1});
        const mdx = new MDX('override-encryption.mdx', fixture.bytes, {encryptType: 0});
        try {
            assert.equal(mdx.lookup('entry').definition, 'definition\0');
        } finally {
            mdx.close();
        }
    });

    test('invalid encryption overrides are rejected', () => {
        const fixture = makeMdictFixture([{key: 'entry', value: 'definition'}]);
        assert.throws(() => new MDX('invalid-override.mdx', fixture.bytes, {encryptType: 4}), /encryption override/iu);
    });
});


describe('MDict text format and compact styles', () => {
    test('Format=Text preserves literal markup, whitespace and line breaks', async () => {
        const definition = '  <b>literal & text</b>\nsecond  ';
        const fixture = makeMdictFixture([{key: 'plain', value: definition}], {format: 'Text'});
        const {files} = await createMdxImportData('plain.mdx', {}, fixture.bytes, []);
        const glossary = readRows(files)[0][5];
        const preformatted = nodes(glossary, 'div').find(({style}) => style?.whiteSpace === 'pre-wrap');
        assert.ok(preformatted);
        assert.deepEqual(preformatted.content, [definition]);
        assert.equal(nodes(glossary, 'span').some(({style}) => style?.fontWeight === 'bold'), false);
    });

    test('compact stylesheet markers preserve prefix and expand known styles', async () => {
        const fixture = makeMdictFixture(
            [{key: 'styled', value: 'prefix `1`bold'}],
            {format: 'Html', styleSheet: '1\r\n<strong>\r\n</strong>'},
        );
        const {files} = await createMdxImportData('compact.mdx', {}, fixture.bytes, []);
        const glossary = readRows(files)[0][5];
        assert.ok(JSON.stringify(glossary).includes('prefix '));
        const bold = nodes(glossary, 'span').find(({style}) => style?.fontWeight === 'bold');
        assert.ok(bold);
        assert.deepEqual(bold.content, ['bold']);
    });

    test('unknown compact style markers remain visible with their content', async () => {
        const fixture = makeMdictFixture(
            [{key: 'styled', value: 'prefix `99`visible'}],
            {format: 'Html', styleSheet: '1\n<strong>\n</strong>'},
        );
        const {files} = await createMdxImportData('unknown-style.mdx', {}, fixture.bytes, []);
        assert.ok(JSON.stringify(readRows(files)[0][5]).includes('`99`visible'));
    });

    test('stylesheet parser preserves empty fields and numeric XML newlines', () => {
        const parsed = mdictCommon.parseHeader(
            '<Dictionary StyleSheet="1&#13;&#10;&lt;strong&gt;&#13;&#10;&lt;/strong&gt;&#13;&#10;2&#13;&#10;&lt;em&gt;&#13;&#10;"/>',
        );
        assert.deepEqual(parsed.StyleSheet, {
            1: ['<strong>', '</strong>'],
            2: ['<em>', ''],
        });
    });
});
