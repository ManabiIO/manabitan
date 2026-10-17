/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test, vi} from 'vitest';
import {AnkiDeckGeneratorController} from '../ext/js/pages/settings/anki-deck-generator-controller.js';
import {AnkiController} from '../ext/js/pages/settings/anki-controller.js';
import {CollapsibleDictionaryController} from '../ext/js/pages/settings/collapsible-dictionary-controller.js';
import {DictionaryController} from '../ext/js/pages/settings/dictionary-controller.js';
import {KeyboardShortcutController} from '../ext/js/pages/settings/keyboard-shortcuts-controller.js';
import {PermissionsToggleController} from '../ext/js/pages/settings/permissions-toggle-controller.js';
import {PopupFrequencyBlurController} from '../ext/js/pages/settings/popup-frequency-blur-controller.js';
import {ScanInputsController} from '../ext/js/pages/settings/scan-inputs-controller.js';
import {ScanInputsSimpleController} from '../ext/js/pages/settings/scan-inputs-simple-controller.js';
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
 * @param {number} profileIndex
 * @returns {SettingsController}
 */
function createSettingsController(profileIndex) {
    const optionsFull = {
        profileCurrent: 0,
        profiles: Array.from({length: 3}, (_, index) => ({id: `profile-${index}`, name: `Profile ${index}`, options: {}, conditionGroups: []})),
    };
    return Object.assign(Object.create(SettingsController.prototype), {
        _profileIndex: profileIndex,
        _profileId: `profile-${profileIndex}`,
        _profileIndexChangeGeneration: 0,
        _preparedOptionsFull: optionsFull,
        _application: {api: {optionsGetFull: async () => optionsFull}},
    });
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
        _readGeneration: 0,
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
    const controller = /** @type {SettingsController} */ (createSettingsController(0));
    /** @type {ReturnType<typeof deferred<import('settings').ProfileOptions>>} */
    const pending = deferred();
    Reflect.set(controller, 'getOptions', () => pending.promise);
    const trigger = vi.fn();
    Reflect.set(controller, 'trigger', trigger);

    const refresh = controller._onOptionsUpdatedInternal(false);
    await flush();
    Reflect.set(controller, '_profileIndex', 1);
    Reflect.set(controller, '_profileIndexChangeGeneration', 1);
    pending.resolve(profileOptions('profile-0'));
    await refresh;

    expect(trigger).not.toHaveBeenCalled();
});


test('SettingsController applies only the latest overlapping refresh for one profile', async () => {
    const controller = /** @type {SettingsController} */ (createSettingsController(0));
    /** @type {ReturnType<typeof deferred<import('settings').Options>>} */
    const older = deferred();
    /** @type {ReturnType<typeof deferred<import('settings').Options>>} */
    const newer = deferred();
    Reflect.set(controller.application.api, 'optionsGetFull', vi.fn()
        .mockImplementationOnce(() => older.promise)
        .mockImplementationOnce(() => newer.promise));
    const getOptions = vi.fn(async () => profileOptions('newer'));
    Reflect.set(controller, 'getOptions', getOptions);
    const trigger = vi.fn();
    Reflect.set(controller, 'trigger', trigger);

    const first = controller._onOptionsUpdatedInternal(false);
    const second = controller._onOptionsUpdatedInternal(false);
    await flush();

    const newerOptions = await getOptions();
    newer.resolve(/** @type {import('settings').Options} */ (/** @type {unknown} */ ({profileCurrent: 0, profiles: [{id: 'profile-0', options: {}, conditionGroups: []}]})));
    await second;
    older.resolve(/** @type {import('settings').Options} */ (/** @type {unknown} */ ({profileCurrent: 0, profiles: [{id: 'profile-0', options: {}, conditionGroups: []}]})));
    await first;

    expect(trigger).toHaveBeenCalledOnce();
    expect(trigger).toHaveBeenCalledWith('optionsChanged', {
        options: newerOptions,
        optionsContext: {index: 0, profileId: 'profile-0'},
    });
});

