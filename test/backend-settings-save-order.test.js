/*
 * Copyright (C) 2026  Manabitan Authors
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
import {Backend} from '../ext/js/background/backend.js';
import {log} from '../ext/js/core/log.js';

/**
 * @param {(options: import('settings').Options) => Promise<void>} save
 * @returns {{backend: Backend, options: {value: string}, applyOptions: ReturnType<typeof vi.fn>, clearCache: ReturnType<typeof vi.fn>}}
 */
function createBackend(save) {
    const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
    const options = {value: 'initial'};
    const applyOptions = vi.fn();
    const clearCache = vi.fn();
    Reflect.set(backend, '_options', options);
    Reflect.set(backend, '_optionsUtil', {save});
    Reflect.set(backend, '_applyOptions', applyOptions);
    Reflect.set(backend, '_clearProfileConditionsSchemaCache', clearCache);
    return {backend, options, applyOptions, clearCache};
}

describe('Backend settings persistence ordering', () => {
    test('a newer settings snapshot cannot be overwritten by a delayed earlier save', async () => {
        const firstEntered = Promise.withResolvers();
        const releaseFirst = Promise.withResolvers();
        /** @type {string[]} */
        const persisted = [];
        let attempts = 0;
        const save = vi.fn(async (/** @type {import('settings').Options} */ options) => {
            const snapshot = /** @type {unknown} */ (Reflect.get(options, 'value'));
            if (++attempts === 1) {
                firstEntered.resolve(void 0);
                await releaseFirst.promise;
            }
            persisted.push(String(snapshot));
        });
        const {backend, applyOptions, clearCache} = createBackend(async (options) => { await save(options); });
        Reflect.set(backend, '_modifySetting', (/** @type {import('settings-modifications').ScopedModification} */ target) => {
            const current = /** @type {{value: string}} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
            if (target.action !== 'set' || target.path !== 'value') { throw new Error('Unexpected mutation'); }
            current.value = /** @type {string} */ (target.value);
            return target.value;
        });
        /** @type {import('settings-modifications').ScopedModification} */
        const firstTarget = {action: 'set', scope: 'global', optionsContext: null, path: 'value', value: 'first'};
        /** @type {import('settings-modifications').ScopedModification} */
        const secondTarget = {...firstTarget, value: 'second'};

        const earlier = backend._modifySettings([firstTarget], 'first');
        await firstEntered.promise;
        const later = backend._modifySettings([secondTarget], 'second');
        await Promise.resolve();

        expect(save).toHaveBeenCalledOnce();
        releaseFirst.resolve(void 0);
        await Promise.all([earlier, later]);

        expect(persisted).toStrictEqual(['first', 'second']);
        expect(applyOptions.mock.calls).toStrictEqual([['first'], ['second']]);
        expect(clearCache).toHaveBeenCalledTimes(2);
    });

    test('settings reads see only committed state until an asynchronous save finishes', async () => {
        const saveStarted = Promise.withResolvers();
        const releaseSave = Promise.withResolvers();
        const save = vi.fn(async () => {
            saveStarted.resolve(void 0);
            await releaseSave.promise;
        });
        const {backend, options} = createBackend(save);
        Reflect.set(backend, '_modifySetting', (/** @type {import('settings-modifications').ScopedModification} */ target) => {
            const draft = /** @type {{value: string}} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
            if (target.action === 'set') { draft.value = /** @type {string} */ (target.value); }
            return true;
        });
        Reflect.set(backend, '_getSetting', () => /** @type {{value: string}} */ (/** @type {unknown} */ (Reflect.get(backend, '_options'))).value);
        /** @type {import('settings-modifications').ScopedModification} */
        const modification = {action: 'set', scope: 'global', optionsContext: null, path: 'value', value: 'not yet committed'};
        /** @type {import('settings-modifications').ScopedRead} */
        const read = {scope: 'global', optionsContext: null, path: 'value'};

        const pending = backend._modifySettings([modification], 'settings');
        await saveStarted.promise;

        expect(Reflect.get(backend, '_options')).toBe(options);
        expect(backend._onApiGetSettings({targets: [read]}, /** @type {chrome.runtime.MessageSender} */ ({}))).toEqual([{result: 'initial'}]);
        releaseSave.resolve(void 0);
        await pending;

        expect(Reflect.get(backend, '_options')).not.toBe(options);
        expect(backend._onApiGetSettings({targets: [read]}, /** @type {chrome.runtime.MessageSender} */ ({}))).toEqual([{result: 'not yet committed'}]);
    });

    test('failed mutation persistence restores the previous in-memory settings', async () => {
        const options = {value: 'persisted'};
        const save = vi.fn()
            .mockRejectedValueOnce(new Error('disk full'))
            .mockResolvedValueOnce(void 0);
        const {backend, applyOptions} = createBackend(save);
        Reflect.set(backend, '_options', options);
        Reflect.set(backend, '_modifySetting', (/** @type {import('settings-modifications').ScopedModification} */ target) => {
            if (target.action !== 'set' || target.path !== 'value') { throw new Error('Unexpected mutation'); }
            const current = /** @type {{value: string}} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
            current.value = /** @type {string} */ (target.value);
            return target.value;
        });
        /** @type {import('settings-modifications').ScopedModification} */
        const failedTarget = {action: 'set', scope: 'global', optionsContext: null, path: 'value', value: 'unpersisted'};
        /** @type {import('settings-modifications').ScopedModification} */
        const laterTarget = {action: 'set', scope: 'global', optionsContext: null, path: 'value', value: 'second write'};

        const failed = backend._modifySettings([failedTarget], 'first');
        await expect(failed).rejects.toThrow('disk full');
        expect(Reflect.get(backend, '_options')).toBe(options);
        expect(options.value).toBe('persisted');

        const later = backend._modifySettings([laterTarget], 'second');
        await expect(later).resolves.toEqual([{result: 'second write'}]);

        expect(save).toHaveBeenCalledTimes(2);
        expect(/** @type {{value: string}} */ (/** @type {unknown} */ (Reflect.get(backend, '_options'))).value).toBe('second write');
        expect(applyOptions).toHaveBeenCalledOnce();
        expect(applyOptions).toHaveBeenCalledWith('second');
    });

    test('an apply-time failure after persistence does not roll committed state back', async () => {
        const save = vi.fn().mockResolvedValue(void 0);
        const {backend, options} = createBackend(save);
        const report = vi.spyOn(log, 'error').mockImplementation(() => {});
        Reflect.set(backend, '_applyOptions', () => { throw new Error('runtime listener failed'); });
        Reflect.set(backend, '_modifySetting', (/** @type {import('settings-modifications').ScopedModification} */ target) => {
            const current = /** @type {{value: string}} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
            if (target.action === 'set') { current.value = /** @type {string} */ (target.value); }
            return true;
        });
        /** @type {import('settings-modifications').ScopedModification} */
        const target = {action: 'set', scope: 'global', optionsContext: null, path: 'value', value: 'committed'};
        try {
            await expect(backend._modifySettings([target], 'settings')).resolves.toEqual([{result: true}]);
            expect(Reflect.get(backend, '_options')).not.toBe(options);
            expect(/** @type {{value: string}} */ (/** @type {unknown} */ (Reflect.get(backend, '_options'))).value).toBe('committed');
            expect(save).toHaveBeenCalledOnce();
            expect(report).toHaveBeenCalledOnce();
        } finally {
            report.mockRestore();
        }
    });

    test('fully rejected modification batches do not save or apply options', async () => {
        const save = vi.fn().mockResolvedValue(void 0);
        const {backend, options, applyOptions, clearCache} = createBackend(save);
        Reflect.set(backend, '_modifySetting', () => { throw new Error('invalid setting'); });
        /** @type {import('settings-modifications').ScopedModification} */
        const target = {action: 'set', scope: 'global', optionsContext: null, path: 'invalid', value: 1};

        const response = await backend._modifySettings([target], 'invalid');

        expect(response).toHaveLength(1);
        expect(response[0].error).toMatchObject({message: 'invalid setting'});
        expect(Reflect.get(backend, '_options')).toBe(options);
        expect(save).not.toHaveBeenCalled();
        expect(applyOptions).not.toHaveBeenCalled();
        expect(clearCache).not.toHaveBeenCalled();
    });

    test('full-options replacement waits for an earlier mutation to settle', async () => {
        const firstEntered = Promise.withResolvers();
        const releaseFirst = Promise.withResolvers();
        let attempts = 0;
        const save = vi.fn(async () => {
            if (++attempts === 1) {
                firstEntered.resolve(void 0);
                await releaseFirst.promise;
            }
        });
        const {backend, applyOptions} = createBackend(save);
        const validate = vi.fn();
        Reflect.set(backend, '_optionsUtil', {save, validate});
        Reflect.set(backend, '_getCurrentProfileEnabledDictionaryNames', () => []);
        Reflect.set(backend, '_areStringArraysEqual', () => true);
        Reflect.set(backend, '_warmEnabledDictionaryLookupCaches', vi.fn());
        Reflect.set(backend, '_modifySetting', (/** @type {import('settings-modifications').ScopedModification} */ target) => {
            const current = /** @type {{value: string}} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
            if (target.action === 'set') { current.value = /** @type {string} */ (target.value); }
            return true;
        });
        /** @type {import('settings-modifications').ScopedModification} */
        const target = {action: 'set', scope: 'global', optionsContext: null, path: 'value', value: 'before replacement'};

        const earlier = backend._modifySettings([target], 'mutate');
        await firstEntered.promise;
        const replacement = backend._onApiSetAllSettings({
            value: /** @type {import('settings').Options} */ (/** @type {unknown} */ ({value: 'replacement'})),
            source: 'replace',
        }, /** @type {chrome.runtime.MessageSender} */ ({}));
        await Promise.resolve();
        expect(validate).not.toHaveBeenCalled();
        expect(save).toHaveBeenCalledOnce();
        releaseFirst.resolve(void 0);
        await Promise.all([earlier, replacement]);

        expect(validate).toHaveBeenCalledOnce();
        expect(save).toHaveBeenCalledTimes(2);
        expect(applyOptions.mock.calls).toStrictEqual([['mutate'], ['replace']]);
        expect(/** @type {{value: string}} */ (/** @type {unknown} */ (Reflect.get(backend, '_options'))).value).toBe('replacement');
    });

    test('an earlier storage failure does not poison an already queued edit', async () => {
        const save = vi.fn()
            .mockRejectedValueOnce(new Error('storage unavailable'))
            .mockResolvedValueOnce(void 0);
        const {backend, applyOptions} = createBackend(save);
        Reflect.set(backend, '_modifySetting', (/** @type {import('settings-modifications').ScopedModification} */ target) => {
            const current = /** @type {{value: string}} */ (/** @type {unknown} */ (Reflect.get(backend, '_options')));
            if (target.action !== 'set') { throw new Error('Unexpected mutation'); }
            current.value = /** @type {string} */ (target.value);
            return target.value;
        });
        /** @type {import('settings-modifications').ScopedModification} */
        const failedTarget = {action: 'set', scope: 'global', optionsContext: null, path: 'value', value: 'failed'};
        /** @type {import('settings-modifications').ScopedModification} */
        const retryTarget = {...failedTarget, value: 'retry'};

        const earlier = backend._modifySettings([failedTarget], 'failed');
        const later = backend._modifySettings([retryTarget], 'retry');

        await expect(earlier).rejects.toThrow('storage unavailable');
        await expect(later).resolves.toEqual([{result: 'retry'}]);
        expect(save).toHaveBeenCalledTimes(2);
        expect(applyOptions).toHaveBeenCalledOnce();
        expect(applyOptions).toHaveBeenCalledWith('retry');
        expect(/** @type {{value: string}} */ (/** @type {unknown} */ (Reflect.get(backend, '_options'))).value).toBe('retry');
    });
});
