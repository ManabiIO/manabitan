/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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
import {CrossFrameAPI, CrossFrameAPIPort} from '../ext/js/comm/cross-frame-api.js';
import {log} from '../ext/js/core/log.js';

/**
 * @param {number} tabId
 * @param {number} frameId
 * @returns {import('../ext/js/comm/cross-frame-api.js').CrossFrameAPIPort}
 */
function createPort(tabId, frameId) {
    const port = new CrossFrameAPIPort(tabId, frameId, /** @type {chrome.runtime.Port} */ ({}), new Map());
    vi.spyOn(port, 'off');
    return port;
}

/**
 * @returns {CrossFrameAPI}
 */
function createApi() {
    return new CrossFrameAPI(/** @type {import('../ext/js/comm/api.js').API} */ ({}), 1, 0);
}

/** @returns {chrome.runtime.Port & {disconnect: ReturnType<typeof vi.fn>}} */
function createRuntimePort() {
    return /** @type {chrome.runtime.Port & {disconnect: ReturnType<typeof vi.fn>}} */ (/** @type {unknown} */ ({
        onMessage: {addListener: vi.fn(), removeListener: vi.fn()},
        onDisconnect: {addListener: vi.fn(), removeListener: vi.fn()},
        postMessage: vi.fn(),
        disconnect: vi.fn(),
    }));
}

