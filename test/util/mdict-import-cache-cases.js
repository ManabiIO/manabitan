/* Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import {createMdxImportData} from '../../ext/js/dictionary/mdx/mdx-converter.js';
import {Mdict} from '../../ext/js/dictionary/mdx/vendor/js-mdict/mdict.js';
import {makeMdictFixture} from './mdict-binary-fixture.js';

const originalDecompressBuff = Mdict.prototype.decompressBuff;

afterEach(() => {
    Mdict.prototype.decompressBuff = originalDecompressBuff;
});

test('dense MDX conversion decompresses each record block once', async () => {
    const recordBlockSize = 4096;
    const entries = Array.from({length: 256}, (_, index) => ({
        key: `term-${String(index).padStart(4, '0')}`,
        value: `<p>${'abcdef '.repeat(24)}${index}</p>`,
    }));
    const fixture = makeMdictFixture(entries, {
        recordBlockSize,
        keysPerBlock: 32,
        compression: 'zlib',
    });
    const recordBytes = fixture.records.reduce((total, record) => total + record.byteLength, 0);
    const expectedRecordBlocks = Math.ceil(recordBytes / recordBlockSize);

    let decompressions = 0;
    Mdict.prototype.decompressBuff = function (
        /** @type {Uint8Array} */ recordBuffer,
        /** @type {number} */ unpackSize,
    ) {
        ++decompressions;
        return originalDecompressBuff.call(this, recordBuffer, unpackSize);
    };

    const result = await createMdxImportData('dense-cache.mdx', {}, fixture.bytes, []);

    assert.ok(result.files.has('term_bank_1.json'));
    assert.equal(decompressions, expectedRecordBlocks);
    assert.ok(decompressions < entries.length / 4, 'conversion should reuse decompressed blocks across adjacent entries');
});
