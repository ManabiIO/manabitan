/*
 * Copyright (C) 2026  Yomitan Authors
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

import {describe, expect, test, vi} from 'vitest';
import {createDictionaryImportBusyError} from '../ext/js/core/dictionary-import-busy-error.js';
import {ExtensionError} from '../ext/js/core/extension-error.js';
import {Display} from '../ext/js/display/display.js';

describe('Display dictionary update handling', () => {
    for (const method of /** @type {const} */ (['_refreshSearchEmptyStateAfterOptionsUpdate', '_refreshAfterDictionaryDatabaseUpdate'])) {
        test.each(['terms', 'kanji', 'unloaded', 'clear'])(`${method} only updates a still-empty search page after options load (%s)`, async (type) => {
            const pending = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
            const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
            const updateOptions = vi.fn().mockReturnValue(pending.promise);
            const setNoContentVisible = vi.fn();
            const setNoDictionariesVisible = vi.fn();
            Object.assign(display, {
                _pageType: 'search',
                _contentType: 'clear',
                _options: {dictionaries: [{enabled: true}]},
                _application: {webExtension: {unloaded: false}},
                _refreshDictionaryInfo: vi.fn().mockResolvedValue(void 0),
                updateOptions,
                _setNoContentVisible: setNoContentVisible,
                _setNoDictionariesVisible: setNoDictionariesVisible,
            });
            const operation = display[method]();
            await vi.waitFor(() => { expect(updateOptions).toHaveBeenCalledOnce(); });
            Reflect.set(display, '_contentType', type);
            pending.resolve();
            await operation;
            if (type === 'clear') {
                expect(setNoContentVisible).toHaveBeenCalledExactlyOnceWith(false);
                expect(setNoDictionariesVisible).toHaveBeenCalledExactlyOnceWith(false);
            } else {
                expect(setNoContentVisible).not.toHaveBeenCalled();
                expect(setNoDictionariesVisible).not.toHaveBeenCalled();
            }
        });
    }

    test('dictionary database updates refresh cached dictionary info', async () => {
        const getDictionaryInfo = vi.fn().mockResolvedValue([{title: 'JMdict'}]);
        const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
        Reflect.set(display, '_dictionaryInfo', []);
        Reflect.set(display, '_dictionaryInfoRefreshGeneration', 0);
        Reflect.set(display, '_pageType', 'popup');
        Reflect.set(display, '_contentType', 'clear');
        Reflect.set(display, 'searchLast', vi.fn());
        Reflect.set(display, '_application', {
            api: {getDictionaryInfo},
            webExtension: {unloaded: false},
        });

        const onDatabaseUpdated = Reflect.get(Display.prototype, '_onDatabaseUpdated');
        await onDatabaseUpdated.call(display, {type: 'dictionary', cause: 'import'});
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(getDictionaryInfo).toHaveBeenCalledOnce();
        expect(Reflect.get(display, '_dictionaryInfo')).toStrictEqual([{title: 'JMdict'}]);
        expect(Reflect.get(display, 'searchLast')).not.toHaveBeenCalled();
    });

    test('dictionary database updates rerun visible popup/search results outside the search page', async () => {
        const getDictionaryInfo = vi.fn().mockResolvedValue([{title: 'JMdict'}]);
        const updateOptions = vi.fn().mockResolvedValue(void 0);
        const searchLast = vi.fn();
        const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
        Reflect.set(display, '_dictionaryInfo', []);
        Reflect.set(display, '_dictionaryInfoRefreshGeneration', 0);
        Reflect.set(display, '_pageType', 'popup');
        Reflect.set(display, '_contentType', 'terms');
        Reflect.set(display, 'updateOptions', updateOptions);
        Reflect.set(display, 'searchLast', searchLast);
        Reflect.set(display, '_application', {
            api: {getDictionaryInfo},
            webExtension: {unloaded: false},
        });

        const onDatabaseUpdated = Reflect.get(Display.prototype, '_onDatabaseUpdated');
        await onDatabaseUpdated.call(display, {type: 'dictionary', cause: 'delete'});
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(updateOptions).toHaveBeenCalledOnce();
        expect(searchLast).toHaveBeenCalledOnce();
        expect(searchLast).toHaveBeenCalledWith(false);
    });

    test('dictionary database updates do not double-rerun the dedicated search page', async () => {
        const getDictionaryInfo = vi.fn().mockResolvedValue([{title: 'JMdict'}]);
        const searchLast = vi.fn();
        const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
        Reflect.set(display, '_dictionaryInfo', []);
        Reflect.set(display, '_dictionaryInfoRefreshGeneration', 0);
        Reflect.set(display, '_pageType', 'search');
        Reflect.set(display, '_contentType', 'terms');
        Reflect.set(display, 'searchLast', searchLast);
        Reflect.set(display, '_application', {
            api: {getDictionaryInfo},
            webExtension: {unloaded: false},
        });

        const onDatabaseUpdated = Reflect.get(Display.prototype, '_onDatabaseUpdated');
        await onDatabaseUpdated.call(display, {type: 'dictionary', cause: 'import'});
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(searchLast).not.toHaveBeenCalled();
    });

    test('dictionary database updates do not rerun non-search displays in unloaded state', async () => {
        const getDictionaryInfo = vi.fn().mockResolvedValue([{title: 'JMdict'}]);
        const updateOptions = vi.fn().mockResolvedValue(void 0);
        const searchLast = vi.fn();
        const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
        Reflect.set(display, '_dictionaryInfo', []);
        Reflect.set(display, '_dictionaryInfoRefreshGeneration', 0);
        Reflect.set(display, '_pageType', 'popup');
        Reflect.set(display, '_contentType', 'unloaded');
        Reflect.set(display, 'updateOptions', updateOptions);
        Reflect.set(display, 'searchLast', searchLast);
        Reflect.set(display, '_application', {
            api: {getDictionaryInfo},
            webExtension: {unloaded: false},
        });

        const onDatabaseUpdated = Reflect.get(Display.prototype, '_onDatabaseUpdated');
        await onDatabaseUpdated.call(display, {type: 'dictionary', cause: 'import'});
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(getDictionaryInfo).toHaveBeenCalledOnce();
        expect(updateOptions).not.toHaveBeenCalled();
        expect(searchLast).not.toHaveBeenCalled();
    });

    test('dictionary database updates refresh empty search-page dictionary state', async () => {
        const getDictionaryInfo = vi.fn().mockResolvedValue([{title: 'JMdict'}]);
        const updateOptions = vi.fn().mockImplementation(async () => {
            Reflect.set(display, '_options', {dictionaries: [{enabled: true}]});
        });
        const setNoContentVisible = vi.fn();
        const setNoDictionariesVisible = vi.fn();
        const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
        Reflect.set(display, '_dictionaryInfo', []);
        Reflect.set(display, '_dictionaryInfoRefreshGeneration', 0);
        Reflect.set(display, '_pageType', 'search');
        Reflect.set(display, '_contentType', 'clear');
        Reflect.set(display, '_options', {dictionaries: [{enabled: false}]});
        Reflect.set(display, 'updateOptions', updateOptions);
        Reflect.set(display, '_setNoContentVisible', setNoContentVisible);
        Reflect.set(display, '_setNoDictionariesVisible', setNoDictionariesVisible);
        Reflect.set(display, 'searchLast', vi.fn());
        Reflect.set(display, '_application', {
            api: {getDictionaryInfo},
            webExtension: {unloaded: false},
        });

        const onDatabaseUpdated = Reflect.get(Display.prototype, '_onDatabaseUpdated');
        await onDatabaseUpdated.call(display, {type: 'dictionary', cause: 'import'});
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(updateOptions).toHaveBeenCalledOnce();
        expect(setNoContentVisible).toHaveBeenCalledWith(false);
        expect(setNoDictionariesVisible).toHaveBeenCalledWith(false);
    });

    test('stale dictionary-info refresh does not overwrite newer display state', async () => {
        const firstRefreshDeferred = Promise.withResolvers();
        const secondRefreshDeferred = Promise.withResolvers();
        const getDictionaryInfo = vi.fn()
            .mockImplementationOnce(() => firstRefreshDeferred.promise)
            .mockImplementationOnce(() => secondRefreshDeferred.promise);
        const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
        Reflect.set(display, '_dictionaryInfo', []);
        Reflect.set(display, '_dictionaryInfoRefreshGeneration', 0);
        Reflect.set(display, '_application', {
            api: {getDictionaryInfo},
        });

        const firstRefresh = Display.prototype._refreshDictionaryInfo.call(display);
        const secondRefresh = Display.prototype._refreshDictionaryInfo.call(display);
        secondRefreshDeferred.resolve([{title: 'Jitendex'}]);
        await secondRefresh;
        firstRefreshDeferred.resolve([{title: 'JMdict'}]);
        await firstRefresh;

        expect(Reflect.get(display, '_dictionaryInfo')).toStrictEqual([{title: 'Jitendex'}]);
    });

    test('options updates rerun visible popup results outside the search page', async () => {
        const updateOptions = vi.fn().mockResolvedValue(void 0);
        const searchLast = vi.fn();
        const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
        Reflect.set(display, '_pageType', 'popup');
        Reflect.set(display, '_contentType', 'terms');
        Reflect.set(display, 'updateOptions', updateOptions);
        Reflect.set(display, 'searchLast', searchLast);
        Reflect.set(display, '_application', {webExtension: {unloaded: false}});

        const onOptionsUpdated = Reflect.get(Display.prototype, '_onOptionsUpdated');
        await onOptionsUpdated.call(display);
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(updateOptions).toHaveBeenCalledOnce();
        expect(searchLast).toHaveBeenCalledOnce();
        expect(searchLast).toHaveBeenCalledWith(false);
    });

    test('options updates do not rerun the dedicated search page display directly', async () => {
        const updateOptions = vi.fn().mockImplementation(async () => {
            Reflect.set(display, '_options', {dictionaries: [{enabled: true}]});
        });
        const searchLast = vi.fn();
        const setNoContentVisible = vi.fn();
        const setNoDictionariesVisible = vi.fn();
        const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
        Reflect.set(display, '_pageType', 'search');
        Reflect.set(display, '_contentType', 'clear');
        Reflect.set(display, 'updateOptions', updateOptions);
        Reflect.set(display, 'searchLast', searchLast);
        Reflect.set(display, '_options', {dictionaries: [{enabled: false}]});
        Reflect.set(display, '_setNoContentVisible', setNoContentVisible);
        Reflect.set(display, '_setNoDictionariesVisible', setNoDictionariesVisible);
        Reflect.set(display, '_application', {webExtension: {unloaded: false}});

        const onOptionsUpdated = Reflect.get(Display.prototype, '_onOptionsUpdated');
        await onOptionsUpdated.call(display);
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(updateOptions).toHaveBeenCalledOnce();
        expect(searchLast).not.toHaveBeenCalled();
        expect(setNoContentVisible).toHaveBeenCalledWith(false);
        expect(setNoDictionariesVisible).toHaveBeenCalledWith(false);
    });

    test('options updates do not rerun search results directly when the dedicated search page is already showing content', async () => {
        const updateOptions = vi.fn().mockResolvedValue(void 0);
        const searchLast = vi.fn();
        const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
        Reflect.set(display, '_pageType', 'search');
        Reflect.set(display, '_contentType', 'terms');
        Reflect.set(display, 'updateOptions', updateOptions);
        Reflect.set(display, 'searchLast', searchLast);
        Reflect.set(display, '_application', {webExtension: {unloaded: false}});

        const onOptionsUpdated = Reflect.get(Display.prototype, '_onOptionsUpdated');
        await onOptionsUpdated.call(display);
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(updateOptions).not.toHaveBeenCalled();
        expect(searchLast).not.toHaveBeenCalled();
    });

    test('options updates do not rerun non-search displays in unloaded state', async () => {
        const updateOptions = vi.fn().mockResolvedValue(void 0);
        const searchLast = vi.fn();
        const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
        Reflect.set(display, '_pageType', 'popup');
        Reflect.set(display, '_contentType', 'unloaded');
        Reflect.set(display, 'updateOptions', updateOptions);
        Reflect.set(display, 'searchLast', searchLast);
        Reflect.set(display, '_application', {webExtension: {unloaded: false}});

        const onOptionsUpdated = Reflect.get(Display.prototype, '_onOptionsUpdated');
        await onOptionsUpdated.call(display);
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(updateOptions).not.toHaveBeenCalled();
        expect(searchLast).not.toHaveBeenCalled();
    });
});

