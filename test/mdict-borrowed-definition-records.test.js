/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test} from 'vitest';
import {MDX} from '../ext/js/dictionary/mdx/vendor/js-mdict/mdx.js';
import {makeMdictFixture} from './util/mdict-binary-fixture.js';

describe.each(['raw', 'zlib'])('MDX borrowed definition records with %s blocks', (compression) => {
    test('string-returning APIs borrow records while byte lookup stays owned', () => {
        const fixture = makeMdictFixture([
            {key: 'entry', value: '<div>definition payload</div>'},
        ], {
            compression: /** @type {'raw'|'zlib'} */ (compression),
            recordBlockSize: 4096,
        });
        const mdx = new MDX('borrowed-definition.mdx', fixture.bytes, {recordBlockCacheBytes: 4096});
        try {
            const item = mdx.keywordList[0];
            const originalLookup = Reflect.get(mdx, '_lookupRecordByKeyBlock');
            /** @type {boolean[]} */
            const copyModes = [];
            Reflect.set(mdx, '_lookupRecordByKeyBlock', function(keyBlockItem, copyOutput) {
                copyModes.push(copyOutput);
                return Reflect.apply(originalLookup, this, [keyBlockItem, copyOutput]);
            });

            expect(mdx.fetch_definition(item).definition).toBe('<div>definition payload</div>\0');
            expect(mdx.fetch(item).definition).toBe('<div>definition payload</div>\0');
            expect(mdx.lookup('entry').definition).toBe('<div>definition payload</div>\0');
            expect(copyModes).toEqual([false, false, false]);

            const owned = mdx.lookupRecordByKeyBlock(item);
            expect(copyModes).toEqual([false, false, false, true]);
            expect(owned).toEqual(fixture.records[0]);
            owned.fill(0);

            expect(mdx.fetch_definition(item).definition).toBe('<div>definition payload</div>\0');
            expect(copyModes.at(-1)).toBe(false);
        } finally {
            mdx.close();
        }
    });
});
