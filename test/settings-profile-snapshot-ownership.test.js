/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test, vi} from 'vitest';
import {AnkiDeckGeneratorController} from '../ext/js/pages/settings/anki-deck-generator-controller.js';
import {AnkiController} from '../ext/js/pages/settings/anki-controller.js';
import {CollapsibleDictionaryController} from '../ext/js/pages/settings/collapsible-dictionary-controller.js';
import {KeyboardShortcutController} from '../ext/js/pages/settings/keyboard-shortcuts-controller.js';
import {PopupFrequencyBlurController} from '../ext/js/pages/settings/popup-frequency-blur-controller.js';
import {ScanInputsController} from '../ext/js/pages/settings/scan-inputs-controller.js';
import {SecondarySearchDictionaryController} from '../ext/js/pages/settings/secondary-search-dictionary-controller.js';
import {SentenceTerminationCharactersController} from '../ext/js/pages/settings/sentence-termination-characters-controller.js';
import {SettingsController} from '../ext/js/pages/settings/settings-controller.js';
import {SortFrequencyDictionaryController} from '../ext/js/pages/settings/sort-frequency-dictionary-controller.js';
import {TranslationTextReplacementsController} from '../ext/js/pages/settings/translation-text-replacements-controller.js';

/**
 * @template T
 * @returns {{promise: Promise<T>, resolve: (value: T) => void, reject: (reason: unknown) => void}}
 */
function deferred() {
    /** @type {(value: T) => void} */
    let resolve = () => {};
    /** @type {(reason: unknown) => void} */
    let reject = () => {};
    /** @type {Promise<T>} */
    const promise = new Promise((resolve2, reject2) => {
        resolve = resolve2;
        reject = reject2;
    });
    return {promise, resolve, reject};
}

/** @returns {Promise<void>} */
async function flush() {
    for (let i = 0; i < 20; ++i) { await Promise.resolve(); }
}

/**
 * @param {string} marker
 * @returns {import('settings').ProfileOptions}
 */
function profileOptions(marker) {
    return /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({marker}));
}

/**
 * @param {object} prototype
 * @param {string} method
 * @param {unknown[]} [args]
 * @param {Record<string, unknown>} [extra]
 */
async function expectDirectRefreshDropsStaleProfile(prototype, method, args = [], extra = {}) {
    let profileIndex = 0;
    /** @type {ReturnType<typeof deferred<import('settings').ProfileOptions>>} */
    const pending = deferred();
    const applied = vi.fn();
    const controller = Object.assign(Object.create(prototype), {
        _settingsController: {
            getOptionsContext: () => ({index: profileIndex}),
            getOptions: () => pending.promise,
        },
        _onOptionsChanged: applied,
        ...extra,
    });

    const operation = Reflect.apply(Reflect.get(prototype, method), controller, args);
    await flush();
    profileIndex = 1;
    pending.resolve(profileOptions('profile-0'));
    await operation;

    expect(applied).not.toHaveBeenCalled();
}

test('SettingsController never emits an old-profile options snapshot after the profile changes', async () => {
    const controller = /** @type {SettingsController} */ (Object.create(SettingsController.prototype));
    Reflect.set(controller, '_profileIndex', 0);
    /** @type {ReturnType<typeof deferred<import('settings').ProfileOptions>>} */
    const pending = deferred();
    Reflect.set(controller, 'getOptions', () => pending.promise);
    const trigger = vi.fn();
    Reflect.set(controller, 'trigger', trigger);

    const refresh = controller._onOptionsUpdatedInternal(false);
    await flush();
    Reflect.set(controller, '_profileIndex', 1);
    pending.resolve(profileOptions('profile-0'));
    await refresh;

    expect(trigger).not.toHaveBeenCalled();
});

test('SettingsController still emits a stable current-profile options snapshot', async () => {
    const controller = /** @type {SettingsController} */ (Object.create(SettingsController.prototype));
    Reflect.set(controller, '_profileIndex', 2);
    const options = profileOptions('profile-2');
    Reflect.set(controller, 'getOptions', async () => options);
    const trigger = vi.fn();
    Reflect.set(controller, 'trigger', trigger);

    await controller._onOptionsUpdatedInternal(false);

    expect(trigger).toHaveBeenCalledOnce();
    expect(trigger).toHaveBeenCalledWith('optionsChanged', {options, optionsContext: {index: 2}});
});

for (const [name, prototype, method, args] of [
    ['scan input refresh', ScanInputsController.prototype, 'refresh', []],
    ['sentence termination refresh', SentenceTerminationCharactersController.prototype, '_updateOptions', []],
    ['translation replacement refresh', TranslationTextReplacementsController.prototype, '_updateOptions', []],
    ['Anki settings refresh', AnkiController.prototype, '_updateOptions', []],
    ['keyboard shortcut refresh', KeyboardShortcutController.prototype, '_updateOptions', []],
    ['secondary dictionary reorder refresh', SecondarySearchDictionaryController.prototype, '_onDictionarySettingsReordered', [null]],
    ['collapsible dictionary reorder refresh', CollapsibleDictionaryController.prototype, '_onDictionarySettingsReordered', [null]],
]) {
    test(`${name} drops a result when the selected profile changes during its read`, async () => {
        await expectDirectRefreshDropsStaleProfile(prototype, method, args);
    });
}

