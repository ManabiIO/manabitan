/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MDX} from '../../ext/js/dictionary/mdx/vendor/js-mdict/mdx.js';
import {MDD} from '../../ext/js/dictionary/mdx/vendor/js-mdict/mdd.js';
import {createMdxImportData} from '../../ext/js/dictionary/mdx/mdx-converter.js';
import {makeMdictFixture} from './mdict-binary-fixture.js';

const keys = ['word', '\ufeffword', '\ufeff\ufeffword', 'mid\ufeffword'];

/**
 * @param {string} value
 * @returns {Uint8Array}
 */
function encodeUtf16Be(value) {
    return new Uint8Array(Buffer.from(value, 'utf16le').swap16());
}

const encodings = /** @type {const} */ ([
    {encoding: 'utf8', encodingLabel: 'UTF-8'},
    {encoding: 'utf8', encodingLabel: 'unicode-1-1-utf-8'},
    {encoding: 'utf16le', encodingLabel: 'UTF-16'},
    {encoding: 'utf16le', encodingLabel: 'UTF-16BE', textEncoder: encodeUtf16Be},
]);

for (const encoding of encodings) {
    for (const compression of /** @type {const} */ (['raw', 'zlib'])) {
        for (const version of ['1.2', '2.0']) {
            const label = `${encoding.encodingLabel}/${compression}/${version}`;
            test(`MDX literal key identity: ${label}`, () => {
                const fixture = makeMdictFixture(keys.map((key, i) => ({key, value: `record-${i}`})), {
                    ...encoding, compression, version, keysPerBlock: 1, recordBlockSize: 7,
                });
                const dictionary = new MDX('key-bom.mdx', fixture.bytes);
                try {
                    assert.deepEqual(new Set(dictionary.keywordList.map((item) => item.keyText)), new Set(keys));
                    assert.deepEqual(new Set(dictionary.keyInfoList.map((item) => item.firstKey)), new Set(keys));
                    assert.deepEqual(new Set(dictionary.keyInfoList.map((item) => item.lastKey)), new Set(keys));
                    for (const [i, key] of keys.entries()) {
                        assert.equal(dictionary.lookup(key).definition, `record-${i}\0`);
                        const matching = dictionary.prefix(key).filter((item) => item.keyText === key);
                        assert.equal(matching.length, 1);
                    }
                } finally {
                    dictionary.close();
                }
            });
        }
    }
}

for (const compression of /** @type {const} */ (['raw', 'zlib'])) {
    test(`MDD literal resource key identity: ${compression}`, () => {
        const fixture = makeMdictFixture(keys.map((key, i) => ({key: `${key}.png`, value: Uint8Array.of(i, 255)})), {
            mdd: true, compression, keysPerBlock: 1, recordBlockSize: 1,
        });
        const dictionary = new MDD('key-bom.mdd', fixture.bytes);
        try {
            assert.deepEqual(new Set(dictionary.keywordList.map((item) => item.keyText)), new Set(keys.map((key) => `${key}.png`)));
            for (const [i, key] of keys.entries()) {
                const item = dictionary.lookupKeyBlockByWord(`${key}.png`);
                assert.ok(item);
                assert.deepEqual(dictionary.lookupRecordByKeyBlock(item), Uint8Array.of(i, 255));
            }
        } finally {
            dictionary.close();
        }
    });
}

for (const encoding of encodings) {
    test(`MDX converter retains distinct headwords: ${encoding.encodingLabel}`, async () => {
        const fixture = makeMdictFixture(keys.map((key, i) => ({key, value: `definition-${i}`})), {
            ...encoding, keysPerBlock: 1, recordBlockSize: 7,
        });
        const result = await createMdxImportData('key-bom.mdx', {}, fixture.bytes, []);
        const bytes = result.files.get('term_bank_1.json');
        assert.ok(bytes instanceof Uint8Array);
        const rows = /** @type {unknown[][]} */ (JSON.parse(new TextDecoder().decode(bytes)));
        assert.deepEqual(new Set(rows.map((row) => row[0])), new Set(keys));
        for (const [i, key] of keys.entries()) {
            const row = rows.find((item) => item[0] === key);
            assert.ok(row);
            assert.ok(JSON.stringify(row[5]).includes(`definition-${i}`));
        }
    });
}

for (const encoding of encodings) {
    test(`MDX record document BOM handling is unchanged: ${encoding.encodingLabel}`, () => {
        const fixture = makeMdictFixture([{key: 'ordinary', value: '\ufeffrecord'}], encoding);
        const dictionary = new MDX('record-bom.mdx', fixture.bytes);
        try {
            assert.equal(dictionary.lookup('ordinary').definition, 'record\0');
            assert.equal(dictionary.header.Title, 'MDict binary regression fixture');
            assert.equal(dictionary.meta.decoder.ignoreBOM, false);
        } finally {
            dictionary.close();
        }
    });
}
