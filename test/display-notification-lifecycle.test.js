/*
 * Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {DisplayNotification} from '../ext/js/display/display-notification.js';

/**
 * @returns {{
 *   notification: DisplayNotification,
 *   node: {hidden: boolean},
 *   appendChild: ReturnType<typeof vi.fn>,
 *   removeChild: ReturnType<typeof vi.fn>,
 *   addEventListener: ReturnType<typeof vi.fn>,
 *   removeEventListener: ReturnType<typeof vi.fn>,
 * }}
 */
function createHarness() {
    let attached = false;
    const appendChild = vi.fn(() => { attached = true; });
    const removeChild = vi.fn(() => { attached = false; });
    const container = {appendChild, removeChild};
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const closeButton = {addEventListener, removeEventListener};
    const body = {textContent: '', appendChild: vi.fn()};
    const node = {
        hidden: true,
        get parentNode() { return attached ? container : null; },
        querySelector: (/** @type {string} */ selector) => (
            selector === '.footer-notification-body' ? body : closeButton
        ),
    };
    const notification = new DisplayNotification(
        /** @type {HTMLElement} */ (/** @type {unknown} */ (container)),
        /** @type {HTMLElement} */ (/** @type {unknown} */ (node)),
    );
    return {notification, node, appendChild, removeChild, addEventListener, removeEventListener};
}

describe('DisplayNotification close and reopen lifecycle', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('getComputedStyle', () => ({getPropertyValue: () => ''}));
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    test('reopening before the close animation completes cancels removal', () => {
        const {notification, node, appendChild, removeChild} = createHarness();
        notification.open();
        notification.close(true);
        expect(node.hidden).toBe(true);
        expect(notification.isClosing()).toBe(true);
        expect(vi.getTimerCount()).toBe(1);

        notification.open();
        expect(node.hidden).toBe(false);
        expect(notification.isClosed()).toBe(false);
        expect(notification.isClosing()).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(500);
        expect(notification.isClosed()).toBe(false);
        expect(appendChild).toHaveBeenCalledOnce();
        expect(removeChild).not.toHaveBeenCalled();
    });

    test('reopen does not install duplicate close-button listeners', () => {
        const {notification, addEventListener, removeEventListener} = createHarness();
        notification.open();
        notification.close(true);
        notification.open();
        notification.open();
        expect(addEventListener).toHaveBeenCalledOnce();
        expect(removeEventListener).not.toHaveBeenCalled();
        notification.close(false);
        expect(removeEventListener).toHaveBeenCalledOnce();

        notification.open();
        expect(addEventListener).toHaveBeenCalledTimes(2);
        notification.close(false);
        expect(removeEventListener).toHaveBeenCalledTimes(2);
    });

    test('close animation still removes the node if not interrupted', () => {
        const {notification, node, removeChild, removeEventListener} = createHarness();
        notification.open();
        notification.close(true);
        vi.advanceTimersByTime(200);
        expect(notification.isClosed()).toBe(true);
        expect(notification.isClosing()).toBe(false);
        expect(node.hidden).toBe(true);
        expect(removeChild).toHaveBeenCalledOnce();
        expect(removeEventListener).toHaveBeenCalledOnce();
    });

    test('a new notification after a completed close attaches normally', () => {
        const {notification, node, appendChild} = createHarness();
        notification.open();
        notification.close(true);
        vi.advanceTimersByTime(200);
        notification.open();
        expect(notification.isClosed()).toBe(false);
        expect(node.hidden).toBe(false);
        expect(appendChild).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });
});
