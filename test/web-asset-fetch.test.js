/*
 * Copyright (C) 2024-2026  Yomitan Authors
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

import {JSDOM} from 'jsdom';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {fetchJson, fetchText, resolveAssetUrl} from '../ext/js/core/fetch-utilities.js';
import {HtmlTemplateCollection} from '../ext/js/dom/html-template-collection.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('package-local asset resolution', () => {
    test.each(['chrome-extension://test/', 'moz-extension://test/', 'https://reader.example/vendor/manabitan/v1/'])('preserves relative, root-relative and pre-resolved assets under %s', (root) => {
        const base = new URL(root);
        for (const input of ['templates-display.html', '/templates-display.html', `${root}templates-display.html`]) {
            expect(resolveAssetUrl(input, base).href).toBe(`${root}templates-display.html`);
        }
        expect(resolveAssetUrl('/data/schemas/options-schema.json', base).href).toBe(`${root}data/schemas/options-schema.json`);
    });

    test.each([
        'https://other.example/templates-display.html',
        'https://reader.example/vendor/manabitan/v10/templates-display.html',
        '//other.example/asset',
        '../outside',
        '/../../outside',
        '%2e%2e/outside',
        'data:text/html,no',
        'javascript:alert(1)',
        'https://user:password@reader.example/vendor/manabitan/v1/asset',
    ])('rejects an asset outside the package: %s', (input) => {
        expect(() => resolveAssetUrl(input, new URL('https://reader.example/vendor/manabitan/v1/'))).toThrow('outside the package');
    });

    test('does not confuse two extension hosts with null URL origins', () => {
        expect(() => resolveAssetUrl('chrome-extension://other/a', new URL('chrome-extension://test/'))).toThrow('outside the package');
    });
});

describe('actual shared fetch and template call chain', () => {
    test('HtmlTemplateCollection fetches an already-resolved URL once without chrome.runtime', async () => {
        const dom = new JSDOM('');
        vi.stubGlobal('DOMParser', dom.window.DOMParser);
        vi.stubGlobal('chrome', {runtime: {getURL: vi.fn(() => { throw new Error('Must not prefix an already resolved URL'); })}});
        const request = vi.fn().mockResolvedValue(new Response('<template id="test-template"><span>猫</span></template>'));
        vi.stubGlobal('fetch', request);
        const url = new URL('../ext/templates-display.html', import.meta.url).href;
        const templates = new HtmlTemplateCollection();
        try {
            await templates.loadFromFiles([url]);
            expect(request).toHaveBeenCalledExactlyOnceWith(new URL(url), expect.objectContaining({credentials: 'omit', referrerPolicy: 'no-referrer'}));
            expect(templates.getTemplateContent('test').textContent).toBe('猫');
            expect(chrome.runtime.getURL).not.toHaveBeenCalled();
        } finally { dom.window.close(); }
    });

    test('legacy root-relative callers still fetch inside the package root', async () => {
        const request = vi.fn().mockResolvedValue(new Response('{"value":7}'));
        vi.stubGlobal('fetch', request);
        await expect(fetchJson('/data/schemas/options-schema.json')).resolves.toEqual({value: 7});
        expect(request.mock.calls[0][0]).toEqual(new URL('../ext/data/schemas/options-schema.json', import.meta.url));
    });

    test('HTTP failures remain failures rather than usable templates', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('missing', {status: 404})));
        await expect(fetchText('/templates-display.html')).rejects.toThrow('404');
    });

    test('foreign URLs fail before a network request', async () => {
        const request = vi.fn();
        vi.stubGlobal('fetch', request);
        await expect(fetchText('https://untrusted.example/asset')).rejects.toThrow('outside the package');
        expect(request).not.toHaveBeenCalled();
    });
});
