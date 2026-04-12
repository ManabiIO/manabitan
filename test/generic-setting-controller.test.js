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

import {describe, expect, vi} from 'vitest';
import {createDomTest} from './fixtures/dom-test.js';

const logError = vi.fn();

vi.mock('../ext/js/core/log.js', () => ({
    log: {
        error: logError,
    },
}));

const test = createDomTest();

describe('GenericSettingController', () => {
    test('options-changed refresh logs binder refresh failures instead of rejecting', async () => {
        vi.resetModules();
        vi.clearAllMocks();
        globalThis.MutationObserver = class {
            observe() {}
            disconnect() {}
            takeRecords() { return []; }
        };

        const {GenericSettingController} = await import('../ext/js/pages/settings/generic-setting-controller.js');
        const settingsController = {on: vi.fn()};
        const controller = new GenericSettingController(/** @type {any} */ (settingsController));
        controller._dataBinder = /** @type {any} */ ({
            observe: vi.fn(),
            refresh: vi.fn().mockRejectedValue(new Error('refresh failed')),
        });

        controller._onOptionsChanged();
        await Promise.resolve();
        await Promise.resolve();

        expect(logError).toHaveBeenCalled();
    });
});