test('an older same-profile refresh failure cannot reset profile zero after a newer refresh succeeds', async () => {
    const controller = /** @type {SettingsController} */ (createSettingsController(2));
    /** @type {ReturnType<typeof deferred<import('settings').Options>>} */
    const older = deferred();
    /** @type {ReturnType<typeof deferred<import('settings').Options>>} */
    const newer = deferred();
    Reflect.set(controller.application.api, 'optionsGetFull', vi.fn()
        .mockImplementationOnce(() => older.promise)
        .mockImplementationOnce(() => newer.promise));
    Reflect.set(controller, 'getOptions', async () => profileOptions('newer'));
    Reflect.set(controller, 'trigger', vi.fn());
    const setProfileIndex = vi.fn();
    Reflect.set(controller, '_setProfileIndex', setProfileIndex);

    const first = controller._onOptionsUpdatedInternal(true);
    const second = controller._onOptionsUpdatedInternal(true);
    await flush();

    newer.resolve(/** @type {import('settings').Options} */ (/** @type {unknown} */ ({
        profileCurrent: 0,
        profiles: Array.from({length: 3}, (_, index) => ({id: `profile-${index}`, options: {}, conditionGroups: []})),
    })));
    await second;
    older.reject(new Error('stale failure'));
    await first;

    expect(setProfileIndex).not.toHaveBeenCalled();
    expect(Reflect.get(controller, '_profileIndex')).toBe(2);
});

test('SettingsController ignores a stale old-profile refresh failure after the profile changes', async () => {
    const controller = /** @type {SettingsController} */ (createSettingsController(1));
    /** @type {ReturnType<typeof deferred<import('settings').ProfileOptions>>} */
    const pending = deferred();
    Reflect.set(controller, 'getOptions', () => pending.promise);
    const setProfileIndex = vi.fn();
    Reflect.set(controller, '_setProfileIndex', setProfileIndex);

    const refresh = controller._onOptionsUpdatedInternal(true);
    await flush();
    Reflect.set(controller, '_profileIndex', 2);
    Reflect.set(controller, '_profileIndexChangeGeneration', 1);
    pending.reject(new Error('old profile unavailable'));
    await refresh;

    expect(setProfileIndex).not.toHaveBeenCalled();
    expect(Reflect.get(controller, '_profileIndex')).toBe(2);
});

test('SettingsController still falls back to profile zero when the current profile refresh fails', async () => {
    const controller = /** @type {SettingsController} */ (createSettingsController(2));
    Reflect.set(controller, 'getOptions', async () => { throw new Error('current profile unavailable'); });
    Reflect.set(controller, 'trigger', vi.fn());
    await controller._onOptionsUpdatedInternal(true);

    expect(Reflect.get(controller, '_profileIndex')).toBe(0);
    expect(Reflect.get(controller, '_profileId')).toBe('profile-0');
});

test('SettingsController still emits a stable current-profile options snapshot', async () => {
    const controller = /** @type {SettingsController} */ (createSettingsController(2));
    const options = profileOptions('profile-2');
    Reflect.set(controller, 'getOptions', async () => options);
    const trigger = vi.fn();
    Reflect.set(controller, 'trigger', trigger);

    await controller._onOptionsUpdatedInternal(false);

    expect(trigger).toHaveBeenCalledOnce();
    expect(trigger).toHaveBeenCalledWith('optionsChanged', {options, optionsContext: {index: 2, profileId: 'profile-2'}});
});

/** @type {[string, object, string, unknown[]][]} */
const directRefreshCases = [
    ['scan input refresh', ScanInputsController.prototype, 'refresh', []],
    ['sentence termination refresh', SentenceTerminationCharactersController.prototype, '_updateOptions', []],
    ['translation replacement refresh', TranslationTextReplacementsController.prototype, '_updateOptions', []],
    ['Anki settings refresh', AnkiController.prototype, '_updateOptions', []],
    ['keyboard shortcut refresh', KeyboardShortcutController.prototype, '_updateOptions', []],
    ['secondary dictionary reorder refresh', SecondarySearchDictionaryController.prototype, '_onDictionarySettingsReordered', [null]],
    ['collapsible dictionary reorder refresh', CollapsibleDictionaryController.prototype, '_onDictionarySettingsReordered', [null]],
];

