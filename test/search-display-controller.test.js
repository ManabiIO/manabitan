/*
 * Copyright (C) 2023-2026  Yomitan Authors
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

import {afterAll, afterEach, describe, expect, test, vi} from 'vitest';
import {Application} from '../ext/js/application.js';
import {API} from '../ext/js/comm/api.js';
import {CrossFrameAPI} from '../ext/js/comm/cross-frame-api.js';
import {DisplayAudio} from '../ext/js/display/display-audio.js';
import {Display} from '../ext/js/display/display.js';
import {SearchDisplayController} from '../ext/js/display/search-display-controller.js';
import {SearchPersistentStateController} from '../ext/js/display/search-persistent-state-controller.js';
import {DocumentFocusController} from '../ext/js/dom/document-focus-controller.js';
import {querySelectorNotNull} from '../ext/js/dom/query-selector.js';
import {WebExtension} from '../ext/js/extension/web-extension.js';
import {HotkeyHandler} from '../ext/js/input/hotkey-handler.js';
import {setupDomTest} from './fixtures/dom-test.js';

const documentSearchDisplayControllerEnv = await setupDomTest('ext/search.html');

const {window, teardown} = documentSearchDisplayControllerEnv;

const {document} = window;

const frameId = 1;
const tabId = 1;
const webExtension = new WebExtension();
const hotkeyHandler = new HotkeyHandler();
const documentFocusController = new DocumentFocusController();
const displayPageType = 'search';
const api = new API(webExtension);
const crossFrameAPI = new CrossFrameAPI(api, tabId, frameId);
const application = new Application(api, crossFrameAPI);
const display = new Display(application, displayPageType, documentFocusController, hotkeyHandler);
const displayAudio = new DisplayAudio(display);
const searchPersistentStateController = new SearchPersistentStateController();

const searchDisplayController = new SearchDisplayController(display, displayAudio, searchPersistentStateController);


const onKeyDownMethod = searchDisplayController._onKeyDown.bind(searchDisplayController);

const onSearchMethod = searchDisplayController._onSearch.bind(searchDisplayController);

const onSearchKeydownMethod = searchDisplayController._onSearchKeydown.bind(searchDisplayController);

/**
 * @type {HTMLInputElement}
 */
const queryInput = querySelectorNotNull(document, '#search-textbox');

const focusSpy = vi.spyOn(queryInput, 'focus');

