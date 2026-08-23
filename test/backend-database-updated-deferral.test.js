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
import {Backend} from '../ext/js/background/backend.js';

function createGate() {
    /** @type {() => void} */
    let resolve = () => {};
    const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise;
    });
    return {promise, resolve};
}

describe('Backend database update deferral', () => {
    test('successful import update reuses worker-side translator invalidation', async () => {
        const clearDatabaseCaches = vi.fn();
        const refreshDictionaryDatabaseAfterUpdate = vi.fn().mockResolvedValue(void 0);
        const sendMessageAllTabsIgnoreResponse = vi.fn();
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        Reflect.set(backend, '_translator', {clearDatabaseCaches});
        Reflect.set(backend, '_dictionaryImportModeActive', false);
        Reflect.set(backend, '_deferredDictionaryRefreshDuringImport', false);
        Reflect.set(backend, '_pendingDatabaseUpdatedNotifications', []);
        Reflect.set(backend, '_refreshDictionaryDatabaseAfterUpdate', refreshDictionaryDatabaseAfterUpdate);
        Reflect.set(backend, '_sendMessageAllTabsIgnoreResponse', sendMessageAllTabsIgnoreResponse);

        await Backend.prototype._triggerDatabaseUpdated.call(backend, 'dictionary', 'import');

        expect(clearDatabaseCaches).not.toHaveBeenCalled();
        expect(refreshDictionaryDatabaseAfterUpdate).toHaveBeenCalledWith({reuseActiveImportConnection: true});
        expect(sendMessageAllTabsIgnoreResponse).toHaveBeenCalledOnce();

        await Backend.prototype._triggerDatabaseUpdated.call(backend, 'dictionary', 'delete');

        expect(clearDatabaseCaches).toHaveBeenCalledOnce();
        expect(refreshDictionaryDatabaseAfterUpdate).toHaveBeenLastCalledWith({reuseActiveImportConnection: false});
    });

    test('serializes overlapping import-mode transitions in request order', async () => {
        const prepareGate = createGate();
        const refreshGate = createGate();
        const refreshDictionaryDatabaseAfterUpdate = vi.fn(() => refreshGate.promise);
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        Reflect.set(backend, '_translator', {clearDatabaseCaches: vi.fn()});
        Reflect.set(backend, '_dictionaryImportModeActive', false);
        Reflect.set(backend, '_deferredDictionaryRefreshDuringImport', false);
        Reflect.set(backend, '_pendingDatabaseUpdatedNotifications', []);
        Reflect.set(backend, '_dictionaryDatabasePreparePromise', prepareGate.promise);
        Reflect.set(backend, '_setDictionaryImportModePromise', null);
        Reflect.set(backend, '_offscreen', null);
        Reflect.set(backend, '_localDictionaryRuntime', null);
        Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));
        Reflect.set(backend, '_refreshDictionaryDatabaseAfterUpdate', refreshDictionaryDatabaseAfterUpdate);
        Reflect.set(backend, '_clearDictionaryRefreshRetry', vi.fn());

        const enter1 = Backend.prototype._setDictionaryImportMode.call(backend, true);
        const exit = Backend.prototype._setDictionaryImportMode.call(backend, false);
        const enter2 = Backend.prototype._setDictionaryImportMode.call(backend, true);
        prepareGate.resolve();
        await vi.waitFor(() => {
            expect(refreshDictionaryDatabaseAfterUpdate).toHaveBeenCalledOnce();
        });

        expect(Reflect.get(backend, '_dictionaryImportModeActive')).toBe(false);
        expect(Reflect.get(backend, '_setDictionaryImportModePromise')).not.toBeNull();

        refreshGate.resolve();
        await Promise.all([enter1, exit, enter2]);

        expect(Reflect.get(backend, '_dictionaryImportModeActive')).toBe(true);
        expect(Reflect.get(backend, '_setDictionaryImportModePromise')).toBeNull();
    });

    test('dictionary updates during import defer page notifications until refresh completes', async () => {
        const sendMessageAllTabsIgnoreResponse = vi.fn();
        const refreshDictionaryDatabaseAfterUpdate = vi.fn().mockResolvedValue(void 0);
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        Reflect.set(backend, '_translator', {clearDatabaseCaches: vi.fn()});
        Reflect.set(backend, '_dictionaryImportModeActive', true);
        Reflect.set(backend, '_deferredDictionaryRefreshDuringImport', false);
        Reflect.set(backend, '_pendingDatabaseUpdatedNotifications', []);
        Reflect.set(backend, '_sendMessageAllTabsIgnoreResponse', sendMessageAllTabsIgnoreResponse);
        Reflect.set(backend, '_refreshDictionaryDatabaseAfterUpdate', refreshDictionaryDatabaseAfterUpdate);
        Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));
        Reflect.set(backend, '_dictionaryDatabasePreparePromise', null);
        Reflect.set(backend, '_setDictionaryImportModePromise', null);

        await Backend.prototype._triggerDatabaseUpdated.call(backend, 'dictionary', 'import');

        expect(sendMessageAllTabsIgnoreResponse).not.toHaveBeenCalled();
        expect(Reflect.get(backend, '_pendingDatabaseUpdatedNotifications')).toStrictEqual([{type: 'dictionary', cause: 'import'}]);

        await Backend.prototype._setDictionaryImportMode.call(backend, false);

        expect(refreshDictionaryDatabaseAfterUpdate).toHaveBeenCalledOnce();
        expect(sendMessageAllTabsIgnoreResponse).toHaveBeenCalledOnce();
        expect(sendMessageAllTabsIgnoreResponse).toHaveBeenCalledWith({
            action: 'applicationDatabaseUpdated',
            params: {type: 'dictionary', cause: 'import'},
        });
        expect(Reflect.get(backend, '_pendingDatabaseUpdatedNotifications')).toStrictEqual([]);
    });

    test('dictionary updates during import coalesce to one final notification', async () => {
        const sendMessageAllTabsIgnoreResponse = vi.fn();
        const refreshDictionaryDatabaseAfterUpdate = vi.fn().mockResolvedValue(void 0);
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        Reflect.set(backend, '_translator', {clearDatabaseCaches: vi.fn()});
        Reflect.set(backend, '_dictionaryImportModeActive', true);
        Reflect.set(backend, '_deferredDictionaryRefreshDuringImport', false);
        Reflect.set(backend, '_pendingDatabaseUpdatedNotifications', []);
        Reflect.set(backend, '_sendMessageAllTabsIgnoreResponse', sendMessageAllTabsIgnoreResponse);
        Reflect.set(backend, '_refreshDictionaryDatabaseAfterUpdate', refreshDictionaryDatabaseAfterUpdate);
        Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));
        Reflect.set(backend, '_dictionaryDatabasePreparePromise', null);
        Reflect.set(backend, '_setDictionaryImportModePromise', null);

        await Backend.prototype._triggerDatabaseUpdated.call(backend, 'dictionary', 'import');
        await Backend.prototype._triggerDatabaseUpdated.call(backend, 'dictionary', 'delete');
        await Backend.prototype._triggerDatabaseUpdated.call(backend, 'dictionary', 'purge');

        expect(Reflect.get(backend, '_pendingDatabaseUpdatedNotifications')).toStrictEqual([{type: 'dictionary', cause: 'purge'}]);

        await Backend.prototype._setDictionaryImportMode.call(backend, false);

        expect(refreshDictionaryDatabaseAfterUpdate).toHaveBeenCalledOnce();
        expect(sendMessageAllTabsIgnoreResponse).toHaveBeenCalledOnce();
        expect(sendMessageAllTabsIgnoreResponse).toHaveBeenCalledWith({
            action: 'applicationDatabaseUpdated',
            params: {type: 'dictionary', cause: 'purge'},
        });
        expect(Reflect.get(backend, '_pendingDatabaseUpdatedNotifications')).toStrictEqual([]);
    });

    test('failed import-mode exit preserves deferred dictionary notification for retry', async () => {
        const sendMessageAllTabsIgnoreResponse = vi.fn();
        const refreshDictionaryDatabaseAfterUpdate = vi.fn()
            .mockRejectedValueOnce(new Error('refresh failed'))
            .mockResolvedValueOnce(void 0);
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        Reflect.set(backend, '_translator', {clearDatabaseCaches: vi.fn()});
        Reflect.set(backend, '_dictionaryImportModeActive', true);
        Reflect.set(backend, '_deferredDictionaryRefreshDuringImport', true);
        Reflect.set(backend, '_pendingDatabaseUpdatedNotifications', [{type: 'dictionary', cause: 'import'}]);
        Reflect.set(backend, '_sendMessageAllTabsIgnoreResponse', sendMessageAllTabsIgnoreResponse);
        Reflect.set(backend, '_refreshDictionaryDatabaseAfterUpdate', refreshDictionaryDatabaseAfterUpdate);
        Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));
        Reflect.set(backend, '_dictionaryDatabasePreparePromise', null);
        Reflect.set(backend, '_setDictionaryImportModePromise', null);

        await expect(Backend.prototype._setDictionaryImportMode.call(backend, false)).rejects.toThrow('refresh failed');

        expect(sendMessageAllTabsIgnoreResponse).not.toHaveBeenCalled();
        expect(Reflect.get(backend, '_dictionaryImportModeActive')).toBe(false);
        expect(Reflect.get(backend, '_deferredDictionaryRefreshDuringImport')).toBe(true);
        expect(Reflect.get(backend, '_pendingDatabaseUpdatedNotifications')).toStrictEqual([{type: 'dictionary', cause: 'import'}]);

        await Backend.prototype._setDictionaryImportMode.call(backend, false);

        expect(refreshDictionaryDatabaseAfterUpdate).toHaveBeenCalledTimes(2);
        expect(sendMessageAllTabsIgnoreResponse).toHaveBeenCalledOnce();
        expect(sendMessageAllTabsIgnoreResponse).toHaveBeenCalledWith({
            action: 'applicationDatabaseUpdated',
            params: {type: 'dictionary', cause: 'import'},
        });
        expect(Reflect.get(backend, '_deferredDictionaryRefreshDuringImport')).toBe(false);
        expect(Reflect.get(backend, '_pendingDatabaseUpdatedNotifications')).toStrictEqual([]);
    });

    test('failed dictionary refresh outside import mode schedules retry and sends deferred notification', async () => {
        vi.useFakeTimers();
        try {
            const sendMessageAllTabsIgnoreResponse = vi.fn();
            const refreshDictionaryDatabaseAfterUpdate = vi.fn()
                .mockRejectedValueOnce(new Error('refresh failed'))
                .mockResolvedValueOnce(void 0);
            const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
            Reflect.set(backend, '_translator', {clearDatabaseCaches: vi.fn()});
            Reflect.set(backend, '_dictionaryImportModeActive', false);
            Reflect.set(backend, '_deferredDictionaryRefreshDuringImport', false);
            Reflect.set(backend, '_pendingDatabaseUpdatedNotifications', []);
            Reflect.set(backend, '_sendMessageAllTabsIgnoreResponse', sendMessageAllTabsIgnoreResponse);
            Reflect.set(backend, '_refreshDictionaryDatabaseAfterUpdate', refreshDictionaryDatabaseAfterUpdate);
            Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));
            Reflect.set(backend, '_dictionaryDatabasePreparePromise', null);
            Reflect.set(backend, '_setDictionaryImportModePromise', null);
            Reflect.set(backend, '_dictionaryRefreshRetryTimer', null);
            Reflect.set(backend, '_dictionaryRefreshRetryAttempt', 0);

            await expect(Backend.prototype._triggerDatabaseUpdated.call(backend, 'dictionary', 'delete')).rejects.toThrow('refresh failed');

            expect(sendMessageAllTabsIgnoreResponse).not.toHaveBeenCalled();
            expect(Reflect.get(backend, '_deferredDictionaryRefreshDuringImport')).toBe(true);
            expect(Reflect.get(backend, '_pendingDatabaseUpdatedNotifications')).toStrictEqual([{type: 'dictionary', cause: 'delete'}]);
            expect(Reflect.get(backend, '_dictionaryRefreshRetryTimer')).not.toBe(null);

            await vi.advanceTimersByTimeAsync(250);

            expect(refreshDictionaryDatabaseAfterUpdate).toHaveBeenCalledTimes(2);
            expect(sendMessageAllTabsIgnoreResponse).toHaveBeenCalledOnce();
            expect(sendMessageAllTabsIgnoreResponse).toHaveBeenCalledWith({
                action: 'applicationDatabaseUpdated',
                params: {type: 'dictionary', cause: 'delete'},
            });
            expect(Reflect.get(backend, '_deferredDictionaryRefreshDuringImport')).toBe(false);
            expect(Reflect.get(backend, '_pendingDatabaseUpdatedNotifications')).toStrictEqual([]);
            expect(Reflect.get(backend, '_dictionaryRefreshRetryTimer')).toBe(null);
            expect(Reflect.get(backend, '_dictionaryRefreshRetryAttempt')).toBe(0);
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    test('scheduled dictionary refresh retry does not disable a new active import', async () => {
        vi.useFakeTimers();
        try {
            const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
            Reflect.set(backend, '_dictionaryImportModeActive', false);
            Reflect.set(backend, '_deferredDictionaryRefreshDuringImport', true);
            Reflect.set(backend, '_pendingDatabaseUpdatedNotifications', [{type: 'dictionary', cause: 'delete'}]);
            Reflect.set(backend, '_dictionaryRefreshRetryTimer', null);
            Reflect.set(backend, '_dictionaryRefreshRetryAttempt', 0);
            Reflect.set(backend, '_setDictionaryImportModePromise', null);
            Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));
            Reflect.set(backend, '_refreshDictionaryDatabaseAfterUpdate', vi.fn().mockResolvedValue(void 0));
            Reflect.set(backend, '_sendMessageAllTabsIgnoreResponse', vi.fn());

            Backend.prototype._scheduleDictionaryRefreshRetry.call(backend, 'test');
            Reflect.set(backend, '_dictionaryImportModeActive', true);

            await vi.advanceTimersByTimeAsync(250);

            expect(Reflect.get(backend, '_ensureDictionaryDatabaseReady')).not.toHaveBeenCalled();
            expect(Reflect.get(backend, '_refreshDictionaryDatabaseAfterUpdate')).not.toHaveBeenCalled();
            expect(Reflect.get(backend, '_sendMessageAllTabsIgnoreResponse')).not.toHaveBeenCalled();
            expect(Reflect.get(backend, '_dictionaryImportModeActive')).toBe(true);
            expect(Reflect.get(backend, '_dictionaryRefreshRetryTimer')).not.toBe(null);
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    test('non-dictionary updates still notify immediately during import mode', async () => {
        const sendMessageAllTabsIgnoreResponse = vi.fn();
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        Reflect.set(backend, '_translator', {clearDatabaseCaches: vi.fn()});
        Reflect.set(backend, '_dictionaryImportModeActive', true);
        Reflect.set(backend, '_deferredDictionaryRefreshDuringImport', false);
        Reflect.set(backend, '_pendingDatabaseUpdatedNotifications', []);
        Reflect.set(backend, '_sendMessageAllTabsIgnoreResponse', sendMessageAllTabsIgnoreResponse);

        await Backend.prototype._triggerDatabaseUpdated.call(backend, 'popup', 'purge');

        expect(sendMessageAllTabsIgnoreResponse).toHaveBeenCalledOnce();
        expect(sendMessageAllTabsIgnoreResponse).toHaveBeenCalledWith({
            action: 'applicationDatabaseUpdated',
            params: {type: 'popup', cause: 'purge'},
        });
    });
});
