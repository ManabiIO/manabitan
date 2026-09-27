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

// Use real compressed MDX records and the production converter. Keep this
// separate from the existing native wrapper to avoid overlapping unrelated PRs.
const cases = [
    {name: 'double-quoted opener in a declaration', css: '.before{content:"/*"}.after{color:blue}'},
    {name: 'single-quoted opener in a declaration', css: ".before{content:'/*'}.after{color:blue}"},
    {name: 'quoted opener before an actual comment', css: '.before{content:"/*";/* real */color:red}.after{color:blue}'},
    {name: 'escaped quote before an opener', css: String.raw`.before{content:"\"/*"}.after{color:blue}`},
    {name: 'quoted opener and braces', css: '.before{content:"/* } {"}.after{color:blue}'},
    {name: 'separately quoted opener and closer', css: '.before{content:"/*";font-family:"*/"}.after{color:blue}'},
    {name: 'opener in a custom-property string', css: '.before{--label:"/*"}.after{color:blue}'},
    {name: 'double-quoted attribute selector', css: '.before[data-label="/*"]{color:red}.after{color:blue}'},
    {name: 'single-quoted attribute selector', css: ".before[data-label='/*']{color:red}.after{color:blue}"},
    {name: 'escaped quote in an attribute selector', css: String.raw`.before[data-label="\"/*"]{color:red}.after{color:blue}`},
    {name: 'quoted attribute before an actual comment', css: '.before[data-label="/*"]/* real */{color:red}.after{color:blue}'},
    {name: 'nested media rules', css: '@media screen{.before{content:"/*"}.after{color:blue}}'},
    {name: 'nested supports rules', css: '@supports (display:block){.before{content:"/*"}.after{color:blue}}'},
    {name: 'nested layer rules', css: '@layer dictionary{.before{content:"/*"}.after{color:blue}}'},
    {name: 'quoted supports prelude', css: '@supports selector([data-label="/*"]){.before{color:red}}.after{color:blue}'},
    {name: 'balanced literal comment control', css: '.before{content:"/* text */"}.after{color:blue}'},
    {name: 'real comment control', css: '.before{/* } { " */color:red}.after{color:blue}'},
    {name: 'ordinary rule control', css: '.before{color:red}.after{color:blue}'},
];

for (const {name, css} of cases) {
    test(`MDict CSS string/comment boundary: ${name}`, async () => {
        const fixture = makeMdictFixture([
            {key: 'Entry', value: `<style>${css}</style><div class="before">before</div><div class="after">after</div>`},
        ], {compression: 'zlib'});
        const result = await createMdxImportData('css-comments.mdx', {}, fixture.bytes, []);
        const stylesheetBytes = result.files.get('styles.css');
        assert.ok(stylesheetBytes instanceof Uint8Array);
        const stylesheet = new TextDecoder().decode(stylesheetBytes);
        const root = '[data-sc-class~="mdict-yomitan-entry-0"]';
        const migratedAfter = `[data-sc-class~="after"]:where(${root}, ${root} *)`;
        assert.ok(stylesheet.includes(`${migratedAfter}{color:blue}`), stylesheet);
        assert.ok(!stylesheet.includes('.after{color:blue}'), stylesheet);
    });
}


const escapeCases = [
    {
        name: 'escaped opening brace in class selector',
        css: String.raw`.a\{b{color:red}.after{color:blue}`,
        expected: String.raw`[data-sc-class~="a{b"]`,
    },
    {
        name: 'escaped closing brace in declaration',
        css: String.raw`.before{--label:a\}b}.after{color:blue}`,
        expected: String.raw`--label:a\}b`,
    },
    {
        name: 'escaped closing bracket stays inside unquoted attribute value',
        css: String.raw`[class=a\]\.b]{color:red}.after{color:blue}`,
        expected: String.raw`[data-sc-class=a\]\.b]`,
    },
];

for (const {name, css, expected} of escapeCases) {
    test(`MDict CSS escaped delimiter: ${name}`, async () => {
        const fixture = makeMdictFixture([
            {key: 'Entry', value: `<style>${css}</style><div class="before">before</div><div class="after">after</div>`},
        ], {compression: 'zlib'});
        const result = await createMdxImportData('css-escapes.mdx', {}, fixture.bytes, []);
        const stylesheetBytes = result.files.get('styles.css');
        assert.ok(stylesheetBytes instanceof Uint8Array);
        const stylesheet = new TextDecoder().decode(stylesheetBytes);
        const root = '[data-sc-class~="mdict-yomitan-entry-0"]';
        const migratedAfter = `[data-sc-class~="after"]:where(${root}, ${root} *)`;
        assert.ok(stylesheet.includes(expected), stylesheet);
        assert.ok(stylesheet.includes(`${migratedAfter}{color:blue}`), stylesheet);
    });
}
