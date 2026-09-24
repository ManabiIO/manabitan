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

// Expected transformations were checked independently against Chromium CSSOM,
// computed styles, and an outside-entry negative control in the review harness.
// These cases exercise the real compressed-MDX conversion entry point in CI.
const cases = [
    {
        name: 'escaped opening brace in class',
        css: String.raw`.a\{b{color:red}.after{color:blue}`,
        expected: String.raw`[data-sc-class~="a{b"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:red}[data-sc-class~="after"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:blue}`,
    },
    {
        name: 'escaped closing brace in class',
        css: String.raw`.a\}b{color:red}.after{color:blue}`,
        expected: String.raw`[data-sc-class~="a}b"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:red}[data-sc-class~="after"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:blue}`,
    },
    {
        name: 'escaped semicolon in class',
        css: String.raw`.a\;b{color:red}.after{color:blue}`,
        expected: String.raw`[data-sc-class~="a;b"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:red}[data-sc-class~="after"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:blue}`,
    },
    {
        name: 'escaped opening bracket in class',
        css: String.raw`.a\[b{color:red}.after{color:blue}`,
        expected: String.raw`[data-sc-class~="a[b"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:red}[data-sc-class~="after"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:blue}`,
    },
    {
        name: 'escaped closing bracket in attribute',
        css: String.raw`.a[data-x=b\]]{color:red}.after{color:blue}`,
        expected: String.raw`[data-sc-class~="a"][data-x=b\]]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:red}[data-sc-class~="after"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:blue}`,
    },
    {
        name: 'escaped opening parenthesis in class',
        css: String.raw`.a\(b{color:red}.after{color:blue}`,
        expected: String.raw`[data-sc-class~="a(b"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:red}[data-sc-class~="after"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:blue}`,
    },
    {
        name: 'escaped closing parenthesis in pseudo',
        css: String.raw`:is(.a\)b){color:red}.after{color:blue}`,
        expected: String.raw`:is([data-sc-class~="a)b"]):where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:red}[data-sc-class~="after"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:blue}`,
    },
    {
        name: 'escaped double quote in class',
        css: String.raw`.a\"b{color:red}.after{color:blue}`,
        expected: String.raw`[data-sc-class~="a\"b"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:red}[data-sc-class~="after"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:blue}`,
    },
    {
        name: 'escaped single quote in class',
        css: String.raw`.a\'b{color:red}.after{color:blue}`,
        expected: String.raw`[data-sc-class~="a'b"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:red}[data-sc-class~="after"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:blue}`,
    },
    {
        name: 'escaped open brace in declaration',
        css: String.raw`.before{--label:a\{b}.after{color:blue}`,
        expected: String.raw`[data-sc-class~="before"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){--label:a\{b}[data-sc-class~="after"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:blue}`,
    },
    {
        name: 'escaped close brace in declaration',
        css: String.raw`.before{--label:a\}b}.after{color:blue}`,
        expected: String.raw`[data-sc-class~="before"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){--label:a\}b}[data-sc-class~="after"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:blue}`,
    },
    {
        name: 'escaped quote in declaration',
        css: String.raw`.before{--label:a\"b}.after{color:blue}`,
        expected: String.raw`[data-sc-class~="before"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){--label:a\"b}[data-sc-class~="after"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:blue}`,
    },
    {
        name: 'escaped apostrophe in declaration',
        css: String.raw`.before{--label:a\'b}.after{color:blue}`,
        expected: String.raw`[data-sc-class~="before"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){--label:a\'b}[data-sc-class~="after"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:blue}`,
    },
    {
        name: 'escaped slash before asterisk',
        css: String.raw`.before{--label:a\/*b}.after{color:blue}`,
        expected: String.raw`[data-sc-class~="before"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){--label:a\/*b}[data-sc-class~="after"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:blue}`,
    },
    {
        name: 'hex escaped open brace',
        css: String.raw`.a\7b b{--label:x\7d y}.after{color:blue}`,
        expected: String.raw`[data-sc-class~="a{b"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){--label:x\7d y}[data-sc-class~="after"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:blue}`,
    },
    {
        name: 'escaped backslash parity',
        css: String.raw`.a\\{--label:x\\}.after{color:blue}`,
        expected: String.raw`[data-sc-class~="a\\"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){--label:x\\}[data-sc-class~="after"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:blue}`,
    },
    {
        name: 'three backslash parity',
        css: String.raw`.a\\\{b{--label:x\\\}y}.after{color:blue}`,
        expected: String.raw`[data-sc-class~="a\\{b"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){--label:x\\\}y}[data-sc-class~="after"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:blue}`,
    },
    {
        name: 'nested media with escaped selector and value',
        css: String.raw`@media screen{.a\{b{--label:x\}y}.after{color:blue}}.last{color:green}`,
        expected: String.raw`@media screen{[data-sc-class~="a{b"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){--label:x\}y}[data-sc-class~="after"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:blue}}[data-sc-class~="last"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:green}`,
    },
    {
        name: 'nested supports with escaped selector',
        css: String.raw`@supports (display:block){.a\(b{color:red}.after{color:blue}}`,
        expected: String.raw`@supports (display:block){[data-sc-class~="a(b"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:red}[data-sc-class~="after"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:blue}}`,
    },
    {
        name: 'nested layer with escaped value',
        css: String.raw`@layer dictionary{.before{--label:a\{b}.after{color:blue}}`,
        expected: String.raw`@layer dictionary{[data-sc-class~="before"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){--label:a\{b}[data-sc-class~="after"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:blue}}`,
    },
    {
        name: 'real comment control',
        css: String.raw`.before{/* } { " */color:red}.after{color:blue}`,
        expected: String.raw`[data-sc-class~="before"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){/* } { " */color:red}[data-sc-class~="after"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:blue}`,
    },
    {
        name: 'quoted comment opener control',
        css: String.raw`.before{content:"/*"}.after{color:blue}`,
        expected: String.raw`[data-sc-class~="before"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){content:"/*"}[data-sc-class~="after"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:blue}`,
    },
    {
        name: 'quoted attribute control',
        css: String.raw`.before[data-x="/*"]{color:red}.after{color:blue}`,
        expected: String.raw`[data-sc-class~="before"][data-x="/*"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:red}[data-sc-class~="after"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:blue}`,
    },
    {
        name: 'escaped attribute closing bracket before dot',
        css: String.raw`[class=a\]\.b]{color:red}.after{color:blue}`,
        expected: String.raw`[data-sc-class=a\]\.b]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:red}[data-sc-class~="after"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:blue}`,
    },
    {
        name: 'escaped attribute closing bracket before pseudo token',
        css: String.raw`[id=a\]\:root]{color:red}.after{color:blue}`,
        expected: String.raw`[data-sc-id=a\]\:root]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:red}[data-sc-class~="after"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:blue}`,
    },
    {
        name: 'ordinary control',
        css: '.before{color:red}.after{color:blue}',
        expected: String.raw`[data-sc-class~="before"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:red}[data-sc-class~="after"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){color:blue}`,
    },
];

for (const {name, css, expected} of cases) {
    test(`MDict CSS escaped delimiters: ${name}`, async () => {
        const fixture = makeMdictFixture([
            {key: 'Entry', value: `<style>${css}</style><div class="before">before</div><div class="after">after</div>`},
        ], {compression: 'zlib'});
        const result = await createMdxImportData('css-escapes.mdx', {}, fixture.bytes, []);
        const bytes = result.files.get('styles.css');
        assert.ok(bytes instanceof Uint8Array);
        const stylesheet = new TextDecoder().decode(bytes);
        assert.ok(stylesheet.includes(expected), stylesheet);
        const bankBytes = result.files.get('term_bank_1.json');
        assert.ok(bankBytes instanceof Uint8Array);
        const bank = JSON.parse(new TextDecoder().decode(bankBytes));
        assert.equal(bank.length, 1);
        assert.equal(bank[0][0], 'Entry');
    });
}
