/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {afterEach, expect, test, vi} from 'vitest';
import {PopupProxy} from '../ext/js/app/popup-proxy.js';
import {log} from '../ext/js/core/log.js';

afterEach(() => { vi.restoreAllMocks(); });

/**
 * @param {boolean} [withOffset]
 * @returns {{proxy: PopupProxy, offset: import('vitest').Mock<() => Promise<?[number, number]>>, invoke: import('vitest').Mock}}
 */
function createProxy(withOffset = true) {
    const offset = vi.fn(/** @returns {Promise<?[number, number]>} */ async () => [10, 20]);
    const invoke = vi.fn().mockResolvedValue(void 0);
    const application = /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({
        crossFrame: {invoke}, webExtension: {unloaded: false},
    }));
    const forwarder = /** @type {import('../ext/js/comm/frame-offset-forwarder.js').FrameOffsetForwarder} */ (/** @type {unknown} */ ({getOffset: offset}));
    return {proxy: new PopupProxy(application, 'root', 0, 0, withOffset ? forwarder : null), offset, invoke};
}

/**
 * @param {number} [left]
 * @returns {import('popup').ContentDetails}
 */
function details(left = 1) {
    return {optionsContext: {depth: 0, url: 'https://example.test'}, writingMode: 'horizontal-tb', sourceRects: [{left, top: 2, right: left + 2, bottom: 4}]};
}

test('hide cancels a show still waiting for initial frame offsets', async () => {
    const {proxy, offset, invoke} = createProxy();
    const pending = /** @type {PromiseWithResolvers<?[number, number]>} */ (Promise.withResolvers());
    offset.mockReturnValue(pending.promise);
    const show = proxy.showContent(details(), null);
    await proxy.hide(false);
    pending.resolve([10, 20]);
    await show;
    expect(invoke.mock.calls.map((call) => call[1])).toStrictEqual(['popupFactoryHide']);
});

test('only the latest show is forwarded after a shared initial offset wait', async () => {
    const {proxy, offset, invoke} = createProxy();
    const pending = /** @type {PromiseWithResolvers<?[number, number]>} */ (Promise.withResolvers());
    offset.mockReturnValue(pending.promise);
    const older = proxy.showContent(details(1), null);
    const newer = proxy.showContent(details(9), null);
    pending.resolve([10, 20]);
    await Promise.all([older, newer]);
    expect(offset).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][2].details.sourceRects[0].left).toBe(19);
});

test('coordinate translation does not mutate or accumulate on caller rectangles', async () => {
    const {proxy, invoke} = createProxy();
    const input = details();
    const original = structuredClone(input);
    await proxy.showContent(input, null);
    await proxy.showContent(input, null);
    expect(input).toStrictEqual(original);
    expect(invoke.mock.calls.map((call) => call[2].details.sourceRects)).toStrictEqual([
        [{left: 11, top: 22, right: 13, bottom: 24}],
        [{left: 11, top: 22, right: 13, bottom: 24}],
    ]);
});

test('translation supports frozen caller rectangles and request details', async () => {
    const {proxy, invoke} = createProxy();
    const input = details();
    Object.freeze(input.sourceRects[0]);
    Object.freeze(input.sourceRects);
    Object.freeze(input);
    await proxy.showContent(input, null);
    expect(invoke.mock.calls[0][2].details.sourceRects[0].left).toBe(11);
});

test('show snapshots its source geometry before an asynchronous offset lookup', async () => {
    const {proxy, offset, invoke} = createProxy();
    const pending = /** @type {PromiseWithResolvers<?[number, number]>} */ (Promise.withResolvers());
    offset.mockReturnValue(pending.promise);
    const input = details();
    const show = proxy.showContent(input, null);
    input.sourceRects[0].left = 100;
    input.writingMode = 'vertical-rl';
    pending.resolve([10, 20]);
    await show;
    expect(invoke.mock.calls[0][2].details.sourceRects[0].left).toBe(11);
    expect(invoke.mock.calls[0][2].details.writingMode).toBe('horizontal-tb');
});

