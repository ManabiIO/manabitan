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
import {DictionaryController} from '../ext/js/pages/settings/dictionary-controller.js';

/**
 * @param {string} name
 * @returns {Function}
 */
function getDictionaryControllerMethod(name) {
    const method = /** @type {unknown} */ (Reflect.get(DictionaryController.prototype, name));
    if (typeof method !== 'function') {
        throw new Error(`Expected DictionaryController.${name} to be a function`);
    }
    return method;
}

/**
 * @returns {DictionaryController}
 */
function createControllerForInternalTests() {
    return /** @type {DictionaryController} */ (Object.create(DictionaryController.prototype));
}

describe('DictionaryController task queue', () => {
    const isDictionaryInTaskQueue = /** @type {(this: DictionaryController, dictionaryTitle: string) => boolean} */ (getDictionaryControllerMethod('isDictionaryInTaskQueue'));
    const enqueueTask = /** @type {(this: DictionaryController, task: {type: 'delete'|'update', dictionaryTitle: string, downloadUrl?: string}) => Promise<void>} */ (getDictionaryControllerMethod('_enqueueTask'));
    const hideUpdatesAvailableButton = /** @type {(this: DictionaryController, dictionaryTitle: string) => void} */ (getDictionaryControllerMethod('_hideUpdatesAvailableButton'));
    const runTaskQueue = /** @type {(this: DictionaryController) => Promise<void>} */ (getDictionaryControllerMethod('_runTaskQueue'));
    const deleteDictionaryInternal = /** @type {(this: DictionaryController, dictionaryTitle: string, onProgress: (details: unknown) => void) => Promise<void>} */ (getDictionaryControllerMethod('_deleteDictionaryInternal'));
    const updateDictionary = /** @type {(this: DictionaryController, dictionaryTitle: string, downloadUrl?: string) => Promise<void>} */ (getDictionaryControllerMethod('_updateDictionary'));
    const openDeleteDictionaryModal = /** @type {(this: DictionaryController, dictionaryTitle: string) => Promise<void>} */ (getDictionaryControllerMethod('deleteDictionary'));
    const getProfileNamesUsingDictionary = /** @type {(this: DictionaryController, dictionaryTitle: string) => Promise<string[]>} */ (getDictionaryControllerMethod('getProfileNamesUsingDictionary'));
    const deleteDictionarySettings = /** @type {(this: DictionaryController, dictionaryTitle: string) => Promise<void>} */ (getDictionaryControllerMethod('_deleteDictionarySettings'));
    const showUpdateDictionaryModal = /** @type {(this: DictionaryController, dictionaryTitle: string, downloadUrl?: string) => void} */ (getDictionaryControllerMethod('updateDictionary'));
    const onDictionaryConfirmUpdate = /** @type {(this: DictionaryController, e: MouseEvent) => void} */ (getDictionaryControllerMethod('_onDictionaryConfirmUpdate'));
    const checkForUpdates = /** @type {(this: DictionaryController) => Promise<void>} */ (getDictionaryControllerMethod('_checkForUpdates'));
    const clearMutationErrors = /** @type {(this: DictionaryController) => void} */ (getDictionaryControllerMethod('_clearMutationErrors'));

    test('detects queued dictionaries by title', () => {
        const controller = createControllerForInternalTests();
        Reflect.set(controller, '_dictionaryTaskQueue', [
            {type: 'update', dictionaryTitle: 'Jitendex', downloadUrl: void 0},
        ]);

        expect(isDictionaryInTaskQueue.call(controller, 'Jitendex')).toBe(true);
        expect(isDictionaryInTaskQueue.call(controller, 'JMdict')).toBe(false);
    });

    test('enqueueTask coalesces queued dictionary titles and starts the queue once', async () => {
        const controller = createControllerForInternalTests();
        const runTaskQueue = vi.fn().mockResolvedValue(void 0);
        Reflect.set(controller, '_dictionaryTaskQueue', []);
        Reflect.set(controller, '_isTaskQueueRunning', true);
        Reflect.set(controller, '_runTaskQueue', runTaskQueue);

        await enqueueTask.call(controller, {type: 'update', dictionaryTitle: 'Jitendex', downloadUrl: void 0});
        await enqueueTask.call(controller, {type: 'delete', dictionaryTitle: 'Jitendex'});
        await enqueueTask.call(controller, {type: 'update', dictionaryTitle: 'JMdict', downloadUrl: void 0});

        expect(Reflect.get(controller, '_dictionaryTaskQueue')).toStrictEqual([
            {type: 'delete', dictionaryTitle: 'Jitendex'},
            {type: 'update', dictionaryTitle: 'JMdict', downloadUrl: void 0},
        ]);
        expect(runTaskQueue).toHaveBeenCalledTimes(2);
    });

    test('enqueueTask lets delete replace a queued update for the same dictionary', async () => {
        const controller = createControllerForInternalTests();
        const runTaskQueue = vi.fn().mockResolvedValue(void 0);
        Reflect.set(controller, '_dictionaryTaskQueue', []);
        Reflect.set(controller, '_isTaskQueueRunning', true);
        Reflect.set(controller, '_runTaskQueue', runTaskQueue);

        await enqueueTask.call(controller, {type: 'update', dictionaryTitle: 'Jitendex', downloadUrl: 'https://example.com/old.zip'});
        await enqueueTask.call(controller, {type: 'delete', dictionaryTitle: 'Jitendex'});

        expect(Reflect.get(controller, '_dictionaryTaskQueue')).toStrictEqual([
            {type: 'delete', dictionaryTitle: 'Jitendex'},
        ]);
        expect(runTaskQueue).toHaveBeenCalledTimes(1);
    });

    test('enqueueTask replaces queued update metadata for the same dictionary', async () => {
        const controller = createControllerForInternalTests();
        const runTaskQueue = vi.fn().mockResolvedValue(void 0);
        Reflect.set(controller, '_dictionaryTaskQueue', []);
        Reflect.set(controller, '_isTaskQueueRunning', true);
        Reflect.set(controller, '_runTaskQueue', runTaskQueue);

        await enqueueTask.call(controller, {type: 'update', dictionaryTitle: 'Jitendex', downloadUrl: 'https://example.com/old.zip'});
        await enqueueTask.call(controller, {type: 'update', dictionaryTitle: 'Jitendex', downloadUrl: 'https://example.com/new.zip'});

        expect(Reflect.get(controller, '_dictionaryTaskQueue')).toStrictEqual([
            {type: 'update', dictionaryTitle: 'Jitendex', downloadUrl: 'https://example.com/new.zip'},
        ]);
        expect(runTaskQueue).toHaveBeenCalledTimes(1);
    });

    test('enqueueTask restarts processing when it replaces an existing queued task while idle', async () => {
        const controller = createControllerForInternalTests();
        const runTaskQueue = vi.fn().mockResolvedValue(void 0);
        Reflect.set(controller, '_dictionaryTaskQueue', [
            {type: 'update', dictionaryTitle: 'Jitendex', downloadUrl: 'https://example.com/old.zip'},
        ]);
        Reflect.set(controller, '_isTaskQueueRunning', false);
        Reflect.set(controller, '_runTaskQueue', runTaskQueue);

        await enqueueTask.call(controller, {type: 'delete', dictionaryTitle: 'Jitendex'});

        expect(Reflect.get(controller, '_dictionaryTaskQueue')).toStrictEqual([
            {type: 'delete', dictionaryTitle: 'Jitendex'},
        ]);
        expect(runTaskQueue).toHaveBeenCalledTimes(1);
    });

    test('hideUpdatesAvailableButton only touches the matching entry', () => {
        const controller = createControllerForInternalTests();
        const hideA = vi.fn();
        const hideB = vi.fn();
        Reflect.set(controller, '_dictionaryEntries', [
            {dictionaryTitle: 'Jitendex', hideUpdatesAvailableButton: hideA},
            {dictionaryTitle: 'JMdict', hideUpdatesAvailableButton: hideB},
        ]);

        hideUpdatesAvailableButton.call(controller, 'JMdict');

        expect(hideA).not.toHaveBeenCalled();
        expect(hideB).toHaveBeenCalledTimes(1);
    });

    test('confirm update clears stale modal downloadUrl after enqueueing', () => {
        const controller = createControllerForInternalTests();
        const setVisible = vi.fn();
        const enqueueTask = vi.fn();
        const hideUpdatesAvailableButton = vi.fn();
        const node = /** @type {{dataset: Record<string, string|undefined>}} */ ({
            dataset: {
                dictionaryTitle: 'Jitendex',
                downloadUrl: 'https://example.com/jitendex.zip',
            },
        });
        Reflect.set(controller, '_updateDictionaryModal', {setVisible, node});
        Reflect.set(controller, '_enqueueTask', enqueueTask);
        Reflect.set(controller, '_hideUpdatesAvailableButton', hideUpdatesAvailableButton);

        onDictionaryConfirmUpdate.call(controller, /** @type {unknown} */ ({preventDefault: vi.fn()}));

        expect(enqueueTask).toHaveBeenCalledWith({
            type: 'update',
            dictionaryTitle: 'Jitendex',
            downloadUrl: 'https://example.com/jitendex.zip',
        });
        expect(node.dataset.dictionaryTitle).toBeUndefined();
        expect(node.dataset.downloadUrl).toBeUndefined();
    });

    test('confirm update clears stale modal fields even when dictionary title is missing', () => {
        const controller = createControllerForInternalTests();
        const enqueueTask = vi.fn();
        const hideUpdatesAvailableButton = vi.fn();
        const node = /** @type {{dataset: Record<string, string|undefined>}} */ ({
            dataset: {
                downloadUrl: 'https://example.com/jitendex.zip',
            },
        });
        Reflect.set(controller, '_updateDictionaryModal', {setVisible: vi.fn(), node});
        Reflect.set(controller, '_enqueueTask', enqueueTask);
        Reflect.set(controller, '_hideUpdatesAvailableButton', hideUpdatesAvailableButton);

        onDictionaryConfirmUpdate.call(controller, /** @type {unknown} */ ({preventDefault: vi.fn()}));

        expect(enqueueTask).not.toHaveBeenCalled();
        expect(hideUpdatesAvailableButton).not.toHaveBeenCalled();
        expect(node.dataset.dictionaryTitle).toBeUndefined();
        expect(node.dataset.downloadUrl).toBeUndefined();
    });

    test('confirm update normalizes invalid modal downloadUrl values before enqueueing', () => {
        const controller = createControllerForInternalTests();
        const enqueueTask = vi.fn();
        const hideUpdatesAvailableButton = vi.fn();
        const node = /** @type {{dataset: Record<string, string|undefined>}} */ ({
            dataset: {
                dictionaryTitle: 'Jitendex',
                downloadUrl: 'undefined',
            },
        });
        Reflect.set(controller, '_updateDictionaryModal', {setVisible: vi.fn(), node});
        Reflect.set(controller, '_enqueueTask', enqueueTask);
        Reflect.set(controller, '_hideUpdatesAvailableButton', hideUpdatesAvailableButton);

        onDictionaryConfirmUpdate.call(controller, /** @type {unknown} */ ({preventDefault: vi.fn()}));

        expect(enqueueTask).toHaveBeenCalledWith({
            type: 'update',
            dictionaryTitle: 'Jitendex',
            downloadUrl: undefined,
        });
        expect(hideUpdatesAvailableButton).toHaveBeenCalledWith('Jitendex');
        expect(node.dataset.dictionaryTitle).toBeUndefined();
        expect(node.dataset.downloadUrl).toBeUndefined();
    });

    test('confirm delete clears stale modal title even when dictionary title is missing', () => {
        const controller = createControllerForInternalTests();
        const enqueueTask = vi.fn();
        const hideUpdatesAvailableButton = vi.fn();
        const node = /** @type {{dataset: Record<string, string|undefined>}} */ ({
            dataset: {
                dictionaryTitle: undefined,
            },
        });
        Reflect.set(controller, '_deleteDictionaryModal', {setVisible: vi.fn(), node});
        Reflect.set(controller, '_enqueueTask', enqueueTask);
        Reflect.set(controller, '_hideUpdatesAvailableButton', hideUpdatesAvailableButton);

        const onDictionaryConfirmDelete = /** @type {(this: DictionaryController, e: MouseEvent) => void} */ (getDictionaryControllerMethod('_onDictionaryConfirmDelete'));
        onDictionaryConfirmDelete.call(controller, /** @type {unknown} */ ({preventDefault: vi.fn()}));

        expect(enqueueTask).not.toHaveBeenCalled();
        expect(hideUpdatesAvailableButton).not.toHaveBeenCalled();
        expect(node.dataset.dictionaryTitle).toBeUndefined();
    });

    test('updateDictionary does not persist the string "undefined" as modal downloadUrl', () => {
        const controller = createControllerForInternalTests();
        const setVisible = vi.fn();
        const nameElement = {textContent: ''};
        const node = /** @type {{dataset: Record<string, string|undefined>, querySelector: (selector: string) => unknown}} */ ({
            dataset: {downloadUrl: 'https://example.com/stale.zip'},
            querySelector(selector) {
                if (selector === '#dictionary-confirm-update-name') { return nameElement; }
                return null;
            },
        });
        Reflect.set(controller, '_updateDictionaryModal', {setVisible, node});

        showUpdateDictionaryModal.call(controller, 'Jitendex', undefined);

        expect(node.dataset.dictionaryTitle).toBe('Jitendex');
        expect(node.dataset.downloadUrl).toBeUndefined();
        expect(nameElement.textContent).toBe('Jitendex');
        expect(setVisible).toHaveBeenCalledWith(true);
    });

    test('updateDictionary does not mutate modal dataset when modal content lookup fails', () => {
        const controller = createControllerForInternalTests();
        const node = /** @type {{dataset: Record<string, string|undefined>, querySelector: (selector: string) => unknown}} */ ({
            dataset: {dictionaryTitle: 'Old Title', downloadUrl: 'https://example.com/stale.zip'},
            querySelector() {
                return null;
            },
        });
        Reflect.set(controller, '_updateDictionaryModal', {setVisible: vi.fn(), node});

        expect(() => {
            showUpdateDictionaryModal.call(controller, 'Jitendex', 'https://example.com/jitendex.zip');
        }).toThrow();
        expect(node.dataset.dictionaryTitle).toBe('Old Title');
        expect(node.dataset.downloadUrl).toBe('https://example.com/stale.zip');
    });

    test('deleteDictionary does not mutate modal dataset when profile lookup UI is missing', async () => {
        const controller = createControllerForInternalTests();
        const nameElement = {textContent: ''};
        const node = /** @type {{dataset: Record<string, string|undefined>, querySelector: (selector: string) => unknown}} */ ({
            dataset: {dictionaryTitle: 'Old Title'},
            querySelector(selector) {
                if (selector === '#dictionary-confirm-delete-name') { return nameElement; }
                return null;
            },
        });
        Reflect.set(controller, '_deleteDictionaryModal', {setVisible: vi.fn(), node});

        await openDeleteDictionaryModal.call(controller, 'Jitendex');

        expect(node.dataset.dictionaryTitle).toBe('Old Title');
        expect(nameElement.textContent).toBe('Jitendex');
    });

    test('getProfileNamesUsingDictionary includes disabled, main, and sort-frequency references', async () => {
        const controller = createControllerForInternalTests();
        Reflect.set(controller, '_settingsController', {
            getOptionsFull: vi.fn().mockResolvedValue({
                profiles: [
                    {
                        name: 'Disabled reference',
                        options: {
                            dictionaries: [{name: 'Jitendex', enabled: false}],
                            general: {mainDictionary: '', sortFrequencyDictionary: null},
                        },
                    },
                    {
                        name: 'Main dictionary reference',
                        options: {
                            dictionaries: [],
                            general: {mainDictionary: 'Jitendex', sortFrequencyDictionary: null},
                        },
                    },
                    {
                        name: 'Sort frequency reference',
                        options: {
                            dictionaries: [],
                            general: {mainDictionary: '', sortFrequencyDictionary: 'Jitendex'},
                        },
                    },
                    {
                        name: 'Unrelated',
                        options: {
                            dictionaries: [{name: 'JMdict', enabled: true}],
                            general: {mainDictionary: 'JMdict', sortFrequencyDictionary: 'Freq'},
                        },
                    },
                ],
            }),
        });

        await expect(getProfileNamesUsingDictionary.call(controller, 'Jitendex')).resolves.toStrictEqual([
            'Disabled reference',
            'Main dictionary reference',
            'Sort frequency reference',
        ]);
    });

    test('deleteDictionarySettings removes duplicate dictionary entries from a profile in descending index order', async () => {
        const controller = createControllerForInternalTests();
        const modifyGlobalSettings = vi.fn().mockResolvedValue(void 0);
        Reflect.set(controller, '_settingsController', {
            getOptionsFull: vi.fn().mockResolvedValue({
                profiles: [
                    {
                        options: {
                            dictionaries: [
                                {name: 'JMdict', enabled: true},
                                {name: 'Jitendex', enabled: true},
                                {name: 'Jitendex', enabled: false},
                                {name: 'Other', enabled: true},
                            ],
                            general: {mainDictionary: 'Jitendex', sortFrequencyDictionary: 'Jitendex'},
                        },
                    },
                ],
            }),
            modifyGlobalSettings,
        });

        await deleteDictionarySettings.call(controller, 'Jitendex');

        expect(modifyGlobalSettings).toHaveBeenCalledWith([
            {
                action: 'splice',
                path: 'profiles[0].options.dictionaries',
                start: 2,
                deleteCount: 1,
                items: [],
            },
            {
                action: 'splice',
                path: 'profiles[0].options.dictionaries',
                start: 1,
                deleteCount: 1,
                items: [],
            },
            {
                action: 'set',
                path: 'profiles[0].options.general.mainDictionary',
                value: '',
            },
            {
                action: 'set',
                path: 'profiles[0].options.general.sortFrequencyDictionary',
                value: null,
            },
        ]);
    });

    test('runTaskQueue clears the running flag and continues after a task failure', async () => {
        const controller = createControllerForInternalTests();
        const deleteDictionary = vi.fn().mockRejectedValue(new Error('delete failed'));
        const updateDictionary = vi.fn().mockResolvedValue(void 0);
        const showMutationError = vi.fn();
        const showUpdatesAvailableButton = vi.fn();
        Reflect.set(controller, '_dictionaryTaskQueue', [
            {type: 'delete', dictionaryTitle: 'Jitendex'},
            {type: 'update', dictionaryTitle: 'JMdict', downloadUrl: 'https://example.com/jmdict.zip'},
        ]);
        Reflect.set(controller, '_isTaskQueueRunning', false);
        Reflect.set(controller, '_deleteDictionary', deleteDictionary);
        Reflect.set(controller, '_updateDictionary', updateDictionary);
        Reflect.set(controller, '_showMutationError', showMutationError);
        Reflect.set(controller, '_showUpdatesAvailableButton', showUpdatesAvailableButton);

        await runTaskQueue.call(controller);

        expect(deleteDictionary).toHaveBeenCalledWith('Jitendex');
        expect(updateDictionary).toHaveBeenCalledWith('JMdict', 'https://example.com/jmdict.zip');
        expect(showMutationError).toHaveBeenCalledTimes(1);
        expect(showUpdatesAvailableButton).toHaveBeenCalledWith('Jitendex');
        expect(Reflect.get(controller, '_dictionaryTaskQueue')).toStrictEqual([]);
        expect(Reflect.get(controller, '_isTaskQueueRunning')).toBe(false);
    });

    test('runTaskQueue restores update availability when a delete task fails', async () => {
        const controller = createControllerForInternalTests();
        const deleteDictionary = vi.fn().mockRejectedValue(new Error('delete failed'));
        const showMutationError = vi.fn();
        const showUpdatesAvailableButton = vi.fn();
        Reflect.set(controller, '_dictionaryTaskQueue', [
            {type: 'delete', dictionaryTitle: 'Jitendex'},
        ]);
        Reflect.set(controller, '_isTaskQueueRunning', false);
        Reflect.set(controller, '_deleteDictionary', deleteDictionary);
        Reflect.set(controller, '_updateDictionary', vi.fn());
        Reflect.set(controller, '_showMutationError', showMutationError);
        Reflect.set(controller, '_showUpdatesAvailableButton', showUpdatesAvailableButton);

        await runTaskQueue.call(controller);

        expect(showMutationError).toHaveBeenCalledTimes(1);
        expect(showUpdatesAvailableButton).toHaveBeenCalledWith('Jitendex');
    });

    test('deleteDictionaryInternal clears the update waiter if triggerDatabaseUpdated throws', async () => {
        const controller = createControllerForInternalTests();
        Reflect.set(controller, '_settingsController', {
            application: {
                api: {
                    deleteDictionaryByTitle: vi.fn().mockResolvedValue(void 0),
                    triggerDatabaseUpdated: vi.fn().mockRejectedValue(new Error('refresh failed')),
                },
            },
        });

        await expect(deleteDictionaryInternal.call(controller, 'Jitendex', vi.fn())).rejects.toThrow(/refresh failed/);
        expect(Reflect.get(controller, '_onDictionariesUpdate')).toBeNull();
    });

    test('deleteDictionaryInternal times out if dictionary refresh never arrives', async () => {
        const controller = createControllerForInternalTests();
        Reflect.set(controller, '_getMutationCallbackTimeoutMs', () => 1);
        Reflect.set(controller, '_settingsController', {
            application: {
                api: {
                    deleteDictionaryByTitle: vi.fn().mockResolvedValue(void 0),
                    triggerDatabaseUpdated: vi.fn().mockResolvedValue(void 0),
                },
            },
        });

        await expect(deleteDictionaryInternal.call(controller, 'Jitendex', vi.fn())).rejects.toThrow(/Timed out waiting for dictionary delete refresh/);
        expect(Reflect.get(controller, '_onDictionariesUpdate')).toBeNull();
    });

    test('updateDictionary times out if replacement download callback never resolves', async () => {
        const controller = createControllerForInternalTests();
        Reflect.set(controller, '_checkingIntegrity', false);
        Reflect.set(controller, '_checkingUpdates', false);
        Reflect.set(controller, '_dictionaries', [{title: 'Jitendex', downloadUrl: 'https://example.com/jitendex.zip'}]);
        Reflect.set(controller, '_getMutationCallbackTimeoutMs', () => 1);
        Reflect.set(controller, '_settingsController', {
            getOptionsFull: vi.fn().mockResolvedValue({profiles: []}),
            downloadDictionaryFromUrl: vi.fn(() => new Promise(() => {})),
        });

        await expect(updateDictionary.call(controller, 'Jitendex')).rejects.toThrow(/Timed out downloading replacement dictionary/);
    });

    test('updateDictionary times out if replacement import callback never resolves', async () => {
        const controller = createControllerForInternalTests();
        Reflect.set(controller, '_checkingIntegrity', false);
        Reflect.set(controller, '_checkingUpdates', false);
        Reflect.set(controller, '_dictionaries', [{title: 'Jitendex', downloadUrl: 'https://example.com/jitendex.zip'}]);
        Reflect.set(controller, '_getMutationCallbackTimeoutMs', () => 1);
        Reflect.set(controller, '_validateUpdatedDictionaryState', vi.fn().mockResolvedValue(void 0));
        Reflect.set(controller, '_settingsController', {
            getOptionsFull: vi.fn().mockResolvedValue({profiles: []}),
            downloadDictionaryFromUrl: vi.fn().mockResolvedValue(new File([new Uint8Array([1])], 'jitendex.zip', {type: 'application/zip'})),
            importDictionaryFromFile: vi.fn(() => new Promise(() => {})),
            application: {
                api: {
                    getDictionaryInfo: vi.fn().mockResolvedValue([]),
                },
            },
        });

        await expect(updateDictionary.call(controller, 'Jitendex')).rejects.toThrow(/Timed out importing replacement dictionary/);
    });

    test('updateDictionary treats timed-out replacement import as success when backend state already converged', async () => {
        const controller = createControllerForInternalTests();
        const getDictionaryInfo = vi.fn().mockResolvedValue([
            {title: 'Jitendex', updateSessionToken: 'recover01'},
        ]);
        Reflect.set(controller, '_checkingIntegrity', false);
        Reflect.set(controller, '_checkingUpdates', false);
        Reflect.set(controller, '_dictionaries', [{title: 'Jitendex', downloadUrl: 'https://example.com/jitendex.zip'}]);
        Reflect.set(controller, '_getMutationCallbackTimeoutMs', () => 1);
        Reflect.set(controller, '_createUpdateImportToken', () => 'recover01');
        Reflect.set(controller, '_settingsController', {
            getOptionsFull: vi.fn().mockResolvedValue({profiles: []}),
            downloadDictionaryFromUrl: vi.fn().mockResolvedValue(new File([new Uint8Array([1])], 'jitendex.zip', {type: 'application/zip'})),
            importDictionaryFromFile: vi.fn(() => new Promise(() => {})),
            application: {
                api: {
                    getDictionaryInfo,
                },
            },
        });
        await expect(updateDictionary.call(controller, 'Jitendex')).resolves.toBeUndefined();

        expect(getDictionaryInfo).toHaveBeenCalled();
    });

    test('checkForUpdates keeps successful update results when one dictionary check fails', async () => {
        const controller = createControllerForInternalTests();
        const button = {textContent: '', disabled: false};
        const setButtonsEnabled = vi.fn();
        const showMutationError = vi.fn();
        Reflect.set(controller, '_dictionaries', []);
        Reflect.set(controller, '_checkingIntegrity', false);
        Reflect.set(controller, '_checkingUpdates', false);
        Reflect.set(controller, '_isTaskQueueRunning', false);
        Reflect.set(controller, '_setButtonsEnabled', setButtonsEnabled);
        Reflect.set(controller, '_showMutationError', showMutationError);
        Reflect.set(controller, '_checkUpdatesButton', button);
        Reflect.set(controller, '_dictionaryEntries', [
            {checkForUpdate: vi.fn().mockResolvedValue(true)},
            {checkForUpdate: vi.fn().mockRejectedValue(new Error('index fetch failed'))},
        ]);

        await checkForUpdates.call(controller);

        expect(button.textContent).toBe('1 update');
        expect(button.disabled).toBe(false);
        expect(showMutationError).toHaveBeenCalledTimes(1);
        expect(Reflect.get(controller, '_checkingUpdates')).toBe(false);
        expect(setButtonsEnabled).toHaveBeenNthCalledWith(1, false);
        expect(setButtonsEnabled).toHaveBeenNthCalledWith(2, true);
    });

    test('checkForUpdates keeps the button retryable when all update checks fail', async () => {
        const controller = createControllerForInternalTests();
        const button = {textContent: '', disabled: false};
        const showMutationError = vi.fn();
        Reflect.set(controller, '_dictionaries', []);
        Reflect.set(controller, '_checkingIntegrity', false);
        Reflect.set(controller, '_checkingUpdates', false);
        Reflect.set(controller, '_isTaskQueueRunning', false);
        Reflect.set(controller, '_setButtonsEnabled', vi.fn());
        Reflect.set(controller, '_showMutationError', showMutationError);
        Reflect.set(controller, '_checkUpdatesButton', button);
        Reflect.set(controller, '_dictionaryEntries', [
            {checkForUpdate: vi.fn().mockRejectedValue(new Error('index fetch failed'))},
        ]);

        await checkForUpdates.call(controller);

        expect(button.textContent).toBe('Check failed');
        expect(button.disabled).toBe(false);
        expect(showMutationError).toHaveBeenCalledTimes(1);
    });

    test('clearMutationErrors is a no-op when there is no document', () => {
        const controller = createControllerForInternalTests();

        expect(() => clearMutationErrors.call(controller)).not.toThrow();
    });

    test('checkForUpdates clears stale mutation errors before a successful retry', async () => {
        const controller = createControllerForInternalTests();
        const button = {textContent: '', disabled: false};
        const clearMutationErrorsSpy = vi.fn();
        Reflect.set(controller, '_dictionaries', []);
        Reflect.set(controller, '_checkingIntegrity', false);
        Reflect.set(controller, '_checkingUpdates', false);
        Reflect.set(controller, '_isTaskQueueRunning', false);
        Reflect.set(controller, '_setButtonsEnabled', vi.fn());
        Reflect.set(controller, '_showMutationError', vi.fn());
        Reflect.set(controller, '_checkUpdatesButton', button);
        Reflect.set(controller, '_dictionaryEntries', [
            {checkForUpdate: vi.fn().mockResolvedValue(false)},
        ]);
        Reflect.set(controller, '_clearMutationErrors', clearMutationErrorsSpy);

        await checkForUpdates.call(controller);

        expect(clearMutationErrorsSpy).toHaveBeenCalledTimes(1);
        expect(button.textContent).toBe('No updates');
    });
});
