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

import {afterAll, describe, expect, test, vi} from 'vitest';
import {DictionaryImportController, ImportProgressTracker} from '../ext/js/pages/settings/dictionary-import-controller.js';
import {setupDomTest} from './fixtures/dom-test.js';

const testEnv = await setupDomTest();
afterAll(async () => {
    await testEnv.teardown(global);
});

/**
 * @param {Document} document
 * @returns {HTMLElement}
 */
function setupProgressDom(document) {
    document.body.innerHTML = `
        <div class="dictionary-import-progress">
            <div class="progress-info"></div>
            <div class="progress-bar"></div>
            <div class="progress-status"></div>
        </div>
    `;
    const info = document.querySelector('.dictionary-import-progress .progress-info');
    if (!(info instanceof HTMLElement)) {
        throw new Error('Expected progress info element');
    }
    return info;
}

/**
 * @param {Document} document
 * @returns {HTMLElement}
 */
function setupErrorDom(document) {
    document.body.innerHTML = '<div id="dictionary-error" hidden></div>';
    const errorContainer = document.querySelector('#dictionary-error');
    if (!(errorContainer instanceof HTMLElement)) {
        throw new Error('Expected dictionary error element');
    }
    return errorContainer;
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

/**
 * @returns {import('dictionary-importer').ImportSteps}
 */
function getFileImportSteps() {
    const getFileImportStepsMethod = getDictionaryImportControllerMethod('_getFileImportSteps');
    return /** @type {import('dictionary-importer').ImportSteps} */ (getFileImportStepsMethod.call({}));
}

/**
 * @returns {import('dictionary-importer').ImportSteps}
 */
function getUrlImportSteps() {
    const getUrlImportStepsMethod = getDictionaryImportControllerMethod('_getUrlImportSteps');
    /** @type {Record<string, unknown>} */
    const context = {};
    Reflect.set(context, '_getFileImportSteps', () => getFileImportSteps());
    return /** @type {import('dictionary-importer').ImportSteps} */ (getUrlImportStepsMethod.call(context));
}

describe('Dictionary import progress steps', () => {
    const {window} = testEnv;

    test('File and URL import steps exclude validation phase', () => {
        const fileImportSteps = getFileImportSteps();
        expect(fileImportSteps.map(({label}) => label)).toStrictEqual([
            '',
            'Initializing import',
            'Loading dictionary',
            'Importing data',
            'Finalizing import',
        ]);

        const urlImportSteps = getUrlImportSteps();
        expect(urlImportSteps.map(({label}) => label)).toStrictEqual([
            '',
            'Initializing import',
            'Downloading dictionary',
            'Loading dictionary',
            'Importing data',
            'Finalizing import',
        ]);

        for (const label of [...fileImportSteps, ...urlImportSteps].map(({label: stepLabel}) => stepLabel.toLowerCase())) {
            expect(label.includes('validat')).toBe(false);
        }
    });

    test('ImportProgressTracker keeps step numbering stable without validation', () => {
        const infoLabel = setupProgressDom(window.document);
        const steps = getFileImportSteps();
        const tracker = new ImportProgressTracker(steps, 1);

        expect(infoLabel.textContent).toBe('Importing dictionary - Step 1 of 5: ...');

        tracker.onNextDictionary();
        expect(infoLabel.textContent).toBe('Importing dictionary - Step 2 of 5: Initializing import...');

        tracker.onProgress({nextStep: true, index: 0, count: 0});
        expect(infoLabel.textContent).toBe('Importing dictionary - Step 3 of 5: Loading dictionary...');

        tracker.onProgress({nextStep: true, index: 0, count: 0});
        expect(infoLabel.textContent).toBe('Importing dictionary - Step 4 of 5: Importing data...');

        tracker.onProgress({nextStep: true, index: 0, count: 0});
        expect(infoLabel.textContent).toBe('Importing dictionary - Step 5 of 5: Finalizing import...');
    });
});

describe('Dictionary import stale-run fencing', () => {
    test('stale finalized imports do not perform page-side mutations', async () => {
        const finalizeImportedDictionaryResult = /** @type {(this: DictionaryImportController, context: Record<string, unknown>) => Promise<{errors: Error[], importedTitle: string|null}>} */ (
            getDictionaryImportControllerMethod('_finalizeImportedDictionaryResult')
        );
        const addDictionarySettings = /** @type {ReturnType<typeof vi.fn>} */ (vi.fn().mockResolvedValue([]));
        const triggerDatabaseUpdated = /** @type {ReturnType<typeof vi.fn>} */ (vi.fn().mockResolvedValue(void 0));
        const verifyImportedDictionaryVisible = /** @type {ReturnType<typeof vi.fn>} */ (vi.fn().mockResolvedValue(void 0));
        const recordImportDebugSnapshot = /** @type {ReturnType<typeof vi.fn>} */ (vi.fn());

        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            _activeImportRunGeneration: 2,
            _isImportRunCurrent(importRunGeneration) {
                return importRunGeneration === this._activeImportRunGeneration;
            },
            _addDictionarySettings: addDictionarySettings,
            _verifyImportedDictionaryVisible: verifyImportedDictionaryVisible,
            _recordImportDebugSnapshot: recordImportDebugSnapshot,
            _settingsController: {
                application: {
                    api: {
                        triggerDatabaseUpdated,
                    },
                },
            },
        }));

        const result = await finalizeImportedDictionaryResult.call(controller, {
            dictionaryTitle: 'JMdict',
            importStartTime: 0,
            importDetails: /** @type {import('dictionary-importer').ImportDetails} */ ({replacementDictionaryTitle: null}),
            importResult: {
                result: /** @type {import('dictionary-importer').Summary} */ ({title: 'JMdict'}),
                errors: [],
                debug: {},
            },
            workerImportStartTime: 0,
            workerImportEndTime: 0,
            useImportSession: false,
            finalizeImportSession: true,
            importRunGeneration: 1,
            profilesDictionarySettings: null,
            localPhaseTimings: [],
        });

        expect(result.importedTitle).toBeNull();
        expect(addDictionarySettings).not.toHaveBeenCalled();
        expect(triggerDatabaseUpdated).not.toHaveBeenCalled();
        expect(verifyImportedDictionaryVisible).not.toHaveBeenCalled();
        expect(recordImportDebugSnapshot).not.toHaveBeenCalled();
        expect(result.errors.map((error) => error.message)).toContain('Ignored stale import completion for JMdict');
    });

    test('profile reference rewrite skips profiles without carried-over dictionary settings', async () => {
        const finalizeImportedDictionaryResult = /** @type {(this: DictionaryImportController, context: Record<string, unknown>) => Promise<{errors: Error[], importedTitle: string|null}>} */ (
            getDictionaryImportControllerMethod('_finalizeImportedDictionaryResult')
        );
        const setAllSettings = /** @type {ReturnType<typeof vi.fn>} */ (vi.fn().mockResolvedValue(void 0));
        const triggerDatabaseUpdated = /** @type {ReturnType<typeof vi.fn>} */ (vi.fn().mockResolvedValue(void 0));
        const verifyImportedDictionaryVisible = /** @type {ReturnType<typeof vi.fn>} */ (vi.fn().mockResolvedValue(void 0));
        const removeDictionarySettingsByName = /** @type {ReturnType<typeof vi.fn>} */ (vi.fn().mockResolvedValue(void 0));

        const options = {
            profiles: [
                {
                    id: 'profile-1',
                    options: {
                        anki: {
                            cardFormats: [
                                {fields: {glossary: {value: 'old-dictionary glossary'}}},
                            ],
                        },
                    },
                },
                {
                    id: 'profile-2',
                    options: {
                        anki: {
                            cardFormats: [
                                {fields: {glossary: {value: 'should stay old-dictionary glossary'}}},
                            ],
                        },
                    },
                },
            ],
        };

        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            _activeImportRunGeneration: 1,
            _isImportRunCurrent(importRunGeneration) {
                return importRunGeneration === this._activeImportRunGeneration;
            },
            _addDictionarySettings: vi.fn().mockResolvedValue([]),
            _removeDictionarySettingsByName: removeDictionarySettingsByName,
            _verifyImportedDictionaryVisible: verifyImportedDictionaryVisible,
            _recordImportDebugSnapshot: vi.fn(),
            _settingsController: {
                getOptionsFull: vi.fn().mockResolvedValue(options),
                setAllSettings,
                application: {
                    api: {
                        triggerDatabaseUpdated,
                    },
                },
            },
        }));

        const result = await finalizeImportedDictionaryResult.call(controller, {
            dictionaryTitle: 'JMdict',
            importStartTime: 0,
            importDetails: /** @type {import('dictionary-importer').ImportDetails} */ ({replacementDictionaryTitle: 'Old Dictionary'}),
            importResult: {
                result: /** @type {import('dictionary-importer').Summary} */ ({
                    title: 'New Dictionary',
                    sourceTitle: 'New Dictionary',
                }),
                errors: [],
                debug: {},
            },
            workerImportStartTime: 0,
            workerImportEndTime: 0,
            useImportSession: false,
            finalizeImportSession: true,
            importRunGeneration: 1,
            profilesDictionarySettings: {
                'profile-1': {name: 'Old Dictionary'},
            },
            localPhaseTimings: [],
        });

        expect(result.errors).toHaveLength(0);
        expect(result.importedTitle).toBe('New Dictionary');
        expect(triggerDatabaseUpdated).toHaveBeenCalledOnce();
        expect(verifyImportedDictionaryVisible).toHaveBeenCalledOnce();
        expect(removeDictionarySettingsByName).toHaveBeenCalledOnce();
        expect(setAllSettings).toHaveBeenCalledOnce();
        expect(options.profiles[0].options.anki.cardFormats[0].fields.glossary.value).toContain('new-dictionary');
        expect(options.profiles[1].options.anki.cardFormats[0].fields.glossary.value).toBe('should stay old-dictionary glossary');
    });

    test('stale import sessions still exit dictionary import mode', async () => {
        const importDictionaries = /** @type {(this: DictionaryImportController, ...args: unknown[]) => Promise<void>} */ (
            getDictionaryImportControllerMethod('_importDictionaries')
        );
        const setDictionaryImportMode = vi.fn()
            .mockResolvedValueOnce(void 0)
            .mockResolvedValueOnce(void 0);
        const setModifying = vi.fn();
        const showErrors = vi.fn();
        const triggerStorageChanged = vi.fn();
        const onImportDone = vi.fn();

        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            _activeImportRunGeneration: 1,
            _modifying: false,
            _statusFooter: null,
            _isImportRunCurrent() {
                return false;
            },
            _setModifying: setModifying,
            _hideErrors: vi.fn(),
            _showErrors: showErrors,
            _triggerStorageChanged: triggerStorageChanged,
            _preventPageExit: () => ({end() {}}),
            _getUseImportSession: () => false,
            _getImportPerformanceFlags: () => ({
                skipImageMetadata: false,
                mediaResolutionConcurrency: 4,
                debugImportLogging: false,
                enableTermEntryContentDedup: true,
                termContentStorageMode: 'inline',
            }),
            _settingsController: {
                getOptionsFull: vi.fn().mockResolvedValue({global: {database: {prefixWildcardsSupported: false}}}),
                application: {
                    api: {
                        setDictionaryImportMode,
                    },
                },
            },
            _importDictionaryFromZip: vi.fn().mockResolvedValue({errors: [], importedTitle: 'JMdict'}),
        }));

        await importDictionaries.call(
            controller,
            (async function* () {
                yield new File([new Uint8Array([1])], 'JMdict.zip', {type: 'application/zip'});
            })(),
            null,
            onImportDone,
            {dictionaryCount: 1, onProgress() {}, onNextDictionary() {}, onImportComplete() {}, getStepTimingHistory() { return []; }},
            null,
        );

        expect(setDictionaryImportMode).toHaveBeenCalledTimes(2);
        expect(setDictionaryImportMode).toHaveBeenNthCalledWith(1, true);
        expect(setDictionaryImportMode).toHaveBeenNthCalledWith(2, false);
        expect(setModifying).toHaveBeenCalledWith(true);
        expect(setModifying).not.toHaveBeenCalledWith(false);
        expect(showErrors).not.toHaveBeenCalled();
        expect(triggerStorageChanged).not.toHaveBeenCalled();
        expect(onImportDone).not.toHaveBeenCalled();
    });

    test('stale import sessions do not exit import mode after a newer run has taken over', async () => {
        const importDictionaries = /** @type {(this: DictionaryImportController, ...args: unknown[]) => Promise<void>} */ (
            getDictionaryImportControllerMethod('_importDictionaries')
        );
        const setDictionaryImportMode = vi.fn()
            .mockResolvedValueOnce(void 0);
        const setModifying = vi.fn(function(value) {
            this._modifying = value;
        });
        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            _activeImportRunGeneration: 1,
            _modifying: false,
            _statusFooter: null,
            _isImportRunCurrent() {
                return false;
            },
            _setModifying: setModifying,
            _hideErrors: vi.fn(),
            _showErrors: vi.fn(),
            _triggerStorageChanged: vi.fn(),
            _preventPageExit: () => ({end() {}}),
            _getUseImportSession: () => false,
            _getImportPerformanceFlags: () => ({
                skipImageMetadata: false,
                mediaResolutionConcurrency: 4,
                debugImportLogging: false,
                enableTermEntryContentDedup: true,
                termContentStorageMode: 'inline',
            }),
            _settingsController: {
                getOptionsFull: vi.fn().mockResolvedValue({global: {database: {prefixWildcardsSupported: false}}}),
                application: {
                    api: {
                        setDictionaryImportMode,
                    },
                },
            },
            _importDictionaryFromZip: vi.fn().mockResolvedValue({errors: [], importedTitle: 'JMdict'}),
        }));

        await importDictionaries.call(
            controller,
            (async function* () {
                yield new File([new Uint8Array([1])], 'JMdict.zip', {type: 'application/zip'});
            })(),
            null,
            vi.fn(),
            {dictionaryCount: 1, onProgress() {}, onNextDictionary() {}, onImportComplete() {}, getStepTimingHistory() { return []; }},
            null,
        );

        expect(setDictionaryImportMode).toHaveBeenCalledTimes(1);
        expect(setDictionaryImportMode).toHaveBeenCalledWith(true);
    });

    test('import session ignores onImportDone callback errors after cleanup', async () => {
        const importDictionaries = /** @type {(this: DictionaryImportController, ...args: unknown[]) => Promise<void>} */ (
            getDictionaryImportControllerMethod('_importDictionaries')
        );
        const triggerStorageChanged = /** @type {ReturnType<typeof vi.fn>} */ (vi.fn());
        const setDictionaryImportMode = /** @type {ReturnType<typeof vi.fn>} */ (vi.fn().mockResolvedValue(void 0));
        const setModifying = /** @type {ReturnType<typeof vi.fn>} */ (vi.fn());

        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            _activeImportRunGeneration: 0,
            _modifying: false,
            _statusFooter: null,
            _isImportRunCurrent(importRunGeneration) {
                return importRunGeneration === this._activeImportRunGeneration;
            },
            _setModifying: setModifying,
            _hideErrors: vi.fn(),
            _showErrors: vi.fn(),
            _triggerStorageChanged: triggerStorageChanged,
            _preventPageExit: () => ({end() {}}),
            _getUseImportSession: () => false,
            _getImportPerformanceFlags: () => ({
                skipImageMetadata: false,
                mediaResolutionConcurrency: 4,
                debugImportLogging: false,
                enableTermEntryContentDedup: true,
                termContentStorageMode: 'inline',
            }),
            _settingsController: {
                getOptionsFull: vi.fn().mockResolvedValue({global: {database: {prefixWildcardsSupported: false}}}),
                application: {
                    api: {
                        setDictionaryImportMode,
                    },
                },
            },
            _importDictionaryFromZip: vi.fn().mockResolvedValue({errors: [], importedTitle: 'JMdict'}),
        }));

        await expect(importDictionaries.call(
            controller,
            (async function* () {
                yield new File([new Uint8Array([1])], 'JMdict.zip', {type: 'application/zip'});
            })(),
            null,
            () => {
                throw new Error('import callback failed');
            },
            {dictionaryCount: 1, onProgress() {}, onNextDictionary() {}, onImportComplete() {}, getStepTimingHistory() { return []; }},
            null,
        )).resolves.toBeUndefined();

        expect(triggerStorageChanged).toHaveBeenCalledOnce();
        expect(setDictionaryImportMode).toHaveBeenCalledTimes(2);
        expect(setModifying).toHaveBeenCalledWith(true);
        expect(setModifying).toHaveBeenCalledWith(false);
    });

    test('import mode exit failure is surfaced before completion callback', async () => {
        const importDictionaries = /** @type {(this: DictionaryImportController, ...args: unknown[]) => Promise<void>} */ (
            getDictionaryImportControllerMethod('_importDictionaries')
        );
        const showErrors = /** @type {ReturnType<typeof vi.fn>} */ (vi.fn());
        const onImportDone = /** @type {ReturnType<typeof vi.fn>} */ (vi.fn());
        const setDictionaryImportMode = /** @type {ReturnType<typeof vi.fn>} */ (vi.fn()
            .mockResolvedValueOnce(void 0)
            .mockRejectedValueOnce(new Error('import mode exit failed')));

        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            _activeImportRunGeneration: 0,
            _modifying: false,
            _statusFooter: null,
            _isImportRunCurrent(importRunGeneration) {
                return importRunGeneration === this._activeImportRunGeneration;
            },
            _setModifying: vi.fn(),
            _hideErrors: vi.fn(),
            _showErrors: showErrors,
            _triggerStorageChanged: vi.fn(),
            _preventPageExit: () => ({end() {}}),
            _getUseImportSession: () => false,
            _getImportPerformanceFlags: () => ({
                skipImageMetadata: false,
                mediaResolutionConcurrency: 4,
                debugImportLogging: false,
                enableTermEntryContentDedup: true,
                termContentStorageMode: 'inline',
            }),
            _settingsController: {
                getOptionsFull: vi.fn().mockResolvedValue({global: {database: {prefixWildcardsSupported: false}}}),
                application: {
                    api: {
                        setDictionaryImportMode,
                    },
                },
            },
            _importDictionaryFromZip: vi.fn().mockResolvedValue({errors: [], importedTitle: 'JMdict'}),
        }));

        await importDictionaries.call(
            controller,
            (async function* () {
                yield new File([new Uint8Array([1])], 'JMdict.zip', {type: 'application/zip'});
            })(),
            null,
            onImportDone,
            {dictionaryCount: 1, onProgress() {}, onNextDictionary() {}, onImportComplete() {}, getStepTimingHistory() { return []; }},
            null,
        );

        expect(showErrors).toHaveBeenCalledOnce();
        const shownErrors = showErrors.mock.calls[0][0];
        expect(shownErrors.map((error) => error.message)).toContain('import mode exit failed');
        expect(onImportDone).toHaveBeenCalledOnce();
        expect(onImportDone.mock.calls[0][0].ok).toBe(false);
        expect(onImportDone.mock.calls[0][0].errors.map((error) => error.message)).toContain('import mode exit failed');
    });

    test('download callback errors do not escape the controller', async () => {
        const onEventDownloadDictionaryFromUrl = /** @type {(this: DictionaryImportController, details: Record<string, unknown>) => void} */ (
            getDictionaryImportControllerMethod('_onEventDownloadDictionaryFromUrl')
        );
        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            downloadDictionaryFileFromURL: vi.fn().mockResolvedValue(new File([new Uint8Array([1])], 'JMdict.zip', {type: 'application/zip'})),
            _showErrors: vi.fn(),
        }));

        onEventDownloadDictionaryFromUrl.call(controller, {
            url: 'https://example.com/JMdict.zip',
            onDownloadDone() {
                throw new Error('download callback failed');
            },
        });

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(controller.downloadDictionaryFileFromURL).toHaveBeenCalledOnce();
    });
});

