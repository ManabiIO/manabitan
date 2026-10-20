/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later */

import {readFileSync} from 'node:fs';
import {expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {JsonSchema} from '../ext/js/data/json-schema.js';
import {DictionaryController} from '../ext/js/pages/settings/dictionary-controller.js';
import {enableDictionarySettings} from './chromium/restart-interruption-settings.js';

const schema = JSON.parse(readFileSync(new URL('../ext/data/schemas/options-schema.json', import.meta.url), 'utf8'));
const dictionariesSchema = new JsonSchema(schema.properties.profiles.items.properties.options.properties.dictionaries);

/**
 * @returns {{state: any, sendMessage: import('vitest').Mock}}
 */
function setup() {
    const state = {options: {profileCurrent: 0,
        profiles: [
            {id: 'profile-a', options: {general: {marker: 0}, dictionaries: []}},
            {id: 'profile-b', options: {general: {marker: 0}, dictionaries: []}},
        ]},
    afterRead: /** @type {null|(() => void)} */ (null)};
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    Reflect.set(backend, '_getOptionsFull', () => state.options);
    const sendMessage = vi.fn(async (action, params) => {
        if (action === 'optionsGetFull') {
            const snapshot = structuredClone(state.options);
            const afterRead = state.afterRead;
            state.afterRead = null;
            afterRead?.();
            return snapshot;
        }
        if (action === 'setAllSettings') {
            for (const profile of params.value.profiles) { dictionariesSchema.validate(profile.options.dictionaries); }
            state.options = params.value;
            return void 0;
        }
        if (action === 'modifySettings') {
            const results = params.targets.map((/** @type {import('settings-modifications').ScopedModification} */ target) => ({result: backend._modifySetting(target)}));
            for (const profile of state.options.profiles) { dictionariesSchema.validate(profile.options.dictionaries); }
            return results;
        }
        throw new Error('Unexpected API: ' + action);
    });
    return {state, sendMessage};
}

test('recovery setup creates complete dictionary options when import reconciliation has not run', async () => {
    const {state, sendMessage} = setup();
    await expect(enableDictionarySettings(sendMessage, 'Fixture')).resolves.toStrictEqual({enabled: true, name: 'Fixture'});
    const row = state.options.profiles[0].options.dictionaries[0];
    expect(row).toStrictEqual(DictionaryController.createDefaultDictionarySettings('Fixture', true, ''));
    dictionariesSchema.validate(state.options.profiles[0].options.dictionaries);
});

test('recovery setup does not replace an unrelated edit committed after its snapshot', async () => {
    const {state, sendMessage} = setup();
    state.options.profiles[0].options.dictionaries.push(DictionaryController.createDefaultDictionarySettings('Fixture', false, ''));
    state.afterRead = () => { state.options.profiles[0].options.general.marker = 42; };
    await enableDictionarySettings(sendMessage, 'Fixture');
    expect(state.options.profiles[0].options.general.marker).toBe(42);
    expect(state.options.profiles[0].options.dictionaries[0].enabled).toBe(true);
});

test('recovery setup retains profile identity when profiles reorder after its snapshot', async () => {
    const {state, sendMessage} = setup();
    state.options.profiles[0].options.dictionaries.push(DictionaryController.createDefaultDictionarySettings('Fixture', false, ''));
    state.afterRead = () => { state.options.profiles.reverse(); };
    await enableDictionarySettings(sendMessage, 'Fixture');
    expect(state.options.profiles[0].id).toBe('profile-b');
    expect(state.options.profiles[1].options.dictionaries[0].enabled).toBe(true);
    expect(state.options.profiles[0].options.dictionaries).toStrictEqual([]);
});

test('recovery setup enables an existing alias without replacing its options', async () => {
    const {state, sendMessage} = setup();
    const existing = DictionaryController.createDefaultDictionarySettings('Fixture', false, 'custom-style');
    existing.alias = 'Custom';
    existing.allowSecondarySearches = true;
    state.options.profiles[0].options.dictionaries.push(existing);
    await enableDictionarySettings(sendMessage, 'Fixture');
    expect(state.options.profiles[0].options.dictionaries).toStrictEqual([{...existing, enabled: true}]);
});


for (const reply of [[], [{result: true}], [{error: {message: 'Rejected'}}, {result: false}]]) {
    test('recovery setup rejects failed or incomplete mutation replies: ' + JSON.stringify(reply), async () => {
        const {state, sendMessage} = setup();
        sendMessage.mockResolvedValueOnce(structuredClone(state.options)).mockResolvedValueOnce(reply);
        await expect(enableDictionarySettings(sendMessage, 'Fixture')).rejects.toThrow('dictionary enablement failed');
    });
}

test('recovery setup verifies committed enablement after valid no-op acknowledgments', async () => {
    const {state, sendMessage} = setup();
    sendMessage.mockResolvedValueOnce(structuredClone(state.options)).mockResolvedValueOnce([{result: false}, {result: false}]);
    await expect(enableDictionarySettings(sendMessage, 'Fixture')).rejects.toThrow('not committed');
});

test('recovery setup cannot restore a profile deleted after its snapshot', async () => {
    const {state, sendMessage} = setup();
    state.afterRead = () => { state.options.profiles.splice(0, 1); };
    await expect(enableDictionarySettings(sendMessage, 'Fixture')).rejects.toThrow('Profile identity changed');
    expect(state.options.profiles.map((/** @type {{id: string}} */ profile) => profile.id)).toStrictEqual(['profile-b']);
});
