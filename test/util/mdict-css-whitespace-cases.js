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
 * @param {string} css
 * @param {Array<{key: string, value: Uint8Array}>} [assets]
 * @returns {Promise<Awaited<ReturnType<typeof createMdxImportData>>>}
 */
async function convertCss(css, assets = []) {
    const mdx = makeMdictFixture([
        {
            key: 'Entry',
            value: `<style>${css}</style><div class="a${nbsp}b before">content</div>`,
        },
    ], {compression: 'zlib'});
    const mddSources = assets.length === 0 ?
        [] :
        [{
            name: 'assets.mdd',
            bytes: makeMdictFixture(assets, {mdd: true, compression: 'zlib'}).bytes,
        }];
    return await createMdxImportData('css-whitespace.mdx', {}, mdx.bytes, mddSources);
}

test('MDict CSS keeps NBSP inside selector and HTML class tokens', async () => {
    const result = await convertCss(`.a${nbsp}b{color:red}.before{color:blue}`);
    const stylesheetBytes = result.files.get('styles.css');
    const termBankBytes = result.files.get('term_bank_1.json');
    assert.ok(stylesheetBytes instanceof Uint8Array);
    assert.ok(termBankBytes instanceof Uint8Array);
    const stylesheet = new TextDecoder().decode(stylesheetBytes);
    const termBankJson = new TextDecoder().decode(termBankBytes);

    assert.ok(stylesheet.includes(`[data-sc-class~="a${nbsp}b"]`), stylesheet);
    assert.ok(!stylesheet.includes('[data-sc-class~="a"] [data-sc-tag="b"]'), stylesheet);
    assert.ok(termBankJson.includes(`"class":"a${nbsp}b before"`), termBankJson);
});

test('MDict CSS resolves NBSP inside an unquoted url token', async () => {
    const assetKey = `images/a${nbsp}b.png`;
    const result = await convertCss(
        `.before{background:url(${assetKey})}`,
        [{key: assetKey, value: Uint8Array.of(1, 2, 3)}],
    );
    const stylesheetBytes = result.files.get('styles.css');
    assert.ok(stylesheetBytes instanceof Uint8Array);
    const stylesheet = new TextDecoder().decode(stylesheetBytes);

    assert.ok(stylesheet.includes(`url("mdict-media/${assetKey}")`), stylesheet);
    assert.deepEqual(result.files.get(`mdict-media/${assetKey}`), Uint8Array.of(1, 2, 3));
});

test('MDict CSS consumes CRLF as one hex-escape terminator', async () => {
    const css = '.before{background:url(images/a\\20\r\nb.png)}';
    const assetKey = 'images/a b.png';
    const result = await convertCss(
        css,
        [{key: assetKey, value: Uint8Array.of(4, 5, 6)}],
    );
    const stylesheetBytes = result.files.get('styles.css');
    assert.ok(stylesheetBytes instanceof Uint8Array);
    const stylesheet = new TextDecoder().decode(stylesheetBytes);

    assert.ok(stylesheet.includes('url("mdict-media/images/a b.png")'), stylesheet);
    assert.deepEqual(result.files.get('mdict-media/images/a b.png'), Uint8Array.of(4, 5, 6));
});