describe('Dictionary import error rendering', () => {
    const {window} = testEnv;

    test('showErrors keeps the container hidden when there are no errors', () => {
        const showErrors = /** @type {(this: DictionaryImportController, errors: Error[]) => void} */ (
            getDictionaryImportControllerMethod('_showErrors')
        );
        const hideErrors = /** @type {(this: DictionaryImportController) => void} */ (
            getDictionaryImportControllerMethod('_hideErrors')
        );
        const errorContainer = setupErrorDom(window.document);
        errorContainer.textContent = 'stale error';
        errorContainer.hidden = false;

        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            _errorContainer: errorContainer,
            _hideErrors: hideErrors,
        }));

        showErrors.call(controller, []);

        expect(errorContainer.hidden).toBe(true);
        expect(errorContainer.textContent).toBe('');
    });

    test('showErrors replaces stale rendered errors instead of appending to them', () => {
        const showErrors = /** @type {(this: DictionaryImportController, errors: Error[]) => void} */ (
            getDictionaryImportControllerMethod('_showErrors')
        );
        const errorContainer = setupErrorDom(window.document);
        errorContainer.innerHTML = '<p>old error</p>';
        errorContainer.hidden = false;

        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            _errorContainer: errorContainer,
            _errorToString(error) {
                return error.message;
            },
        }));

        showErrors.call(controller, [new Error('new error')]);

        expect(errorContainer.hidden).toBe(false);
        expect(errorContainer.textContent).toBe('new error');
        expect(errorContainer.querySelectorAll('p')).toHaveLength(1);
    });
});

