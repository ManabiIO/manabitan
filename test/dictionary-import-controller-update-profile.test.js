/*
 * Copyright (C) 2026 Manabitan authors
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

import {afterEach, describe, expect, test, vi} from 'vitest';
import {DictionaryImportController} from '../ext/js/pages/settings/dictionary-import-controller.js';

/**
 * @returns {DictionaryImportController}
 */
function createControllerForInternalTests() {
    return /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
}

/**
 * @param {string} name
 * @returns {Function}
 */
function getDictionaryImportControllerMethod(name) {
    const method = /** @type {unknown} */ (Reflect.get(DictionaryImportController.prototype, name));
    if (typeof method !== 'function') {
        throw new Error(`Expected DictionaryImportController.${name} to be a function`);
    }
    return method;
}

describe('DictionaryImportController staged update profile rewrites', () => {
    const importDictionaryFromZip = /** @type {(this: DictionaryImportController, file: File, profilesDictionarySettings: import('settings-controller').ProfilesDictionarySettings, importDetails: import('dictionary-importer').ImportDetails, useImportSession: boolean, finalizeImportSession: boolean, onProgress: import('dictionary-worker').ImportProgressCallback) => Promise<{errors: Error[], importedTitle: string|null}>} */ (getDictionaryImportControllerMethod('_importDictionaryFromZip'));
    const getImportPerformanceFlags = /** @type {(this: DictionaryImportController) => {mediaResolutionConcurrency: number}} */ (getDictionaryImportControllerMethod('_getImportPerformanceFlags'));

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        Reflect.deleteProperty(globalThis, 'manabitanImportPerformanceFlags');
    });

    test('uses the profiled media concurrency default and clamps debug overrides', () => {
        const controller = createControllerForInternalTests();

        expect(getImportPerformanceFlags.call(controller).mediaResolutionConcurrency).toBe(16);

        Reflect.set(globalThis, 'manabitanImportPerformanceFlags', {mediaResolutionConcurrency: 100});
        expect(getImportPerformanceFlags.call(controller).mediaResolutionConcurrency).toBe(32);
    });

    test('watchdog recovery terminates an active MDX conversion worker', async () => {
        const controller = createControllerForInternalTests();
        const disconnect = vi.fn();
        const setDictionaryImportMode = vi.fn().mockResolvedValue();
        vi.stubGlobal('document', {querySelectorAll: vi.fn().mockReturnValue([])});
        Reflect.set(controller, '_activeImportRunGeneration', 4);
        Reflect.set(controller, '_activeMdx', {disconnect});
        Reflect.set(controller, '_setRecommendedError', vi.fn());
        Reflect.set(controller, '_errorToString', vi.fn().mockReturnValue('timed out'));
        Reflect.set(controller, '_showErrors', vi.fn());
        Reflect.set(controller, '_recommendedDictionaryQueue', ['pending']);
        Reflect.set(controller, '_recommendedDictionaryActiveImport', true);
        Reflect.set(controller, '_recommendedDictionaryCurrentUrl', 'https://example.test/dictionary.mdx');
        Reflect.set(controller, '_updateRecommendedImportDebugState', vi.fn());
        Reflect.set(controller, '_setModifying', vi.fn());
        Reflect.set(controller, '_statusFooter', null);
        Reflect.set(controller, '_settingsController', {application: {api: {setDictionaryImportMode}}});
        Reflect.set(controller, '_triggerStorageChanged', vi.fn());

        Reflect.get(DictionaryImportController.prototype, '_forceRecoverHungImportSession').call(
            controller,
            new Error('MDX import did not complete within 180000ms'),
            'MDX import',
        );
        await Promise.resolve();

        expect(disconnect).toHaveBeenCalledOnce();
        expect(Reflect.get(controller, '_activeMdx')).toBeNull();
        expect(setDictionaryImportMode).toHaveBeenCalledWith(false);
        expect(Reflect.get(controller, '_activeImportRunGeneration')).toBe(5);
    });

    test('skips profile dictionary rewrites for profiles without carried-over update settings', async () => {
        const controller = createControllerForInternalTests();
        const replaceDictionaryTitle = vi.fn().mockResolvedValue(void 0);
        const triggerDatabaseUpdated = vi.fn().mockResolvedValue(void 0);
        const setAllSettings = vi.fn().mockResolvedValue(void 0);
        const verifyImportedDictionaryVisible = vi.fn().mockResolvedValue(void 0);
        const addDictionarySettings = vi.fn().mockResolvedValue([]);
        const removeDictionarySettingsByName = vi.fn().mockResolvedValue(void 0);
        const showErrors = vi.fn();
        const options = /** @type {import('settings').Options} */ (/** @type {unknown} */ ({
            profiles: [
                {
                    id: 'profile-1',
                    name: 'Profile 1',
                    options: {
                        anki: {
                            cardFormats: [
                                {fields: {expression: {value: '{{jitendexorg-2025-01-01}}'}}},
                            ],
                        },
                    },
                },
                {
                    id: null,
                    name: 'Profile 2',
                    options: {
                        anki: {
                            cardFormats: [
                                {fields: {expression: {value: '{{untouched}}'}}},
                            ],
                        },
                    },
                },
            ],
        }));
        Reflect.set(controller, '_settingsController', {
            application: {
                api: {
                    replaceDictionaryTitle,
                    triggerDatabaseUpdated,
                },
            },
            getOptionsFull: vi.fn().mockResolvedValue(options),
            setAllSettings,
        });
        Reflect.set(controller, '_verifyImportedDictionaryVisible', verifyImportedDictionaryVisible);
        Reflect.set(controller, '_addDictionarySettings', addDictionarySettings);
        Reflect.set(controller, '_removeDictionarySettingsByName', removeDictionarySettingsByName);
        Reflect.set(controller, '_showErrors', showErrors);
        Reflect.set(controller, '_recordImportDebugSnapshot', vi.fn());
        Reflect.set(controller, '_tryImportDictionaryOffscreen', vi.fn().mockResolvedValue({
            result: {title: 'Jitendex staged [update-staging token123]', sourceTitle: 'Jitendex.org [2026-02-05]'},
            errors: [],
            debug: {importerDebug: {phaseTimings: []}},
        }));

        const result = await importDictionaryFromZip.call(
            controller,
            new File([new Uint8Array([1, 2, 3])], 'Jitendex staged [update-staging token123].zip', {type: 'application/zip'}),
            {
                'profile-1': {
                    index: 0,
                    alias: 'Jitendex',
                    name: 'Jitendex.org [2025-01-01]',
                    enabled: true,
                    allowSecondarySearches: false,
                    definitionsCollapsible: 'not-collapsible',
                    partsOfSpeechFilter: false,
                    useDeinflections: true,
                },
            },
            /** @type {import('dictionary-importer').ImportDetails} */ (/** @type {unknown} */ ({
                replacementDictionaryTitle: 'Jitendex.org [2025-01-01]',
                updateSessionToken: 'token123',
                yomitanVersion: '1.2.3.4',
            })),
            false,
            false,
            vi.fn(),
        );

        expect(result.errors).toHaveLength(0);
        expect(result.importedTitle).toBe('Jitendex.org [2026-02-05]');
        expect(replaceDictionaryTitle).toHaveBeenCalledTimes(1);
        expect(triggerDatabaseUpdated).toHaveBeenCalledTimes(1);
        expect(verifyImportedDictionaryVisible).toHaveBeenCalledWith('Jitendex.org [2026-02-05]', false);
        expect(setAllSettings).toHaveBeenCalledTimes(1);
        expect(options.profiles[0].options.anki.cardFormats[0].fields.expression.value).toContain('jitendexorg-2026-02-05');
        expect(options.profiles[1].options.anki.cardFormats[0].fields.expression.value).toBe('{{untouched}}');
        expect(showErrors).not.toHaveBeenCalled();
    });
});