describe('Keyboard Event Handling', () => {
    afterAll(() => teardown(global));
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    const validKeypressEvents = [
        new KeyboardEvent('keydown', {key: 'a', ctrlKey: false, metaKey: false, altKey: false}),
        new KeyboardEvent('keydown', {key: 'Backspace'}),
        new KeyboardEvent('keydown', {key: 'Backspace', ctrlKey: true, metaKey: false, altKey: false}),
    ];

    const invalidKeypressEvents = [
        new KeyboardEvent('keydown', {key: '', ctrlKey: true, metaKey: false, altKey: false}),
        new KeyboardEvent('keydown', {key: '', ctrlKey: false, metaKey: true, altKey: false}),
        new KeyboardEvent('keydown', {key: '', ctrlKey: false, metaKey: false, altKey: true}),
        new KeyboardEvent('keydown', {key: ' ', ctrlKey: false, metaKey: false, altKey: false}),
        new KeyboardEvent('keydown', {key: 'a', ctrlKey: true, metaKey: false, altKey: false}),
        new KeyboardEvent('keydown', {key: 'a', ctrlKey: false, metaKey: true, altKey: false}),
        new KeyboardEvent('keydown', {key: 'a', ctrlKey: false, metaKey: false, altKey: true}),
        new KeyboardEvent('keydown', {key: 'Backspace', ctrlKey: false, metaKey: true, altKey: false}),
        new KeyboardEvent('keydown', {key: 'Backspace', ctrlKey: false, metaKey: false, altKey: true}),
        new KeyboardEvent('keydown', {key: 'ArrowDown'}),
    ];

    test('should test that onKeyDown function focuses input for valid keys', () => {
        for (const event of validKeypressEvents) {
            queryInput.blur();
            onKeyDownMethod(event);
        }

        expect(focusSpy.mock.calls.length).toBe(validKeypressEvents.length);
        focusSpy.mockReset();
    });


    test('should test that onKeyDown function does not focus input for invalid keys', () => {
        for (const event of invalidKeypressEvents) {
            queryInput.blur();
            onKeyDownMethod(event);
        }

        expect(focusSpy.mock.calls.length).toBe(0);
    });

    test('search button click dispatches search', () => {
        const searchSpy = vi.spyOn(searchDisplayController, '_search').mockImplementation(() => {});
        const preventDefault = vi.fn();
        const event = /** @type {MouseEvent} */ (/** @type {unknown} */ ({
            preventDefault,
        }));
        onSearchMethod(event);
        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(searchSpy).toHaveBeenCalledTimes(1);
        expect(searchSpy).toHaveBeenCalledWith(true, 'new', true, null);
        searchSpy.mockRestore();
    });

    test('enter keydown dispatches search and prevents default behavior', () => {
        const searchSpy = vi.spyOn(searchDisplayController, '_search').mockImplementation(() => {});
        const clearRealtimeSearchTimerSpy = vi.spyOn(searchDisplayController, '_clearRealtimeSearchTimer').mockImplementation(() => {});
        const blurSpy = vi.spyOn(display, 'blurElement').mockImplementation(() => {});
        const preventDefault = vi.fn();
        const stopImmediatePropagation = vi.fn();
        const event = /** @type {KeyboardEvent} */ (/** @type {unknown} */ ({
            isComposing: false,
            keyCode: 13,
            code: 'Enter',
            key: 'Enter',
            shiftKey: false,
            currentTarget: queryInput,
            preventDefault,
            stopImmediatePropagation,
        }));
        onSearchKeydownMethod(event);
        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(stopImmediatePropagation).toHaveBeenCalledTimes(1);
        expect(clearRealtimeSearchTimerSpy).toHaveBeenCalledTimes(1);
        expect(blurSpy).toHaveBeenCalledTimes(1);
        expect(searchSpy).toHaveBeenCalledTimes(1);
        expect(searchSpy).toHaveBeenCalledWith(true, 'new', true, null);
        blurSpy.mockRestore();
        searchSpy.mockRestore();
        clearRealtimeSearchTimerSpy.mockRestore();
    });

    test('typing dispatches realtime search after debounce using overwrite history', async () => {
        vi.useFakeTimers();
        const searchSpy = vi.spyOn(searchDisplayController, '_search').mockImplementation(() => {});
        queryInput.value = '食う';

        searchDisplayController._onSearchInput(new InputEvent('input', {data: 'う'}));
        expect(searchSpy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(149);
        expect(searchSpy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(searchSpy).toHaveBeenCalledTimes(1);
        expect(searchSpy).toHaveBeenCalledWith(false, 'overwrite', true, null);
    });

    test('typing clears search results when the textbox becomes blank', async () => {
        vi.useFakeTimers();
        const clearSearchResultsSpy = vi.spyOn(searchDisplayController, '_clearSearchResults').mockImplementation(() => {});
        queryInput.value = '   ';

        searchDisplayController._onSearchInput(new InputEvent('input'));
        await vi.runAllTimersAsync();

        expect(clearSearchResultsSpy).toHaveBeenCalledTimes(1);
        expect(clearSearchResultsSpy).toHaveBeenCalledWith('overwrite');
    });

    test('composing input does not dispatch realtime search', async () => {
        vi.useFakeTimers();
        const searchSpy = vi.spyOn(searchDisplayController, '_search').mockImplementation(() => {});
        queryInput.value = 'よ';

        searchDisplayController._onSearchInput(new InputEvent('input', {isComposing: true}));
        await vi.runAllTimersAsync();

        expect(searchSpy).not.toHaveBeenCalled();
    });

    test('dictionary database updates refresh options and rerun the active display search', async () => {
        const updateOptionsSpy = vi.spyOn(display, 'updateOptions').mockResolvedValue(void 0);
        const searchLastSpy = vi.spyOn(display, 'searchLast').mockImplementation(() => {});
        queryInput.value = '暗記';

        await searchDisplayController._onDatabaseUpdated({type: 'dictionary', cause: 'import'});

        expect(updateOptionsSpy).toHaveBeenCalledTimes(1);
        expect(searchLastSpy).toHaveBeenCalledTimes(1);
        expect(searchLastSpy).toHaveBeenCalledWith(false);
    });

    test('search requests disable wildcards when the search-page wildcard setting is off', () => {
        vi.spyOn(display, 'getOptions').mockReturnValue({
            scanning: {
                matchTypePrefix: false,
            },
        });
        const setContentSpy = vi.spyOn(display, 'setContent').mockImplementation(() => {});
        queryInput.value = '読み';

        searchDisplayController._search(false, 'overwrite', true, null);

        expect(setContentSpy).toHaveBeenCalledTimes(1);
        expect(setContentSpy.mock.calls[0][0].params.wildcards).toBe('off');
    });

    test('search requests keep wildcards enabled when the search-page wildcard setting is on', () => {
        vi.spyOn(display, 'getOptions').mockReturnValue({
            scanning: {
                matchTypePrefix: true,
            },
        });
        const setContentSpy = vi.spyOn(display, 'setContent').mockImplementation(() => {});
        queryInput.value = '読み';

        searchDisplayController._search(false, 'overwrite', true, null);

        expect(setContentSpy).toHaveBeenCalledTimes(1);
        expect(setContentSpy.mock.calls[0][0].params.wildcards).toBeUndefined();
    });

    test('options updates rerun visible results even if the textbox has been cleared locally', async () => {
        const updateOptionsSpy = vi.spyOn(display, 'updateOptions').mockResolvedValue(void 0);
        const searchLastSpy = vi.spyOn(display, 'searchLast').mockImplementation(() => {});
        Reflect.set(display, '_contentType', 'terms');
        queryInput.value = '';

        await searchDisplayController._refreshAfterOptionsUpdate();

        expect(updateOptionsSpy).toHaveBeenCalledTimes(1);
        expect(searchLastSpy).toHaveBeenCalledTimes(1);
        expect(searchLastSpy).toHaveBeenCalledWith(false);
    });

    test('options updates do not invent a rerun when no search results are currently shown', async () => {
        const updateOptionsSpy = vi.spyOn(display, 'updateOptions').mockResolvedValue(void 0);
        const searchLastSpy = vi.spyOn(display, 'searchLast').mockImplementation(() => {});
        Reflect.set(display, '_contentType', 'clear');
        queryInput.value = 'unsent query';

        await searchDisplayController._refreshAfterOptionsUpdate();

        expect(updateOptionsSpy).toHaveBeenCalledTimes(1);
        expect(searchLastSpy).not.toHaveBeenCalled();
    });

    test('options updates do not touch the dedicated search page while it is showing unloaded state', async () => {
        const updateOptionsSpy = vi.spyOn(display, 'updateOptions').mockResolvedValue(void 0);
        const searchLastSpy = vi.spyOn(display, 'searchLast').mockImplementation(() => {});
        Reflect.set(display, '_contentType', 'unloaded');

        await searchDisplayController._refreshAfterOptionsUpdate();

        expect(updateOptionsSpy).not.toHaveBeenCalled();
        expect(searchLastSpy).not.toHaveBeenCalled();
    });

    test('options update refresh failures are logged instead of escaping', async () => {
        const updateOptionsSpy = vi.spyOn(display, 'updateOptions').mockRejectedValue(new Error('refresh failed'));
        const searchLastSpy = vi.spyOn(display, 'searchLast').mockImplementation(() => {});
        const logErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        Reflect.set(display, '_contentType', 'terms');

        searchDisplayController._onOptionsUpdated();
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(updateOptionsSpy).toHaveBeenCalledTimes(1);
        expect(searchLastSpy).not.toHaveBeenCalled();
        expect(logErrorSpy).toHaveBeenCalled();
    });

    test('dictionary database update refresh failures are logged instead of escaping', async () => {
        const updateOptionsSpy = vi.spyOn(display, 'updateOptions').mockRejectedValue(new Error('refresh failed'));
        const searchLastSpy = vi.spyOn(display, 'searchLast').mockImplementation(() => {});
        const logErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        searchDisplayController._onDatabaseUpdated({type: 'dictionary', cause: 'import'});
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(updateOptionsSpy).toHaveBeenCalledTimes(1);
        expect(searchLastSpy).not.toHaveBeenCalled();
        expect(logErrorSpy).toHaveBeenCalled();
    });

    test('failed search-page profile selection refreshes the persisted selection and logs the error', async () => {
        const updateProfileSelectSpy = vi.spyOn(searchDisplayController, '_updateProfileSelect').mockResolvedValue(void 0);
        const setDefaultProfileIndexSpy = vi.spyOn(searchDisplayController, '_setDefaultProfileIndex').mockRejectedValue(new Error('profile save failed'));
        const logErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(display.application.api, 'optionsGetFull').mockResolvedValue({
            profileCurrent: 0,
            profiles: [{name: 'Default'}, {name: 'Mining'}],
        });

        searchDisplayController._onProfileSelectChangeEvent(/** @type {Event} */ (/** @type {unknown} */ ({
            currentTarget: {value: '1'},
        })));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(setDefaultProfileIndexSpy).toHaveBeenCalledWith(1);
        expect(updateProfileSelectSpy).toHaveBeenCalledOnce();
        expect(logErrorSpy).toHaveBeenCalled();
    });

    test('search-page profile selection ignores out-of-range indices', async () => {
        const setDefaultProfileIndexSpy = vi.spyOn(searchDisplayController, '_setDefaultProfileIndex').mockResolvedValue(void 0);
        vi.spyOn(display.application.api, 'optionsGetFull').mockResolvedValue({
            profileCurrent: 0,
            profiles: [{name: 'Default'}, {name: 'Mining'}],
        });

        await searchDisplayController._onProfileSelectChange(/** @type {Event} */ (/** @type {unknown} */ ({
            currentTarget: {value: '2'},
        })));

        expect(setDefaultProfileIndexSpy).not.toHaveBeenCalled();
    });

    test('stale search-page profile-select refresh does not overwrite newer options', async () => {
        let resolveFirst;
        let resolveSecond;
        Reflect.set(searchDisplayController, '_profileSelectRefreshGeneration', 0);
        vi.spyOn(display.application.api, 'optionsGetFull')
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveFirst = resolve;
            }))
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveSecond = resolve;
            }));

        const firstRefresh = searchDisplayController._updateProfileSelect();
        const secondRefresh = searchDisplayController._updateProfileSelect();
        resolveSecond({
            profileCurrent: 1,
            profiles: [{name: 'Default'}, {name: 'Mining'}],
        });
        await secondRefresh;
        resolveFirst({
            profileCurrent: 0,
            profiles: [{name: 'Default'}, {name: 'Mining'}],
        });
        await firstRefresh;

        expect(searchDisplayController._profileSelect.value).toBe('1');
    });
});