test('all first-offset waiters share failure handling and recover on a later request', async () => {
    const {proxy, offset, invoke} = createProxy();
    const pending = /** @type {PromiseWithResolvers<?[number, number]>} */ (Promise.withResolvers());
    offset.mockReturnValueOnce(pending.promise).mockResolvedValueOnce([10, 20]);
    const error = new Error('Offset transport unavailable');
    const report = vi.spyOn(log, 'error').mockImplementation(() => {});
    const first = proxy.containsPoint(1, 2);
    const second = proxy.containsPoint(3, 4);
    const observed = Promise.allSettled([first, second]);
    pending.reject(error);
    expect(await observed).toStrictEqual([{status: 'fulfilled', value: false}, {status: 'fulfilled', value: false}]);
    expect(report).toHaveBeenCalledExactlyOnceWith(error);
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockResolvedValueOnce(true);
    expect(await proxy.containsPoint(1, 2)).toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(0, 'popupFactoryContainsPoint', {id: 'root', x: 11, y: 22});
});

test('synchronous offset failure is handled and does not poison later requests', async () => {
    const {proxy, offset, invoke} = createProxy();
    const error = new Error('Offset provider failed synchronously');
    offset.mockImplementationOnce(() => { throw error; }).mockResolvedValueOnce([10, 20]);
    const report = vi.spyOn(log, 'error').mockImplementation(() => {});
    const first = await proxy.showContent(details(), null).then(() => null, (failure) => failure);
    expect(first).toBeNull();
    expect(report).toHaveBeenCalledExactlyOnceWith(error);
    expect(invoke).not.toHaveBeenCalled();
    await proxy.showContent(details(), null);
    expect(invoke).toHaveBeenCalledTimes(1);
});

for (const value of [null, [Number.NaN, 20], [10, Infinity]]) {
    test(`missing or invalid offsets ${JSON.stringify(value)} never forward a show at guessed coordinates`, async () => {
        const {proxy, offset, invoke} = createProxy();
        offset.mockResolvedValue(/** @type {?[number, number]} */ (value));
        const unavailable = vi.fn();
        proxy.on('offsetNotFound', unavailable);
        await proxy.showContent(details(), null);
        expect(unavailable).toHaveBeenCalledTimes(1);
        expect(invoke).not.toHaveBeenCalled();
        expect(proxy._frameOffsetUpdatedAt).toBeNull();
    });
}

test('background refresh remains nonblocking while cached offsets are usable', async () => {
    const {proxy, offset, invoke} = createProxy();
    vi.spyOn(Date, 'now').mockReturnValue(100);
    await proxy.showContent(details(), null);
    const refresh = /** @type {PromiseWithResolvers<?[number, number]>} */ (Promise.withResolvers());
    offset.mockReturnValueOnce(refresh.promise);
    vi.mocked(Date.now).mockReturnValue(1200);
    await proxy.showContent(details(), null);
    expect(invoke.mock.calls[1][2].details.sourceRects[0].left).toBe(11);
    expect(offset).toHaveBeenCalledTimes(2);
    refresh.resolve([30, 40]);
    await proxy._frameOffsetPromise;
    await proxy.showContent(details(), null);
    expect(invoke.mock.calls[2][2].details.sourceRects[0].left).toBe(31);
});

test('a failed refresh invalidates old offset readiness rather than retaining zero as a valid cache', async () => {
    const {proxy, offset, invoke} = createProxy();
    vi.spyOn(Date, 'now').mockReturnValue(100);
    await proxy.showContent(details(), null);
    const refresh = /** @type {PromiseWithResolvers<?[number, number]>} */ (Promise.withResolvers());
    offset.mockReturnValueOnce(refresh.promise);
    vi.mocked(Date.now).mockReturnValue(1200);
    await proxy.showContent(details(), null);
    refresh.resolve(null);
    await proxy._frameOffsetPromise;
    const unavailable = /** @type {PromiseWithResolvers<?[number, number]>} */ (Promise.withResolvers());
    offset.mockReturnValueOnce(unavailable.promise);
    const lastShow = proxy.showContent(details(), null);
    await Promise.resolve();
    const requestsBeforeRecovery = invoke.mock.calls.length;
    unavailable.resolve([30, 40]);
    await lastShow;
    expect(requestsBeforeRecovery).toBe(2);
    expect(invoke.mock.calls.at(-1)?.[2].details.sourceRects[0].left).toBe(31);
    expect(offset).toHaveBeenCalledTimes(3);
});

