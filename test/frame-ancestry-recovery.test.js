/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {afterEach, expect, vi} from 'vitest';
import {CrossFrameAPI} from '../ext/js/comm/cross-frame-api.js';
import {FrameAncestryHandler} from '../ext/js/comm/frame-ancestry-handler.js';
import {FrameOffsetForwarder} from '../ext/js/comm/frame-offset-forwarder.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();
afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

/** @returns {CrossFrameAPI} */
function crossFrame() {
    return new CrossFrameAPI(/** @type {import('../ext/js/comm/api.js').API} */ (/** @type {unknown} */ ({})), 1, 7);
}

test('an ancestry timeout releases its resources and a later offset lookup recovers', async ({window}) => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    Object.defineProperty(window, 'parent', {value: {postMessage}});
    const api = crossFrame();
    const forwarder = new FrameOffsetForwarder(api);
    forwarder.prepare();
    vi.spyOn(api, 'invoke').mockResolvedValue(/** @type {never} */ ({x: 12, y: 34, width: 100, height: 100}));
    const first = forwarder.getOffset();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await first).toBeNull();
    const handler = forwarder._frameAncestryHandler;
    expect(handler._responseHandlers.size).toBe(0);
    const second = forwarder.getOffset();
    const message = postMessage.mock.calls.at(-1)?.[0];
    const expiredMessage = postMessage.mock.calls[0][0];
    expect(handler._onFrameAncestryHandlerRequestFrameInfoResponse({...expiredMessage.params, frameId: 3, more: false})).toBeNull();
    handler._onFrameAncestryHandlerRequestFrameInfoResponse({...message.params, frameId: 3, more: false});
    expect(await second).toStrictEqual([12, 34]);
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(handler._responseHandlers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
});

