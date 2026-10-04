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

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {FrameClient} from '../ext/js/comm/frame-client.js';
import {log} from '../ext/js/core/log.js';

/**
 * @returns {{client: FrameClient, frame: import('extension').HtmlElementWithContentWindow, postMessage: ReturnType<typeof vi.fn>, runtime: {addListener: ReturnType<typeof vi.fn>, removeListener: ReturnType<typeof vi.fn>}, emit: (message: import('application').ApiMessageAny) => void}}
 */
function createHarness() {
    /** @type {Set<import('extension').ChromeRuntimeOnMessageCallback<import('application').ApiMessageAny>>} */
    const callbacks = new Set();
    const runtime = {
        addListener: vi.fn((callback) => { callbacks.add(callback); }),
        removeListener: vi.fn((callback) => { callbacks.delete(callback); }),
    };
    vi.stubGlobal('chrome', {runtime: {onMessage: runtime}});
    const postMessage = vi.fn();
    const frame = /** @type {import('extension').HtmlElementWithContentWindow} */ (/** @type {unknown} */ (Object.assign(new EventTarget(), {
        contentDocument: {location: {href: 'https://extension.test/popup.html'}},
        contentWindow: {location: {origin: 'https://extension.test'}, postMessage},
    })));
    return {
        client: new FrameClient(),
        frame,
        postMessage,
        runtime,
        emit(message) {
            for (const callback of callbacks) { callback(message, {}, () => {}); }
        },
    };
}

/** @returns {Promise<void>} */
async function flushMessages() {
    await Promise.resolve();
    await Promise.resolve();
}

