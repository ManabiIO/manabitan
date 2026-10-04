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
    test('replaced backend ports close and stale errors do not affect the current registration', () => {
        const report = vi.spyOn(log, 'error').mockImplementation(() => {});
        const bridge = new SharedWorkerBridge();
        /** @type {Map<string, () => void>} */
        const oldEvents = new Map();
        /** @type {Map<string, () => void>} */
        const currentEvents = new Map();
        const oldPort = {close: vi.fn(), postMessage: vi.fn(), addEventListener: vi.fn((type, listener) => oldEvents.set(type, listener))};
        const currentPort = {close: vi.fn(), postMessage: vi.fn(), addEventListener: vi.fn((type, listener) => currentEvents.set(type, listener))};
        bridge._onRegisterBackendPort(undefined, /** @type {MessagePort} */ (/** @type {unknown} */ (oldPort)), []);
        bridge._onRegisterBackendPort(undefined, /** @type {MessagePort} */ (/** @type {unknown} */ (currentPort)), []);
        expect(oldPort.close).toHaveBeenCalledTimes(1);
        oldEvents.get('messageerror')?.();
        expect(bridge._backendPort).toBe(currentPort);
        expect(currentPort.close).not.toHaveBeenCalled();
        expect(report).not.toHaveBeenCalled();
        currentEvents.get('messageerror')?.();
        expect(bridge._backendPort).toBeNull();
        expect(currentPort.close).toHaveBeenCalledTimes(1);
        expect(report).toHaveBeenCalledTimes(1);
    });

    test('same backend registration is idempotent', () => {
        const bridge = new SharedWorkerBridge();
        const port = {close: vi.fn(), addEventListener: vi.fn(), postMessage: vi.fn()};
        const backendPort = /** @type {MessagePort} */ (/** @type {unknown} */ (port));
        bridge._onRegisterBackendPort(undefined, backendPort, []);
        bridge._onRegisterBackendPort(undefined, backendPort, []);
        expect(port.addEventListener).toHaveBeenCalledTimes(1);
        expect(port.close).not.toHaveBeenCalled();
    });

    test('failed forwarding closes the broken backend without closing the queued frontend', () => {
        vi.spyOn(log, 'error').mockImplementation(() => {});
        const bridge = new SharedWorkerBridge();
        const frontend = {close: vi.fn()};
        const backend = {close: vi.fn(), addEventListener: vi.fn(), postMessage: vi.fn(() => { throw new Error('backend dead'); })};
        bridge._onRegisterBackendPort(undefined, /** @type {MessagePort} */ (/** @type {unknown} */ (backend)), []);
        const frontendPort = /** @type {MessagePort} */ (/** @type {unknown} */ (frontend));
        bridge._onConnectToBackend1(undefined, /** @type {MessagePort} */ (/** @type {unknown} */ ({})), [frontendPort]);
        expect(backend.close).toHaveBeenCalledTimes(1);
        expect(frontend.close).not.toHaveBeenCalled();
        expect(bridge._pendingBackendConnectionPorts).toStrictEqual([frontend]);
    });

    test('large failed flush retains every queued port without argument-limit failure', () => {
        vi.spyOn(log, 'error').mockImplementation(() => {});
        const bridge = new SharedWorkerBridge();
        const pending = Array.from({length: 160_000}, (_, index) => /** @type {MessagePort} */ (/** @type {unknown} */ ({index})));
        bridge._pendingBackendConnectionPorts = [...pending];
        const backend = {close: vi.fn(), addEventListener: vi.fn(), postMessage: vi.fn(() => { throw new Error('backend dead'); })};
        expect(() => bridge._onRegisterBackendPort(undefined, /** @type {MessagePort} */ (/** @type {unknown} */ (backend)), [])).not.toThrow();
        expect(bridge._pendingBackendConnectionPorts).toStrictEqual(pending);
    });

    test('partial flush resumes in original order without replaying transferred ports', () => {
        vi.spyOn(log, 'error').mockImplementation(() => {});
        const bridge = new SharedWorkerBridge();
        const pending = Array.from({length: 4}, (_, index) => /** @type {MessagePort} */ (/** @type {unknown} */ ({index})));
        bridge._pendingBackendConnectionPorts = [...pending];
        const failed = {close: vi.fn(), addEventListener: vi.fn(), postMessage: vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error('backend dead'); })};
        bridge._onRegisterBackendPort(undefined, /** @type {MessagePort} */ (/** @type {unknown} */ (failed)), []);
        expect(bridge._pendingBackendConnectionPorts).toStrictEqual(pending.slice(1));
        const replacement = {close: vi.fn(), addEventListener: vi.fn(), postMessage: vi.fn()};
        bridge._onRegisterBackendPort(undefined, /** @type {MessagePort} */ (/** @type {unknown} */ (replacement)), []);
        expect(replacement.postMessage.mock.calls.map(([, ports]) => ports[0])).toStrictEqual(pending.slice(1));
        expect(bridge._pendingBackendConnectionPorts).toHaveLength(0);
    });

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