/**
 * @param {ReturnType<typeof vi.fn>} getDictionaryInfo
 * @returns {{display: Display, listeners: Map<string, (details: unknown) => void>}}
 */
function createPreparingDisplay(getDictionaryInfo) {
    const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
    /** @type {Map<string, (details: unknown) => void>} */
    const listeners = new Map();
    vi.stubGlobal('document', {documentElement: {dataset: {}, addEventListener: vi.fn()}, addEventListener: vi.fn()});
    vi.stubGlobal('window', {addEventListener: vi.fn()});
    Object.assign(display, {
        _themeController: {prepare: vi.fn()},
        _hotkeyHelpController: {prepare: vi.fn().mockResolvedValue(void 0)},
        _displayGenerator: {prepare: vi.fn().mockResolvedValue(void 0)},
        _queryParser: {prepare: vi.fn(), on: vi.fn()},
        _history: {prepare: vi.fn(), on: vi.fn()},
        _optionToggleHotkeyHandler: {prepare: vi.fn()},
        _progressIndicatorVisible: {on: vi.fn()},
        _contentScrollElement: null,
        _closeButton: null,
        _navigationPreviousButton: null,
        _navigationNextButton: null,
        _pageType: 'popup',
        _contentType: 'clear',
        _dictionaryInfo: [],
        _dictionaryInfoRefreshGeneration: 0,
        _options: null,
        _application: {
            api: {
                getEnvironmentInfo: vi.fn().mockResolvedValue({browser: 'chrome', platform: {os: 'mac'}}),
                getLanguageSummaries: vi.fn().mockResolvedValue([]),
                getDictionaryInfo,
            },
            on: vi.fn((name, listener) => { listeners.set(name, listener); }),
            crossFrame: {registerHandlers: vi.fn()},
            webExtension: {unloaded: false},
        },
    });
    return {display, listeners};
}

