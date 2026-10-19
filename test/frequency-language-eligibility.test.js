/*
 * Copyright (C) 2026  Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test, vi} from 'vitest';
import {SortFrequencyDictionaryController} from '../ext/js/pages/settings/sort-frequency-dictionary-controller.js';

/**
 * @param {string|undefined} sourceLanguage
 * @param {string} [frequencyMode]
 * @returns {{controller: SortFrequencyDictionaryController, getTermFrequencies: ReturnType<typeof vi.fn>}}
 */
function createHarness(sourceLanguage, frequencyMode) {
    const getTermFrequencies = vi.fn(async () => []);
    const controller = /** @type {SortFrequencyDictionaryController} */ (Object.create(SortFrequencyDictionaryController.prototype));
    Reflect.set(controller, '_settingsController', {
        application: {api: {
            getDictionaryInfo: async () => [{title: 'Frequency', sourceLanguage, frequencyMode}],
            getTermFrequencies,
        }},
    });
    return {controller, getTermFrequencies};
}

describe('frequency auto-order language eligibility', () => {
    test.each(['en', 'zh', 'ko', 'constructor', '__proto__', 'toString'])('leaves %s dictionaries without a known mode unchanged', async (language) => {
        const {controller, getTermFrequencies} = createHarness(language);
        await expect(controller._getFrequencyOrder('Frequency')).resolves.toBeNull();
        expect(getTermFrequencies).not.toHaveBeenCalled();
    });

    test.each(['en', 'constructor'])('honors explicit modes for %s dictionaries', async (language) => {
        const occurrence = createHarness(language, 'occurrence-based');
        await expect(occurrence.controller._getFrequencyOrder('Frequency')).resolves.toBe('descending');
        expect(occurrence.getTermFrequencies).not.toHaveBeenCalled();
        const rank = createHarness(language, 'rank-based');
        await expect(rank.controller._getFrequencyOrder('Frequency')).resolves.toBe('ascending');
        expect(rank.getTermFrequencies).not.toHaveBeenCalled();
    });

    test.each(['ja', '', undefined])('preserves the supported fallback for language %s', async (language) => {
        const {controller, getTermFrequencies} = createHarness(language);
        await expect(controller._getFrequencyOrder('Frequency')).resolves.toBeNull();
        expect(getTermFrequencies).toHaveBeenCalledOnce();
        expect(getTermFrequencies).toHaveBeenCalledWith(expect.arrayContaining([{term: '来る', reading: null}, {term: '暁', reading: null}]), ['Frequency']);
    });
});


test('unsupported-language auto order preserves the selected order without writing', async () => {
    const {controller, getTermFrequencies} = createHarness('en');
    const settings = Reflect.get(controller, '_settingsController');
    settings.getOptionsContext = () => ({index: 0, profileId: 'profile-a'});
    Reflect.set(controller, '_autoOrderRequestId', 0);
    Reflect.set(controller, '_confirmedDictionary', 'Frequency');
    Reflect.set(controller, '_sortFrequencyDictionarySelect', {value: 'Frequency'});
    const orderSelect = {value: 'descending'};
    Reflect.set(controller, '_sortFrequencyDictionaryOrderSelect', orderSelect);
    const saveOrder = vi.fn();
    Reflect.set(controller, '_setSortFrequencyDictionaryOrderValue', saveOrder);
    await controller._autoUpdateOrder('Frequency');
    expect(orderSelect.value).toBe('descending');
    expect(saveOrder).not.toHaveBeenCalled();
    expect(getTermFrequencies).not.toHaveBeenCalled();
});
