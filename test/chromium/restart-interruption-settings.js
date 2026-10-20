/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later */

import {DictionaryController} from '../../ext/js/pages/settings/dictionary-controller.js';

/**
 * @param {(action: string, params?: any) => Promise<any>} sendMessage
 * @param {string} dictionaryTitle
 * @returns {Promise<{enabled: boolean, name: string}>}
 */
export async function enableDictionarySettings(sendMessage, dictionaryTitle) {
    const full = /** @type {import('settings').Options} */ (await sendMessage('optionsGetFull'));
    const profile = full.profiles?.[0];
    const profileId = profile?.id;
    const dictionaries = profile?.options?.dictionaries;
    if (typeof profileId !== 'string' || profileId.length === 0 || !Array.isArray(dictionaries)) {
        throw new Error('profile dictionary options are unavailable');
    }
    const item = DictionaryController.createDefaultDictionarySettings(dictionaryTitle, true, '');
    const alias = dictionaries.find((entry) => entry?.name === dictionaryTitle)?.alias ?? item.alias;
    const results = await sendMessage('modifySettings', {
        source: 'restart-interruption-campaign',
        targets: [
            {action: 'ensureDictionary', profileId, item, scope: 'global', optionsContext: null},
            {action: 'setDictionaryEnabled', profileId, name: dictionaryTitle, alias, value: true, scope: 'global', optionsContext: null},
        ],
    });
    if (!Array.isArray(results) || results.length !== 2 || results.some((result) => (
        result === null || typeof result !== 'object' || result.error || typeof result.result !== 'boolean'
    ))) {
        throw new Error('dictionary enablement failed: ' + JSON.stringify(results));
    }
    const committed = /** @type {import('settings').Options} */ (await sendMessage('optionsGetFull'));
    const matchingProfiles = committed.profiles.filter((entry) => entry.id === profileId);
    const enabled = matchingProfiles.length === 1 && matchingProfiles[0].options.dictionaries.some((entry) => (
        entry.name === dictionaryTitle && entry.alias === alias && entry.enabled === true
    ));
    if (!enabled) { throw new Error('dictionary enablement was not committed'); }
    return {enabled: true, name: dictionaryTitle};
}
