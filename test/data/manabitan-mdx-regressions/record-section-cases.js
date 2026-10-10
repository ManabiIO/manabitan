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
import {MDX} from '../../../ext/js/dictionary/mdx/vendor/js-mdict/mdx.js';
import {MDD} from '../../../ext/js/dictionary/mdx/vendor/js-mdict/mdd.js';
import {createMdxImportData} from '../../../ext/js/dictionary/mdx/mdx-converter.js';
import {makeMdictFixture} from '../../util/mdict-binary-fixture.js';

/** @type {Array<'raw'|'zlib'>} */
const compressions = ['raw', 'zlib'];

for (const version of ['1.2', '2.0']) {
    for (const compression of compressions) {
        for (const mdd of [false, true]) {
            test(`rejects truncated ${mdd ? 'MDD' : 'MDX'} ${version} ${compression} data during metadata parsing`, () => {
                const fixture = makeMdictFixture([{key: 'entry', value: 'text'}], {mdd, version, compression});
                const Dictionary = mdd ? MDD : MDX;
                const name = mdd ? 'truncated.mdd' : 'truncated.mdx';
                assert.throws(() => new Dictionary(name, fixture.bytes.slice(0, -1)), /MDict read exceeds/u);
            });
        }
    }
}

test('lazy unreferenced MDD data cannot hide a truncated record section', async () => {
    const mdx = makeMdictFixture([{key: 'entry', value: '<div>healthy text</div>'}]);
    const mdd = makeMdictFixture([{key: 'unused.bin', value: new Uint8Array([1, 2, 3])}], {mdd: true, compression: 'raw'});
    await assert.rejects(
        createMdxImportData('healthy.mdx', {}, mdx.bytes, [{name: 'truncated.mdd', bytes: mdd.bytes.slice(0, -1)}]),
        /MDict read exceeds/u,
    );
});

test('valid unused MDD blocks remain lazy and preserve converted text', async () => {
    const mdx = makeMdictFixture([{key: 'entry', value: '<div>healthy text</div>'}]);
    const mdd = makeMdictFixture([{key: 'unused.bin', value: new Uint8Array([1, 2, 3])}], {mdd: true, compression: 'raw'});
    const originalLookup = MDD.prototype.lookupRecordByKeyBlock;
    let lookups = 0;
    /** @param {unknown} item */
    MDD.prototype.lookupRecordByKeyBlock = function (item) {
        lookups += 1;
        return originalLookup.call(this, item);
    };
    try {
        const result = await createMdxImportData('healthy.mdx', {}, mdx.bytes, [{name: 'valid.mdd', bytes: mdd.bytes}]);
        assert.equal(lookups, 0);
        assert.match(new TextDecoder().decode(result.files.get('term_bank_1.json')), /healthy text/u);
        assert.equal(result.files.has('mdict-media/unused.bin'), false);
    } finally {
        MDD.prototype.lookupRecordByKeyBlock = originalLookup;
    }
});
