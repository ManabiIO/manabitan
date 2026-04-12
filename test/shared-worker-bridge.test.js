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

const originalAddEventListener = globalThis.addEventListener;
globalThis.addEventListener = vi.fn();
const {SharedWorkerBridge} = await import('../ext/js/comm/shared-worker-bridge.js');
const {log} = await import('../ext/js/core/log.js');
globalThis.addEventListener = originalAddEventListener;

afterEach(() => {
    vi.restoreAllMocks();
});

describe('SharedWorkerBridge', () => {
    test('queues frontend connection ports until backend registers', () => {
        vi.spyOn(log, 'warn').mockImplementation(() => {});
        const bridge = new SharedWorkerBridge();
        const frontendPort = /** @type {MessagePort} */ (/** @type {unknown} */ ({close: vi.fn()}));
        const backendPort = /** @type {MessagePort} */ (/** @type {unknown} */ ({
            addEventListener: vi.fn(),
            postMessage: vi.fn(),
        }));

        bridge._onConnectToBackend1(undefined, /** @type {MessagePort} */ (/** @type {unknown} */ ({})), [frontendPort]);

        expect(bridge._pendingBackendConnectionPorts).toHaveLength(1);

        bridge._onRegisterBackendPort(undefined, backendPort, []);

        expect(bridge._pendingBackendConnectionPorts).toHaveLength(0);
        expect(backendPort.postMessage).toHaveBeenCalledTimes(1);
        expect(backendPort.postMessage).toHaveBeenCalledWith(void 0, [frontendPort]);
    });

    test('requeues connection when backend port postMessage throws', () => {
        vi.spyOn(log, 'error').mockImplementation(() => {});
        const bridge = new SharedWorkerBridge();
        const frontendPort = /** @type {MessagePort} */ (/** @type {unknown} */ ({close: vi.fn()}));
        const backendPort = /** @type {MessagePort} */ (/** @type {unknown} */ ({
            addEventListener: vi.fn(),
            postMessage: vi.fn(() => {
                throw new Error('backend dead');
            }),
        }));

        bridge._onRegisterBackendPort(undefined, backendPort, []);
        bridge._onConnectToBackend1(undefined, /** @type {MessagePort} */ (/** @type {unknown} */ ({})), [frontendPort]);

        expect(bridge._backendPort).toBe(null);
        expect(bridge._pendingBackendConnectionPorts).toStrictEqual([frontendPort]);
    });
});
