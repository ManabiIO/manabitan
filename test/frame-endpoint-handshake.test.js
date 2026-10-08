/*
 * Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {FrameEndpoint} from '../ext/js/comm/frame-endpoint.js';

/**
 * @param {ReturnType<typeof vi.fn>} broadcastTab
 * @param {ReturnType<typeof vi.fn>} sendMessageToFrame
 * @returns {FrameEndpoint}
 */
function createEndpoint(broadcastTab, sendMessageToFrame) {
    const api = /** @type {import('../ext/js/comm/api.js').API} */ (/** @type {unknown} */ ({
        broadcastTab,
        sendMessageToFrame,
    }));
    return new FrameEndpoint(api);
}

/**
 * @param {FrameEndpoint} endpoint
 * @param {unknown} token
 * @param {unknown} hostFrameId
 */
function connect(endpoint, token, hostFrameId) {
    const secret = Reflect.get(endpoint, '_secret');
    endpoint._onMessage(/** @type {MessageEvent<unknown>} */ (/** @type {unknown} */ ({
        data: {action: 'frameEndpointConnect', params: {secret, token, hostFrameId}},
    })));
}

/**
 * @returns {Promise<void>}
 */
async function settleAsyncMessages() {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
}

describe('FrameEndpoint handshake lifecycle', () => {
    beforeEach(() => {
        vi.stubGlobal('window', new EventTarget());
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    test('successful acknowledgement authenticates and removes the temporary listener', async () => {
        const broadcastTab = vi.fn().mockResolvedValue(void 0);
        const sendMessageToFrame = vi.fn().mockResolvedValue(void 0);
        const endpoint = createEndpoint(broadcastTab, sendMessageToFrame);
        endpoint.signal();
        expect(Reflect.get(endpoint, '_eventListeners').size).toBe(1);

        connect(endpoint, 'token1', 3);
        await settleAsyncMessages();

        expect(sendMessageToFrame).toHaveBeenCalledWith(3, {
            action: 'frameEndpointConnected',
            params: {secret: Reflect.get(endpoint, '_secret'), token: 'token1'},
        });
        expect(endpoint.authenticate({secret: Reflect.get(endpoint, '_secret'), token: 'token1'})).toBe(true);
        expect(Reflect.get(endpoint, '_eventListeners').size).toBe(0);
    });

    test.each([Number.NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '3'])(
        'invalid host frame id %s does not lock the endpoint',
        async (frameId) => {
            const broadcastTab = vi.fn().mockResolvedValue(void 0);
            const sendMessageToFrame = vi.fn().mockResolvedValue(void 0);
            const endpoint = createEndpoint(broadcastTab, sendMessageToFrame);
            endpoint.signal();
            connect(endpoint, 'token1', frameId);
            await settleAsyncMessages();

            expect(Reflect.get(endpoint, '_token')).toBeNull();
            expect(Reflect.get(endpoint, '_eventListeners').size).toBe(1);
            expect(sendMessageToFrame).not.toHaveBeenCalled();
        },
    );

    test('empty authentication tokens cannot lock the endpoint', async () => {
        const broadcastTab = vi.fn().mockResolvedValue(void 0);
        const sendMessageToFrame = vi.fn().mockResolvedValue(void 0);
        const endpoint = createEndpoint(broadcastTab, sendMessageToFrame);
        endpoint.signal();
        connect(endpoint, '', 3);
        await settleAsyncMessages();
        expect(Reflect.get(endpoint, '_token')).toBeNull();
        expect(sendMessageToFrame).not.toHaveBeenCalled();
    });

    test('a rejected acknowledgement restores the listener and advertises readiness again', async () => {
        const broadcastTab = vi.fn().mockResolvedValue(void 0);
        const sendMessageToFrame = vi.fn()
            .mockRejectedValueOnce(new Error('backend port closed'))
            .mockResolvedValueOnce(void 0);
        const endpoint = createEndpoint(broadcastTab, sendMessageToFrame);
        endpoint.signal();
        connect(endpoint, 'first', 3);
        await settleAsyncMessages();

        expect(Reflect.get(endpoint, '_token')).toBeNull();
        expect(Reflect.get(endpoint, '_eventListeners').size).toBe(1);
        expect(broadcastTab).toHaveBeenCalledTimes(2);

        connect(endpoint, 'replacement', 3);
        await settleAsyncMessages();
        expect(sendMessageToFrame).toHaveBeenCalledTimes(2);
        expect(endpoint.authenticate({secret: Reflect.get(endpoint, '_secret'), token: 'replacement'})).toBe(true);
    });

    test('a synchronous acknowledgement exception also leaves the endpoint retryable', async () => {
        const broadcastTab = vi.fn().mockResolvedValue(void 0);
        const sendMessageToFrame = vi.fn().mockImplementationOnce(() => {
            throw new Error('transport unavailable');
        }).mockResolvedValue(void 0);
        const endpoint = createEndpoint(broadcastTab, sendMessageToFrame);
        endpoint.signal();
        connect(endpoint, 'first', 3);
        await settleAsyncMessages();
        expect(Reflect.get(endpoint, '_token')).toBeNull();
        expect(Reflect.get(endpoint, '_eventListeners').size).toBe(1);
        connect(endpoint, 'second', 3);
        await settleAsyncMessages();
        expect(endpoint.authenticate({secret: Reflect.get(endpoint, '_secret'), token: 'second'})).toBe(true);
    });

    test('persistent acknowledgement failures stop automatic retrying after a bounded backoff', async () => {
        vi.useFakeTimers();
        try {
            let attempts = 0;
            const broadcastTab = vi.fn().mockImplementation(async () => {
                connect(endpoint, `attempt-${++attempts}`, 3);
            });
            const sendMessageToFrame = vi.fn().mockRejectedValue(new Error('persistent failure'));
            const endpoint = createEndpoint(broadcastTab, sendMessageToFrame);
            endpoint.signal();
            await vi.advanceTimersByTimeAsync(10_000);

            // Initial handshake plus at most five automatic retries.
            expect(broadcastTab).toHaveBeenCalledTimes(6);
            expect(sendMessageToFrame).toHaveBeenCalledTimes(6);
            expect(Reflect.get(endpoint, '_eventListeners').size).toBe(1);
            expect(vi.getTimerCount()).toBe(0);

            // The endpoint remains usable if the host reconnects explicitly.
            sendMessageToFrame.mockResolvedValueOnce(void 0);
            connect(endpoint, 'recovered', 3);
            await vi.advanceTimersByTimeAsync(0);
            expect(endpoint.authenticate({secret: Reflect.get(endpoint, '_secret'), token: 'recovered'})).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    test('a failed ready broadcast is logged and does not cause an unhandled rejection', async () => {
        const broadcastTab = vi.fn().mockRejectedValue(new Error('broadcast failed'));
        const sendMessageToFrame = vi.fn().mockResolvedValue(void 0);
        const endpoint = createEndpoint(broadcastTab, sendMessageToFrame);
        expect(() => endpoint.signal()).not.toThrow();
        await settleAsyncMessages();
        expect(broadcastTab).toHaveBeenCalledOnce();
        expect(Reflect.get(endpoint, '_eventListeners').size).toBe(1);
        expect(console.error).toHaveBeenCalled();
    });
});
