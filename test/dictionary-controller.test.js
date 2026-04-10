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
        Reflect.set(controller, '_runTaskQueue', runTaskQueue);

        await enqueueTask.call(controller, {type: 'update', dictionaryTitle: 'Jitendex', downloadUrl: 'https://example.com/old.zip'});
        await enqueueTask.call(controller, {type: 'update', dictionaryTitle: 'Jitendex', downloadUrl: 'https://example.com/new.zip'});

        expect(Reflect.get(controller, '_dictionaryTaskQueue')).toStrictEqual([
            {type: 'update', dictionaryTitle: 'Jitendex', downloadUrl: 'https://example.com/new.zip'},
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
            trigger: vi.fn(),
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
            trigger: vi.fn((eventName, details) => {
                if (eventName === 'downloadDictionaryFromUrl') {
                    details.onDownloadDone(new File([new Uint8Array([1])], 'jitendex.zip', {type: 'application/zip'}));
                }
            }),
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
            trigger: vi.fn((eventName, details) => {
                if (eventName === 'downloadDictionaryFromUrl') {
                    details.onDownloadDone(new File([new Uint8Array([1])], 'jitendex.zip', {type: 'application/zip'}));
                }
            }),
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
