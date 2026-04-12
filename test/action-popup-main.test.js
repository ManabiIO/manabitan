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

import {afterAll, beforeEach, describe, expect, test, vi} from 'vitest';
import {DisplayController} from '../ext/js/pages/action-popup-controller.js';
import {setupDomTest} from './fixtures/dom-test.js';
import {log} from '../ext/js/core/log.js';

const {window, teardown} = await setupDomTest('ext/action-popup.html');

describe('action popup live refresh handling', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    test('options refresh does not duplicate toggle listeners', async () => {
        const commandExec = vi.fn().mockResolvedValue(void 0);
        const controller = new DisplayController(/** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({
            api: {
                commandExec,
            },
        })));
        vi.spyOn(controller, '_updatePermissionsWarnings').mockResolvedValue(void 0);
        vi.spyOn(controller, '_updateDictionariesEnabledWarnings').mockResolvedValue(void 0);
        Reflect.set(controller, '_optionsFull', {
            profileCurrent: 0,
            profiles: [
                {options: {scanning: {inputs: [{include: 'ctrl'}]}}},
            ],
        });
        const {document} = window;
        const toggle = /** @type {HTMLInputElement} */ (document.querySelector('.enable-search'));

        controller._setupOptions({
            options: {
                general: {enable: true, popupTheme: 'default', popupThemePreset: 'default'},
                dictionaries: [],
            },
        });
        controller._setupOptions({
            options: {
                general: {enable: true, popupTheme: 'default', popupThemePreset: 'default'},
                dictionaries: [],
            },
        });

        toggle.dispatchEvent(new window.Event('change'));

        expect(commandExec).toHaveBeenCalledTimes(1);
    });

    test('dictionary database updates refresh dictionary warning state for the current profile', async () => {
        const updateDictionariesEnabledWarnings = vi.fn().mockResolvedValue(void 0);
        const controller = new DisplayController(/** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({
            api: {},
        })));
        Reflect.set(controller, '_updateDictionariesEnabledWarnings', updateDictionariesEnabledWarnings);
        Reflect.set(controller, '_optionsFull', {
            profileCurrent: 0,
            profiles: [
                {options: {general: {}, dictionaries: [{name: 'JMdict', enabled: true}]}},
            ],
        });

        controller._onDatabaseUpdated({type: 'dictionary'});
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(updateDictionariesEnabledWarnings).toHaveBeenCalledWith({
            general: {},
            dictionaries: [{name: 'JMdict', enabled: true}],
        }, 0);
    });

    test('stale dictionary warning refresh does not overwrite newer profile state', async () => {
        const dictionariesDeferred = Promise.withResolvers();
        const controller = new DisplayController(/** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({
            api: {
                getDictionaryInfo: vi.fn(() => dictionariesDeferred.promise),
            },
        })));
        const restoreDefaultTooltips = vi.spyOn(controller, '_updateDisplayModifierKey').mockImplementation(() => {});
        vi.spyOn(controller, '_updatePermissionsWarnings').mockResolvedValue(void 0);
        const {document} = window;
        document.body.innerHTML = '<p class="tooltip">Hover over text to scan</p>';

        controller._setupOptions({
            options: {
                general: {enable: true, popupTheme: 'default', popupThemePreset: 'default'},
                dictionaries: [{name: 'JMdict', enabled: false}],
            },
        });
        controller._setupOptions({
            options: {
                general: {enable: true, popupTheme: 'default', popupThemePreset: 'default'},
                dictionaries: [{name: 'JMdict', enabled: true}],
            },
        });
        dictionariesDeferred.resolve([{title: 'JMdict'}]);
        await dictionariesDeferred.promise;
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(document.querySelector('.tooltip')?.textContent).toBe('Hover over text to scan');
        expect(document.querySelector('.tooltip')?.classList.contains('enable-dictionary-tooltip')).toBe(false);
        expect(restoreDefaultTooltips).toHaveBeenCalled();
    });

    test('options refresh failures are logged instead of escaping', async () => {
        const controller = new DisplayController(/** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({
            api: {},
        })));
        const error = new Error('refresh failed');
        vi.spyOn(controller, '_refreshOptionsState').mockRejectedValue(error);
        const logSpy = vi.spyOn(log, 'error').mockImplementation(() => {});

        controller._onOptionsUpdated({});
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(logSpy).toHaveBeenCalledWith(error);
    });

    test('dictionary update refresh failures are logged instead of escaping', async () => {
        const controller = new DisplayController(/** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({
            api: {},
        })));
        const error = new Error('dictionary warning failed');
        vi.spyOn(controller, '_updateDictionariesEnabledWarnings').mockRejectedValue(error);
        const logSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
        Reflect.set(controller, '_optionsFull', {
            profileCurrent: 0,
            profiles: [
                {options: {general: {}, dictionaries: []}},
            ],
        });

        controller._onDatabaseUpdated({type: 'dictionary'});
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(logSpy).toHaveBeenCalledWith(error);
    });

    test('failed profile selection rolls action popup state back to persisted options', async () => {
        const controller = new DisplayController(/** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({
            api: {},
        })));
        const setupOptions = vi.spyOn(controller, '_setupOptions').mockImplementation(() => {});
        const refreshOptionsState = vi.spyOn(controller, '_refreshOptionsState').mockResolvedValue(void 0);
        const error = new Error('profile save failed');
        vi.spyOn(controller, '_setDefaultProfileIndex').mockRejectedValue(error);
        const logSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
        Reflect.set(controller, '_optionsFull', {
            profileCurrent: 0,
            profiles: [
                {options: {general: {}, dictionaries: []}},
                {options: {general: {}, dictionaries: [{name: 'JMdict', enabled: true}]}},
            ],
        });

        controller._onProfileSelectChange({currentTarget: {value: '1'}});
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(setupOptions).toHaveBeenCalledWith({options: {general: {}, dictionaries: [{name: 'JMdict', enabled: true}]}});
        expect(refreshOptionsState).toHaveBeenCalledOnce();
        expect(logSpy).toHaveBeenCalledWith(error);
    });

    test('stale options refresh does not overwrite newer action popup state', async () => {
        let resolveFirst;
        let resolveSecond;
        const optionsGetFull = vi
            .fn()
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveFirst = resolve;
            }))
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveSecond = resolve;
            }));
        const controller = new DisplayController(/** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({
            api: {
                optionsGetFull,
            },
        })));
        const setupOptions = vi.spyOn(controller, '_setupOptions').mockImplementation(() => {});
        const updateProfileSelect = vi.spyOn(controller, '_updateProfileSelect').mockImplementation(() => {});

        const firstRefresh = controller._refreshOptionsState();
        const secondRefresh = controller._refreshOptionsState();
        resolveSecond({
            profileCurrent: 1,
            profiles: [
                {options: {general: {}, dictionaries: []}},
                {options: {general: {}, dictionaries: [{name: 'JMdict', enabled: true}]}},
            ],
        });
        await secondRefresh;
        resolveFirst({
            profileCurrent: 0,
            profiles: [
                {options: {general: {}, dictionaries: []}},
            ],
        });
        await firstRefresh;

        expect(Reflect.get(controller, '_optionsFull')).toEqual({
            profileCurrent: 1,
            profiles: [
                {options: {general: {}, dictionaries: []}},
                {options: {general: {}, dictionaries: [{name: 'JMdict', enabled: true}]}},
            ],
        });
        expect(setupOptions).toHaveBeenCalledTimes(1);
        expect(updateProfileSelect).toHaveBeenCalledTimes(1);
    });
});

afterAll(() => teardown(global));
