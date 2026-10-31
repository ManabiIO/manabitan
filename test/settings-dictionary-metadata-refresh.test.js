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

import {afterEach, describe, expect, vi} from 'vitest';
import {createDictionaryImportBusyError} from '../ext/js/core/dictionary-import-busy-error.js';
import {EventDispatcher} from '../ext/js/core/event-dispatcher.js';
import {ExtensionError} from '../ext/js/core/extension-error.js';
import {log} from '../ext/js/core/log.js';
import {deferPromise} from '../ext/js/core/utilities.js';
import {CollapsibleDictionaryController} from '../ext/js/pages/settings/collapsible-dictionary-controller.js';
import {PopupFrequencyBlurController} from '../ext/js/pages/settings/popup-frequency-blur-controller.js';
import {SecondarySearchDictionaryController} from '../ext/js/pages/settings/secondary-search-dictionary-controller.js';
import {SortFrequencyDictionaryController} from '../ext/js/pages/settings/sort-frequency-dictionary-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();
const controllers = [SecondarySearchDictionaryController, CollapsibleDictionaryController, SortFrequencyDictionaryController, PopupFrequencyBlurController];

/** @returns {ExtensionError} */
function busyError() {
    // Exercise the real worker/API transport representation, including data.code.
    return ExtensionError.deserialize(JSON.parse(JSON.stringify(ExtensionError.serialize(createDictionaryImportBusyError('getDictionaryInfoOffscreen')))));
}

/**
 * @param {string} title
 * @returns {import('dictionary-importer').Summary[]}
 */
function dictionaryInfo(title) {
    return [{
        title,
        revision: '1',
        version: 3,
        sequenced: false,
        importDate: 0,
        prefixWildcardsSupported: false,
        styles: '',
        sourceLanguage: 'ja',
        counts: {terms: {total: 1}, kanji: {total: 0}, termMeta: {total: 1, freq: 1}, kanjiMeta: {total: 0}, tagMeta: {total: 0}, media: {total: 0}},
    }];
}

/**
 * @param {string} name
 * @returns {import('settings').ProfileOptions}
 */
function optionsFor(name) {
    return /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({
        general: {sortFrequencyDictionary: name, sortFrequencyDictionaryOrder: 'ascending', popupBlurByFrequencyDictionary: name},
        dictionaries: [{name, definitionsCollapsible: 'expanded', allowSecondarySearches: true}],
    }));
}

/**
 * @param {typeof controllers[number]} Controller
 * @param {import('jsdom').DOMWindow} window
 * @returns {{
 *     controller: InstanceType<typeof controllers[number]>,
 *     application: EventDispatcher<import('application').Events>,
 *     events: EventDispatcher<import('settings-controller').Events>,
 *     getDictionaryInfo: import('vitest').Mock<() => Promise<import('dictionary-importer').Summary[]>>,
 *     getOptions: import('vitest').Mock<() => Promise<import('settings').ProfileOptions>>,
 *     getOptionsContext: import('vitest').Mock<() => {index: number, profileId: string}>,
 *     container: HTMLElement,
 *     publish: () => boolean,
 * }}
 */
