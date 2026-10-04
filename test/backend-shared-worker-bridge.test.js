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
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    test('persistent registration failure cannot schedule an endless reconnect microtask loop', () => {
        const {backend, port, scheduled} = createBridgeHarness();
        port.postMessage.mockImplementation(() => { throw new Error('registration failed'); });
        const initial = /** @type {SharedWorker} */ (/** @type {unknown} */ ({port: {close: vi.fn()}}));
        backend._sharedWorkerBridge = initial;
        backend._resetSharedWorkerBridge(initial, 'error', new Error('worker failed'));
        expect(scheduled).toHaveLength(1);
        scheduled.shift()?.();
        expect(scheduled).toHaveLength(0);
        expect(port.postMessage).toHaveBeenCalledTimes(1);
        expect(port.close).toHaveBeenCalledTimes(1);
        expect(backend._sharedWorkerBridge).toBeNull();
        expect(backend._sharedWorkerBridgeReconnectScheduled).toBe(false);
    });

    test('queued reconnect does not replace a bridge recovered before the microtask runs', () => {
        const {backend, scheduled} = createBridgeHarness();
        const initial = /** @type {SharedWorker} */ (/** @type {unknown} */ ({port: {close: vi.fn()}}));
        backend._sharedWorkerBridge = initial;
        backend._resetSharedWorkerBridge(initial, 'error', new Error('worker failed'));
        const healthy = /** @type {SharedWorker} */ (/** @type {unknown} */ ({port: {close: vi.fn()}}));
        backend._sharedWorkerBridge = healthy;
        const setup = vi.spyOn(backend, '_setupSharedWorkerBridge');
        scheduled.shift()?.();
        expect(backend._sharedWorkerBridge).toBe(healthy);
        expect(setup).not.toHaveBeenCalled();
        expect(backend._sharedWorkerBridgeReconnectScheduled).toBe(false);
    });

    test('initial bridge port-start failure releases the broken setup', () => {
        const {backend, port} = createBridgeHarness();
        port.start.mockImplementation(() => { throw new Error('start failed'); });
        expect(() => backend._setupSharedWorkerBridge()).toThrow('start failed');
        expect(port.close).toHaveBeenCalledTimes(1);
        expect(backend._sharedWorkerBridge).toBeNull();
    });

    test('obsolete bridge messages release incoming frontend ports instead of binding handlers', () => {
        const {backend, events} = createBridgeHarness();
        backend._setupSharedWorkerBridge();
        backend._sharedWorkerBridge = /** @type {SharedWorker} */ (/** @type {unknown} */ ({port: {close: vi.fn()}}));
        const incoming = {close: vi.fn(), onmessage: null};
        events.get('message')?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({ports: [incoming]})));
        expect(incoming.close).toHaveBeenCalledTimes(1);
        expect(incoming.onmessage).toBeNull();
    });

    test('obsolete bridge deserialization errors are ignored before reporting or resetting', () => {
        const {backend, events} = createBridgeHarness();
        backend._setupSharedWorkerBridge();
        const healthy = /** @type {SharedWorker} */ (/** @type {unknown} */ ({port: {close: vi.fn()}}));
        backend._sharedWorkerBridge = healthy;
        const report = vi.spyOn(backend, '_onPmMessageError').mockImplementation(() => {});
        events.get('messageerror')?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({ports: []})));
        expect(report).not.toHaveBeenCalled();
        expect(backend._sharedWorkerBridge).toBe(healthy);
    });

    test('malformed bridge messages without a port cannot throw out of the listener', () => {
        const {backend, events} = createBridgeHarness();
        backend._setupSharedWorkerBridge();
        expect(() => events.get('message')?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({ports: []})))).not.toThrow();
    });

    test('current bridge messages retain a live frontend port and bind its handler', () => {
        const {backend, events} = createBridgeHarness();
        backend._setupSharedWorkerBridge();
        const incoming = {close: vi.fn(), onmessage: null};
        events.get('message')?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({ports: [incoming]})));
        expect(incoming.close).not.toHaveBeenCalled();
        expect(incoming.onmessage).toBeTypeOf('function');
    });

    for (const stale of [false, true]) {
        test(`invalid multi-port handshake releases every endpoint even if one close throws, stale=${stale}`, () => {
            const {backend, events} = createBridgeHarness();
            backend._setupSharedWorkerBridge();
            if (stale) {
                backend._sharedWorkerBridge = /** @type {SharedWorker} */ (/** @type {unknown} */ ({port: {close: vi.fn()}}));
            }
            const first = {close: vi.fn(() => { throw new Error('close failed'); }), onmessage: null};
            const second = {close: vi.fn(), onmessage: null};
            expect(() => events.get('message')?.(/** @type {MessageEvent} */ (/** @type {unknown} */ ({ports: [first, second]})))).not.toThrow();
            expect(first.close).toHaveBeenCalledTimes(1);
            expect(second.close).toHaveBeenCalledTimes(1);
            expect(first.onmessage).toBeNull();
            expect(second.onmessage).toBeNull();
        });
    }

    test('duplicate setup leaves the established backend bridge intact', () => {
        const {backend, port} = createBridgeHarness();
        backend._setupSharedWorkerBridge();
        const current = backend._sharedWorkerBridge;
        backend._setupSharedWorkerBridge();
        expect(backend._sharedWorkerBridge).toBe(current);
        expect(port.postMessage).toHaveBeenCalledTimes(1);
        expect(port.close).not.toHaveBeenCalled();
    });

    test('heartbeat recovers after a failed automatic reconnect without requiring backend restart', () => {
        const {backend, port, scheduled} = createBridgeHarness();
        port.postMessage.mockImplementationOnce(() => { throw new Error('temporary registration failure'); });
        const initial = /** @type {SharedWorker} */ (/** @type {unknown} */ ({port: {close: vi.fn()}}));
        backend._sharedWorkerBridge = initial;
        backend._resetSharedWorkerBridge(initial, 'error', new Error('worker failed'));
        scheduled.shift()?.();
        expect(backend._sharedWorkerBridge).toBeNull();
        expect(scheduled).toHaveLength(0);
        backend._onApiHeartbeat(undefined, {});
        expect(backend._sharedWorkerBridge).not.toBeNull();
        expect(port.postMessage).toHaveBeenCalledTimes(2);
        expect(backend._sharedWorkerBridgeReconnectScheduled).toBe(false);
    });

    test('failed heartbeat repair does not queue more retries and later heartbeat can succeed', () => {
        const {backend, port, scheduled} = createBridgeHarness();
        port.postMessage.mockImplementationOnce(() => { throw new Error('temporary registration failure'); });
        expect(() => backend._onApiHeartbeat(undefined, {})).toThrow('temporary registration failure');
        expect(scheduled).toHaveLength(0);
        expect(backend._sharedWorkerBridgeReconnectScheduled).toBe(false);
        backend._onApiHeartbeat(undefined, {});
        expect(backend._sharedWorkerBridge).not.toBeNull();
        expect(port.postMessage).toHaveBeenCalledTimes(2);
    });

    test('heartbeat leaves healthy, queued, and non-window bridge state alone', () => {
        const {backend, port} = createBridgeHarness();
        backend._sharedWorkerBridge = /** @type {SharedWorker} */ (/** @type {unknown} */ ({port: {close: vi.fn()}}));
        backend._onApiHeartbeat(undefined, {});
        backend._sharedWorkerBridge = null;
        backend._sharedWorkerBridgeReconnectScheduled = true;
        backend._onApiHeartbeat(undefined, {});
        backend._sharedWorkerBridgeReconnectScheduled = false;
        vi.mocked(backend._isWindowBackgroundRuntime).mockReturnValue(false);
        backend._onApiHeartbeat(undefined, {});
        expect(port.postMessage).not.toHaveBeenCalled();
    });

    test('readiness repairs an absent Firefox bridge before announcing backend readiness', () => {
        const {backend, port} = createBridgeHarness();
        /** @type {string[]} */
        const calls = [];
        port.postMessage.mockImplementation(() => calls.push('register'));
        vi.spyOn(backend, '_sendMessageIgnoreResponse').mockImplementation(() => { calls.push('ready'); });
        backend._onApiRequestBackendReadySignal(undefined, {});
        expect(calls).toStrictEqual(['register', 'ready']);
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

/**
 * @typedef {object} BridgeHarness
 * @property {InstanceType<typeof Backend>} backend
 * @property {{close: import('vitest').Mock, postMessage: import('vitest').Mock, start: import('vitest').Mock, addEventListener: import('vitest').Mock}} port
 * @property {Map<string, (event: MessageEvent) => void>} events
 * @property {(() => void)[]} scheduled
 */

/** @returns {BridgeHarness} */
function createBridgeHarness() {
    vi.spyOn(log, 'error').mockImplementation(() => {});
    /** @type {Map<string, (event: MessageEvent) => void>} */
    const events = new Map();
    /** @type {(() => void)[]} */
    const scheduled = [];
    vi.stubGlobal('queueMicrotask', vi.fn((callback) => scheduled.push(callback)));
    const port = {close: vi.fn(), postMessage: vi.fn(), start: vi.fn(), addEventListener: vi.fn((type, listener) => events.set(type, listener))};
    vi.stubGlobal('SharedWorker', class {
        constructor() { this.port = port; }
    });
    const backend = /** @type {InstanceType<typeof Backend>} */ (Object.create(Backend.prototype));
    backend._sharedWorkerBridge = null;
    backend._sharedWorkerBridgeReconnectScheduled = false;
    vi.spyOn(backend, '_isWindowBackgroundRuntime').mockReturnValue(true);
    return {backend, port, events, scheduled};
}
