/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {API} from '../ext/js/comm/api.js';

class FakeSharedWorker {}

describe('Firefox dictionary import backend reconnect', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    test.each(['url', 'blob'])('reconnects for %s imports after the backend port disappears', async (mode) => {
        vi.stubGlobal('navigator', {});
        vi.stubGlobal('window', {location: {protocol: 'file:'}});
        vi.stubGlobal('SharedWorker', FakeSharedWorker);
        /** @type {string[]} */
        const sentActions = [];
        const backendPort = {
            postMessage: vi.fn((/** @type {{action: string}} */ message, /** @type {MessagePort[]} */ ports) => {
                sentActions.push(message.action);
                ports[0].postMessage({type: 'complete', result: {title: 'Imported Dictionary'}});
                ports[0].close();
            }),
            close: vi.fn(),
            onmessageerror: null,
        };
        const api = new API(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ ({})));
        const reconnect = vi.spyOn(api, '_createFirefoxBackendPort').mockReturnValue(
            /** @type {MessagePort} */ (/** @type {unknown} */ (backendPort)),
        );

        try {
            const result = mode === 'url' ?
                await api.importDictionaryUrlOffscreen('https://example.test/dictionary.zip', {}, null) :
                await api.importDictionaryOffscreen(new Blob(['archive']), {}, null);

            expect(result).toStrictEqual({title: 'Imported Dictionary'});
            expect(reconnect).toHaveBeenCalledOnce();
            expect(sentActions).toStrictEqual([mode === 'url' ? 'importDictionaryUrlOffscreen' : 'importDictionaryOffscreen']);
        } finally {
            api.shutdownRuntimeConnections();
        }
    });

    test('preserves the immediate error if the backend cannot be reconnected', async () => {
        vi.stubGlobal('navigator', {});
        vi.stubGlobal('window', {location: {protocol: 'file:'}});
        vi.stubGlobal('SharedWorker', undefined);
        const api = new API(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ ({})));
        const reconnect = vi.spyOn(api, '_createFirefoxBackendPort');

        await expect(api.importDictionaryUrlOffscreen('https://example.test/dictionary.zip', {}, null))
            .rejects.toThrow('Backend message port is not available');
        expect(reconnect).not.toHaveBeenCalled();
    });

    test('shutdown prevents reconnecting imports', async () => {
        vi.stubGlobal('navigator', {});
        vi.stubGlobal('window', {location: {protocol: 'file:'}});
        vi.stubGlobal('SharedWorker', FakeSharedWorker);
        const api = new API(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ ({})));
        const reconnect = vi.spyOn(api, '_createFirefoxBackendPort');
        api.shutdownRuntimeConnections();
        await expect(api.importDictionaryUrlOffscreen('https://example.test/dictionary.zip', {}, null))
            .rejects.toThrow('Runtime connections have been shut down');
        expect(reconnect).not.toHaveBeenCalled();
    });
});
