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

describe('Backend database update deferral', () => {
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
