/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, vi} from 'vitest';
import {Display} from '../ext/js/display/display.js';
import {DocumentFocusController} from '../ext/js/dom/document-focus-controller.js';
import {HotkeyHandler} from '../ext/js/input/hotkey-handler.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest('ext/search.html');
afterEach(() => { vi.restoreAllMocks(); });

/** @typedef {{identifier: number, clientY: number}} TestTouch */

function setup() {
    const application = /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({api: {}, tabId: 1, frameId: 2}));
    const display = new Display(application, 'search', new DocumentFocusController(), new HotkeyHandler());
    const scanning = {reducedMotionScrolling: true, reducedMotionScrollingSwipeThreshold: 30, reducedMotionScrollingScale: 0.8};
    display._options = /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({scanning}));
    const scroll = vi.spyOn(display, '_scrollByPopupHeight').mockImplementation(() => {});
    const element = display._contentScrollElement;
    element.addEventListener('touchstart', (event) => display._onTouchStart(event));
    element.addEventListener('touchmove', display._onTouchMove);
    /**
     * @param {string} type
     * @param {TestTouch[]} touches
     * @param {TestTouch[]} [changedTouches]
     * @returns {Event}
     */
    const send = (type, touches, changedTouches = touches) => {
        const event = new Event(type, {cancelable: true});
        Object.defineProperties(event, {touches: {value: touches}, changedTouches: {value: changedTouches}});
        element.dispatchEvent(event);
        return event;
    };
    return {display, scanning, scroll, send};
}

test('a cancelled swipe cannot turn the next stationary tap into a page jump', ({window: _window}) => {
    const {scroll, send} = setup();
    send('touchstart', [{identifier: 1, clientY: 300}]);
    send('touchcancel', [], [{identifier: 1, clientY: 150}]);
    send('touchstart', [{identifier: 2, clientY: 100}]);
    send('touchend', [], [{identifier: 2, clientY: 100}]);

    expect(scroll).not.toHaveBeenCalled();
});

test('adding a second finger cancels page scrolling for the whole gesture', ({window: _window}) => {
    const {scroll, send} = setup();
    const first = {identifier: 1, clientY: 300};
    const second = {identifier: 2, clientY: 100};
    send('touchstart', [first]);
    send('touchstart', [first, second], [second]);
    send('touchend', [first], [second]);
    send('touchend', [], [{identifier: 1, clientY: 100}]);

    expect(scroll).not.toHaveBeenCalled();
});

test('an unrelated touch ending does not consume the active swipe', ({window: _window}) => {
    const {scroll, send} = setup();
    send('touchstart', [{identifier: 7, clientY: 300}]);
    send('touchend', [{identifier: 7, clientY: 300}], [{identifier: 8, clientY: 500}]);
    expect(scroll).not.toHaveBeenCalled();
    send('touchend', [], [{identifier: 7, clientY: 100}]);

    expect(scroll).toHaveBeenCalledExactlyOnceWith(1, 0.8);
});

test.for([{end: 100, direction: 1}, {end: 500, direction: -1}])('a completed single-finger swipe scrolls one page: %j', ({end, direction}, {window: _window}) => {
    const {scroll, send} = setup();
    send('touchstart', [{identifier: 7, clientY: 300}]);
    send('touchend', [], [{identifier: 7, clientY: end}]);
    send('touchend', [], [{identifier: 7, clientY: end}]);

    expect(scroll).toHaveBeenCalledExactlyOnceWith(direction, 0.8);
});

test('disabling reduced-motion scrolling during a swipe prevents a late page jump', ({window: _window}) => {
    const {display, scanning, scroll, send} = setup();
    send('touchstart', [{identifier: 7, clientY: 300}]);
    display._options = /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({scanning: {...scanning, reducedMotionScrolling: false}}));
    send('touchend', [], [{identifier: 7, clientY: 100}]);

    expect(scroll).not.toHaveBeenCalled();
});

test('reduced-motion scrolling leaves multi-touch movement available to the browser', ({window: _window}) => {
    const {send} = setup();
    const touches = [{identifier: 1, clientY: 300}, {identifier: 2, clientY: 100}];
    send('touchstart', touches);

    expect(send('touchmove', touches).defaultPrevented).toBe(false);
});