describe('CrossFrameAPI connection lifecycle', () => {
    beforeEach(() => {
        vi.stubGlobal('window', new EventTarget());
        vi.stubGlobal('document', new EventTarget());
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    test('concurrent cold callers share one open request', async () => {
        const api = createApi();
        let release = () => {};
        const opened = new Promise((resolve) => { release = () => resolve({targetTabId: 2, targetFrameId: 3}); });
        const open = vi.fn(() => opened);
        api._api.openCrossFramePort = open;
        const first = api._getOrCreateCommPort(2, 3);
        const second = api._getOrCreateCommPort(2, 3);
        await Promise.resolve();
        expect(open).toHaveBeenCalledTimes(1);
        const port = api._setupCommPort(2, 3, createRuntimePort());
        release();
        await expect(first).resolves.toBe(port);
        await expect(second).resolves.toBe(port);
        expect(api._pendingCommPorts.size).toBe(0);
        port.disconnect();
    });

    test('a failed shared open rejects all callers and the next request can recover', async () => {
        const api = createApi();
        const error = new Error('open failed');
        const open = vi.fn().mockRejectedValueOnce(error).mockImplementationOnce(() => {
            api._setupCommPort(2, 3, createRuntimePort());
            return Promise.resolve({targetTabId: 2, targetFrameId: 3});
        });
        api._api.openCrossFramePort = open;
        const outcomes = await Promise.allSettled([
            api._getOrCreateCommPort(2, 3), api._getOrCreateCommPort(2, 3),
        ]);
        expect(outcomes).toEqual([
            {status: 'rejected', reason: error}, {status: 'rejected', reason: error},
        ]);
        expect(open).toHaveBeenCalledTimes(1);
        expect(api._pendingCommPorts.size).toBe(0);
        const recovered = await api._getOrCreateCommPort(2, 3);
        expect(open).toHaveBeenCalledTimes(2);
        expect(api._pendingCommPorts.size).toBe(0);
        recovered.disconnect();
    });

    test('a peer connection arriving before the open task is reused', async () => {
        const api = createApi();
        api._api.openCrossFramePort = vi.fn();
        const pending = api._getOrCreateCommPort(2, 3);
        const port = api._setupCommPort(2, 3, createRuntimePort());
        await expect(pending).resolves.toBe(port);
        expect(api._api.openCrossFramePort).not.toHaveBeenCalled();
        expect(api._pendingCommPorts.size).toBe(0);
        port.disconnect();
    });

    test('concurrent public invocations deliver both replies over the shared channel', async () => {
        const api = createApi();
        const runtime = createRuntimePort();
        let port = /** @type {?CrossFrameAPIPort} */ (null);
        api._api.openCrossFramePort = vi.fn(async () => {
            port = api._setupCommPort(2, 3, runtime);
            return {targetTabId: 2, targetFrameId: 3};
        });
        vi.spyOn(runtime, 'postMessage').mockImplementation((message) => {
            queueMicrotask(() => {
                port?._onMessage({type: 'ack', id: message.id});
                port?._onMessage({type: 'result', id: message.id, data: {result: true}});
            });
        });
        const results = await Promise.all([
            api.invokeTab(2, 3, 'popupFactoryIsVisible', {id: 'one'}),
            api.invokeTab(2, 3, 'popupFactoryIsVisible', {id: 'two'}),
        ]);
        expect(results).toEqual([true, true]);
        expect(api._api.openCrossFramePort).toHaveBeenCalledTimes(1);
        expect(runtime.postMessage).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
        api._commPorts.get(2)?.get(3)?.disconnect();
    });

    test('different frames open independently', async () => {
        const api = createApi();
        api._api.openCrossFramePort = vi.fn(async (tabId, frameId) => {
            api._setupCommPort(tabId, frameId, createRuntimePort());
            return {targetTabId: tabId, targetFrameId: frameId};
        });
        const ports = await Promise.all([api._getOrCreateCommPort(2, 3), api._getOrCreateCommPort(2, 4), api._getOrCreateCommPort(5, 3)]);
        expect(api._api.openCrossFramePort).toHaveBeenCalledTimes(3);
        expect(new Set(ports).size).toBe(3);
        for (const port of ports) { port.disconnect(); }
    });

    test.each([false, true])('partial setup releases listeners and preserves the existing mapping: replacement=%s', (replacement) => {
        const api = createApi();
        const previous = replacement ? api._setupCommPort(2, 3, createRuntimePort()) : undefined;
        const runtime = createRuntimePort();
        vi.spyOn(runtime.onMessage, 'addListener').mockImplementation(() => { throw new Error('listener failed'); });
        expect(() => api._setupCommPort(2, 3, runtime)).toThrow('listener failed');
        expect(api._commPorts.get(2)?.get(3)).toBe(previous);
        expect(runtime.onDisconnect.removeListener).toHaveBeenCalledTimes(1);
        expect(runtime.disconnect).toHaveBeenCalledTimes(1);
        previous?.disconnect();
    });

    test.each(['disconnect', 'resume', 'pageshow'])('local %s closes the transport and rejects pending requests immediately', async (reason) => {
        const api = createApi();
        const runtime = createRuntimePort();
        const port = api._setupCommPort(2, 3, runtime);
        const pending = port.invoke('popupFactoryIsVisible', {id: 'popup'}, 1000, 2000);
        const rejected = expect(pending).rejects.toThrow('Disconnected');
        if (reason === 'resume') {
            document.dispatchEvent(new Event('resume'));
        } else if (reason === 'pageshow') {
            const event = new Event('pageshow');
            Object.defineProperty(event, 'persisted', {value: true});
            window.dispatchEvent(event);
        } else {
            port.disconnect();
        }
        await rejected;
        expect(api._commPorts.size).toBe(0);
        expect(port._activeInvocations.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(runtime.disconnect).toHaveBeenCalledTimes(1);
        port.disconnect();
        expect(runtime.disconnect).toHaveBeenCalledTimes(1);
    });

    test('ordinary pageshow does not disconnect a live channel', () => {
        const api = createApi();
        const runtime = createRuntimePort();
        const port = api._setupCommPort(2, 3, runtime);
        window.dispatchEvent(new Event('pageshow'));
        expect(runtime.disconnect).not.toHaveBeenCalled();
        expect(api._commPorts.get(2)?.get(3)).toBe(port);
        port.disconnect();
    });

    test('remote disconnect removes state without closing the transport again', () => {
        const api = createApi();
        const runtime = createRuntimePort();
        const port = api._setupCommPort(2, 3, runtime);
        port._onDisconnect();
        expect(api._commPorts.size).toBe(0);
        port.disconnect();
        expect(runtime.disconnect).not.toHaveBeenCalled();
    });

    test('a transport close error cannot leave pending invocations or mappings behind', async () => {
        const api = createApi();
        const runtime = createRuntimePort();
        runtime.disconnect.mockImplementation(() => { throw new Error('invalid extension context'); });
        const port = api._setupCommPort(2, 3, runtime);
        const rejected = expect(port.invoke('popupFactoryIsVisible', {id: 'popup'}, 1000, 2000)).rejects.toThrow('Disconnected');
        expect(() => port.disconnect()).not.toThrow();
        await rejected;
        expect(api._commPorts.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(runtime.disconnect).toHaveBeenCalledTimes(1);
    });

    test('replacing a port does not abort a request already using the previous channel', async () => {
        const api = createApi();
        const previous = api._setupCommPort(2, 3, createRuntimePort());
        const pending = previous.invoke('popupFactoryIsVisible', {id: 'popup'}, 1000, 2000);
        const replacement = api._setupCommPort(2, 3, createRuntimePort());
        previous._onMessage({type: 'ack', id: 0});
        previous._onMessage({type: 'result', id: 0, data: {result: true}});
        await expect(pending).resolves.toBe(true);
        previous.disconnect();
        expect(api._commPorts.get(2)?.get(3)).toBe(replacement);
        replacement.disconnect();
        expect(vi.getTimerCount()).toBe(0);
    });

    test('failed invoke delivery evicts the channel, rejects its peers, and a later request reconnects', async () => {
        const api = createApi();
        const runtime = createRuntimePort();
        const port = api._setupCommPort(2, 3, runtime);
        /** @type {unknown[]} */
        const errors = [];
        const first = port.invoke('popupFactoryIsVisible', {id: 'first'}, 1000, 2000).catch((error) => { errors.push(error); });
        const failure = new Error('Attempting to use a disconnected port object');
        vi.spyOn(runtime, 'postMessage').mockImplementationOnce(() => { throw failure; });
        await expect(port.invoke('popupFactoryIsVisible', {id: 'second'}, 1000, 2000)).rejects.toBe(failure);
        expect(api._commPorts.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(runtime.disconnect).toHaveBeenCalledTimes(1);
        await first;
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(Error);

        const nextRuntime = createRuntimePort();
        api._api.openCrossFramePort = vi.fn(async () => {
            const next = api._setupCommPort(2, 3, nextRuntime);
            vi.spyOn(nextRuntime, 'postMessage').mockImplementation((message) => {
                next._onMessage({type: 'ack', id: message.id});
                next._onMessage({type: 'result', id: message.id, data: {result: true}});
            });
            return {targetTabId: 2, targetFrameId: 3};
        });
        await expect(api.invokeTab(2, 3, 'popupFactoryIsVisible', {id: 'recovered'})).resolves.toBe(true);
        expect(api._api.openCrossFramePort).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        api._commPorts.get(2)?.get(3)?.disconnect();
    });

    test('a failed acknowledgement does not execute the incoming action', () => {
        const api = createApi();
        const handler = vi.fn();
        api.registerHandlers([['frontendClosePopup', handler]]);
        const runtime = createRuntimePort();
        vi.spyOn(runtime, 'postMessage').mockImplementation(() => { throw new Error('port closed'); });
        const port = api._setupCommPort(2, 3, runtime);
        expect(() => port._onMessage({type: 'invoke', id: 7, data: {action: 'frontendClosePopup', params: undefined}})).not.toThrow();
        expect(handler).not.toHaveBeenCalled();
        expect(api._commPorts.size).toBe(0);
        expect(runtime.disconnect).toHaveBeenCalledTimes(1);
    });

    test('failed result delivery closes the channel and ignores late invocations', () => {
        const api = createApi();
        const handler = vi.fn(() => true);
        api.registerHandlers([['popupFactoryIsVisible', handler]]);
        const runtime = createRuntimePort();
        vi.spyOn(runtime, 'postMessage').mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('result send failed'); });
        const port = api._setupCommPort(2, 3, runtime);
        const message = /** @type {const} */ ({type: 'invoke', id: 7, data: {action: 'popupFactoryIsVisible', params: {id: 'popup'}}});
        expect(() => port._onMessage(message)).not.toThrow();
        expect(api._commPorts.size).toBe(0);
        expect(runtime.disconnect).toHaveBeenCalledTimes(1);
        port._onMessage(message);
        expect(handler).toHaveBeenCalledTimes(1);
    });

    test('a queued invocation on a retired port cannot execute its handler', () => {
        const api = createApi();
        const handler = vi.fn();
        api.registerHandlers([['frontendClosePopup', handler]]);
        const port = api._setupCommPort(2, 3, createRuntimePort());
        port.disconnect();
        port._onMessage({type: 'invoke', id: 7, data: {action: 'frontendClosePopup', params: undefined}});
        expect(handler).not.toHaveBeenCalled();
    });

    test('listener removal failure cannot strand pending requests or prevent transport closure', async () => {
        const api = createApi();
        const runtime = createRuntimePort();
        const failure = new Error('Extension context invalidated');
        vi.spyOn(runtime.onDisconnect, 'removeListener').mockImplementation(() => { throw failure; });
        const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
        const port = api._setupCommPort(2, 3, runtime);
        const windowRemoval = vi.spyOn(window, 'removeEventListener');
        const documentRemoval = vi.spyOn(document, 'removeEventListener');
        const pending = expect(port.invoke('popupFactoryIsVisible', {id: 'popup'}, 1000, 2000)).rejects.toThrow('Disconnected');
        expect(() => port.disconnect()).not.toThrow();
        await pending;
        expect(warn).toHaveBeenCalledExactlyOnceWith(failure);
        expect(api._commPorts.size).toBe(0);
        expect(port._eventListeners.size).toBe(0);
        expect(runtime.onMessage.removeListener).toHaveBeenCalledTimes(1);
        expect(windowRemoval).toHaveBeenCalledTimes(1);
        expect(documentRemoval).toHaveBeenCalledTimes(1);
        expect(runtime.disconnect).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    test('asynchronous results from a disconnected handler cannot affect the replacement channel', async () => {
        const api = createApi();
        let complete = () => {};
        const result = new Promise((resolve) => { complete = () => resolve(true); });
        api.registerHandlers([['popupFactoryIsVisible', () => result]]);
        const runtime = createRuntimePort();
        const port = api._setupCommPort(2, 3, runtime);
        port._onMessage({type: 'invoke', id: 7, data: {action: 'popupFactoryIsVisible', params: {id: 'popup'}}});
        port.disconnect();
        const replacement = api._setupCommPort(2, 3, createRuntimePort());
        complete();
        await result;
        expect(runtime.postMessage).toHaveBeenCalledTimes(1);
        expect(api._commPorts.get(2)?.get(3)).toBe(replacement);
        replacement.disconnect();
    });
});

describe('CrossFrameAPI connection replacement', () => {
    test('a stale disconnect cannot remove a replacement port', async () => {
        const api = createApi();
        const stale = createPort(2, 3);
        const replacement = createPort(2, 3);
        api._commPorts.set(2, new Map([[3, replacement]]));

        api._onDisconnect(stale);

        expect(api._commPorts.get(2)?.get(3)).toBe(replacement);
        await expect(api._getOrCreateCommPort(2, 3)).resolves.toBe(replacement);
        expect(stale.off).toHaveBeenCalledOnce();
    });

    test('the current port disconnect still removes its mapping', () => {
        const api = createApi();
        const current = createPort(2, 3);
        api._commPorts.set(2, new Map([[3, current]]));

        api._onDisconnect(current);

        expect(api._commPorts.has(2)).toBe(false);
        expect(current.off).toHaveBeenCalledOnce();
    });

    test('a stale disconnect preserves replacement and sibling frame mappings', () => {
        const api = createApi();
        const stale = createPort(2, 3);
        const replacement = createPort(2, 3);
        const sibling = createPort(2, 4);
        api._commPorts.set(2, new Map([
            [3, replacement],
            [4, sibling],
        ]));

        api._onDisconnect(stale);

        expect([...api._commPorts.get(2)?.entries() ?? []]).toStrictEqual([
            [3, replacement],
            [4, sibling],
        ]);
    });

    test('disconnecting the current port preserves sibling frames', () => {
        const api = createApi();
        const current = createPort(2, 3);
        const sibling = createPort(2, 4);
        api._commPorts.set(2, new Map([
            [3, current],
            [4, sibling],
        ]));

        api._onDisconnect(current);

        expect(api._commPorts.get(2)?.has(3)).toBe(false);
        expect(api._commPorts.get(2)?.get(4)).toBe(sibling);
    });

    test('disconnect for an absent tab remains harmless', () => {
        const api = createApi();
        const stale = createPort(9, 4);

        api._onDisconnect(stale);

        expect(api._commPorts.size).toBe(0);
        expect(stale.off).toHaveBeenCalledOnce();
    });

    test('real port disconnect events preserve replacement ownership and then prune the current port', () => {
        const api = createApi();
        const stale = createPort(2, 3);
        const replacement = createPort(2, 3);
        stale.on('disconnect', api._onDisconnectBind);
        replacement.on('disconnect', api._onDisconnectBind);
        api._commPorts.set(2, new Map([[3, replacement]]));

        stale.disconnect();
        expect(stale.hasListeners('disconnect')).toBe(false);
        expect(api._commPorts.get(2)?.get(3)).toBe(replacement);
        expect(replacement.hasListeners('disconnect')).toBe(true);
        stale.disconnect();
        expect(stale.off).toHaveBeenCalledOnce();

        replacement.disconnect();
        expect(replacement.hasListeners('disconnect')).toBe(false);
        expect(api._commPorts.size).toBe(0);
        expect(replacement.off).toHaveBeenCalledOnce();
    });
});