describe('Dictionary import entrypoints', () => {
    const {window} = testEnv;
    const importFilesFromURLs = /** @type {(this: DictionaryImportController, text: string, profilesDictionarySettings: unknown, onImportDone: unknown, importDetailsOverrides?: Partial<import('dictionary-importer').ImportDetails>|null) => Promise<void>} */ (
        getDictionaryImportControllerMethod('importFilesFromURLs')
    );
    const isRecommendedImportQueuedOrActive = /** @type {(this: DictionaryImportController, importUrl: string) => boolean} */ (
        getDictionaryImportControllerMethod('_isRecommendedImportQueuedOrActive')
    );
    const normalizeImportUrls = /** @type {(this: DictionaryImportController, text: string) => string[]} */ (
        getDictionaryImportControllerMethod('_normalizeImportUrls')
    );

    test('file input change delegates to importFiles so the watchdog path is used', async () => {
        const onImportFileChange = /** @type {(this: DictionaryImportController, e: Event) => Promise<void>} */ (
            getDictionaryImportControllerMethod('_onImportFileChange')
        );
        const importFiles = /** @type {ReturnType<typeof vi.fn>} */ (vi.fn().mockResolvedValue(void 0));
        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            importFiles,
            _importModal: {setVisible: vi.fn()},
        }));
        const input = window.document.createElement('input');
        const file = new File([new Uint8Array([1])], 'JMdict.zip', {type: 'application/zip'});
        Object.defineProperty(input, 'files', {
            configurable: true,
            value: [file],
        });
        input.value = 'fake-value';

        await onImportFileChange.call(controller, /** @type {unknown} */ ({currentTarget: input}));

        expect(importFiles).toHaveBeenCalledOnce();
        expect(importFiles).toHaveBeenCalledWith([file], null, null);
        expect(input.value).toBe('');
    });

    test('file input change does not start an import when no files were selected', async () => {
        const onImportFileChange = /** @type {(this: DictionaryImportController, e: Event) => Promise<void>} */ (
            getDictionaryImportControllerMethod('_onImportFileChange')
        );
        const importFiles = /** @type {ReturnType<typeof vi.fn>} */ (vi.fn().mockResolvedValue(void 0));
        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            importFiles,
            _importModal: {setVisible: vi.fn()},
        }));
        const input = window.document.createElement('input');
        Object.defineProperty(input, 'files', {
            configurable: true,
            value: [],
        });
        input.value = 'fake-value';

        await onImportFileChange.call(controller, /** @type {unknown} */ ({currentTarget: input}));

        expect(importFiles).not.toHaveBeenCalled();
        expect(input.value).toBe('');
    });

    test('URL import trims blank lines before starting import', async () => {
        const importDictionaries = vi.fn().mockResolvedValue(void 0);
        const getUrlImportSources = vi.fn((urls) => urls);
        const runImportWithWatchdog = vi.fn(async (promise) => await promise);
        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            _getUrlImportSteps: () => getUrlImportSteps(),
            _getUrlImportSources: getUrlImportSources,
            _importDictionaries: importDictionaries,
            _normalizeImportUrls: normalizeImportUrls,
            _runImportWithWatchdog: runImportWithWatchdog,
        }));

        await importFilesFromURLs.call(controller, ' https://example.com/a.zip \n\n  \nhttps://example.com/b.zip  ', null, null);

        expect(importDictionaries).toHaveBeenCalledOnce();
        expect(getUrlImportSources).toHaveBeenCalledWith(
            ['https://example.com/a.zip', 'https://example.com/b.zip'],
            expect.any(Function),
        );
        expect(runImportWithWatchdog).toHaveBeenCalledOnce();
    });

    test('URL import click prevents default before starting import', async () => {
        const onImportFromURL = /** @type {(this: DictionaryImportController, e: Event) => Promise<void>} */ (
            getDictionaryImportControllerMethod('_onImportFromURL')
        );
        const importFilesFromURLs = /** @type {ReturnType<typeof vi.fn>} */ (vi.fn().mockResolvedValue(void 0));
        const preventDefault = vi.fn();
        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            _importURLText: {value: 'https://example.com/a.zip'},
            importFilesFromURLs,
        }));

        await onImportFromURL.call(controller, /** @type {unknown} */ ({preventDefault}));

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(importFilesFromURLs).toHaveBeenCalledWith('https://example.com/a.zip', null, null);
    });

    test('URL import ignores whitespace-only input after normalization', async () => {
        const importDictionaries = vi.fn();
        const runImportWithWatchdog = vi.fn();
        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            _getUrlImportSteps: () => getUrlImportSteps(),
            _getUrlImportSources: vi.fn(),
            _importDictionaries: importDictionaries,
            _normalizeImportUrls: normalizeImportUrls,
            _runImportWithWatchdog: runImportWithWatchdog,
        }));

        await importFilesFromURLs.call(controller, ' \n \n ', null, null);

        expect(importDictionaries).not.toHaveBeenCalled();
        expect(runImportWithWatchdog).not.toHaveBeenCalled();
    });

    test('URL import normalization removes duplicate URLs while preserving order', () => {
        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({}));

        const urls = normalizeImportUrls.call(
            controller,
            ' https://example.com/a.zip \nhttps://example.com/b.zip\nhttps://example.com/a.zip \n\nhttps://example.com/b.zip\nhttps://example.com/c.zip',
        );

        expect(urls).toStrictEqual([
            'https://example.com/a.zip',
            'https://example.com/b.zip',
            'https://example.com/c.zip',
        ]);
    });

    test('file import ignores an empty file list after normalization', async () => {
        const importDictionaries = vi.fn();
        const runImportWithWatchdog = vi.fn();
        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            _getFileImportSteps: () => getFileImportSteps(),
            _arrayToAsyncGenerator: vi.fn(),
            _importDictionaries: importDictionaries,
            _runImportWithWatchdog: runImportWithWatchdog,
        }));
        const importFiles = /** @type {(this: DictionaryImportController, files: File[], profilesDictionarySettings: unknown, onImportDone: unknown, importDetailsOverrides?: Partial<import('dictionary-importer').ImportDetails>|null) => Promise<void>} */ (
            getDictionaryImportControllerMethod('importFiles')
        );

        await importFiles.call(controller, [], null, null);

        expect(importDictionaries).not.toHaveBeenCalled();
        expect(runImportWithWatchdog).not.toHaveBeenCalled();
    });

    test('recommended import click deduplicates already queued URLs', async () => {
        const onRecommendedImportClick = /** @type {(this: DictionaryImportController, e: MouseEvent) => Promise<void>} */ (
            getDictionaryImportControllerMethod('_onRecommendedImportClick')
        );
        const button = window.document.createElement('button');
        button.setAttribute('data-import-url', 'https://example.com/jitendex.zip');
        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            _recommendedDictionaryQueue: ['https://example.com/jitendex.zip'],
            _recommendedDictionaryActiveImport: false,
            _recommendedDictionaryCurrentUrl: null,
            _updateRecommendedImportDebugState: vi.fn(),
            _isRecommendedImportQueuedOrActive: isRecommendedImportQueuedOrActive,
        }));

        await onRecommendedImportClick.call(controller, /** @type {unknown} */ ({target: button}));

        expect(Reflect.get(controller, '_recommendedDictionaryQueue')).toStrictEqual(['https://example.com/jitendex.zip']);
        expect(button.disabled).toBe(true);
    });

    test('recommended import click deduplicates the currently active URL', async () => {
        const onRecommendedImportClick = /** @type {(this: DictionaryImportController, e: MouseEvent) => Promise<void>} */ (
            getDictionaryImportControllerMethod('_onRecommendedImportClick')
        );
        const button = window.document.createElement('button');
        button.setAttribute('data-import-url', 'https://example.com/jitendex.zip');
        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            _recommendedDictionaryQueue: [],
            _recommendedDictionaryActiveImport: true,
            _recommendedDictionaryCurrentUrl: 'https://example.com/jitendex.zip',
            _updateRecommendedImportDebugState: vi.fn(),
            _isRecommendedImportQueuedOrActive: isRecommendedImportQueuedOrActive,
        }));

        await onRecommendedImportClick.call(controller, /** @type {unknown} */ ({target: button}));

        expect(Reflect.get(controller, '_recommendedDictionaryQueue')).toStrictEqual([]);
        expect(button.disabled).toBe(true);
    });

    test('recommended import click ignores empty import URLs', async () => {
        const onRecommendedImportClick = /** @type {(this: DictionaryImportController, e: MouseEvent) => Promise<void>} */ (
            getDictionaryImportControllerMethod('_onRecommendedImportClick')
        );
        const button = window.document.createElement('button');
        button.setAttribute('data-import-url', '');
        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            _recommendedDictionaryQueue: [],
            _recommendedDictionaryActiveImport: false,
            _recommendedDictionaryCurrentUrl: null,
            _updateRecommendedImportDebugState: vi.fn(),
            _isRecommendedImportQueuedOrActive: isRecommendedImportQueuedOrActive,
        }));

        await onRecommendedImportClick.call(controller, /** @type {unknown} */ ({target: button}));

        expect(Reflect.get(controller, '_recommendedDictionaryQueue')).toStrictEqual([]);
        expect(button.disabled).toBe(false);
    });

    test('recommended import click uses currentTarget button when a nested element is clicked', async () => {
        const onRecommendedImportClick = /** @type {(this: DictionaryImportController, e: MouseEvent) => Promise<void>} */ (
            getDictionaryImportControllerMethod('_onRecommendedImportClick')
        );
        const button = window.document.createElement('button');
        button.setAttribute('data-import-url', 'https://example.com/jitendex.zip');
        const child = window.document.createElement('span');
        button.append(child);
        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            _recommendedDictionaryQueue: [],
            _recommendedDictionaryActiveImport: true,
            _recommendedDictionaryCurrentUrl: 'https://example.com/jitendex.zip',
            _updateRecommendedImportDebugState: vi.fn(),
            _isRecommendedImportQueuedOrActive: isRecommendedImportQueuedOrActive,
        }));

        await onRecommendedImportClick.call(controller, /** @type {unknown} */ ({
            currentTarget: button,
            target: child,
        }));

        expect(Reflect.get(controller, '_recommendedDictionaryQueue')).toStrictEqual([]);
        expect(button.disabled).toBe(true);
    });

    test('file drop delegates to importFiles so the watchdog path is used', async () => {
        const onFileDrop = /** @type {(this: DictionaryImportController, e: DragEvent) => Promise<void>} */ (
            getDictionaryImportControllerMethod('_onFileDrop')
        );
        const importFiles = /** @type {ReturnType<typeof vi.fn>} */ (vi.fn().mockResolvedValue(void 0));
        const file = new File([new Uint8Array([1])], 'JMdict.zip', {type: 'application/zip'});
        const fileEntry = {
            file(resolve) { resolve(file); },
        };
        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            importFiles,
            _importModal: {setVisible: vi.fn()},
            _importFileDrop: {classList: {remove: vi.fn()}},
            _getAllFileEntries: vi.fn().mockResolvedValue([fileEntry]),
        }));
        const preventDefault = vi.fn();

        await onFileDrop.call(controller, /** @type {unknown} */ ({
            preventDefault,
            dataTransfer: {items: {}},
        }));

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(importFiles).toHaveBeenCalledOnce();
        expect(importFiles).toHaveBeenCalledWith([file], null, null);
    });

    test('file drop skips null entries and still imports valid files', async () => {
        const onFileDrop = /** @type {(this: DictionaryImportController, e: DragEvent) => Promise<void>} */ (
            getDictionaryImportControllerMethod('_onFileDrop')
        );
        const importFiles = /** @type {ReturnType<typeof vi.fn>} */ (vi.fn().mockResolvedValue(void 0));
        const file = new File([new Uint8Array([1])], 'JMdict.zip', {type: 'application/zip'});
        const fileEntry = {
            file(resolve) { resolve(file); },
        };
        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            importFiles,
            _importModal: {setVisible: vi.fn()},
            _importFileDrop: {classList: {remove: vi.fn()}},
            _getAllFileEntries: vi.fn().mockResolvedValue([null, fileEntry]),
        }));

        await onFileDrop.call(controller, /** @type {unknown} */ ({
            preventDefault() {},
            dataTransfer: {items: {}},
        }));

        expect(importFiles).toHaveBeenCalledOnce();
        expect(importFiles).toHaveBeenCalledWith([file], null, null);
    });

    test('file drop does not start an empty import when no valid files were extracted', async () => {
        const onFileDrop = /** @type {(this: DictionaryImportController, e: DragEvent) => Promise<void>} */ (
            getDictionaryImportControllerMethod('_onFileDrop')
        );
        const importFiles = /** @type {ReturnType<typeof vi.fn>} */ (vi.fn().mockResolvedValue(void 0));
        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            importFiles,
            _importModal: {setVisible: vi.fn()},
            _importFileDrop: {classList: {remove: vi.fn()}},
            _getAllFileEntries: vi.fn().mockResolvedValue([null]),
        }));

        await onFileDrop.call(controller, /** @type {unknown} */ ({
            preventDefault() {},
            dataTransfer: {items: {}},
        }));

        expect(importFiles).not.toHaveBeenCalled();
    });
});

