/* SPDX-License-Identifier: GPL-3.0-or-later */
import {describe, expect, test} from 'vitest';
import {recommendedDictionariesFromCatalog} from '../ext/web/presets.js';

describe('static web recommended dictionary catalog', () => {
    test('skips malformed and non-HTTPS records without hiding valid recommendations', () => {
        const valid = {name: 'Valid', description: 'Description', homepage: 'https://example.test/home', downloadUrl: 'https://example.test/dict.zip'};
        const catalog = {ja: {terms: [
            {name: 'Broken URL', description: 'Broken', homepage: 'not a URL', downloadUrl: valid.downloadUrl},
            {name: 'Broken archive', description: 'Broken', homepage: valid.homepage, downloadUrl: 'not a URL'},
            {name: 'Unsafe scheme', description: 'Unsafe', homepage: 'javascript:alert(1)', downloadUrl: valid.downloadUrl},
            {name: 'Credentials', description: 'Unsafe', homepage: 'https://user:secret@example.test/', downloadUrl: valid.downloadUrl},
            valid,
        ]}};
        expect(recommendedDictionariesFromCatalog(catalog)).toEqual([{
            ...valid,
            category: 'terms',
        }]);
    });

    test('rejects invalid catalog roots instead of silently accepting corrupted data', () => {
        expect(() => recommendedDictionariesFromCatalog(null)).toThrow('Invalid Japanese dictionary catalog');
        expect(() => recommendedDictionariesFromCatalog({ja: null})).toThrow('Invalid Japanese dictionary catalog');
    });
});
