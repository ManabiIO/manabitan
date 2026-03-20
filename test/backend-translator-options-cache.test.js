/*
 * Copyright (C) 2023-2025  Yomitan Authors
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

/* eslint-disable no-underscore-dangle */

import {describe, expect, test} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';

/**
 * @returns {import('settings').ProfileOptions}
 */
function createProfileOptions() {
    return /** @type {import('settings').ProfileOptions} */ ({
        general: {
            mainDictionary: 'Main Dictionary',
            sortFrequencyDictionary: null,
            sortFrequencyDictionaryOrder: 'descending',
            language: 'ja',
        },
        scanning: {
            alphanumeric: false,
        },
        translation: {
            searchResolution: 'letter',
            textReplacements: {
                searchOriginal: true,
                groups: [[
                    {pattern: 'foo', ignoreCase: false, replacement: 'bar'},
                ]],
            },
        },
        dictionaries: [{
            name: 'Terms Dictionary',
            enabled: true,
            alias: 'Terms Dictionary',
            allowSecondarySearches: false,
            partsOfSpeechFilter: true,
            useDeinflections: true,
        }],
    });
}

/**
 * @returns {Backend}
 */
function createBackendForTesting() {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    backend._translatorProfileOptionsCache = new WeakMap();
    return backend;
}

describe('Backend translator option cache', () => {
    test('reuses compiled lookup state for repeated term lookups', () => {
        const backend = createBackendForTesting();
        const options = createProfileOptions();

        const first = backend._getTranslatorFindTermsOptions('split', {}, options);
        const second = backend._getTranslatorFindTermsOptions('split', {}, options);

        expect(second.enabledDictionaryMap).toBe(first.enabledDictionaryMap);
        expect(second.textReplacements).toBe(first.textReplacements);
        expect(second.textReplacements[1]?.[0].pattern).toBeInstanceOf(RegExp);
    });

    test('keeps merge fallback state isolated from the base dictionary map', () => {
        const backend = createBackendForTesting();
        const options = createProfileOptions();

        const split = backend._getTranslatorFindTermsOptions('split', {}, options);
        const mergeFirst = backend._getTranslatorFindTermsOptions('merge', {}, options);
        const mergeSecond = backend._getTranslatorFindTermsOptions('merge', {}, options);

        expect(split.enabledDictionaryMap.has('Main Dictionary')).toBe(false);
        expect(mergeFirst.enabledDictionaryMap.has('Main Dictionary')).toBe(true);
        expect(mergeSecond.enabledDictionaryMap).toBe(mergeFirst.enabledDictionaryMap);
        expect(mergeSecond.excludeDictionaryDefinitions).toBe(mergeFirst.excludeDictionaryDefinitions);
    });
});

/* eslint-enable no-underscore-dangle */
