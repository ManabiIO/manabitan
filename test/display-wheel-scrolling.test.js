/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, vi} from 'vitest';
import {Display} from '../ext/js/display/display.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

test.for([
    {deltaX: 40, deltaY: 0, direction: null},
    {deltaX: -40, deltaY: 0, direction: null},
    {deltaX: 0, deltaY: 0, direction: null},
    {deltaX: 0, deltaY: 40, direction: 1},
    {deltaX: 0, deltaY: -40, direction: -1},
    {deltaX: 0, deltaY: 40, direction: null, ctrlKey: true},
    {deltaX: 0, deltaY: -40, direction: null, ctrlKey: true},
])('reduced-motion wheel paging uses vertical scrolling: %j', ({deltaX, deltaY, direction, ctrlKey = false}, {window}) => {
    const scroll = vi.fn();
    const display = /** @type {Display} */ (Object.assign(Object.create(Display.prototype), {
        _options: {scanning: {reducedMotionScrolling: true, reducedMotionScrollingScale: 0.8}},
        _scrollByPopupHeight: scroll,
    }));
    window.document.body.addEventListener('wheel', (event) => display._onWheel(event));
    const event = new window.WheelEvent('wheel', {deltaX, deltaY, ctrlKey, cancelable: true});
    window.document.body.dispatchEvent(event);

    if (direction === null) {
        expect(scroll).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
    } else {
        expect(scroll).toHaveBeenCalledExactlyOnceWith(direction, 0.8);
        expect(event.defaultPrevented).toBe(true);
    }
});