test('direct proxy forwarding still works without an offset provider', async () => {
    const {proxy, offset, invoke} = createProxy(false);
    const input = details();
    await proxy.showContent(input, null);
    invoke.mockResolvedValueOnce(true);
    expect(await proxy.containsPoint(1, 2)).toBe(true);
    expect(offset).not.toHaveBeenCalled();
    expect(invoke.mock.calls[0]).toStrictEqual([0, 'popupFactoryShowContent', {id: 'root', details: input, displayDetails: null, publication: void 0}]);
});

test('hide invalidates a waiting show even when the remote hide fails', async () => {
    const {proxy, offset, invoke} = createProxy();
    const pending = /** @type {PromiseWithResolvers<?[number, number]>} */ (Promise.withResolvers());
    offset.mockReturnValueOnce(pending.promise);
    const show = proxy.showContent(details(), null);
    const error = new Error('Remote hide failed');
    invoke.mockRejectedValueOnce(error);
    await expect(proxy.hide(false)).rejects.toBe(error);
    pending.resolve([10, 20]);
    await show;
    expect(invoke).toHaveBeenCalledExactlyOnceWith(0, 'popupFactoryHide', {id: 'root', changeFocus: false, publication: {source: Reflect.get(proxy, '_publicationSource'), generation: 1}});
});

test('show and hit testing share one fully published initial offset update', async () => {
    const {proxy, offset, invoke} = createProxy();
    const pending = /** @type {PromiseWithResolvers<?[number, number]>} */ (Promise.withResolvers());
    offset.mockReturnValueOnce(pending.promise);
    invoke.mockImplementation(async (_frameId, action) => (action === 'popupFactoryContainsPoint' ? true : void 0));
    const show = proxy.showContent(details(), null);
    const contains = proxy.containsPoint(1, 2);
    pending.resolve([0, -20]);
    await show;
    expect(await contains).toBe(true);
    expect(offset).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls.find((call) => call[1] === 'popupFactoryShowContent')?.[2].details.sourceRects).toStrictEqual([
        {left: 1, top: -18, right: 3, bottom: -16},
    ]);
    expect(invoke).toHaveBeenCalledWith(0, 'popupFactoryContainsPoint', {id: 'root', x: 1, y: -18});
});

test('an immediately missing refresh cannot forward a show with reset coordinates', async () => {
    const {proxy, offset, invoke} = createProxy();
    vi.spyOn(Date, 'now').mockReturnValue(100);
    await proxy.showContent(details(), null);
    offset.mockResolvedValueOnce(null);
    vi.mocked(Date.now).mockReturnValue(1200);
    await proxy.showContent(details(), null);
    await proxy._frameOffsetPromise;
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(proxy._frameOffsetUpdatedAt).toBeNull();
    await proxy.showContent(details(), null);
    expect(offset).toHaveBeenCalledTimes(3);
    expect(invoke.mock.calls[1][2].details.sourceRects[0].left).toBe(11);
});

test('a rejected background refresh keeps usable coordinates and releases its retry slot', async () => {
    const {proxy, offset, invoke} = createProxy();
    vi.spyOn(Date, 'now').mockReturnValue(100);
    await proxy.showContent(details(), null);
    const refresh = /** @type {PromiseWithResolvers<?[number, number]>} */ (Promise.withResolvers());
    offset.mockReturnValueOnce(refresh.promise);
    vi.mocked(Date.now).mockReturnValue(1200);
    await proxy.showContent(details(), null);
    const error = new Error('Temporary offset transport failure');
    const report = vi.spyOn(log, 'error').mockImplementation(() => {});
    refresh.reject(error);
    await proxy._frameOffsetPromise;
    expect(report).toHaveBeenCalledExactlyOnceWith(error);
    expect(proxy._frameOffsetPromise).toBeNull();
    expect(proxy._frameOffsetUpdatedAt).toBe(100);
    offset.mockResolvedValueOnce([30, 40]);
    await proxy.showContent(details(), null);
    expect(offset).toHaveBeenCalledTimes(3);
    expect(invoke.mock.calls.at(-1)?.[2].details.sourceRects[0].left).toBe(31);
});
