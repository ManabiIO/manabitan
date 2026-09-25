/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from '../ext/js/dictionary/dictionary-importer-media-loader.js';

/**
 * @param {string[]} modes
 * @returns {import('dictionary-importer').SummaryMetaCount}
 */
function countModes(modes) {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
    const rows = modes.map((mode) => ({mode}));
    return Reflect.get(importer, '_getMetaCounts').call(importer, /** @type {import('core').SafeAny} */ (rows));
}

describe('dictionary import metadata summary counting', () => {
    test.each([
        [[], {total: 0}],
        [['freq'], {total: 1, freq: 1}],
        [['pitch', 'pitch'], {total: 2, pitch: 2}],
        [['ipa', 'freq', 'pitch', 'freq'], {total: 4, freq: 2, pitch: 1, ipa: 1}],
        [['other', 'freq', 'other'], {total: 3, freq: 1, other: 2}],
        [['total', 'freq', 'total'], {total: 3, freq: 1}],
    ])('preserves summary semantics for %j', (modes, expected) => {
        expect(countModes(modes)).toEqual(expected);
    });

    test('counts large validated metadata lists without changing totals', () => {
        const modes = Array.from({length: 100000}, (_, index) => (
            index % 3 === 0 ? 'freq' : (index % 3 === 1 ? 'pitch' : 'ipa')
        ));
        expect(countModes(modes)).toEqual({
            total: 100000,
            freq: 33334,
            pitch: 33333,
            ipa: 33333,
        });
    });
});
