/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';

function fixture() {
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    const oldEntry = {name: 'Old title', alias: 'My dictionary', enabled: false, definitionsCollapsible: 'expanded', styles: 'old styles'};
    const profile = {id: 'profile-A',
        options: {
            dictionaries: [oldEntry],
            general: {mainDictionary: 'Old title', sortFrequencyDictionary: 'Old title'},
            anki: {cardFormats: [{fields: {Glossary: {value: '{single-glossary-old-title} literal Old title'}}}]},
        }};
    const options = {profiles: [profile]};
    const summary = {title: 'New title',
        sourceTitle: 'New title',
        replacedDictionaryTitle: 'Old title',
        updateSessionToken: 'completed-update',
        storageGenerationId: 'generation-new',
        importSuccess: true,
        styles: 'new styles'};
    const summaries = [summary];
    const save = vi.fn(async () => {});
    Object.assign(backend, {
        _options: options,
        _dictionaryDatabase: {getDictionaryInfo: async () => summaries},
        _ensureDictionaryDatabaseReady: async () => {},
        _optionsUtil: {save, createValidatingProxy: (/** @type {unknown} */ value) => value},
        _clearProfileConditionsSchemaCache: vi.fn(),
    });
    return {backend, options, profile, oldEntry, summaries, summary, save};
}

test('startup recovers preferences, selectors, and Anki markers after a committed title update loses page finalization', async () => {
    const {backend, profile, oldEntry, save} = fixture();
    const summary = await backend._pruneStaleProfileDictionaryOptions();
    expect(profile.options.dictionaries).toEqual([{...oldEntry, name: 'New title', styles: 'new styles'}]);
    expect(profile.options.general).toEqual({mainDictionary: 'New title', sortFrequencyDictionary: 'New title'});
    expect(profile.options.anki.cardFormats[0].fields.Glossary.value).toBe('{single-glossary-new-title} literal Old title');
    expect(summary.removedEntryCount).toBe(0);
    expect(save).toHaveBeenCalledOnce();
    await backend._pruneStaleProfileDictionaryOptions();
    expect(save).toHaveBeenCalledOnce();
});

test('startup keeps newer target preferences while completing a partially applied title migration', async () => {
    const {backend, profile, save} = fixture();
    const newer = {...profile.options.dictionaries[0], name: 'New title', enabled: true, styles: 'user styles'};
    profile.options.dictionaries.push(newer);
    await backend._pruneStaleProfileDictionaryOptions();
    expect(profile.options.dictionaries).toEqual([newer]);
    expect(profile.options.general.mainDictionary).toBe('New title');
    expect(save).toHaveBeenCalledOnce();
});

test('startup never migrates a source dictionary which is still installed', async () => {
    const {backend, profile, summaries, summary, save} = fixture();
    summaries.push({...summary, title: 'Old title', sourceTitle: 'Old title', replacedDictionaryTitle: ''});
    await backend._pruneStaleProfileDictionaryOptions();
    expect(profile.options.dictionaries[0].name).toBe('Old title');
    expect(profile.options.general.mainDictionary).toBe('Old title');
    expect(save).not.toHaveBeenCalled();
});

test('ambiguous committed replacements retain source preferences instead of guessing or pruning them', async () => {
    const {backend, profile, summaries, summary, save} = fixture();
    summaries.push({...summary, title: 'Another title', sourceTitle: 'Another title', storageGenerationId: 'another-generation'});
    await backend._pruneStaleProfileDictionaryOptions();
    expect(profile.options.dictionaries[0].name).toBe('Old title');
    expect(profile.options.general.mainDictionary).toBe('Old title');
    expect(save).not.toHaveBeenCalled();
});


test.each(['staged', 'missing-token', 'missing-generation', 'failed-import'])('startup does not recover preferences from an unconfirmed %s summary', async (state) => {
    const {backend, profile, summary} = fixture();
    if (state === 'staged') { Reflect.set(summary, 'transientUpdateStage', 'update-staging'); }
    if (state === 'missing-token') { summary.updateSessionToken = ''; }
    if (state === 'missing-generation') { summary.storageGenerationId = ''; }
    if (state === 'failed-import') { summary.importSuccess = false; }
    await backend._pruneStaleProfileDictionaryOptions();
    expect(profile.options.dictionaries.some(({name}) => name === 'New title')).toBe(false);
    expect(profile.options.general.mainDictionary).not.toBe('New title');
    expect(profile.options.anki.cardFormats[0].fields.Glossary.value).toBe('{single-glossary-old-title} literal Old title');
});
