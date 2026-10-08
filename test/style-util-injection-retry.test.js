/* SPDX-License-Identifier: GPL-3.0-or-later */
import {JSDOM} from 'jsdom';
import {afterEach, expect, test, vi} from 'vitest';
import {loadStyle} from '../ext/js/dom/style-util.js';

afterEach(() => {
    vi.unstubAllGlobals();
});

/**
 * @param {ReturnType<typeof vi.fn>} inject
 * @returns {import('../ext/js/application.js').Application}
 */
function application(inject) {
    return /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({
        webExtension: {isExtensionUrl: () => false},
        api: {injectStylesheet: inject},
    }));
}

test('WebExtension style-injection failures do not poison the identifier for retry', async () => {
    const dom = new JSDOM('<head></head><body></body>', {url: 'https://content.example.test/'});
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    const failure = new Error('Missing host permission');
    const inject = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(null);
    try {
        const app = application(inject);
        await expect(loadStyle(app, 'retry-api-only', 'code', 'body { color: red; }', true)).rejects.toBe(failure);
        await expect(loadStyle(app, 'retry-api-only', 'code', 'body { color: blue; }', true)).resolves.toBeNull();
        expect(inject).toHaveBeenCalledTimes(2);
    } finally {
        dom.window.close();
    }
});

test('failed browser injection retains the working DOM stylesheet until replacement succeeds', async () => {
    const dom = new JSDOM('<head></head><body></body>', {url: 'https://content.example.test/'});
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    const failure = new Error('Temporary extension runtime failure');
    const inject = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(null);
    try {
        const app = application(inject);
        const original = await loadStyle(app, 'retry-replace-existing', 'code', 'body { color: red; }');
        expect(original?.isConnected).toBe(true);
        await expect(loadStyle(app, 'retry-replace-existing', 'code', 'body { color: blue; }', true)).rejects.toBe(failure);
        expect(original?.isConnected).toBe(true);
        await expect(loadStyle(app, 'retry-replace-existing', 'code', 'body { color: blue; }', true)).resolves.toBeNull();
        expect(original?.isConnected).toBe(false);
        expect(inject).toHaveBeenCalledTimes(2);
    } finally {
        dom.window.close();
    }
});