describe('DictionaryImportController URL download cancellation', () => {
    const downloadDictionaryFileViaXhr = /** @type {(this: DictionaryImportController, url: string, timeoutMs: number, onProgress: import('dictionary-worker').ImportProgressCallback, abortSignal: AbortSignal) => Promise<File>} */ (getDictionaryImportControllerMethod('_downloadDictionaryFileViaXhr'));

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    test('does not send XHR when the abort signal is already cancelled', async () => {
        /** @type {FakeXMLHttpRequest[]} */
        const requests = [];
        class FakeXMLHttpRequest {
            /** */
            constructor() {
                this.open = vi.fn();
                this.send = vi.fn();
                this.abort = vi.fn();
                this.getResponseHeader = vi.fn(() => null);
                this.responseType = '';
                this.timeout = 0;
                this.onload = null;
                this.onerror = null;
                this.onabort = null;
                this.ontimeout = null;
                this.onprogress = null;
                this.status = 0;
                this.response = null;
                requests.push(this);
            }
        }
        vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);

        const controller = createControllerForInternalTests();
        const abortController = new AbortController();
        abortController.abort(new Error('Cancelled before download'));

        await expect(downloadDictionaryFileViaXhr.call(
            controller,
            'https://example.com/dictionary.zip',
            1000,
            vi.fn(),
            abortController.signal,
        )).rejects.toThrow('Cancelled before download');

        expect(requests).toHaveLength(1);
        expect(requests[0].open).toHaveBeenCalledTimes(1);
        expect(requests[0].send).not.toHaveBeenCalled();
    });
});