describe('FrameClient handshake lifecycle', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(log, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    test('duplicate ready announcements reuse the token accepted by the endpoint', async () => {
        const {client, frame, emit, postMessage} = createHarness();
        const pending = client.connect(frame, 'https://extension.test', 0, () => frame.dispatchEvent(new Event('load')), 1000);
        const ready = /** @type {const} */ ({action: 'frameEndpointReady', params: {secret: 'endpoint'}, frameId: 7});
        emit(ready);
        emit(ready);
        await flushMessages();
        expect(postMessage).toHaveBeenCalledTimes(2);
        const first = postMessage.mock.calls[0][0].params;
        const second = postMessage.mock.calls[1][0].params;
        expect(second.token).toBe(first.token);
        emit({action: 'frameEndpointConnected', params: first, frameId: 7});
        await pending;
        expect(client.frameId).toBe(7);
        expect(client.createMessage({query: 'test'}).token).toBe(first.token);
        expect(vi.getTimerCount()).toBe(0);
    });

    test.each(['runtime', 'frame'])('partial %s listener setup rejects immediately and cleans its owned resources', async (stage) => {
        const {client, frame, runtime} = createHarness();
        const failure = new Error('listener setup failed');
        const setup = vi.fn();
        if (stage === 'runtime') {
            runtime.addListener.mockImplementation(() => { throw failure; });
        } else {
            vi.spyOn(frame, 'addEventListener').mockImplementation(() => { throw failure; });
        }
        await expect(client.connect(frame, 'https://extension.test', 0, setup, 1000)).rejects.toBe(failure);
        expect(vi.getTimerCount()).toBe(0);
        expect(setup).not.toHaveBeenCalled();
        expect(client.isConnected()).toBe(false);
        if (stage === 'frame') { expect(runtime.removeListener).toHaveBeenCalledTimes(1); }
    });

    test('timeout settles and removes the load listener even if runtime listener removal fails', async () => {
        const {client, frame, runtime} = createHarness();
        runtime.removeListener.mockImplementation(() => { throw new Error('context invalidated'); });
        const removeLoad = vi.spyOn(frame, 'removeEventListener');
        const pending = expect(client.connect(frame, 'https://extension.test', 0, () => {}, 1000)).rejects.toThrow('Timeout');
        expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
        await pending;
        expect(removeLoad).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        expect(client.isConnected()).toBe(false);
    });

    test.each([false, true])('successful confirmation survives cleanup failure, including failed diagnostics=%s', async (diagnosticsFail) => {
        const {client, frame, emit, postMessage} = createHarness();
        vi.spyOn(frame, 'removeEventListener').mockImplementation(() => { throw new Error('frame detached'); });
        if (diagnosticsFail) {
            vi.spyOn(log, 'warn').mockImplementation(() => { throw new Error('logger unavailable'); });
        }
        const pending = client.connect(frame, 'https://extension.test', 0, () => frame.dispatchEvent(new Event('load')), 1000);
        void pending.catch(() => {});
        emit({action: 'frameEndpointReady', params: {secret: 'endpoint'}, frameId: 7});
        await flushMessages();
        emit({action: 'frameEndpointConnected', params: postMessage.mock.calls[0][0].params, frameId: 7});
        await flushMessages();
        expect(client.isConnected()).toBe(true);
        await pending;
        expect(vi.getTimerCount()).toBe(0);
    });

    test('a setup failure preserves its original error when cleanup also fails', async () => {
        const {client, frame, runtime} = createHarness();
        runtime.removeListener.mockImplementation(() => { throw new Error('cleanup failed'); });
        const failure = new Error('navigation failed');
        await expect(client.connect(frame, 'https://extension.test', 0, () => { throw failure; }, 1000)).rejects.toBe(failure);
        expect(vi.getTimerCount()).toBe(0);
    });

    test('a timed-out attempt cannot post after a late load/ready announcement and the next attempt recovers', async () => {
        const {client, frame, emit, postMessage} = createHarness();
        const failed = expect(client.connect(frame, 'https://extension.test', 0, () => {}, 1000)).rejects.toThrow('Timeout');
        emit({action: 'frameEndpointReady', params: {secret: 'stale'}, frameId: 6});
        vi.advanceTimersByTime(1000);
        await failed;
        frame.dispatchEvent(new Event('load'));
        await flushMessages();
        expect(postMessage).not.toHaveBeenCalled();
        const next = client.connect(frame, 'https://extension.test', 0, () => frame.dispatchEvent(new Event('load')), 1000);
        emit({action: 'frameEndpointReady', params: {secret: 'fresh'}, frameId: 7});
        await flushMessages();
        emit({action: 'frameEndpointConnected', params: postMessage.mock.calls[0][0].params, frameId: 7});
        await next;
        expect(client.frameId).toBe(7);
        expect(vi.getTimerCount()).toBe(0);
    });

    test('an about:blank load does not finish the frame load boundary', async () => {
        const {client, frame, emit, postMessage} = createHarness();
        const aboutBlank = vi.spyOn(FrameClient, 'isFrameAboutBlank').mockReturnValue(true);
        const pending = client.connect(frame, 'https://extension.test', 0, () => frame.dispatchEvent(new Event('load')), 1000);
        emit({action: 'frameEndpointReady', params: {secret: 'endpoint'}, frameId: 7});
        await flushMessages();
        expect(postMessage).not.toHaveBeenCalled();
        aboutBlank.mockReturnValue(false);
        frame.dispatchEvent(new Event('load'));
        await flushMessages();
        emit({action: 'frameEndpointConnected', params: postMessage.mock.calls[0][0].params, frameId: 7});
        await pending;
        expect(client.isConnected()).toBe(true);
    });

    test.each(['post-message', 'origin', 'missing-window'])('failed %s delivery rejects and releases listeners and timers', async (kind) => {
        const {client, frame, emit, postMessage, runtime} = createHarness();
        if (kind === 'post-message') {
            postMessage.mockImplementation(() => { throw new Error('send failed'); });
        } else if (kind === 'origin') {
            Reflect.set(frame, 'contentWindow', {location: {origin: 'https://wrong.test'}, postMessage});
        } else {
            Reflect.set(frame, 'contentWindow', null);
        }
        const failed = expect(client.connect(frame, 'https://extension.test', 0, () => frame.dispatchEvent(new Event('load')), 1000)).rejects.toThrow();
        emit({action: 'frameEndpointReady', params: {secret: 'endpoint'}, frameId: 7});
        await failed;
        expect(runtime.removeListener).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        expect(client.isConnected()).toBe(false);
    });

    test('a second nonblank load terminates the old handshake instead of authenticating a new document', async () => {
        const {client, frame, emit, postMessage} = createHarness();
        const failed = expect(client.connect(frame, 'https://extension.test', 0, () => frame.dispatchEvent(new Event('load')), 1000)).rejects.toThrow('Unexpected load event');
        frame.dispatchEvent(new Event('load'));
        await failed;
        emit({action: 'frameEndpointReady', params: {secret: 'late'}, frameId: 7});
        await flushMessages();
        expect(postMessage).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    test('incorrect confirmation credentials are ignored until the matching token arrives', async () => {
        const {client, frame, emit, postMessage} = createHarness();
        const pending = client.connect(frame, 'https://extension.test', 0, () => frame.dispatchEvent(new Event('load')), 1000);
        emit({action: 'frameEndpointReady', params: {secret: 'endpoint'}, frameId: 7});
        await flushMessages();
        const params = postMessage.mock.calls[0][0].params;
        emit({action: 'frameEndpointConnected', params: {...params, token: 'wrong'}, frameId: 7});
        emit({action: 'frameEndpointConnected', params: {...params, secret: 'wrong'}, frameId: 7});
        await flushMessages();
        expect(client.isConnected()).toBe(false);
        expect(vi.getTimerCount()).toBe(1);
        emit({action: 'frameEndpointConnected', params, frameId: 7});
        await pending;
        expect(client.isConnected()).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
});
