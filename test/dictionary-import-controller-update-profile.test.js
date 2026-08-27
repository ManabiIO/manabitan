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
    const getImportPerformanceFlags = /** @type {(this: DictionaryImportController) => {skipMediaImport: boolean, mediaResolutionConcurrency: number, zipUseWebWorkers: boolean|null, termContentBlockTargetBytes: number|null}} */ (getDictionaryImportControllerMethod('_getImportPerformanceFlags'));
    const runImportWithWatchdog = /** @type {(this: DictionaryImportController, importPromise: Promise<void>, label: string, progressTracker?: {lastActivityTime: number, lastForwardProgressTime: number}|null) => Promise<void>} */ (getDictionaryImportControllerMethod('_runImportWithWatchdog'));
    const finalizeImportedDictionaryResult = /** @type {(this: DictionaryImportController, context: Record<string, unknown>) => Promise<{errors: Error[], importedTitle: string|null}>} */ (getDictionaryImportControllerMethod('_finalizeImportedDictionaryResult'));
    const finalizeDeferredImportedDictionaries = /** @type {(this: DictionaryImportController, contexts: Record<string, unknown>[], importRunGeneration: number) => Promise<{errors: Error[], importedTitles: string[]}>} */ (getDictionaryImportControllerMethod('_finalizeDeferredImportedDictionaries'));
    const verifyImportedDictionaryVisible = /** @type {(this: DictionaryImportController, dictionaryTitle: string, requireEnabledForActiveProfile: boolean) => Promise<void>} */ (getDictionaryImportControllerMethod('_verifyImportedDictionaryVisible'));
    const signalImportSessionCompletion = /** @type {(this: DictionaryImportController, details: {importRunGeneration: number, importRunCurrent: boolean, errorCount: number, importedTitles: string[]}) => void} */ (getDictionaryImportControllerMethod('_signalImportSessionCompletion'));

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        Reflect.deleteProperty(globalThis, 'manabitanImportPerformanceFlags');
        Reflect.deleteProperty(globalThis, '__manabitanImportCompletionSignalEnabled');
        Reflect.deleteProperty(globalThis, '__manabitanImportCompletionSequence');
        Reflect.deleteProperty(globalThis, '__manabitanLastImportCompletion');
    });

    test('uses the profiled media concurrency default and clamps debug overrides', () => {
        const controller = createControllerForInternalTests();

        expect(getImportPerformanceFlags.call(controller).mediaResolutionConcurrency).toBe(16);
        expect(getImportPerformanceFlags.call(controller).skipMediaImport).toBe(false);
        expect(getImportPerformanceFlags.call(controller).zipUseWebWorkers).toBeNull();
        expect(getImportPerformanceFlags.call(controller).termContentBlockTargetBytes).toBeNull();

        Reflect.set(globalThis, 'manabitanImportPerformanceFlags', {
            mediaResolutionConcurrency: 100,
            skipMediaImport: true,
            zipUseWebWorkers: false,
            termContentBlockTargetBytes: Number.MAX_SAFE_INTEGER,
        });
        expect(getImportPerformanceFlags.call(controller).mediaResolutionConcurrency).toBe(32);
        expect(getImportPerformanceFlags.call(controller).skipMediaImport).toBe(true);
        expect(getImportPerformanceFlags.call(controller).zipUseWebWorkers).toBe(false);
        expect(getImportPerformanceFlags.call(controller).termContentBlockTargetBytes).toBe(16 * 1024 * 1024);

        Reflect.set(globalThis, 'manabitanImportPerformanceFlags', {zipUseWebWorkers: true});
        expect(getImportPerformanceFlags.call(controller).zipUseWebWorkers).toBe(true);
    });

    test('publishes a monotonic import completion boundary only when enabled', () => {
        const controller = createControllerForInternalTests();
        const dispatchEvent = vi.fn();
        class TestCustomEvent {
            constructor(type, options) {
                this.type = type;
                this.detail = options?.detail;
            }
        }
        vi.stubGlobal('dispatchEvent', dispatchEvent);
        vi.stubGlobal('CustomEvent', TestCustomEvent);
        const details = {
            importRunGeneration: 7,
            importRunCurrent: true,
            errorCount: 0,
            importedTitles: ['JMdict'],
        };

        signalImportSessionCompletion.call(controller, details);
        expect(Reflect.has(globalThis, '__manabitanLastImportCompletion')).toBe(false);
        expect(dispatchEvent).not.toHaveBeenCalled();

        Reflect.set(globalThis, '__manabitanImportCompletionSignalEnabled', true);
        Reflect.set(globalThis, '__manabitanImportCompletionSequence', 4);
        signalImportSessionCompletion.call(controller, details);

        expect(Reflect.get(globalThis, '__manabitanImportCompletionSequence')).toBe(5);
        expect(Reflect.get(globalThis, '__manabitanLastImportCompletion')).toMatchObject({...details, sequence: 5});
        expect(dispatchEvent).toHaveBeenCalledOnce();
        expect(dispatchEvent.mock.calls[0][0]).toMatchObject({
            type: 'manabitan:dictionary-import-complete',
            detail: {...details, sequence: 5},
        });
    });

    test('watchdog recovery terminates an active MDX conversion worker', async () => {
        const controller = createControllerForInternalTests();
        const disconnect = vi.fn();
        const setDictionaryImportMode = vi.fn().mockResolvedValue(void 0);
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

    test('page watchdog allows long imports that continue reporting progress', async () => {
        vi.useFakeTimers();
        const controller = createControllerForInternalTests();
        const forceRecover = vi.fn();
        Reflect.set(controller, '_forceRecoverHungImportSession', forceRecover);
        let resolveImport = /** @type {() => void} */ (() => {});
        const importPromise = new Promise((resolve) => {
            resolveImport = () => { resolve(void 0); };
        });
        const progressTracker = {lastActivityTime: performance.now(), lastForwardProgressTime: performance.now()};
        const result = runImportWithWatchdog.call(controller, importPromise, 'Test import', progressTracker);

        await vi.advanceTimersByTimeAsync(179_000);
        progressTracker.lastActivityTime = performance.now();
        progressTracker.lastForwardProgressTime = performance.now();
        await vi.advanceTimersByTimeAsync(179_000);
        resolveImport();

        await expect(result).resolves.toBeUndefined();
        expect(forceRecover).not.toHaveBeenCalled();
    });

    test('page watchdog recovers an import after sustained inactivity', async () => {
        vi.useFakeTimers();
        const controller = createControllerForInternalTests();
        const forceRecover = vi.fn();
        Reflect.set(controller, '_forceRecoverHungImportSession', forceRecover);
        const importPromise = new Promise(() => {});
        const progressTracker = {lastActivityTime: performance.now(), lastForwardProgressTime: performance.now()};
        const result = runImportWithWatchdog.call(controller, importPromise, 'Test import', progressTracker);
        const expectation = expect(result).rejects.toThrow(/without progress/);

        await vi.advanceTimersByTimeAsync(180_000);

        await expectation;
        expect(forceRecover).toHaveBeenCalledOnce();
    });

    test('page watchdog ignores duplicate callback activity without forward progress', async () => {
        vi.useFakeTimers();
        const controller = createControllerForInternalTests();
        const forceRecover = vi.fn();
        Reflect.set(controller, '_forceRecoverHungImportSession', forceRecover);
        const importPromise = new Promise(() => {});
        const progressTracker = {lastActivityTime: performance.now(), lastForwardProgressTime: performance.now()};
        const result = runImportWithWatchdog.call(controller, importPromise, 'Test import', progressTracker);
        const expectation = expect(result).rejects.toThrow(/without progress/);

        for (let elapsed = 0; elapsed < 180_000; elapsed += 30_000) {
            await vi.advanceTimersByTimeAsync(30_000);
            progressTracker.lastActivityTime = performance.now();
        }

        await expectation;
        expect(forceRecover).toHaveBeenCalledOnce();
    });

    test('publishes shared-session settings only after all worker results and enables every dictionary', async () => {
        const controller = createControllerForInternalTests();
        const triggerDatabaseUpdated = vi.fn().mockResolvedValue(void 0);
        const optionsFull = /** @type {import('settings').Options} */ (/** @type {unknown} */ ({
            profiles: [
                {
                    id: 'profile-1',
                    options: {
                        dictionaries: [],
                        general: {mainDictionary: '', sortFrequencyDictionary: null},
                    },
                },
                {
                    id: 'profile-2',
                    options: {
                        dictionaries: [],
                        general: {mainDictionary: '', sortFrequencyDictionary: null},
                    },
                },
            ],
        }));
        const modifyGlobalSettings = vi.fn(async (targets) => {
            for (const target of targets) {
                const match = /^profiles\[(\d+)]\.options\.dictionaries$/.exec(target.path);
                if (target.action !== 'push' || match === null) { continue; }
                optionsFull.profiles[Number(match[1])].options.dictionaries.push(...target.items);
            }
            return targets.map(() => ({}));
        });
        Reflect.set(controller, '_activeImportRunGeneration', 11);
        Reflect.set(controller, '_settingsController', {
            profileIndex: 1,
            application: {api: {triggerDatabaseUpdated}},
            getOptionsFull: vi.fn(async () => optionsFull),
            modifyGlobalSettings,
        });
        Reflect.set(controller, '_recordImportDebugSnapshot', vi.fn());
        Reflect.set(controller, '_showErrors', vi.fn());

        /** @type {Record<string, unknown>[]} */
        const deferredFinalizations = [];
        /**
         * @param {string} title
         * @param {boolean} finalizeImportSession
         * @returns {Record<string, unknown>}
         */
        const createContext = (title, finalizeImportSession) => ({
            dictionaryTitle: `${title}.zip`,
            importStartTime: performance.now(),
            importDetails: {},
            importResult: {
                result: {title, revision: '1', sequenced: false, styles: ''},
                errors: [],
                debug: {usesFallbackStorage: false, useImportSession: true, finalizeImportSession},
            },
            workerImportStartTime: performance.now(),
            workerImportEndTime: performance.now(),
            useImportSession: true,
            finalizeImportSession,
            importRunGeneration: 11,
            profilesDictionarySettings: null,
            localPhaseTimings: [],
            deferredFinalizations,
        });

        await finalizeImportedDictionaryResult.call(controller, createContext('JMdict', false));
        await finalizeImportedDictionaryResult.call(controller, createContext('JMnedict', true));

        expect(deferredFinalizations).toHaveLength(2);
        expect(modifyGlobalSettings).not.toHaveBeenCalled();
        expect(triggerDatabaseUpdated).not.toHaveBeenCalled();

        const result = await finalizeDeferredImportedDictionaries.call(controller, deferredFinalizations, 11);

        expect(result.errors).toHaveLength(0);
        expect(result.importedTitles).toStrictEqual(['JMdict', 'JMnedict']);
        expect(triggerDatabaseUpdated).toHaveBeenCalledTimes(1);
        expect(deferredFinalizations).toHaveLength(0);
        expect(optionsFull.profiles[0].options.dictionaries).toMatchObject([
            {name: 'JMdict', enabled: false},
            {name: 'JMnedict', enabled: false},
        ]);
        expect(optionsFull.profiles[1].options.dictionaries).toMatchObject([
            {name: 'JMdict', enabled: true},
            {name: 'JMnedict', enabled: true},
        ]);
    });

    test('continues deferred finalization after an item failure and still refreshes once', async () => {
        const controller = createControllerForInternalTests();
        const triggerDatabaseUpdated = vi.fn().mockResolvedValue(void 0);
        const finalizeItem = vi.fn()
            .mockRejectedValueOnce(new Error('first settings write failed'))
            .mockResolvedValueOnce({errors: [], importedTitle: 'JMnedict'});
        const verifyVisible = vi.fn().mockResolvedValue(void 0);
        Reflect.set(controller, '_activeImportRunGeneration', 17);
        Reflect.set(controller, '_settingsController', {application: {api: {triggerDatabaseUpdated}}});
        Reflect.set(controller, '_finalizeImportedDictionaryResult', finalizeItem);
        Reflect.set(controller, '_verifyImportedDictionaryVisible', verifyVisible);
        Reflect.set(controller, '_recordImportLocalPhase', vi.fn());
        const contexts = [
            {dictionaryTitle: 'JMdict.zip', profilesDictionarySettings: null, localPhaseTimings: []},
            {dictionaryTitle: 'JMnedict.zip', profilesDictionarySettings: null, localPhaseTimings: []},
        ];

        const result = await finalizeDeferredImportedDictionaries.call(controller, contexts, 17);

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('JMdict.zip');
        expect(result.importedTitles).toStrictEqual(['JMnedict']);
        expect(finalizeItem).toHaveBeenCalledTimes(2);
        expect(triggerDatabaseUpdated).toHaveBeenCalledTimes(1);
        expect(verifyVisible).toHaveBeenCalledWith('JMnedict', true);
        expect(contexts).toHaveLength(0);
    });

    test('drops stale deferred finalizations without publishing settings or notifications', async () => {
        const controller = createControllerForInternalTests();
        const triggerDatabaseUpdated = vi.fn().mockResolvedValue(void 0);
        const finalizeItem = vi.fn();
        Reflect.set(controller, '_activeImportRunGeneration', 19);
        Reflect.set(controller, '_settingsController', {application: {api: {triggerDatabaseUpdated}}});
        Reflect.set(controller, '_finalizeImportedDictionaryResult', finalizeItem);
        const contexts = [{dictionaryTitle: 'JMdict.zip'}];

        const result = await finalizeDeferredImportedDictionaries.call(controller, contexts, 18);

        expect(result.errors).toHaveLength(1);
        expect(result.importedTitles).toHaveLength(0);
        expect(finalizeItem).not.toHaveBeenCalled();
        expect(triggerDatabaseUpdated).not.toHaveBeenCalled();
        expect(contexts).toHaveLength(0);
    });

    test('treats missing active-profile enablement as a failed import verification', async () => {
        const controller = createControllerForInternalTests();
        Reflect.set(controller, '_settingsController', {
            profileIndex: 0,
            getOptionsFull: vi.fn().mockResolvedValue({
                profiles: [{id: 'profile-1', options: {dictionaries: [{name: 'JMdict', enabled: false}]}}],
            }),
        });

        await expect(verifyImportedDictionaryVisible.call(controller, 'JMdict', true)).rejects.toThrow(/not enabled/);
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
                'profile-1': [{
                    index: 0,
                    alias: 'Jitendex',
                    name: 'Jitendex.org [2025-01-01]',
                    enabled: true,
                    allowSecondarySearches: false,
                    definitionsCollapsible: 'not-collapsible',
                    partsOfSpeechFilter: false,
                    useDeinflections: true,
                }],
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
