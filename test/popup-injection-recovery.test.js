/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {afterEach, expect, test, vi} from 'vitest';
import {Popup} from '../ext/js/app/popup.js';
import {FrameClient} from '../ext/js/comm/frame-client.js';

afterEach(() => { vi.restoreAllMocks(); });

/** @returns {Popup} */
function createPopup() {
    const popup = /** @type {Popup} */ (Object.create(Popup.prototype));
    for (const [key, value] of Object.entries({
        _container: {parentNode: null},
        _frame: {removeAttribute: vi.fn()},
        _frameClient: null,
        _frameConnected: false,
        _injectPromise: null,
        _injectPromiseComplete: false,
        _useSecureFrameUrl: true,
        _updateHostPageDebugState: vi.fn(),
    })) {
        Reflect.set(popup, key, value);
    }
    return popup;
}

/**
 * @param {Popup} popup
 * @returns {Promise<boolean>}
 */
function inject(popup) {
    return Reflect.get(popup, '_inject').call(popup);
}

test('fallback injection remains shared by concurrent callers and cached after success', async () => {
    const popup = createPopup();
    const fallback = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    const enteredFallback = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    const inner = vi.fn()
        .mockRejectedValueOnce(new Error('Secure frame navigation failed'))
        .mockImplementationOnce(async () => {
            enteredFallback.resolve();
            await fallback.promise;
            Reflect.set(popup, '_frameConnected', true);
        });
    Reflect.set(popup, '_injectInner', inner);

    const first = inject(popup);
    const initiallyConcurrent = inject(popup);
    expect(initiallyConcurrent).toBe(first);
    await enteredFallback.promise;
    const duringFallback = inject(popup);
    fallback.resolve();
    const results = await Promise.all([first, initiallyConcurrent, duringFallback]);

    expect(duringFallback).toBe(first);
    expect(results).toStrictEqual([true, true, true]);
    expect(inject(popup)).toBe(first);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(Reflect.get(popup, '_injectPromiseComplete')).toBe(true);
    expect(Reflect.get(popup, '_frameConnected')).toBe(true);
    expect(Reflect.get(popup, '_useSecureFrameUrl')).toBe(false);

    Reflect.get(popup, '_onFrameLoad').call(popup);
    expect(Reflect.get(popup, '_injectPromise')).toBeNull();
    expect(Reflect.get(popup, '_frameConnected')).toBe(false);
});

test.each([true, false])('terminal injection failure clears the cached request (secure=%s)', async (secure) => {
    const popup = createPopup();
    Reflect.set(popup, '_useSecureFrameUrl', secure);
    const error = new Error('Frame failed');
    const inner = vi.fn().mockRejectedValue(error);
    Reflect.set(popup, '_injectInner', inner);

    await expect(inject(popup)).rejects.toBe(error);
    expect(Reflect.get(popup, '_injectPromise')).toBeNull();
    expect(Reflect.get(popup, '_frameConnected')).toBe(false);
    expect(Reflect.get(popup, '_injectPromiseComplete')).toBe(false);
    inner.mockResolvedValue(void 0);
    await expect(inject(popup)).resolves.toBe(true);
    expect(Reflect.get(popup, '_injectPromiseComplete')).toBe(true);
});

test('iframe reloads retain exactly one pointer listener per event', async () => {
    const popup = createPopup();
    const frame = Object.assign(new EventTarget(), {removeAttribute: vi.fn()});
    const mouseOver = vi.fn();
    const mouseOut = vi.fn();
    for (const [key, value] of Object.entries({
        _frame: frame,
        _optionsContext: {},
        _visible: {on: vi.fn(), value: false},
        _application: {on: vi.fn()},
        _themeController: {prepare: vi.fn()},
        _onVisibleChange: vi.fn(),
        _onFrameMouseOver: mouseOver,
        _onFrameMouseOut: mouseOut,
        _setUpContainer: vi.fn().mockResolvedValue(void 0),
        _invokeSafe: vi.fn().mockResolvedValue(void 0),
    })) {
        Reflect.set(popup, key, value);
    }
    vi.spyOn(FrameClient.prototype, 'connect').mockResolvedValue(void 0);
    popup.prepare();

    for (let index = 0; index < 3; ++index) {
        await expect(inject(popup)).resolves.toBe(true);
        mouseOver.mockClear();
        mouseOut.mockClear();
        frame.dispatchEvent(new Event('mouseover'));
        frame.dispatchEvent(new Event('mouseout'));
        expect(mouseOver).toHaveBeenCalledTimes(1);
        expect(mouseOut).toHaveBeenCalledTimes(1);
        frame.dispatchEvent(new Event('load'));
        expect(Reflect.get(popup, '_frameConnected')).toBe(false);
    }
});
