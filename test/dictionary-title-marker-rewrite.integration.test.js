/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later */

import {readFileSync} from 'node:fs';
import {describe, expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {JsonSchema} from '../ext/js/data/json-schema.js';
import {OptionsUtil} from '../ext/js/data/options-util.js';
import {SettingsController} from '../ext/js/pages/settings/settings-controller.js';

const sender = /** @type {chrome.runtime.MessageSender} */ ({});

/** @returns {Promise<{backend: Backend, settings: SettingsController, options: import('settings').Options, saveOptions: ReturnType<typeof vi.fn>}>} */
async function createHarness() {
    const optionsUtil = new OptionsUtil();
    const schema = JSON.parse(readFileSync(new URL('../ext/data/schemas/options-schema.json', import.meta.url), 'utf8'));
    Reflect.set(optionsUtil, '_optionsSchema', new JsonSchema(schema));
    const options = optionsUtil.getDefault();
    options.profiles[0].id = 'profile-a';
    const secondProfile = structuredClone(options.profiles[0]);
    secondProfile.id = 'profile-b';
    options.profiles.push(secondProfile);
    const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
    Reflect.set(backend, '_options', options);
    Reflect.set(backend, '_optionsUtil', optionsUtil);
    Reflect.set(backend, '_optionsMutationTail', null);
    Reflect.set(backend, '_profileConditionsSchemaCache', []);
    Reflect.set(backend, '_applyOptions', vi.fn());
    Reflect.set(backend, '_clearProfileConditionsSchemaCache', vi.fn());
    const saveOptions = vi.fn(async (_source, nextOptions) => { Reflect.set(backend, '_options', nextOptions); });
    Reflect.set(backend, '_saveOptions', saveOptions);
    const application = {
        on: vi.fn(),
        api: {
            optionsGetFull: async () => structuredClone(backend._onApiOptionsGetFull(undefined, sender)),
            modifySettings: async (/** @type {import('settings-modifications').ScopedModification[]} */ targets, /** @type {string} */ source) => await backend._onApiModifySettings({targets, source}, sender),
        },
    };
    const settings = new SettingsController(/** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ (application)));
    Reflect.set(settings, '_source', 'title-marker-rewrite-test');
    Reflect.set(settings, '_profileId', 'profile-a');
    return {backend, settings, options, saveOptions};
}

/**
 * @param {import('settings').ProfileOptions} profileOptions
 * @param {string} fieldName
 * @param {string} value
 * @param {import('settings').AnkiCardFormat} [format]
 * @returns {void}
 */
function addField(profileOptions, fieldName, value, format = profileOptions.anki.cardFormats[0]) {
    format.fields[fieldName] = {value, overwriteMode: 'overwrite'};
}

/**
 * @param {string} name
 * @returns {import('settings').DictionaryOptions}
 */
function dictionaryRow(name) {
    return {name, alias: name, enabled: true, allowSecondarySearches: false, definitionsCollapsible: 'not-collapsible', partsOfSpeechFilter: true, useDeinflections: true, styles: ''};
}

describe('dictionary title marker rewrite through the real backend settings queue', () => {
    test('changes only complete generated markers for the targeted profile', async () => {
        const {backend, settings, options} = await createHarness();
        const first = options.profiles[0].options;
        const siblingProfile = options.profiles[1].options;
        addField(first, 'Glossary', '{single-glossary-a}');
        addField(first, 'Variants', '{single-glossary-a-no-dictionary} {single-glossary-a-brief} {single-glossary-a-plain} {single-glossary-a-plain-no-dictionary} {single-frequency-a} {single-frequency-number-a}');
        addField(first, 'Literal', 'a cat; single-glossary-a; {single-glossary-a-sibling}; {single-glossary-ab}; {other-a}');
        addField(siblingProfile, 'Sibling', '{single-glossary-a}');
        const kanjiFormat = first.anki.cardFormats.find(({type}) => type === 'kanji');
        expect(kanjiFormat).toBeDefined();
        addField(first, 'KanjiGlossary', '{single-glossary-a}', kanjiFormat);
        first.dictionaries.push(dictionaryRow('A'));

        const result = await settings.modifyGlobalSettings([{
            action: 'replaceDictionaryName',
            profileId: 'profile-a',
            sourceName: 'A',
            name: 'Bee',
            styles: '',
            fallbackSettings: [{index: 0, item: dictionaryRow('A')}],
        }]);

        const saved = /** @type {import('settings').Options} */ (Reflect.get(backend, '_options'));
        const changed = saved.profiles.find(({id}) => id === 'profile-a')?.options;
        const untouched = saved.profiles.find(({id}) => id === 'profile-b')?.options;
        expect(result[0]).toHaveProperty('result', true);
        expect(changed?.anki.cardFormats[0].fields.Glossary.value).toBe('{single-glossary-bee}');
        expect(changed?.anki.cardFormats[0].fields.Variants.value).toBe('{single-glossary-bee-no-dictionary} {single-glossary-bee-brief} {single-glossary-bee-plain} {single-glossary-bee-plain-no-dictionary} {single-frequency-bee} {single-frequency-number-bee}');
        expect(changed?.anki.cardFormats[0].fields.Literal.value).toBe('a cat; single-glossary-a; {single-glossary-a-sibling}; {single-glossary-ab}; {other-a}');
        expect(changed?.anki.cardFormats.find(({type}) => type === 'kanji')?.fields.KanjiGlossary.value).toBe('{single-glossary-bee}');
        expect(untouched?.anki.cardFormats[0].fields.Sibling.value).toBe('{single-glossary-a}');
    });

    test('persists marker-only fallback retry when the new dictionary row already exists', async () => {
        const {backend, settings, options, saveOptions} = await createHarness();
        const profile = options.profiles[0].options;
        addField(profile, 'Glossary', '{single-glossary-a}');
        profile.dictionaries.push(dictionaryRow('Bee'));
        const fallbackSettings = [{index: 0, item: dictionaryRow('A')}];

        saveOptions.mockRejectedValueOnce(new Error('persistence unavailable'));
        await expect(settings.modifyGlobalSettings([{
            action: 'replaceDictionaryName', profileId: 'profile-a', sourceName: 'A', name: 'Bee', styles: '', fallbackSettings,
        }])).rejects.toThrow('persistence unavailable');
        expect(profile.anki.cardFormats[0].fields.Glossary.value).toBe('{single-glossary-a}');
        await expect(settings.modifyGlobalSettings([{
            action: 'replaceDictionaryName', profileId: 'profile-a', sourceName: 'A', name: 'Bee', styles: '', fallbackSettings,
        }])).resolves.toEqual([{result: true}]);

        const saved = /** @type {import('settings').Options} */ (Reflect.get(backend, '_options'));
        expect(saved.profiles[0].options.anki.cardFormats[0].fields.Glossary.value).toBe('{single-glossary-bee}');
        expect(saved.profiles[0].options.dictionaries).toEqual([dictionaryRow('Bee')]);
    });

    test('keeps concurrent profile reorder and field edits and skips identical slugs', async () => {
        const {backend, settings, options, saveOptions} = await createHarness();
        const profileA = options.profiles[0].options;
        addField(profileA, 'Glossary', '{single-glossary-a}');
        addField(profileA, 'User', 'before');
        profileA.dictionaries.push(dictionaryRow('A'));

        const fieldEdit = settings.modifyGlobalSettings([{action: 'set', path: 'profiles[0].options.anki.cardFormats[0].fields.User.value', value: 'concurrent edit'}]);
        const reorder = settings.modifyGlobalSettings([{action: 'swapProfiles', profileId1: 'profile-a', profileId2: 'profile-b'}]);
        const [, reorderResult] = await Promise.all([fieldEdit, reorder]);
        expect(reorderResult[0]).toHaveProperty('result', true);
        const beforeRenameSaveCount = saveOptions.mock.calls.length;
        await settings.modifyGlobalSettings([{
            action: 'replaceDictionaryName',
            profileId: 'profile-a',
            sourceName: 'A',
            name: 'Bee',
            styles: '',
            fallbackSettings: [{index: 0, item: dictionaryRow('A')}],
        }]);

        const saved = /** @type {import('settings').Options} */ (Reflect.get(backend, '_options'));
        const movedProfile = saved.profiles.find(({id}) => id === 'profile-a');
        expect(movedProfile?.options.anki.cardFormats[0].fields.Glossary.value).toBe('{single-glossary-bee}');
        expect(movedProfile?.options.anki.cardFormats[0].fields.User.value).toBe('concurrent edit');
        expect(saved.profiles[0].id).toBe('profile-b');
        expect(saveOptions).toHaveBeenCalledTimes(beforeRenameSaveCount + 1);

        const noOpCount = saveOptions.mock.calls.length;
        await settings.modifyGlobalSettings([{
            action: 'replaceDictionaryName',
            profileId: 'profile-a',
            sourceName: 'Old_Title',
            name: 'old title',
            styles: '',
            fallbackSettings: [],
        }]);
        expect(saveOptions).toHaveBeenCalledTimes(noOpCount);
    });

    test('rewrites empty-slug markers for valid punctuation-only old titles', async () => {
        const {backend, settings, options} = await createHarness();
        const profile = options.profiles[0].options;
        addField(profile, 'Glossary', '{single-glossary-} {single-frequency-number-} literal words');
        profile.dictionaries.push(dictionaryRow('!!!'));
        await settings.modifyGlobalSettings([{
            action: 'replaceDictionaryName',
            profileId: 'profile-a',
            sourceName: '!!!',
            name: 'Bee',
            styles: '',
            fallbackSettings: [{index: 0, item: dictionaryRow('!!!')}],
        }]);
        const saved = /** @type {import('settings').Options} */ (Reflect.get(backend, '_options'));
        expect(saved.profiles[0].options.anki.cardFormats[0].fields.Glossary.value).toBe('{single-glossary-bee} {single-frequency-number-bee} literal words');
    });

    test('does not persist marker rewrites when fallback validation fails in a partially successful batch', async () => {
        const {backend, settings, options} = await createHarness();
        const profile = options.profiles[0].options;
        addField(profile, 'Glossary', '{single-glossary-a}');
        profile.dictionaries.push(dictionaryRow('Bee'));
        const results = await settings.modifyGlobalSettings([
            {
                action: 'replaceDictionaryName',
                profileId: 'profile-a',
                sourceName: 'A',
                name: 'Bee',
                styles: '',
                fallbackSettings: /** @type {{index: number, item: Record<string, unknown>}[]} */ (/** @type {unknown} */ ([null])),
            },
            {action: 'set', path: 'profiles[0].name', value: 'Renamed profile'},
        ]);

        const saved = /** @type {import('settings').Options} */ (Reflect.get(backend, '_options'));
        expect(results[0]).toHaveProperty('error');
        expect(results[1]).toHaveProperty('result', 'Renamed profile');
        expect(saved.profiles[0].options.anki.cardFormats[0].fields.Glossary.value).toBe('{single-glossary-a}');
        expect(saved.profiles[0].name).toBe('Renamed profile');
    });
});
