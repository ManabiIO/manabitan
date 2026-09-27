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
import {createMdxImportData} from '../../ext/js/dictionary/mdx/mdx-converter.js';
import {makeMdictFixture} from './mdict-binary-fixture.js';

const nbsp = '\u00a0';

/**
 * @param {string} definition
 * @returns {ReturnType<typeof createMdxImportData>}
 */
async function makeImport(definition) {
    const mdx = makeMdictFixture([{key: 'Entry', value: definition}], {compression: 'zlib'});
    const mdd = makeMdictFixture([
        {key: `${nbsp}images/logo.png`, value: Uint8Array.of(1, 2, 3)},
        {key: 'images/logo.png', value: Uint8Array.of(9, 9, 9)},
        {key: `${nbsp}docs/file.bin`, value: Uint8Array.of(4, 5, 6)},
        {key: 'docs/file.bin', value: Uint8Array.of(8, 8, 8)},
    ], {mdd: true, compression: 'zlib'});
    return await createMdxImportData(
        'asset-whitespace.mdx',
        {},
        mdx.bytes,
        [{name: 'asset-whitespace.mdd', bytes: mdd.bytes}],
    );
}

test('MDict image asset keeps leading NBSP as filename identity', async () => {
    const result = await makeImport(`<div><img src="${nbsp}images/logo.png"></div>`);
    const nbspPath = `mdict-media/${nbsp}images/logo.png`;
    assert.deepEqual(result.files.get(nbspPath), Uint8Array.of(1, 2, 3));
    assert.equal(result.files.has('mdict-media/images/logo.png'), false);

    const bankBytes = result.files.get('term_bank_1.json');
    assert.ok(bankBytes instanceof Uint8Array);
    const bankJson = new TextDecoder().decode(bankBytes);
    assert.ok(bankJson.includes(`"path":"${nbspPath}"`), bankJson);
});

test('MDict relative link keeps leading NBSP as filename identity', async () => {
    const result = await makeImport(`<div><a href="${nbsp}docs/file.bin">document</a></div>`);
    const nbspPath = `mdict-media/${nbsp}docs/file.bin`;
    assert.deepEqual(result.files.get(nbspPath), Uint8Array.of(4, 5, 6));
    assert.equal(result.files.has('mdict-media/docs/file.bin'), false);

    const bankBytes = result.files.get('term_bank_1.json');
    assert.ok(bankBytes instanceof Uint8Array);
    const bankJson = new TextDecoder().decode(bankBytes);
    assert.ok(bankJson.includes('media:mdict-media/%C2%A0docs/file.bin'), bankJson);
});