describe('Dictionary import watchdog recovery', () => {
    const forceRecoverHungImportSession = /** @type {(this: DictionaryImportController, error: Error, label: string) => void} */ (
        getDictionaryImportControllerMethod('_forceRecoverHungImportSession')
    );

    test('watchdog recovery clears the active recommended import URL', () => {
        const updateRecommendedImportDebugState = vi.fn();
        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            _activeImportRunGeneration: 3,
            _recommendedDictionaryQueue: ['https://example.com/jitendex.zip'],
            _recommendedDictionaryActiveImport: true,
            _recommendedDictionaryCurrentUrl: 'https://example.com/jitendex.zip',
            _updateRecommendedImportDebugState: updateRecommendedImportDebugState,
            _setRecommendedError: vi.fn(),
            _errorToString: (error) => error.message,
            _showErrors: vi.fn(),
            _setModifying: vi.fn(),
            _statusFooter: null,
            _settingsController: {
                application: {
                    api: {
                        setDictionaryImportMode: vi.fn().mockResolvedValue(void 0),
                    },
                },
            },
            _triggerStorageChanged: vi.fn(),
        }));

        forceRecoverHungImportSession.call(controller, new Error('hung import'), 'Recommended dictionary import');

        expect(Reflect.get(controller, '_recommendedDictionaryQueue')).toStrictEqual([]);
        expect(Reflect.get(controller, '_recommendedDictionaryActiveImport')).toBe(false);
        expect(Reflect.get(controller, '_recommendedDictionaryCurrentUrl')).toBeNull();
        expect(updateRecommendedImportDebugState).toHaveBeenCalledWith({
            queueLength: 0,
            activeImport: false,
            currentUrl: null,
            lastError: 'hung import',
        });
    });
});

