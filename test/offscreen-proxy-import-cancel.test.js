/*
 * Copyright (C) 2026 Manabitan authors
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
import {OffscreenProxy} from '../ext/js/background/offscreen-proxy.js';

function createGate() {
    /** @type {(value?: unknown) => void} */
    let resolve = () => {};
    const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise;
    });
    return {promise, resolve};
}

function createProxy() {
    const proxy = /** @type {OffscreenProxy} */ (/** @type {unknown} */ (Object.create(OffscreenProxy.prototype)));
    Reflect.set(proxy, '_activeStreamedImportCount', 0);
    Reflect.set(proxy, '_ensureOffscreenDocument', vi.fn().mockResolvedValue(void 0));
    Reflect.set(proxy, '_ensureOffscreenPort', vi.fn().mockResolvedValue(void 0));
    Reflect.set(proxy, '_currentOffscreenPort', /** @type {MessagePort} */ (/** @type {unknown} */ ({})));
    return proxy;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('OffscreenProxy streamed import cancellation', () => {
    test('skips the cancellation transport after the streamed import has settled', async () => {
        const proxy = createProxy();
        const sendMessagePromise = vi.fn();
        Reflect.set(proxy, '_webExtension', {sendMessagePromise});

        const result = await OffscreenProxy.prototype.sendMessagePromise.call(proxy, {
            action: 'cancelDictionaryImportOffscreen',
        });

        expect(result).toBeUndefined();
        expect(sendMessagePromise).not.toHaveBeenCalled();
        expect(Reflect.get(proxy, '_ensureOffscreenDocument')).not.toHaveBeenCalled();
    });

    test('keeps the cancellation transport available while a streamed import is active', async () => {
        vi.stubGlobal('chrome', {runtime: {lastError: void 0}});
        const proxy = createProxy();
        const gate = createGate();
        const sendMessagePromise = vi.fn().mockResolvedValue({result: void 0});
        Reflect.set(proxy, '_webExtension', {sendMessagePromise});
        Reflect.set(proxy, '_sendOffscreenControlMessage', vi.fn(() => gate.promise));

        const importPromise = OffscreenProxy.prototype.sendMessageViaPort.call(proxy, {
            action: 'importDictionaryOffscreen',
            params: {},
        }, []);

        await vi.waitFor(() => {
            expect(Reflect.get(proxy, '_activeStreamedImportCount')).toBe(1);
        });

        await OffscreenProxy.prototype.sendMessagePromise.call(proxy, {
            action: 'cancelDictionaryImportOffscreen',
        });
        expect(sendMessagePromise).toHaveBeenCalledOnce();

        gate.resolve(void 0);
        await importPromise;
        expect(Reflect.get(proxy, '_activeStreamedImportCount')).toBe(0);
    });

    test('clears streamed-import activity after transport failure', async () => {
        const proxy = createProxy();
        Reflect.set(proxy, '_sendOffscreenControlMessage', vi.fn().mockRejectedValue(new Error('import failed')));

        await expect(OffscreenProxy.prototype.sendMessageViaPort.call(proxy, {
            action: 'importDictionaryOffscreen',
            params: {},
        }, [])).rejects.toThrow('import failed');

        expect(Reflect.get(proxy, '_activeStreamedImportCount')).toBe(0);
    });
});
