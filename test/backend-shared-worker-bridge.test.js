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

import {afterEach, describe, expect, test, vi} from 'vitest';

const {Backend} = await import('../ext/js/background/backend.js');
const {log} = await import('../ext/js/core/log.js');

describe('Backend shared-worker bridge recovery', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('_resetSharedWorkerBridge schedules reconnect for current bridge', async () => {
        vi.spyOn(log, 'error').mockImplementation(() => {});
        const currentBridge = /** @type {SharedWorker} */ (/** @type {unknown} */ ({
            port: {close: vi.fn()},
        }));
        const setupSharedWorkerBridge = vi.fn();
        const context = /** @type {any} */ ({
            _sharedWorkerBridge: currentBridge,
            _sharedWorkerBridgeReconnectScheduled: false,
            _setupSharedWorkerBridge: setupSharedWorkerBridge,
            _isWindowBackgroundRuntime: () => true,
        });

        Reflect.get(Backend.prototype, '_resetSharedWorkerBridge').call(
            context,
            currentBridge,
            'messageerror',
            new Error('bridge broke'),
        );

        expect(context._sharedWorkerBridge).toBe(null);
        expect(currentBridge.port.close).toHaveBeenCalledTimes(1);
        expect(context._sharedWorkerBridgeReconnectScheduled).toBe(true);

        await Promise.resolve();

        expect(setupSharedWorkerBridge).toHaveBeenCalledTimes(1);
        expect(context._sharedWorkerBridgeReconnectScheduled).toBe(false);
    });
});
