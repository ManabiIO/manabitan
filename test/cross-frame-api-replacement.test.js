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

import {describe, expect, test, vi} from 'vitest';
import {CrossFrameAPI, CrossFrameAPIPort} from '../ext/js/comm/cross-frame-api.js';

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
