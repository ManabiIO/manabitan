/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {Popup} from '../ext/js/app/popup.js';

afterEach(() => { vi.restoreAllMocks(); });

/** @returns {Popup} */
function createShowingPopup() {
    const popup = /** @type {Popup} */ (Object.create(Popup.prototype));
    for (const [name, value] of Object.entries({
        _optionsContext: {url: 'https://example.test'},
        _publicationGeneration: 0,
        _publicationSource: 'visibility-test',
        _cancelPendingPublication: null,
        _visible: {value: false},
        _child: null,
        _hidePopupTimer: null,
        _frame: {dataset: {}, style: {}},
        _displayModeIsFullWidth: false,
        _inject: vi.fn().mockResolvedValue(true),
        _getViewport: vi.fn().mockReturnValue({left: 0, top: 0, right: 1000, bottom: 1000}),
        _getPosition: vi.fn().mockImplementation((rects) => ({left: rects[0]?.left ?? 0, top: 0, width: 100, height: 100, after: false, below: true})),
        _setVisible: vi.fn(),
        _invokeSafe: vi.fn().mockResolvedValue(void 0),
        _updateHostPageDebugState: vi.fn(),
        _incrementHostDebugCounter: vi.fn().mockReturnValue(1),
    })) {
        Reflect.set(popup, name, value);
    }
    return popup;
}

/**
 * @param {number} left
 * @returns {import('popup').ContentDetails}
 */
function contentDetails(left = 10) {
    return {optionsContext: null, sourceRects: [{left, top: 0, right: left + 5, bottom: 5}], writingMode: 'horizontal-tb'};
}

describe('Popup visibility', () => {
    test('hiding an already-hidden parent still hides its visible child', () => {
        const popup = /** @type {Popup} */ (Object.create(Popup.prototype));
        const childHide = vi.fn();
        Reflect.set(popup, '_visible', {value: false});
        Reflect.set(popup, '_hidePopupTimer', null);
        Reflect.set(popup, '_child', {hide: childHide});

        popup.hide(false);

        expect(childHide).toHaveBeenCalledExactlyOnceWith(false);
    });

    test('hide during cold injection prevents that request from making the popup visible', async () => {
        const popup = createShowingPopup();
        const injected = /** @type {PromiseWithResolvers<boolean>} */ (Promise.withResolvers());
        const inject = vi.spyOn(popup, '_inject').mockReturnValue(injected.promise);
        const display = /** @type {import('display').ContentDetails} */ (/** @type {unknown} */ ({}));
        const shown = popup.showContent(contentDetails(), display);
        expect(inject).toHaveBeenCalledTimes(1);
        popup.hide(false);
        injected.resolve(true);
        await shown;
        expect(popup._setVisible).not.toHaveBeenCalledWith(true);
    });

    test('hide during content delivery prevents a later show and the next request still works', async () => {
        const popup = createShowingPopup();
        const delivered = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        vi.spyOn(popup, '_invokeSafe').mockReturnValueOnce(delivered.promise);
        const display = /** @type {import('display').ContentDetails} */ (/** @type {unknown} */ ({}));
        const shown = popup.showContent(contentDetails(), display);
        await Promise.resolve();
        popup.hide(false);
        delivered.resolve();
        await shown;
        expect(popup._setVisible).not.toHaveBeenCalledWith(true);
        await popup.showContent(contentDetails(), display);
        expect(popup._setVisible).toHaveBeenCalledExactlyOnceWith(true);
    });

    test('an older show that finishes late cannot overwrite the newest popup position', async () => {
        const popup = createShowingPopup();
        const older = /** @type {PromiseWithResolvers<boolean>} */ (Promise.withResolvers());
        vi.spyOn(popup, '_inject').mockReturnValueOnce(older.promise).mockResolvedValue(true);
        const display = /** @type {import('display').ContentDetails} */ (/** @type {unknown} */ ({}));
        const first = popup.showContent(contentDetails(10), display);
        await popup.showContent(contentDetails(50), display);
        expect(popup._frame.style.left).toBe('50px');
        older.resolve(true);
        await first;
        expect(popup._frame.style.left).toBe('50px');
        expect(popup._setVisible).toHaveBeenCalledTimes(1);
    });

    test('hide during options preparation prevents both injection and content delivery', async () => {
        const popup = createShowingPopup();
        const options = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        vi.spyOn(popup, '_setOptionsContextIfDifferent').mockReturnValue(options.promise);
        const display = /** @type {import('display').ContentDetails} */ (/** @type {unknown} */ ({}));
        const shown = popup.showContent({...contentDetails(), optionsContext: {url: 'https://other.test', depth: 0}}, display);
        popup.hide(false);
        options.resolve();
        await shown;
        expect(popup._inject).not.toHaveBeenCalled();
        expect(popup._invokeSafe).not.toHaveBeenCalled();
        expect(popup._setVisible).not.toHaveBeenCalledWith(true);
    });

    test('superseded content cannot be sent after a delayed injection finishes', async () => {
        const popup = createShowingPopup();
        const older = /** @type {PromiseWithResolvers<boolean>} */ (Promise.withResolvers());
        vi.spyOn(popup, '_inject').mockReturnValueOnce(older.promise).mockResolvedValue(true);
        const display = /** @type {import('display').ContentDetails} */ (/** @type {unknown} */ ({}));
        const first = popup.showContent(contentDetails(10), display);
        await popup.showContent(contentDetails(50), display);
        older.resolve(true);
        await first;
        expect(popup._invokeSafe).toHaveBeenCalledExactlyOnceWith('displaySetContent', {
            details: display, publication: {source: 'visibility-test', generation: 2},
        });
        expect(popup._frame.style.left).toBe('50px');
    });
});