for (const [name, prototype, method, args] of directRefreshCases) {
    test(`${name} drops a result when the selected profile changes during its read`, async () => {
        await expectDirectRefreshDropsStaleProfile(prototype, method, args);
    });
}

/** @type {[string, object][]} */
const dictionaryRefreshCases = [
    ['sort-frequency dictionary refresh', SortFrequencyDictionaryController.prototype],
    ['popup-frequency dictionary refresh', PopupFrequencyBlurController.prototype],
];

for (const [name, prototype] of dictionaryRefreshCases) {
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


/**
 * @param {object} prototype
 * @param {string} method
 * @param {unknown[]} args
 * @param {import('settings').ProfileOptions} options
 */
async function expectProfileWriteDropsAfterSwitch(prototype, method, args, options) {
    let profileIndex = 0;
    /** @type {ReturnType<typeof deferred<import('settings').ProfileOptions>>} */
    const pending = deferred();
    const modifyProfileSettings = vi.fn().mockResolvedValue([]);
    const settingsController = {
        getOptionsContext: () => ({index: profileIndex}),
        getOptions: () => pending.promise,
        modifyProfileSettings,
        modifySettings: modifyProfileSettings,
        trigger: vi.fn(),
    };
    const controller = Object.assign(Object.create(prototype), {
        _settingsController: settingsController,
    });

    // Snapshot-based editors queue against the verified row snapshot, rather than
    // making a fresh options read before dispatch. Hold that real admission
    // boundary so the profile switch still exercises an unsent write.
    const isSentenceEditor = prototype === SentenceTerminationCharactersController.prototype;
    const isReplacementEditor = prototype === TranslationTextReplacementsController.prototype;
    const isShortcutEditor = prototype === KeyboardShortcutController.prototype;
    const queued = isSentenceEditor || isReplacementEditor || isShortcutEditor ? deferred() : null;
    if (queued !== null) {
        Object.assign(controller, {
            _viewContext: {index: 0},
            _viewGeneration: 0,
            _mutationTail: queued.promise,
            _mutationRequestGeneration: 0,
            _savedRows: isSentenceEditor ? options.sentenceParsing.terminationCharacters : (isReplacementEditor ? (options.translation.textReplacements.groups[0] ?? []) : []),
            _savedGroups: isReplacementEditor ? options.translation.textReplacements.groups : [],
            _savedHotkeys: isShortcutEditor ? options.inputs.hotkeys : [],
            _entries: [{index: 0, generation: 0, retired: false, isDisposed: false}],
        });
    }
    const operation = Reflect.apply(Reflect.get(prototype, method), controller, args);
    await flush();
    profileIndex = 1;
    pending.resolve(options);
    queued?.resolve(void 0);
    await operation;

    expect(modifyProfileSettings).not.toHaveBeenCalled();
}

/**
 * @param {unknown} value
 * @returns {import('settings').ProfileOptions}
 */
function partialProfileOptions(value) {
    return /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ (value));
}

