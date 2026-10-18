/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {deferPromise} from '../ext/js/core/utilities.js';
import {DictionaryController} from '../ext/js/pages/settings/dictionary-controller.js';
import {SecondarySearchDictionaryController} from '../ext/js/pages/settings/secondary-search-dictionary-controller.js';
import {SortFrequencyDictionaryController} from '../ext/js/pages/settings/sort-frequency-dictionary-controller.js';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

/** @returns {import('settings').ProfileOptions} */
function optionsFixture() {
    return /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({
        dictionaries: [],
        general: {sortFrequencyDictionary: null, sortFrequencyDictionaryOrder: 'ascending'},
    }));
}

describe('dictionary settings option snapshot ownership', () => {
    test('reorder during database refresh does not cancel the render while dictionaries are unavailable', async () => {
        const deferred = /** @type {import('core').DeferredPromiseDetails<import('dictionary-importer').Summary[]>} */ (deferPromise());
        const dictionary = /** @type {import('dictionary-importer').Summary} */ ({title: 'Dictionary'});
        const controller = /** @type {DictionaryController} */ (Object.create(DictionaryController.prototype));
        const createEntry = vi.fn();
        const options = /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({...optionsFixture(), dictionaries: [{name: 'Dictionary'}]}));
        Reflect.set(controller, '_settingsController', {
            getOptionsContext: () => ({index: 0, profileId: 'profile-a'}),
            getDictionaryInfo: () => deferred.promise,
            getOptions: async () => options,
        });
        Reflect.set(controller, '_dictionaries', null);
        Reflect.set(controller, '_dictionaryEntries', []);
        Reflect.set(controller, '_dictionaryModalBody', {scrollTop: 0, scroll: vi.fn()});
        Reflect.set(controller, '_updateMainDictionarySelectOptions', vi.fn());
        Reflect.set(controller, '_updateDictionaryEntryCount', vi.fn());
        Reflect.set(controller, '_dictionaryInstallCountNode', null);
        Reflect.set(controller, '_noDictionariesInstalledWarnings', []);
        Reflect.set(controller, '_noDictionariesEnabledWarnings', []);
        Reflect.set(controller, '_updateDictionariesEnabledWarnings', vi.fn());
        Reflect.set(controller, '_createDictionaryEntry', createEntry);
        const ensureSettings = vi.spyOn(DictionaryController, 'ensureDictionarySettings').mockResolvedValue();
        const refresh = controller._onDatabaseUpdated();
        await vi.waitFor(() => { expect(Reflect.get(controller, '_databaseStateToken')).not.toBeNull(); });

        controller._updateCurrentEntries(options);
        deferred.resolve([dictionary]);
        await refresh;

        expect(ensureSettings).toHaveBeenCalledOnce();
        expect(createEntry).toHaveBeenCalledOnce();
        expect(createEntry).toHaveBeenCalledWith(0, 'profile-a', {name: 'Dictionary'}, dictionary, null, null);
    });

    test('reorder with cached dictionaries still supersedes a pending options render', async () => {
        const deferred = /** @type {import('core').DeferredPromiseDetails<import('settings').ProfileOptions>} */ (deferPromise());
        const dictionary = /** @type {import('dictionary-importer').Summary} */ ({title: 'Dictionary'});
        const controller = /** @type {DictionaryController} */ (Object.create(DictionaryController.prototype));
        const createEntry = vi.fn();
        Reflect.set(controller, '_settingsController', {getOptions: () => deferred.promise, getOptionsContext: () => ({index: 0, profileId: 'profile-a'})});
        Reflect.set(controller, '_dictionaries', [dictionary]);
        Reflect.set(controller, '_dictionaryEntries', []);
        Reflect.set(controller, '_updateMainDictionarySelectOptions', vi.fn());
        Reflect.set(controller, '_updateDictionaryEntryCount', vi.fn());
        Reflect.set(controller, '_dictionaryInstallCountNode', null);
        Reflect.set(controller, '_noDictionariesInstalledWarnings', []);
        Reflect.set(controller, '_noDictionariesEnabledWarnings', []);
        Reflect.set(controller, '_updateDictionariesEnabledWarnings', vi.fn());
        Reflect.set(controller, '_createDictionaryEntry', createEntry);
        Reflect.set(controller, '_dictionaryModalBody', {scrollTop: 0, scroll: vi.fn()});

        const pendingRefresh = controller._refreshEntriesAfterOptionsChanged();
        await vi.waitFor(() => { expect(Reflect.get(controller, '_entriesUpdateToken')).not.toBeNull(); });
        const options = /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({...optionsFixture(), dictionaries: [{name: 'Dictionary'}]}));
        controller._updateCurrentEntries(options);
        deferred.resolve(optionsFixture());
        await pendingRefresh;

        expect(createEntry).toHaveBeenCalledOnce();
    });

    test('secondary-search panel cannot render an older response after a new settings refresh', async () => {
        const earlier = /** @type {import('core').DeferredPromiseDetails<import('settings').ProfileOptions>} */ (deferPromise());
        const latest = /** @type {import('core').DeferredPromiseDetails<import('settings').ProfileOptions>} */ (deferPromise());
        const getOptions = vi.fn().mockReturnValueOnce(earlier.promise).mockReturnValueOnce(latest.promise);
        const render = vi.fn();
        const controller = /** @type {SecondarySearchDictionaryController} */ (Object.create(SecondarySearchDictionaryController.prototype));
        Reflect.set(controller, '_settingsController', {getOptions, getOptionsContext: () => ({index: 0})});
        Reflect.set(controller, '_optionsRenderRequest', 0);
        Reflect.set(controller, '_getDictionaryInfoToken', null);
        Reflect.set(controller, '_onOptionsChanged', render);
        const first = controller._onDictionarySettingsReordered();
        const second = controller._onDictionarySettingsReordered();
        const fresh = optionsFixture();
        const stale = optionsFixture();
        latest.resolve(fresh);
        await second;
        earlier.resolve(stale);
        await first;
        expect(render).toHaveBeenCalledExactlyOnceWith({options: fresh, optionsContext: {index: 0}});
    });

    test('secondary-search options event supersedes a pending settings request', async () => {
        vi.stubGlobal('document', {createDocumentFragment: vi.fn(() => ({}))});
        const deferred = /** @type {import('core').DeferredPromiseDetails<import('settings').ProfileOptions>} */ (deferPromise());
        const controller = /** @type {SecondarySearchDictionaryController} */ (Object.create(SecondarySearchDictionaryController.prototype));
        const append = vi.fn();
        Reflect.set(controller, '_settingsController', {getOptions: () => deferred.promise, getOptionsContext: () => ({index: 0})});
        Reflect.set(controller, '_getDictionaryInfoToken', null);
        Reflect.set(controller, '_optionsRenderRequest', 0);
        Reflect.set(controller, '_dictionaryInfoMap', new Map());
        Reflect.set(controller, '_eventListeners', {removeAllEventListeners: vi.fn()});
        Reflect.set(controller, '_container', {textContent: '', appendChild: append});
        const pending = controller._onDictionarySettingsReordered();
        const newer = optionsFixture();
        controller._onOptionsChanged({options: newer, optionsContext: {index: 0}});
        deferred.resolve(optionsFixture());
        await pending;
        expect(append).toHaveBeenCalledOnce();
    });

    test('frequency sorting panel cannot reset newer options after a delayed database refresh', async () => {
        const deferred = /** @type {import('core').DeferredPromiseDetails<import('settings').ProfileOptions>} */ (deferPromise());
        const getOptions = vi.fn(() => deferred.promise);
        const controller = /** @type {SortFrequencyDictionaryController} */ (Object.create(SortFrequencyDictionaryController.prototype));
        const dictionarySelect = {value: ''};
        const orderSelect = {value: ''};
        const container = {hidden: false};
        Reflect.set(controller, '_settingsController', {
            getDictionaryInfo: vi.fn().mockResolvedValue([]),
            getOptions,
            getOptionsContext: () => ({index: 0}),
        });
        Reflect.set(controller, '_getDictionaryInfoToken', null);
        Reflect.set(controller, '_optionsRenderRequest', 0);
        Reflect.set(controller, '_updateDictionaryOptions', vi.fn());
        Reflect.set(controller, '_sortFrequencyDictionarySelect', dictionarySelect);
        Reflect.set(controller, '_sortFrequencyDictionaryOrderSelect', orderSelect);
        Reflect.set(controller, '_sortFrequencyDictionaryOrderContainerNode', container);
        const pending = controller._onDatabaseUpdated();
        await vi.waitFor(() => { expect(getOptions).toHaveBeenCalledOnce(); });
        const newer = {...optionsFixture(), general: {...optionsFixture().general, sortFrequencyDictionary: 'Latest'}};
        controller._onOptionsChanged({options: newer, optionsContext: {index: 0}});
        deferred.resolve(optionsFixture());
        await pending;
        expect(dictionarySelect.value).toBe('Latest');
        expect(orderSelect.value).toBe('ascending');
        expect(container.hidden).toBe(false);
    });
});
