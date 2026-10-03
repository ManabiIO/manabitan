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

for (const {name, href, ambiguous, expected} of [
    {name: 'exact CSS resource link', href: 'style.css', ambiguous: false, expected: true},
    {name: 'unique case-insensitive CSS resource link', href: 'STYLE.CSS', ambiguous: false, expected: true},
    {name: 'ambiguous case-insensitive CSS resource link', href: 'STYLE.CSS', ambiguous: true, expected: false},
]) {
    test(name, async () => {
        const css = new TextEncoder().encode('.entry { color: red; }');
        const mdx = makeMdictFixture([{key: 'Entry', value: `<a href="${href}">CSS resource</a>`}]);
        const entries = [{key: '\\style.css', value: css}];
        if (ambiguous) {
            entries.push({key: '\\Style.css', value: new TextEncoder().encode('.entry { color: blue; }')});
        }
        const mdd = makeMdictFixture(entries, {mdd: true});
        const result = await createMdxImportData('css-link.mdx', {}, mdx.bytes, [{name: 'css-link.mdd', bytes: mdd.bytes}]);
        const bank = result.files.get('term_bank_1.json');
        assert.ok(bank instanceof Uint8Array);
        assert.ok(new TextDecoder().decode(bank).includes(`media:mdict-media/${href}`));
        const path = `mdict-media/${href}`;
        if (expected) {
            assert.deepEqual(result.files.get(path), css, 'the emitted media link must have matching resource bytes');
        } else {
            assert.equal(result.files.has(path), false, 'ambiguous casing must not choose an arbitrary resource');
        }
    });
}