describe('Display preparation during dictionary import', () => {
    test('initializes on a transported import-busy response and refreshes after publication', async () => {
        const busy = ExtensionError.deserialize(ExtensionError.serialize(createDictionaryImportBusyError('getDictionaryInfoOffscreen')));
        const getDictionaryInfo = vi.fn().mockRejectedValueOnce(busy).mockResolvedValue([{title: 'JMdict'}]);
        const {display, listeners} = createPreparingDisplay(getDictionaryInfo);
        try {
            await display.prepare();
            expect(display._dictionaryInfo).toEqual([]);
            expect(display._dictionaryInfoRefreshPending).toBe(true);
            expect(listeners.has('databaseUpdated')).toBe(true);
            listeners.get('databaseUpdated')?.({type: 'dictionary', cause: 'import'});
            await vi.waitFor(() => expect(display._dictionaryInfo).toEqual([{title: 'JMdict'}]));
            expect(display._dictionaryInfoRefreshPending).toBe(false);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    test('loads publication that occurs during earlier startup work', async () => {
        const languages = /** @type {PromiseWithResolvers<import('language').LanguageSummary[]>} */ (Promise.withResolvers());
        const getDictionaryInfo = vi.fn().mockResolvedValue([{title: 'Published during startup'}]);
        const {display, listeners} = createPreparingDisplay(getDictionaryInfo);
        const getLanguageSummaries = vi.fn().mockReturnValue(languages.promise);
        display._application.api.getLanguageSummaries = getLanguageSummaries;
        try {
            const preparation = display.prepare();
            await vi.waitFor(() => expect(getLanguageSummaries).toHaveBeenCalledOnce());
            listeners.get('databaseUpdated')?.({type: 'dictionary', cause: 'import'});
            languages.resolve([]);
            await preparation;
            expect(display._dictionaryInfo).toEqual([{title: 'Published during startup'}]);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    test('does not miss publication while initial metadata is still pending', async () => {
        const initial = Promise.withResolvers();
        const getDictionaryInfo = vi.fn().mockReturnValueOnce(initial.promise).mockResolvedValue([{title: 'New'}]);
        const {display, listeners} = createPreparingDisplay(getDictionaryInfo);
        try {
            const preparation = display.prepare();
            await vi.waitFor(() => expect(getDictionaryInfo).toHaveBeenCalledOnce());
            expect(listeners.has('databaseUpdated')).toBe(true);
            listeners.get('databaseUpdated')?.({type: 'dictionary', cause: 'import'});
            await vi.waitFor(() => expect(display._dictionaryInfo).toEqual([{title: 'New'}]));
            initial.resolve([{title: 'Old'}]);
            await preparation;
            expect(display._dictionaryInfo).toEqual([{title: 'New'}]);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    test.each([new Error('Corrupt dictionary metadata'), new Error('Cannot execute getDictionaryInfoOffscreen: dictionary import is in progress')])('propagates unclassified metadata errors: %s', async (error) => {
        const {display} = createPreparingDisplay(vi.fn().mockRejectedValue(error));
        try {
            await expect(display.prepare()).rejects.toBe(error);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