test('synchronous message failure immediately releases the timer and response handler', async ({window}) => {
    vi.useFakeTimers();
    const error = new Error('Detached parent');
    Object.defineProperty(window, 'parent', {value: {postMessage: vi.fn(() => { throw error; })}});
    const handler = new FrameAncestryHandler(crossFrame());
    handler.prepare();
    await expect(handler.getFrameAncestryInfo()).rejects.toBe(error);
    expect(handler._responseHandlers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
});

test('concurrent ancestry callers share one exchange and successful data stays cached', async ({window}) => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    Object.defineProperty(window, 'parent', {value: {postMessage}});
    const handler = new FrameAncestryHandler(crossFrame());
    handler.prepare();
    const first = handler.getFrameAncestryInfo();
    const second = handler.getFrameAncestryInfo();
    const {params} = postMessage.mock.calls[0][0];
    expect(handler._onFrameAncestryHandlerRequestFrameInfoResponse({...params, frameId: 3, more: false})).not.toBeNull();
    expect(await first).toStrictEqual([3]);
    expect(await second).toStrictEqual([3]);
    expect(await handler.getFrameAncestryInfo()).toStrictEqual([3]);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(handler._responseHandlers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
});

test('multi-hop ancestry preserves order and rejects stale nonces and late replies', async ({window}) => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    Object.defineProperty(window, 'parent', {value: {postMessage}});
    const handler = new FrameAncestryHandler(crossFrame());
    handler.prepare();
    const pending = handler.getFrameAncestryInfo();
    const {params} = postMessage.mock.calls[0][0];
    const reply = await handler._onFrameAncestryHandlerRequestFrameInfoResponse({...params, frameId: 3, more: true});
    expect(reply).not.toBeNull();
    expect(handler._onFrameAncestryHandlerRequestFrameInfoResponse({...params, frameId: 99, more: false})).toBeNull();
    handler._onFrameAncestryHandlerRequestFrameInfoResponse({...params, nonce: reply?.nonce ?? '', frameId: 0, more: false});
    expect(await pending).toStrictEqual([3, 0]);
    expect(handler._onFrameAncestryHandlerRequestFrameInfoResponse({...params, frameId: 99, more: false})).toBeNull();
    expect(handler._responseHandlers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
});

test('a failed retired ancestry exchange cannot evict a newer cached result', async ({window: _window}) => {
    const handler = new FrameAncestryHandler(crossFrame());
    const old = /** @type {PromiseWithResolvers<number[]>} */ (Promise.withResolvers());
    vi.spyOn(handler, '_getFrameAncestryInfo').mockReturnValue(old.promise);
    const first = handler.getFrameAncestryInfo();
    const error = new Error('Retired exchange');
    const observed = expect(first).rejects.toBe(error);
    const replacement = Promise.resolve([3]);
    handler._getFrameAncestryInfoPromise = replacement;
    old.reject(error);
    await observed;
    expect(handler._getFrameAncestryInfoPromise).toBe(replacement);
    expect(await handler.getFrameAncestryInfo()).toStrictEqual([3]);
});

test('failed handler registration leaves no window listener and preparation can retry', async ({window}) => {
    const api = crossFrame();
    const handler = new FrameAncestryHandler(api);
    const retireBlocker = api.registerHandlersScoped([
        ['frameAncestryHandlerRequestFrameInfoResponse', () => null],
    ]);
    vi.spyOn(api, 'registerHandlersScoped');
    const listeners = new Set();
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation((type, callback, options) => {
        if (type === 'message') { listeners.add(callback); }
        add(type, callback, options);
    });
    vi.spyOn(window, 'removeEventListener').mockImplementation((type, callback, options) => {
        if (type === 'message') { listeners.delete(callback); }
        remove(type, callback, options);
    });
    expect(() => handler.prepare()).toThrow('already been registered');
    expect(listeners.size).toBe(0);
    retireBlocker();
    handler.prepare();
    handler.prepare();
    expect(listeners.size).toBe(1);
    expect(api.registerHandlersScoped).toHaveBeenCalledTimes(2);
});

test('failed window listener attachment releases its owned API handler for retry', async ({window}) => {
    const api = crossFrame();
    const handler = new FrameAncestryHandler(api);
    const error = new Error('Listener attachment unavailable');
    const attach = vi.spyOn(window, 'addEventListener').mockImplementationOnce(() => { throw error; });
    expect(() => handler.prepare()).toThrow(error);
    expect(api._apiMap.size).toBe(0);
    handler.prepare();
    expect(api._apiMap.size).toBe(1);
    expect(attach).toHaveBeenCalledTimes(2);
});

for (const childFrameId of [-1, 1.5, Infinity, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    test(`invalid child frame id ${String(childFrameId)} cannot create a frame mapping`, async ({window}) => {
        const api = crossFrame();
        const handler = new FrameAncestryHandler(api);
        const invoke = vi.spyOn(api, 'invoke').mockResolvedValue(/** @type {never} */ ({nonce: 'reply'}));
        await handler._onRequestFrameInfo({originFrameId: 7, childFrameId, uniqueId: 'request', nonce: 'nonce'}, /** @type {Window} */ (/** @type {unknown} */ (window)));
        expect(invoke).not.toHaveBeenCalled();
        expect(handler._childFrameMap.size).toBe(0);
    });
}

test('zero is a valid origin and child frame id', async ({window}) => {
    const api = crossFrame();
    const handler = new FrameAncestryHandler(api);
    const invoke = vi.spyOn(api, 'invoke').mockResolvedValue(/** @type {never} */ ({nonce: 'reply'}));
    await handler._onRequestFrameInfo({originFrameId: 0, childFrameId: 0, uniqueId: 'request', nonce: 'nonce'}, /** @type {Window} */ (/** @type {unknown} */ (window)));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(handler._childFrameMap.has(0)).toBe(true);
});

test('a temporarily undiscoverable frame element is not cached as missing forever', async ({window}) => {
    const handler = new FrameAncestryHandler(crossFrame());
    const element = window.document.createElement('iframe');
    window.document.body.append(element);
    handler._childFrameMap.set(3, {window: /** @type {Window} */ (/** @type {unknown} */ (window)), frameElement: void 0});
    const find = vi.spyOn(handler, '_findFrameElementWithContentWindow').mockReturnValueOnce(null).mockReturnValue(element);
    expect(handler.getChildFrameElement(3)).toBeNull();
    expect(handler.getChildFrameElement(3)).toBe(element);
    expect(handler.getChildFrameElement(3)).toBe(element);
    expect(find).toHaveBeenCalledTimes(2);
});

test('a detached cached frame element is rediscovered before computing offsets', async ({window}) => {
    const handler = new FrameAncestryHandler(crossFrame());
    const old = window.document.createElement('iframe');
    const replacement = window.document.createElement('iframe');
    window.document.body.append(old, replacement);
    handler._childFrameMap.set(3, {window: /** @type {Window} */ (/** @type {unknown} */ (window)), frameElement: old});
    const find = vi.spyOn(handler, '_findFrameElementWithContentWindow').mockReturnValue(replacement);
    expect(handler.getChildFrameElement(3)).toBe(old);
    old.remove();
    expect(handler.getChildFrameElement(3)).toBe(replacement);
    expect(find).toHaveBeenCalledTimes(1);
});

test('a saved window cannot reintroduce a detached frame element during rediscovery', async ({window}) => {
    const handler = new FrameAncestryHandler(crossFrame());
    const detached = window.document.createElement('iframe');
    const source = /** @type {Window} */ (/** @type {unknown} */ ({frameElement: detached}));
    handler._childFrameMap.set(3, {window: source, frameElement: detached});
    expect(handler.getChildFrameElement(3)).toBeNull();
});
