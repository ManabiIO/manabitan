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

const reportDiagnostics = vi.fn();
vi.mock('../ext/js/core/diagnostics-reporter.js', () => ({
    reportDiagnostics,
}));

const {DictionaryRuntimeWorkerProxy} = await import('../ext/js/background/offscreen-proxy.js');

/**
 * @returns {import('../ext/js/background/offscreen-proxy.js').DictionaryRuntimeWorkerProxy}
 */
function createProxyForInternalTests() {
    return /** @type {import('../ext/js/background/offscreen-proxy.js').DictionaryRuntimeWorkerProxy} */ (Object.create(DictionaryRuntimeWorkerProxy.prototype));
}

/**
 * @param {string} name
 * @returns {Function}
 */
function getOffscreenProxyMethod(name) {
    const method = /** @type {unknown} */ (Reflect.get(DictionaryRuntimeWorkerProxy.prototype, name));
    if (typeof method !== 'function') {
        throw new Error(`Expected DictionaryRuntimeWorkerProxy.${name} to be a function`);
    }
    return method;
}

describe('OffscreenProxy response diagnostics', () => {
    const onMessage = /** @type {(this: import('../ext/js/background/offscreen-proxy.js').DictionaryRuntimeWorkerProxy, event: MessageEvent<{id?: number, result?: unknown}>) => void} */ (getOffscreenProxyMethod('_onMessage'));

    afterEach(() => {
        vi.restoreAllMocks();
        reportDiagnostics.mockReset();
    });

    test('does not emit unmatched-response diagnostics for matched replies', () => {
        const proxy = createProxyForInternalTests();
        const resolve = vi.fn();
        const reject = vi.fn();
        Reflect.set(proxy, '_responseHandlers', new Map([[7, {resolve, reject}]]));

        onMessage.call(proxy, /** @type {MessageEvent<{id?: number, result?: unknown}>} */ (/** @type {unknown} */ ({
            data: {id: 7, result: {ok: true}},
        })));

        expect(resolve).toHaveBeenCalledWith({ok: true});
        expect(reject).not.toHaveBeenCalled();
        expect(reportDiagnostics).not.toHaveBeenCalled();
    });

    test('emits unmatched-response diagnostics for unknown reply ids', () => {
        const proxy = createProxyForInternalTests();
        Reflect.set(proxy, '_responseHandlers', new Map());

        onMessage.call(proxy, /** @type {MessageEvent<{id?: number, result?: unknown}>} */ (/** @type {unknown} */ ({
            data: {id: 99, result: {ok: true}},
        })));

        expect(reportDiagnostics).toHaveBeenCalledWith('offscreen-proxy-unmatched-response', {
            reason: 'unknown-id',
            id: 99,
            hasError: false,
        });
    });
});