for (const [name, prototype] of [
    ['sort-frequency dictionary refresh', SortFrequencyDictionaryController.prototype],
    ['popup-frequency dictionary refresh', PopupFrequencyBlurController.prototype],
]) {
    test(`${name} drops a result when the selected profile changes during its options read`, async () => {
        let profileIndex = 0;
        /** @type {ReturnType<typeof deferred<import('settings').ProfileOptions>>} */
        const pending = deferred();
        const applied = vi.fn();
        const controller = Object.assign(Object.create(prototype), {
            _settingsController: {
                getDictionaryInfo: async () => [],
                getOptionsContext: () => ({index: profileIndex}),
                getOptions: () => pending.promise,
            },
            _getDictionaryInfoToken: null,
            _updateDictionaryOptions: vi.fn(),
            _onOptionsChanged: applied,
        });

        const operation = controller._onDatabaseUpdated();
        await flush();
        profileIndex = 1;
        pending.resolve(profileOptions('profile-0'));
        await operation;

        expect(applied).not.toHaveBeenCalled();
    });
}

test('deck parsing never combines old-profile options with a newly selected profile', async () => {
    let profileIndex = 0;
    /** @type {ReturnType<typeof deferred<import('settings').ProfileOptions>>} */
    const options = deferred();
    const parseText = vi.fn();
    const controller = /** @type {AnkiDeckGeneratorController} */ (Object.assign(
        Object.create(AnkiDeckGeneratorController.prototype),
        {
            _parseToken: {},
            _wordInputTextarea: {value: 'one'},
            _settingsController: {
                getOptionsContext: () => ({index: profileIndex}),
                getOptions: () => options.promise,
            },
            _application: {api: {parseText}},
        },
    ));

    const parsing = controller._onParse();
    await flush();
    profileIndex = 1;
    options.resolve(/** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({
        scanning: {length: 5},
        parsing: {enableMecabParser: false, useAllFrequencyDictionaries: false},
    })));
    await parsing;

    expect(parseText).not.toHaveBeenCalled();
    expect(controller._wordInputTextarea.value).toBe('one');
});

test('only the newest deck parse can publish after overlapping requests', async () => {
    /** @type {ReturnType<typeof deferred<any>>[]} */
    const parses = [deferred(), deferred()];
    let parseIndex = 0;
    const options = /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({
        scanning: {length: 5},
        parsing: {enableMecabParser: false, useAllFrequencyDictionaries: false},
    }));
    const textarea = {value: 'one'};
    const controller = /** @type {AnkiDeckGeneratorController} */ (Object.assign(
        Object.create(AnkiDeckGeneratorController.prototype),
        {
            _parseToken: {},
            _wordInputTextarea: textarea,
            _settingsController: {
                getOptionsContext: () => ({index: 0}),
                getOptions: async () => options,
            },
            _application: {
                api: {
                    parseText: vi.fn(() => parses[parseIndex++].promise),
                },
            },
        },
    ));

    const first = controller._onParse();
    await flush();
    textarea.value = 'two';
    const second = controller._onParse();
    await flush();

    parses[1].resolve([{content: [[{text: 'TWO'}]]}]);
    await second;
    expect(textarea.value).toBe('TWO');

    parses[0].resolve([{content: [[{text: 'ONE'}]]}]);
    await first;
    expect(textarea.value).toBe('TWO');
});

test('note generation aborts if the selected profile changes during dictionary lookup', async () => {
    let profileIndex = 0;
    /** @type {ReturnType<typeof deferred<any>>} */
    const lookup = deferred();
    const getOptions = vi.fn();
    const controller = /** @type {AnkiDeckGeneratorController} */ (Object.assign(
        Object.create(AnkiDeckGeneratorController.prototype),
        {
            _flashcardFormatDetails: [{type: 'term-kanji', fields: {}}],
            _activeFlashcardFormatSelect: {value: '0'},
            _activeNoteType: 'Model A',
            _activeAnkiDeck: 'Deck A',
            _settingsController: {
                getOptionsContext: () => ({index: profileIndex}),
                getOptions,
            },
            _getDictionaryEntry: () => lookup.promise,
        },
    ));

    const generating = controller._generateNoteData('言葉', false);
    await flush();
    profileIndex = 1;
    lookup.resolve({dictionaryEntry: {}, text: '言葉'});

    await expect(generating).rejects.toThrow('Profile changed while generating Anki note');
    expect(getOptions).not.toHaveBeenCalled();
});
