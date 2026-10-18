/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createMdxImportData} from '../../ext/js/dictionary/mdx/mdx-converter.js';
import {makeMdictFixture} from './mdict-binary-fixture.js';

const root = '[data-sc-class~="mdict-yomitan-entry-0"]';
const guard = `:where(${root}, ${root} *)`;

/**
 * @param {string} selector
 * @returns {Promise<string>}
 */
async function convertSelector(selector) {
    const fixture = makeMdictFixture([
        {
            key: 'Entry',
            value: `<style>${selector}{color:red}.after{color:blue}</style><div id="word-one" class="word-one after">content</div>`,
        },
    ], {compression: 'zlib'});
    const result = await createMdxImportData('attribute-operators.mdx', {}, fixture.bytes, []);
    const stylesheet = result.files.get('styles.css');
    assert.ok(stylesheet instanceof Uint8Array);
    return new TextDecoder().decode(stylesheet);
}

for (const [name, target] of [
    ['class', 'data-sc-class'],
    [String.raw`cl\61 ss`, 'data-sc-class'],
    [String.raw`\63 lass`, 'data-sc-class'],
    ['id', 'data-sc-id'],
    [String.raw`\69 d`, 'data-sc-id'],
    [String.raw`\id`, 'data-sc-id'],
]) {
    for (const tail of ['', '=word', '~="word"', '|=word', '^="word"', '$=one', '*="ord"']) {
        test(`MDict attribute operator: [${name}${tail}]`, async () => {
            const stylesheet = await convertSelector(`[${name}${tail}]`);
            assert.ok(stylesheet.includes(`[${target}${tail}]${guard}{color:red}`), stylesheet);
            assert.ok(stylesheet.includes(`[data-sc-class~="after"]${guard}{color:blue}`), stylesheet);
        });
    }
}

for (const selector of ['[id|role=word]', '[class|role=word]', '[svg|id=word]', '[*|id=word]', '[|id=word]']) {
    test(`MDict namespace control: ${selector}`, async () => {
        const stylesheet = await convertSelector(selector);
        assert.ok(stylesheet.includes(`${selector}${guard}{color:red}`), stylesheet);
        assert.ok(stylesheet.includes(`[data-sc-class~="after"]${guard}{color:blue}`), stylesheet);
    });
}

for (const selector of ['[id |=word]', '[id\t|="word"]', String.raw`[\69 d |=word]`]) {
    test(`MDict spaced dash-match control: ${selector}`, async () => {
        const stylesheet = await convertSelector(selector);
        assert.ok(stylesheet.includes('[data-sc-id'), stylesheet);
        assert.ok(stylesheet.includes(`${guard}{color:red}`), stylesheet);
    });
}
