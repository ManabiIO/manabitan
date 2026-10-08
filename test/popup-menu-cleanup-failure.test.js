/* SPDX-License-Identifier: GPL-3.0-or-later */
import {JSDOM} from 'jsdom';
import {afterEach, expect, test, vi} from 'vitest';
import {PopupMenu} from '../ext/js/dom/popup-menu.js';
import {log} from '../ext/js/core/log.js';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/**
 * @returns {{dom: JSDOM, menu: PopupMenu, container: HTMLElement}}
 */
function createMenu() {
    const dom = new JSDOM('<button id="source">Menu</button><div id="overlay" tabindex="-1"><div class="popup-menu"><div class="popup-menu-body"><button class="popup-menu-item">Choose</button></div></div></div>', {url: 'https://example.test/'});
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('CustomEvent', dom.window.CustomEvent);
    const source = dom.window.document.getElementById('source');
    const container = dom.window.document.getElementById('overlay');
    if (!(source instanceof dom.window.HTMLElement) || !(container instanceof dom.window.HTMLElement)) {
        throw new Error('Missing menu fixture');
    }
    const menu = new PopupMenu(source, container);
    menu.prepare();
    return {dom, menu, container};
}

test('menu still closes and releases other listeners when window removal throws', () => {
    const {dom, menu, container} = createMenu();
    const onClose = vi.fn();
    menu.on('close', onClose);
    const warned = vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.spyOn(dom.window, 'removeEventListener').mockImplementation(() => {
        throw new Error('window context invalidated');
    });
    try {
        expect(menu.close()).toBe(true);
        expect(menu.isClosed).toBe(true);
        expect(container.isConnected).toBe(false);
        expect(menu._itemEventListeners.size).toBe(0);
        expect(menu._eventListeners.size).toBe(0);
        expect(PopupMenu.openMenus.has(menu)).toBe(false);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(warned).toHaveBeenCalledTimes(1);
        expect(menu.close()).toBe(true);
        expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
        dom.window.close();
    }
});

test('diagnostic failure cannot interrupt menu cleanup', () => {
    const {dom, menu, container} = createMenu();
    const onClose = vi.fn();
    menu.on('close', onClose);
    vi.spyOn(log, 'warn').mockImplementation(() => {
        throw new Error('logger unavailable');
    });
    vi.spyOn(dom.window, 'removeEventListener').mockImplementation(() => {
        throw new Error('window detached');
    });
    try {
        expect(menu.close()).toBe(true);
        expect(container.isConnected).toBe(false);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(menu._itemEventListeners.size).toBe(0);
    } finally {
        dom.window.close();
    }
});