function createHarness(Controller, window) {
    window.document.body.innerHTML = `
        <div id="secondary-search-dictionary-list"></div><div id="collapsible-dictionary-list"></div>
        <select id="sort-frequency-dictionary"></select>
        <select id="sort-frequency-dictionary-order"><option value="ascending">Ascending</option><option value="descending">Descending</option></select>
        <button id="sort-frequency-dictionary-order-auto"></button><div id="sort-frequency-dictionary-order-container"></div>
        <select id="popup-frequency-blur-dictionary"></select>`;
    /** @type {EventDispatcher<import('application').Events>} */
    const application = new EventDispatcher();
    /** @type {EventDispatcher<import('settings-controller').Events>} */
    const events = new EventDispatcher();
    const getDictionaryInfo = vi.fn(async () => dictionaryInfo('Old'));
    const getOptions = vi.fn(async () => optionsFor('Old'));
    const getOptionsContext = vi.fn(() => ({index: 0, profileId: 'profile-a'}));
    const settings = {
        application,
        on: events.on.bind(events),
        getDictionaryInfo,
        getOptions,
        getOptionsContext,
        instantiateTemplate: () => {
            const node = window.document.createElement('div');
            node.innerHTML = '<span class="dictionary-title"></span><span class="dictionary-revision"></span><input class="dictionary-allow-secondary-searches"><select class="definitions-collapsible"><option value="expanded">Expanded</option></select>';
            return node;
        },
    };
    const controller = new Controller(/** @type {import('../ext/js/pages/settings/settings-controller.js').SettingsController} */ (/** @type {unknown} */ (settings)));
    let selector = '#popup-frequency-blur-dictionary';
    switch (Controller) {
        case SecondarySearchDictionaryController:
            selector = '#secondary-search-dictionary-list';
            break;
        case CollapsibleDictionaryController:
            selector = '#collapsible-dictionary-list';
            break;
        case SortFrequencyDictionaryController:
            selector = '#sort-frequency-dictionary';
            break;
    }
    const container = /** @type {HTMLElement|null} */ (window.document.querySelector(selector));
    if (container === null) { throw new Error('Missing controller container'); }
    const publish = () => application.trigger('databaseUpdated', {type: 'dictionary', cause: 'import'});
    return {controller, application, events, getDictionaryInfo, getOptions, getOptionsContext, container, publish};
}

afterEach(() => { vi.restoreAllMocks(); });

