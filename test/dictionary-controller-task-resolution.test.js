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
import {DictionaryController} from '../ext/js/pages/settings/dictionary-controller.js';

/**
 * @returns {DictionaryController}
 */
function createControllerForInternalTests() {
    return /** @type {DictionaryController} */ (Object.create(DictionaryController.prototype));
}

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

describe('DictionaryController task dictionary resolution', () => {
    const getDictionaryInfoForTask = /** @type {(this: DictionaryController, dictionaryTitle: string) => Promise<unknown>} */ (getDictionaryControllerMethod('_getDictionaryInfoForTask'));
    const importReplacementDictionary = /** @type {(this: DictionaryController, dictionaryTitle: string, downloadUrl: string, profilesDictionarySettings: import('settings-controller').ProfilesDictionarySettings, importToken: string, stagedDictionaryTitle: string) => Promise<import('settings-controller').ImportDictionaryDoneResult>} */ (getDictionaryControllerMethod('_importReplacementDictionary'));
    const importReplacementDictionaryFromFiles = /** @type {(this: DictionaryController, dictionaryTitle: string, files: File[], profilesDictionarySettings: import('settings-controller').ProfilesDictionarySettings, importToken: string, stagedDictionaryTitle: string) => Promise<import('settings-controller').ImportDictionaryDoneResult>} */ (getDictionaryControllerMethod('_importReplacementDictionaryFromFiles'));
    const recoverTimedOutUpdateState = /** @type {(this: DictionaryController, dictionaryTitle: string, importToken: string, stagedDictionaryTitle: string) => Promise<boolean>} */ (getDictionaryControllerMethod('_recoverTimedOutUpdateState'));

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('resolves a shorthand queued update title to the unique installed dictionary title', async () => {
        const controller = createControllerForInternalTests();
        const getDictionaryInfo = vi.fn().mockResolvedValue([
            {title: 'Jitendex.org [2026-02-05]', downloadUrl: 'https://example.invalid/jitendex.zip'},
            {title: 'JMdict [2026-02-26]', downloadUrl: 'https://example.invalid/jmdict.zip'},
        ]);
        Reflect.set(controller, '_dictionaries', null);
        Reflect.set(controller, '_settingsController', {getDictionaryInfo});

        const result = await getDictionaryInfoForTask.call(controller, 'Jitendex');

        expect(result).toMatchObject({title: 'Jitendex.org [2026-02-05]'});
        expect(getDictionaryInfo).toHaveBeenCalledTimes(1);
    });

    test('imports replacements by URL without cloning a large archive through the settings page', async () => {
        const controller = createControllerForInternalTests();
        const result = {ok: true, errors: [], importedTitles: ['Jitendex']};
        const importDictionaryFromUrl = vi.fn().mockResolvedValue(result);
        Reflect.set(controller, '_settingsController', {importDictionaryFromUrl});
        Reflect.set(controller, '_getMutationCallbackTimeoutMs', vi.fn(() => 10_000));

        await expect(importReplacementDictionary.call(
            controller,
            'Jitendex',
            'https://example.invalid/jitendex.zip',
            {},
            'token123',
            'Jitendex [update-staging token123]',
        )).resolves.toBe(result);

        expect(importDictionaryFromUrl).toHaveBeenCalledWith(
            'https://example.invalid/jitendex.zip',
            {},
            {
                dictionaryTitleOverride: 'Jitendex [update-staging token123]',
                replacementDictionaryTitle: 'Jitendex',
                updateSessionToken: 'token123',
                useImportSession: false,
                finalizeImportSession: false,
            },
        );
    });

    test('imports local recovery files through the staged replacement path', async () => {
        const controller = createControllerForInternalTests();
        const files = [new File(['dictionary'], 'jmdict.zip', {type: 'application/zip'})];
        const result = {ok: true, errors: [], importedTitles: ['JMdict']};
        const importDictionaryFromFile = vi.fn().mockResolvedValue(result);
        Reflect.set(controller, '_settingsController', {importDictionaryFromFile});
        Reflect.set(controller, '_getMutationCallbackTimeoutMs', vi.fn(() => 10_000));

        await expect(importReplacementDictionaryFromFiles.call(
            controller,
            'JMdict',
            files,
            {},
            'token123',
            'JMdict [update-staging token123]',
        )).resolves.toBe(result);

        expect(importDictionaryFromFile).toHaveBeenCalledWith(
            files,
            {},
            {
                dictionaryTitleOverride: 'JMdict [update-staging token123]',
                replacementDictionaryTitle: 'JMdict',
                updateSessionToken: 'token123',
                useImportSession: false,
                finalizeImportSession: false,
            },
        );
    });

    test('does not delete staging state while a timed-out update may still be running', async () => {
        const controller = createControllerForInternalTests();
        const getDictionaryInfo = vi.fn().mockResolvedValue([
            {title: 'Jitendex', updateSessionToken: 'old-token'},
            {title: 'Jitendex [update-staging token123]', updateSessionToken: 'token123'},
        ]);
        const deleteDictionaryInternal = vi.fn();
        const deleteDictionarySettings = vi.fn();
        Reflect.set(controller, '_settingsController', {application: {api: {getDictionaryInfo}}});
        Reflect.set(controller, '_deleteDictionaryInternal', deleteDictionaryInternal);
        Reflect.set(controller, '_deleteDictionarySettings', deleteDictionarySettings);

        await expect(recoverTimedOutUpdateState.call(
            controller,
            'Jitendex',
            'token123',
            'Jitendex [update-staging token123]',
        )).resolves.toBe(false);

        expect(getDictionaryInfo).toHaveBeenCalledOnce();
        expect(deleteDictionaryInternal).not.toHaveBeenCalled();
        expect(deleteDictionarySettings).not.toHaveBeenCalled();
    });

    test('accepts a timed-out update only when its final token is installed', async () => {
        const controller = createControllerForInternalTests();
        const getDictionaryInfo = vi.fn().mockResolvedValue([
            {title: 'Jitendex', updateSessionToken: 'token123'},
        ]);
        Reflect.set(controller, '_settingsController', {application: {api: {getDictionaryInfo}}});

        await expect(recoverTimedOutUpdateState.call(
            controller,
            'Jitendex',
            'token123',
            'Jitendex [update-staging token123]',
        )).resolves.toBe(true);
    });
});
