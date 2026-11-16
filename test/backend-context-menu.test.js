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

import {afterEach, describe, expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';

function createContextMenuHarness() {
    /** @type {Set<(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => void>} */
    const listeners = new Set();
    const contextMenus = {
        create: vi.fn(),
        remove: vi.fn(),
        onClicked: {addListener: vi.fn((listener) => listeners.add(listener))},
    };
    vi.stubGlobal('chrome', {
        contextMenus,
        runtime: {
            onMessage: {addListener: vi.fn()},
            onConnect: {addListener: vi.fn()},
            onInstalled: {addListener: vi.fn()},
        },
    });
    vi.stubGlobal('addEventListener', vi.fn());
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    const options = /** @type {import('settings').ProfileOptions} */ ({general: {enableContextMenuScanSelected: true}});
    const send = vi.fn();
    const broadcast = vi.fn();
    Reflect.set(backend, '_isPrepared', true);
    Reflect.set(backend, '_getProfileOptions', () => options);
    Reflect.set(backend, '_sendMessageTabIgnoreResponse', send);
    Reflect.set(backend, '_sendMessageAllTabsIgnoreResponse', broadcast);
    backend._prepareInternalSync();
    const defaultTab = {id: 17};
    /**
     * @param {Partial<chrome.contextMenus.OnClickData>} [details]
     * @param {Partial<chrome.tabs.Tab>|undefined} [tab]
     */
    const click = (details = {}, tab = defaultTab) => {
        const info = {menuItemId: 'yomitan_lookup', selectionText: '日本語', editable: false, ...details};
        for (const listener of listeners) {
            listener(info, /** @type {chrome.tabs.Tab|undefined} */ (tab));
        }
    };
    return {backend, options, contextMenus, send, broadcast, click};
}

describe('Backend selection context menu', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    test('settings refreshes retain one listener and one lookup in the selected frame', () => {
        const {backend, options, contextMenus, send, broadcast, click} = createContextMenuHarness();
        for (let i = 0; i < 3; i++) {
            backend._setupContextMenu(options);
        }
        click({frameId: 4});
        expect(contextMenus.onClicked.addListener).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledExactlyOnceWith(17, {action: 'frontendScanSelectedText'}, {frameId: 4});
        expect(broadcast).not.toHaveBeenCalled();
    });

    test('a top-level selection targets only its tab and the main frame', () => {
        const {backend, options, send, broadcast, click} = createContextMenuHarness();
        backend._setupContextMenu(options);
        click();
        expect(send).toHaveBeenCalledExactlyOnceWith(17, {action: 'frontendScanSelectedText'}, {frameId: 0});
        expect(broadcast).not.toHaveBeenCalled();
    });

    test('disabling and re-enabling the menu does not accumulate handlers', () => {
        const {backend, options, contextMenus, send, click} = createContextMenuHarness();
        backend._setupContextMenu(options);
        options.general.enableContextMenuScanSelected = false;
        backend._setupContextMenu(options);
        click();
        expect(send).not.toHaveBeenCalled();
        options.general.enableContextMenuScanSelected = true;
        backend._setupContextMenu(options);
        click();
        expect(contextMenus.onClicked.addListener).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledTimes(1);
    });

    test.each([
        {menuItemId: 'another-menu'},
        {selectionText: ''},
        {selectionText: void 0},
    ])('ignores clicks without a matching selection: %j', (details) => {
        const {backend, options, send, broadcast, click} = createContextMenuHarness();
        backend._setupContextMenu(options);
        click(details);
        expect(send).not.toHaveBeenCalled();
        expect(broadcast).not.toHaveBeenCalled();
    });

    test('ignores a click with no target tab ID', () => {
        const {backend, options, send, broadcast, click} = createContextMenuHarness();
        backend._setupContextMenu(options);
        click({}, {});
        expect(send).not.toHaveBeenCalled();
        expect(broadcast).not.toHaveBeenCalled();
    });
});