describe('Dictionary import settings cleanup', () => {
    const clearDictionarySettings = /** @type {(this: DictionaryImportController) => Promise<Error[]>} */ (
        getDictionaryImportControllerMethod('_clearDictionarySettings')
    );

    test('clearDictionarySettings also resets sortFrequencyDictionary for every profile', async () => {
        const modifyGlobalSettings = vi.fn().mockResolvedValue([]);
        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            _settingsController: {
                getOptionsFull: vi.fn().mockResolvedValue({
                    profiles: [
                        {options: {general: {mainDictionary: 'JMdict', sortFrequencyDictionary: 'Freq A'}}},
                        {options: {general: {mainDictionary: 'Jitendex', sortFrequencyDictionary: 'Freq B'}}},
                    ],
                }),
            },
            _modifyGlobalSettings: modifyGlobalSettings,
        }));

        await clearDictionarySettings.call(controller);

        expect(modifyGlobalSettings).toHaveBeenCalledOnce();
        expect(modifyGlobalSettings).toHaveBeenCalledWith([
            {action: 'set', path: 'profiles[0].options.dictionaries', value: []},
            {action: 'set', path: 'profiles[0].options.general.mainDictionary', value: ''},
            {action: 'set', path: 'profiles[0].options.general.sortFrequencyDictionary', value: null},
            {action: 'set', path: 'profiles[1].options.dictionaries', value: []},
            {action: 'set', path: 'profiles[1].options.general.mainDictionary', value: ''},
            {action: 'set', path: 'profiles[1].options.general.sortFrequencyDictionary', value: null},
        ]);
    });
});

