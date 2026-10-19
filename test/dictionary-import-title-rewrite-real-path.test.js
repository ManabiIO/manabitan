/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later */

import {readFileSync} from 'node:fs';
import {describe, expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {DictionaryImportController} from '../ext/js/pages/settings/dictionary-import-controller.js';
import {JsonSchema} from '../ext/js/data/json-schema.js';
import {OptionsUtil} from '../ext/js/data/options-util.js';
import {SettingsController} from '../ext/js/pages/settings/settings-controller.js';

const sender = /** @type {chrome.runtime.MessageSender} */ ({});
/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
const copy = (value) => structuredClone(value);

/**
 * @param {(snapshot: import('settings').Options, readCount: number) => Promise<void>} [onOptionsRead]
 * @returns {Promise<{importer: DictionaryImportController, backend: Backend, settings: SettingsController, saveOptions: ReturnType<typeof vi.fn>}>}
 */
async function createHarness(onOptionsRead = async () => {}) {
    const optionsUtil = new OptionsUtil();
    const schema = JSON.parse(readFileSync(new URL('../ext/data/schemas/options-schema.json', import.meta.url), 'utf8'));
    Reflect.set(optionsUtil, '_optionsSchema', new JsonSchema(schema));
    const options = optionsUtil.getDefault();
    options.profiles[0].id = 'profile-a';
    options.profiles[0].name = 'Profile A';
    const sibling = copy(options.profiles[0]);
    sibling.id = 'profile-b';
    sibling.name = 'Profile B';
    options.profiles.push(sibling);

    const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
    Reflect.set(backend, '_options', options);
    Reflect.set(backend, '_optionsUtil', optionsUtil);
    Reflect.set(backend, '_optionsMutationTail', null);
    Reflect.set(backend, '_profileConditionsSchemaCache', []);
    Reflect.set(backend, '_dictionaryDatabase', {isPrepared: () => true, getDictionaryInfo: async () => []});
    Reflect.set(backend, '_applyOptions', vi.fn());
    Reflect.set(backend, '_clearProfileConditionsSchemaCache', vi.fn());
    const saveOptions = vi.fn(async (_source, nextOptions) => { Reflect.set(backend, '_options', copy(nextOptions)); });
    Reflect.set(backend, '_saveOptions', saveOptions);

    // Model extension messaging/API boundaries with structured clone in both directions.
    let optionsReadCount = 0;
    const application = {
        on: vi.fn(),
        triggerStorageChanged: vi.fn(),
        api: {
            optionsGetFull: async () => {
                const snapshot = copy(await backend._onApiOptionsGetFull(undefined, sender));
                await onOptionsRead(snapshot, ++optionsReadCount);
                return snapshot;
            },
            optionsGet: async (/** @type {import('settings').OptionsContext} */ optionsContext) => copy(await backend._onApiOptionsGet({optionsContext: copy(optionsContext)}, sender)),
            modifySettings: async (/** @type {import('settings-modifications').ScopedModification[]} */ targets, /** @type {string} */ source) => copy(await backend._onApiModifySettings({targets: copy(targets), source}, sender)),
            setAllSettings: async (/** @type {import('settings').Options} */ value, /** @type {string} */ source) => copy(await backend._onApiSetAllSettings({value: copy(value), source}, sender)),
            triggerDatabaseUpdated: vi.fn(async () => {}),
        },
    };
    const settings = new SettingsController(/** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ (application)));
    Reflect.set(settings, '_source', 'real-import-finalization-test');
    Reflect.set(settings, '_profileId', 'profile-a');
    Reflect.set(settings, '_profileIndex', 0);

    const importer = /** @type {DictionaryImportController} */ (/** @type {unknown} */ (Object.create(DictionaryImportController.prototype)));
    Reflect.set(importer, '_settingsController', settings);
    Reflect.set(importer, '_activeImportRunGeneration', 1);
    Reflect.set(importer, '_recordImportDebugSnapshot', vi.fn());
    Reflect.set(importer, '_verifyImportedDictionaryVisible', vi.fn(async () => {}));
    return {importer, backend, settings, saveOptions};
}

/**
 * @param {string} value
 * @returns {import('settings').AnkiField}
 */
function field(/** @type {string} */ value) { return {value, overwriteMode: 'overwrite'}; }
/**
 * @param {string} name
 * @returns {import('settings').DictionaryOptions}
 */
function oldDictionaryRow(name) {
    return {name, alias: name, enabled: true, allowSecondarySearches: false, definitionsCollapsible: 'not-collapsible', partsOfSpeechFilter: true, useDeinflections: true, styles: ''};
}

/**
 * Run the actual finalizer through real _addDictionarySettings, SettingsController, and Backend queue.
 * @param {DictionaryImportController} importer
 * @param {string} oldTitle
 * @returns {Promise<void>}
 */
async function finalize(importer, oldTitle) {
    const result = await importer._finalizeImportedDictionaryResult({
        dictionaryTitle: oldTitle,
        importStartTime: 1,
        importDetails: {},
        importResult: {result: {title: 'Bee', revision: 'test', sequenced: false, version: 3, importDate: 1, prefixWildcardsSupported: true, styles: ''}, errors: [], debug: {phaseTimings: []}},
        workerImportStartTime: 1,
        workerImportEndTime: 2,
        useImportSession: false,
        finalizeImportSession: true,
        importRunGeneration: 1,
        profilesDictionarySettings: {'profile-a': [{...oldDictionaryRow(oldTitle), index: 0}]},
        localPhaseTimings: [],
        notifyDatabaseUpdated: true,
        showErrors: false,
    });
    expect(result).toEqual({errors: [], importedTitle: 'Bee'});
}

/**
 * @param {Backend} backend
 * @param {string} id
 * @returns {import('settings').ProfileOptions}
 */
function profileOptions(backend, id) {
    const result = /** @type {import('settings').Options} */ (backend._options).profiles.find((profile) => profile.id === id)?.options;
    if (typeof result === 'undefined') { throw new Error(`Missing profile ${id}`); }
    return result;
}

/**
 * @param {import('settings').ProfileOptions} profile
 * @param {'term'|'kanji'} type
 * @returns {import('settings').AnkiCardFormat}
 */
function cardFormat(profile, type) {
    const result = profile.anki.cardFormats.find((item) => item.type === type);
    if (typeof result === 'undefined') { throw new Error(`Missing ${type} card format`); }
    return result;
}

describe('real dictionary importer title update path', () => {
    test('renames only the generated marker literals, preserving prose and sibling fields in term and kanji formats', async () => {
        const {importer, backend, saveOptions} = await createHarness();
        const target = profileOptions(backend, 'profile-a');
        const sibling = profileOptions(backend, 'profile-b');
        const term = cardFormat(target, 'term');
        const kanji = cardFormat(target, 'kanji');
        target.dictionaries.push(oldDictionaryRow('A'));
        term.fields = {
            Glossary: field('{single-glossary-a}'),
            Variants: field('{single-glossary-a-no-dictionary} {single-glossary-a-brief} {single-glossary-a-plain} {single-glossary-a-plain-no-dictionary} {single-frequency-a} {single-frequency-number-a}'),
            Literal: field('a cat; single-glossary-a is literal text; {single-glossary-a-sibling}; {single-glossary-ab}; {other-a}'),
        };
        kanji.fields = {Literal: field('A kanji note; {single-glossary-a}')};
        cardFormat(sibling, 'term').fields = {Sibling: field('{single-glossary-a}')};

        await finalize(importer, 'A');

        const changed = profileOptions(backend, 'profile-a');
        const changedTerm = cardFormat(changed, 'term');
        const changedKanji = cardFormat(changed, 'kanji');
        expect(changed.dictionaries.map(({name}) => name)).toContain('Bee');
        expect(changedTerm.fields.Glossary.value).toBe('{single-glossary-bee}');
        expect(changedTerm.fields.Variants.value).toBe('{single-glossary-bee-no-dictionary} {single-glossary-bee-brief} {single-glossary-bee-plain} {single-glossary-bee-plain-no-dictionary} {single-frequency-bee} {single-frequency-number-bee}');
        expect(changedTerm.fields.Literal.value).toBe('a cat; single-glossary-a is literal text; {single-glossary-a-sibling}; {single-glossary-ab}; {other-a}');
        expect(changedKanji.fields.Literal.value).toBe('A kanji note; {single-glossary-bee}');
        expect(cardFormat(profileOptions(backend, 'profile-b'), 'term').fields.Sibling.value).toBe('{single-glossary-a}');
        expect(saveOptions).toHaveBeenCalled();
    });

    test('does not overwrite profile edits committed after options snapshot transport', async () => {
        /** @type {() => void} */
        let releaseSnapshot = () => {};
        /** @type {() => void} */
        let capturedSnapshot = () => {};
        const snapshotCaptured = /** @type {Promise<void>} */ (new Promise((resolve) => { capturedSnapshot = () => resolve(); }));
        const snapshotGate = /** @type {Promise<void>} */ (new Promise((resolve) => { releaseSnapshot = () => resolve(); }));
        const {importer, backend, settings} = await createHarness(async (_snapshot, readCount) => {
            if (readCount === 2) {
                capturedSnapshot();
                await snapshotGate;
            }
        });
        const target = profileOptions(backend, 'profile-a');
        target.dictionaries.push(oldDictionaryRow('A'));
        const finalization = finalize(importer, 'A');
        const boundary = await Promise.race([snapshotCaptured.then(() => 'snapshot'), finalization.then(() => 'completed')]);
        if (boundary === 'snapshot') {
            // The API response is a structured clone already captured by the read handler;
            // a separate user mutation reaches and commits through the backend queue first.
            await settings.modifyGlobalSettings([{action: 'swapProfiles', profileId1: 'profile-a', profileId2: 'profile-b'}]);
            releaseSnapshot();
        } else {
            await settings.modifyGlobalSettings([{action: 'swapProfiles', profileId1: 'profile-a', profileId2: 'profile-b'}]);
        }
        await finalization;
        const saved = /** @type {import('settings').Options} */ (backend._options);
        expect(saved.profiles[0].id).toBe('profile-b');
        expect(profileOptions(backend, 'profile-a').dictionaries.map(({name}) => name)).toContain('Bee');
    });

    test('renames generated empty-slug markers for a punctuation-only prior title without touching literal text', async () => {
        const {importer, backend} = await createHarness();
        const target = profileOptions(backend, 'profile-a');
        const term = cardFormat(target, 'term');
        target.dictionaries.push(oldDictionaryRow('!!!'));
        term.fields = {Markers: field('{single-glossary-} {single-frequency-} {single-frequency-number-}'), Literal: field('punctuation !!! stays literal')};

        await finalize(importer, '!!!');

        const changed = cardFormat(profileOptions(backend, 'profile-a'), 'term');
        expect(changed.fields.Markers.value).toBe('{single-glossary-bee} {single-frequency-bee} {single-frequency-number-bee}');
        expect(changed.fields.Literal.value).toBe('punctuation !!! stays literal');
    });
});