/** @type {[string, object, string, unknown[], import('settings').ProfileOptions][]} */
const staleProfileWriteCases = [
    [
        'Anki card-format add',
        AnkiController.prototype,
        '_addNewFormat',
        [],
        partialProfileOptions({anki: {cardFormats: []}}),
    ],
    [
        'dictionary reorder',
        DictionaryController.prototype,
        'moveDictionaryOptions',
        [0, 1],
        partialProfileOptions({dictionaries: [{name: 'a'}, {name: 'b'}]}),
    ],
    [
        'dictionary enable-all',
        DictionaryController.prototype,
        '_setAllDictionariesEnabled',
        [true],
        partialProfileOptions({dictionaries: [{enabled: false}]}),
    ],
    [
        'keyboard shortcut add',
        KeyboardShortcutController.prototype,
        'addEntry',
        [{}],
        partialProfileOptions({inputs: {hotkeys: []}}),
    ],
    [
        'keyboard shortcut delete',
        KeyboardShortcutController.prototype,
        'deleteEntry',
        [0],
        partialProfileOptions({inputs: {hotkeys: [{}]}}),
    ],
    [
        'collapsible dictionary set-all',
        CollapsibleDictionaryController.prototype,
        '_setDefinitionsCollapsibleAll',
        ['collapsed'],
        partialProfileOptions({dictionaries: [{definitionsCollapsible: 'expanded'}]}),
    ],
    [
        'simple scan middle-mouse change',
        ScanInputsSimpleController.prototype,
        '_setMiddleMouseSuppported',
        [true],
        partialProfileOptions({scanning: {inputs: []}}),
    ],
    [
        'simple scan main-input change',
        ScanInputsSimpleController.prototype,
        '_setMainScanInputs',
        [['shift']],
        partialProfileOptions({scanning: {inputs: []}}),
    ],
    [
        'sentence terminator add',
        SentenceTerminationCharactersController.prototype,
        'addEntry',
        [{}],
        partialProfileOptions({sentenceParsing: {terminationCharacters: []}}),
    ],
    [
        'sentence terminator delete',
        SentenceTerminationCharactersController.prototype,
        'deleteEntry',
        [0],
        partialProfileOptions({sentenceParsing: {terminationCharacters: [{}]}}),
    ],
    [
        'translation replacement add',
        TranslationTextReplacementsController.prototype,
        'addGroup',
        [],
        partialProfileOptions({translation: {textReplacements: {groups: [[]]}}}),
    ],
    [
        'translation replacement delete',
        TranslationTextReplacementsController.prototype,
        'deleteGroup',
        [0],
        partialProfileOptions({translation: {textReplacements: {groups: [[{}]]}}}),
    ],
];

for (const [name, prototype, method, args, options] of staleProfileWriteCases) {
    test(name + ' cannot write an old-profile decision into the newly selected profile', async () => {
        await expectProfileWriteDropsAfterSwitch(prototype, method, args, options);
    });
}


test('keyboard shortcut reset cannot write defaults into a profile selected while defaults load', async () => {
    let profileIndex = 0;
    /** @type {ReturnType<typeof deferred<import('settings').InputsHotkeyOptions[]>>} */
    const pending = deferred();
    const modifySettings = vi.fn().mockResolvedValue([]);
    const controller = Object.assign(Object.create(KeyboardShortcutController.prototype), {
        _settingsController: {
            getOptionsContext: () => ({index: profileIndex}),
            modifySettings,
        },
        getDefaultHotkeys: () => pending.promise,
        _updateOptions: vi.fn(),
        _viewContext: {index: 0},
        _viewGeneration: 0,
        _mutationRequestGeneration: 0,
        _mutationTail: Promise.resolve(),
    });

    const operation = controller._reset();
    await flush();
    profileIndex = 1;
    pending.resolve([]);
    await operation;

    expect(modifySettings).not.toHaveBeenCalled();
});

test('sentence termination reset cannot write defaults into a profile selected while defaults load', async () => {
    let profileIndex = 0;
    /** @type {ReturnType<typeof deferred<import('settings').Options>>} */
    const pending = deferred();
    const modifySettings = vi.fn().mockResolvedValue([]);
    const controller = Object.assign(Object.create(SentenceTerminationCharactersController.prototype), {
        _settingsController: {
            getOptionsContext: () => ({index: profileIndex}),
            getDefaultOptions: () => pending.promise,
            modifySettings,
        },
        _updateOptions: vi.fn(),
        _viewContext: {index: 0},
        _viewGeneration: 0,
        _mutationTail: Promise.resolve(),
        _mutationRequestGeneration: 0,
    });

    const operation = controller._reset();
    await flush();
    profileIndex = 1;
    pending.resolve(/** @type {import('settings').Options} */ (/** @type {unknown} */ ({
        profiles: [{options: {sentenceParsing: {terminationCharacters: []}}}],
    })));
    await operation;

    expect(modifySettings).not.toHaveBeenCalled();
});

