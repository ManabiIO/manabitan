/* Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createMdxImportData} from '../../ext/js/dictionary/mdx/mdx-converter.js';
import {makeMdictFixture} from './mdict-binary-fixture.js';

/**
 * @param {string} attributes
 * @returns {Promise<Record<string, unknown>>}
 */
async function convertedFontStyle(attributes) {
    const fixture = makeMdictFixture([{key: 'font', value: `<font ${attributes}>sample</font>`}], {compression: 'zlib'});
    const {files} = await createMdxImportData('font.mdx', {}, fixture.bytes, []);
    const rows = JSON.parse(new TextDecoder().decode(files.get('term_bank_1.json')));
    const font = rows[0][5][0].content.content[0];
    assert.equal(font.tag, 'span');
    assert.deepEqual(font.content, ['sample']);
    return font.style ?? {};
}

const sizes = ['x-small', 'small', 'medium', 'large', 'x-large', 'xx-large', 'xxx-large'];
for (let size = 1; size <= 7; ++size) {
    test(`MDict font size ${size} becomes a valid CSS keyword`, async () => {
        assert.deepEqual(await convertedFontStyle(`size="${size}"`), {fontSize: sizes[size - 1]});
    });
}
for (const [input, expected] of [
    ['0', 'x-small'],
    ['8', 'xxx-large'],
    ['+0', 'medium'],
    ['-0', 'medium'],
    ['+1', 'large'],
    ['+4', 'xxx-large'],
    ['-1', 'small'],
    ['-2', 'x-small'],
    ['-999', 'x-small'],
    ['999', 'xxx-large'],
    ['0004', 'large'],
    ['  \t\n\f\r+2trailing', 'x-large'],
    ['3.5', 'medium'],
    ['0x7', 'x-small'],
    ['9'.repeat(400), 'xxx-large'],
    [`-${'9'.repeat(400)}`, 'x-small'],
]) {
    test(`MDict legacy font size parsing: ${input.slice(0, 30)}`, async () => {
        assert.equal((await convertedFontStyle(`size="${input}"`)).fontSize, expected);
    });
}
for (const value of ['', ' ', '+', '-', '+ 2', 'large', '.5', '\u00a03', '\u20033']) {
    test(`invalid legacy font size is ignored: ${JSON.stringify(value)}`, async () => {
        assert.deepEqual(await convertedFontStyle(`size="${value}"`), {});
    });
}
test('MDict inline font styles override legacy presentational attributes', async () => {
    assert.deepEqual(await convertedFontStyle('size="3" color="red" face="serif" style="font-size: 24px; color: blue; font-family: monospace"'), {
        fontSize: '24px', color: 'blue', fontFamily: 'monospace',
    });
});
test('unoverridden font attributes survive a partial inline style', async () => {
    assert.deepEqual(await convertedFontStyle('size="+2" color="red" face="serif" style="color: blue"'), {
        fontSize: 'x-large', color: 'blue', fontFamily: 'serif',
    });
});