for (const Controller of controllers) {
    describe(`${Controller.name} metadata ownership`, () => {
        test('initial busy prepare subscribes and recovers on publication', async ({window}) => {
            const h = createHarness(Controller, window);
            h.getDictionaryInfo.mockRejectedValueOnce(busyError());
            await h.controller.prepare();
            expect(h.application.hasListeners('databaseUpdated')).toBe(true);
            expect(h.events.hasListeners('optionsChanged')).toBe(true);
            expect(h.getOptions).not.toHaveBeenCalled();
            expect(Reflect.get(h.controller, '_getDictionaryInfoToken')).toBeNull();
            h.publish();
            await vi.waitFor(() => { expect(h.container.textContent).toContain('Old'); });
            expect(h.getDictionaryInfo).toHaveBeenCalledTimes(2);
        });

        test('initial genuine metadata failure still rejects prepare', async ({window}) => {
            const h = createHarness(Controller, window);
            const failure = new Error(busyError().message);
            h.getDictionaryInfo.mockRejectedValueOnce(failure);
            await expect(h.controller.prepare()).rejects.toBe(failure);
            expect(Reflect.get(h.controller, '_getDictionaryInfoToken')).toBeNull();
        });

        test('busy event retains the rendered controls and metadata until a later publication', async ({window}) => {
            const h = createHarness(Controller, window);
            const logError = vi.spyOn(log, 'error').mockImplementation(() => {});
            await h.controller.prepare();
            const oldNodes = [...h.container.childNodes];
            const oldMap = Reflect.get(h.controller, '_dictionaryInfoMap');
            const oldSelection = 'value' in h.container ? h.container.value : null;
            h.getDictionaryInfo.mockRejectedValueOnce(busyError());
            h.publish();
            await vi.waitFor(() => { expect(Reflect.get(h.controller, '_getDictionaryInfoToken')).toBeNull(); });
            expect([...h.container.childNodes]).toStrictEqual(oldNodes);
            expect(Reflect.get(h.controller, '_dictionaryInfoMap')).toBe(oldMap);
            if ('value' in h.container) { expect(h.container.value).toBe(oldSelection); }
            expect(h.getOptions).toHaveBeenCalledOnce();
            expect(logError).not.toHaveBeenCalled();
            h.getDictionaryInfo.mockResolvedValue(dictionaryInfo('New'));
            h.getOptions.mockResolvedValue(optionsFor('New'));
            h.publish();
            await vi.waitFor(() => { expect(h.container.textContent).toContain('New'); });
            expect(h.container.textContent).not.toContain('Old');
            expect(Reflect.get(h.controller, '_getDictionaryInfoToken')).toBeNull();
            expect(h.getDictionaryInfo).toHaveBeenCalledTimes(3);
        });

        test('a late busy response releases only its own token', async ({window}) => {
            const h = createHarness(Controller, window);
            await h.controller.prepare();
            const previousRead = /** @type {import('core').DeferredPromiseDetails<import('dictionary-importer').Summary[]>} */ (deferPromise());
            const currentRead = /** @type {import('core').DeferredPromiseDetails<import('dictionary-importer').Summary[]>} */ (deferPromise());
            h.getDictionaryInfo.mockReturnValueOnce(previousRead.promise).mockReturnValueOnce(currentRead.promise);
            const previous = h.controller._onDatabaseUpdated();
            const current = h.controller._onDatabaseUpdated();
            const currentToken = Reflect.get(h.controller, '_getDictionaryInfoToken');
            previousRead.reject(busyError());
            await previous;
            expect(Reflect.get(h.controller, '_getDictionaryInfoToken')).toBe(currentToken);
            expect(h.container.textContent).toContain('Old');
            h.getOptions.mockResolvedValue(optionsFor('New'));
            currentRead.resolve(dictionaryInfo('New'));
            await current;
            expect(h.container.textContent).toContain('New');
            expect(Reflect.get(h.controller, '_getDictionaryInfoToken')).toBeNull();
        });

        test('publication during initial prepare supersedes its delayed metadata read', async ({window}) => {
            const h = createHarness(Controller, window);
            const oldRead = /** @type {import('core').DeferredPromiseDetails<import('dictionary-importer').Summary[]>} */ (deferPromise());
            h.getDictionaryInfo.mockReturnValueOnce(oldRead.promise).mockResolvedValue(dictionaryInfo('New'));
            h.getOptions.mockResolvedValue(optionsFor('New'));
            const preparing = h.controller.prepare();
            h.publish();
            oldRead.resolve(dictionaryInfo('Old'));
            await preparing;
            await vi.waitFor(() => { expect(h.container.textContent).toContain('New'); });
            expect(h.container.textContent).not.toContain('Old');
        });

        test('a stale options response cannot overwrite a newer metadata refresh', async ({window}) => {
            const h = createHarness(Controller, window);
            await h.controller.prepare();
            const oldOptions = /** @type {import('core').DeferredPromiseDetails<import('settings').ProfileOptions>} */ (deferPromise());
            h.getOptions.mockReturnValueOnce(oldOptions.promise).mockResolvedValue(optionsFor('New'));
            const previous = h.controller._onDatabaseUpdated();
            await vi.waitFor(() => { expect(h.getOptions).toHaveBeenCalledTimes(2); });
            h.getDictionaryInfo.mockResolvedValue(dictionaryInfo('New'));
            await h.controller._onDatabaseUpdated();
            oldOptions.resolve(optionsFor('Old'));
            await previous;
            expect(h.container.textContent).toContain('New');
            expect(h.container.textContent).not.toContain('Old');
            if ('value' in h.container) { expect(h.container.value).toBe('New'); }
        });

        test('a delayed metadata read renders the current profile after a switch', async ({window}) => {
            const h = createHarness(Controller, window);
            await h.controller.prepare();
            const metadata = /** @type {import('core').DeferredPromiseDetails<import('dictionary-importer').Summary[]>} */ (deferPromise());
            h.getDictionaryInfo.mockReturnValueOnce(metadata.promise);
            const pending = h.controller._onDatabaseUpdated();
            // Metadata is global; the later options read must belong to this profile.
            h.getOptionsContext.mockReturnValue({index: 0, profileId: 'profile-b'});
            h.getOptions.mockResolvedValue(optionsFor('New'));
            h.events.trigger('optionsChanged', {options: optionsFor('New'), optionsContext: h.getOptionsContext()});
            metadata.resolve([...dictionaryInfo('Old'), ...dictionaryInfo('New')]);
            await pending;
            expect(h.container.textContent).toContain('New');
            if ('value' in h.container) { expect(h.container.value).toBe('New'); }
            expect(Reflect.get(h.controller, '_getDictionaryInfoToken')).toBeNull();
        });

        test('a pending options response cannot replace a newer profile at the same index', async ({window}) => {
            const h = createHarness(Controller, window);
            await h.controller.prepare();
            h.getDictionaryInfo.mockResolvedValue([...dictionaryInfo('Old'), ...dictionaryInfo('New')]);
            const options = /** @type {import('core').DeferredPromiseDetails<import('settings').ProfileOptions>} */ (deferPromise());
            h.getOptions.mockReturnValueOnce(options.promise);
            const pending = h.controller._onDatabaseUpdated();
            await vi.waitFor(() => { expect(h.getOptions).toHaveBeenCalledTimes(2); });
            h.getOptionsContext.mockReturnValue({index: 0, profileId: 'profile-b'});
            h.events.trigger('optionsChanged', {options: optionsFor('New'), optionsContext: h.getOptionsContext()});
            const profileNodes = [...h.container.childNodes];
            options.resolve(optionsFor('Old'));
            await pending;
            expect([...h.container.childNodes]).toStrictEqual(profileNodes);
            expect(h.container.textContent).toContain('New');
            if ('value' in h.container) { expect(h.container.value).toBe('New'); }
            expect(Reflect.get(h.controller, '_getDictionaryInfoToken')).toBeNull();
        });

        test('a newer same-profile options event wins over a pending options read', async ({window}) => {
            const h = createHarness(Controller, window);
            await h.controller.prepare();
            const options = /** @type {import('core').DeferredPromiseDetails<import('settings').ProfileOptions>} */ (deferPromise());
            h.getDictionaryInfo.mockResolvedValue([...dictionaryInfo('Old'), ...dictionaryInfo('New')]);
            h.getOptions.mockReturnValueOnce(options.promise);
            const pending = h.controller._onDatabaseUpdated();
            await vi.waitFor(() => { expect(h.getOptions).toHaveBeenCalledTimes(2); });
            h.events.trigger('optionsChanged', {options: optionsFor('New'), optionsContext: h.getOptionsContext()});
            const currentNodes = [...h.container.childNodes];
            options.resolve(optionsFor('Old'));
            await pending;
            expect([...h.container.childNodes]).toStrictEqual(currentNodes);
            expect(h.container.textContent).toContain('New');
            if ('value' in h.container) { expect(h.container.value).toBe('New'); }
        });

        for (const kind of ['plain-message', 'serialized-plain-message', 'unknown-code', 'corrupt-metadata']) {
            test(`reports ${kind} failures from events and propagates direct failure`, async ({window}) => {
                const h = createHarness(Controller, window);
                let error = kind === 'unknown-code' ? new ExtensionError('Unknown metadata failure') : new Error(busyError().message);
                if (kind === 'serialized-plain-message') { error = ExtensionError.deserialize(ExtensionError.serialize(error)); }
                if (kind === 'unknown-code' && error instanceof ExtensionError) { error.data = {code: 'UNKNOWN_METADATA_FAILURE'}; }
                const fail = () => {
                    if (kind === 'corrupt-metadata') {
                        h.getDictionaryInfo.mockResolvedValueOnce(/** @type {import('dictionary-importer').Summary[]} */ (/** @type {unknown} */ (null)));
                    } else {
                        h.getDictionaryInfo.mockRejectedValueOnce(error);
                    }
                };
                await h.controller.prepare();
                const logError = vi.spyOn(log, 'error').mockImplementation(() => {});
                fail();
                h.publish();
                await vi.waitFor(() => { expect(logError).toHaveBeenCalledOnce(); });
                if (kind !== 'corrupt-metadata') { expect(logError).toHaveBeenCalledWith(error); }
                expect(Reflect.get(h.controller, '_getDictionaryInfoToken')).toBeNull();
                fail();
                await expect(h.controller._onDatabaseUpdated()).rejects.toThrow();
            });
        }
    });
}