describe('Recommended dictionary rendering', () => {
    const {window} = testEnv;
    const isRecommendedImportQueuedOrActive = /** @type {(this: DictionaryImportController, importUrl: string) => boolean} */ (
        getDictionaryImportControllerMethod('_isRecommendedImportQueuedOrActive')
    );

    test('renderRecommendedDictionaryGroup keeps the active import button disabled', () => {
        window.document.body.innerHTML = '<div id="list"></div><template id="recommended-dictionaries-list-item-template"></template>';
        const dictionariesList = /** @type {HTMLElement} */ (window.document.querySelector('#list'));
        const fragment = window.document.createDocumentFragment();
        const item = window.document.createElement('div');
        const label = window.document.createElement('div');
        label.className = 'settings-item-label';
        const description = window.document.createElement('div');
        description.className = 'description';
        const homepage = window.document.createElement('a');
        homepage.className = 'homepage';
        const button = window.document.createElement('button');
        button.className = 'action-button';
        button.setAttribute('data-action', 'import-recommended-dictionary');
        item.append(label, description, homepage, button);
        fragment.append(item);
        const controller = /** @type {DictionaryImportController} */ (/** @type {unknown} */ ({
            _recommendedDictionaryQueue: [],
            _recommendedDictionaryCurrentUrl: 'https://example.com/jitendex.zip',
            _isRecommendedImportQueuedOrActive: isRecommendedImportQueuedOrActive,
            _settingsController: {
                instantiateTemplate() {
                    return fragment.cloneNode(true);
                },
            },
        }));
        const renderRecommendedDictionaryGroup = /** @type {(this: DictionaryImportController, recommendedDictionaries: Array<{name: string, description: string, downloadUrl: string, homepage?: string|null}>, dictionariesList: HTMLElement, installedDictionaryNames: Set<string>, installedDictionaryDownloadUrls: Set<string>) => void} */ (
            getDictionaryImportControllerMethod('_renderRecommendedDictionaryGroup')
        );

        renderRecommendedDictionaryGroup.call(controller, [
            {
                name: 'Jitendex',
                description: 'desc',
                downloadUrl: 'https://example.com/jitendex.zip',
                homepage: null,
            },
        ], dictionariesList, new Set(), new Set());

        const renderedButton = /** @type {HTMLButtonElement|null} */ (dictionariesList.querySelector('.action-button[data-action=import-recommended-dictionary]'));
        expect(renderedButton?.disabled).toBe(true);
    });
});