test('sort-frequency auto detection cannot write its result into a newly selected profile', async () => {
    let profileIndex = 0;
    /** @type {ReturnType<typeof deferred<import('settings').SortFrequencyDictionaryOrder|null>>} */
    const pending = deferred();
    const setOrder = vi.fn(async () => {});
    const controller = Object.assign(Object.create(SortFrequencyDictionaryController.prototype), {
        _settingsController: {
            getOptionsContext: () => ({index: profileIndex}),
        },
        _getFrequencyOrder: () => pending.promise,
        _setSortFrequencyDictionaryOrderValue: setOrder,
        _sortFrequencyDictionaryOrderSelect: {value: 'ascending'},
    });

    const operation = controller._autoUpdateOrder('dictionary');
    await flush();
    profileIndex = 1;
    pending.resolve('descending');
    await operation;

    expect(setOrder).not.toHaveBeenCalled();
});

test('permission prompt completion cannot write its result into a newly selected profile', async () => {
    let profileIndex = 0;
    /** @type {((result: boolean) => void)|null} */
    let permissionCallback = null;
    vi.stubGlobal('chrome', {
        runtime: {lastError: null},
        permissions: {
            /**
             * @param {chrome.permissions.Permissions} _permissions
             * @param {(result: boolean) => void} callback
             */
            request(_permissions, callback) {
                permissionCallback = callback;
            },
        },
    });
    const setProfileSetting = vi.fn().mockResolvedValue([]);
    const controller = Object.assign(Object.create(PermissionsToggleController.prototype), {
        _settingsController: {
            getOptionsContext: () => ({index: profileIndex}),
            setProfileSetting,
        },
        _getRequiredPermissions: () => ['clipboardRead'],
        _setToggleValid: vi.fn(),
    });
    const toggle = {
        checked: true,
        dataset: {permissionsSetting: 'general.enableYomitanApi'},
    };

    const operation = controller._onPermissionsToggleChange({currentTarget: toggle});
    await flush();
    profileIndex = 1;
    if (permissionCallback === null) { throw new Error('Permission request was not started'); }
    const resolvePermission = /** @type {(result: boolean) => void} */ (permissionCallback);
    resolvePermission(true);
    await operation;

    expect(setProfileSetting).not.toHaveBeenCalled();
});

for (const [name, method, element] of [
    ['middle mouse handler', '_handleMiddleMouseButtonScanChange', {checked: true}],
    ['main scan modifier handler', '_handleMainScanModifierKeyInputChange', {value: 'shift'}],
]) {
    test(name + ' cannot hand a stale-profile event to a setter for the new profile', async () => {
        let profileIndex = 0;
        /** @type {ReturnType<typeof deferred<import('settings').ProfileOptions>>} */
        const pending = deferred();
        const middleSetter = vi.fn(async () => {});
        const mainSetter = vi.fn(async () => {});
        const controller = Object.assign(Object.create(ScanInputsSimpleController.prototype), {
            _settingsController: {
                getOptionsContext: () => ({index: profileIndex}),
                getOptions: () => pending.promise,
            },
            _setMiddleMouseSuppported: middleSetter,
            _setMainScanInputs: mainSetter,
        });

        const operation = method === '_handleMiddleMouseButtonScanChange' ?
            controller._handleMiddleMouseButtonScanChange(element, true) :
            controller._handleMainScanModifierKeyInputChange(element, ['shift']);
        await flush();
        profileIndex = 1;
        pending.resolve(partialProfileOptions({scanning: {inputs: []}}));
        await operation;

        expect(middleSetter).not.toHaveBeenCalled();
        expect(mainSetter).not.toHaveBeenCalled();
    });
}
