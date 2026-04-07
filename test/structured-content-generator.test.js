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

import {afterAll, describe, expect, test, vi} from 'vitest';
import {DisplayContentManager} from '../ext/js/display/display-content-manager.js';
import {StructuredContentGenerator} from '../ext/js/display/structured-content-generator.js';
import {AnkiTemplateRendererContentManager} from '../ext/js/templates/anki-template-renderer-content-manager.js';
import {setupDomTest} from './fixtures/dom-test.js';

const testEnv = await setupDomTest();
afterAll(async () => {
    await testEnv.teardown(global);
});

describe('StructuredContentGenerator MDX rendering compatibility', () => {
    const {window} = testEnv;

    test('preserves migrated MDX selector data on links and images', () => {
        const mediaProvider = /** @type {import('../ext/js/templates/template-renderer-media-provider.js').TemplateRendererMediaProvider} */ (/** @type {unknown} */ ({
            getMedia: vi.fn().mockReturnValue('https://example.invalid/cover.jpg'),
        }));
        const contentManager = new AnkiTemplateRendererContentManager(
            mediaProvider,
            /** @type {import('anki-templates').NoteData} */ (/** @type {unknown} */ ({})),
        );
        const generator = new StructuredContentGenerator(contentManager, window.document, /** @type {Window} */ (/** @type {unknown} */ (window)));

        const node = generator.createStructuredContent({
            tag: 'div',
            data: {tag: 'div', class: 'entry main', id: 'entry'},
            content: [
                {
                    tag: 'a',
                    href: '?query=target',
                    data: {tag: 'a', class: 'jump'},
                    style: {color: 'red', fontWeight: 'bold'},
                    content: ['jump'],
                },
                {
                    tag: 'img',
                    path: 'mdict-media/images/cover.jpg',
                    data: {tag: 'img', class: 'icon', id: 'cover'},
                    width: 64,
                    height: 32,
                    alt: 'Cover',
                },
            ],
        }, 'Test Dictionary');

        window.document.body.appendChild(node);

        const entry = node.querySelector('[data-sc-tag="div"][data-sc-class~="entry"][data-sc-id="entry"]');
        const link = /** @type {HTMLAnchorElement|null} */ (node.querySelector('[data-sc-tag="a"][data-sc-class~="jump"]'));
        const image = /** @type {HTMLAnchorElement|null} */ (node.querySelector('[data-sc-tag="img"][data-sc-class~="icon"][data-sc-id="cover"]'));

        expect(entry).not.toBeNull();
        expect(link).not.toBeNull();
        expect(link?.getAttribute('href')).toBe('#');
        expect(link?.style.color).toBe('red');
        expect(link?.style.fontWeight).toBe('bold');
        expect(image).not.toBeNull();
        expect(image?.getAttribute('data-path')).toBe('mdict-media/images/cover.jpg');
        expect(image?.querySelector('img.gloss-image')?.getAttribute('src')).toBe('https://example.invalid/cover.jpg');
    });

    test('media links open dictionary media in display mode', async () => {
        const display = {
            application: {
                api: {
                    getMedia: vi.fn(),
                },
            },
            setContent: vi.fn(),
        };
        const contentManager = new DisplayContentManager(/** @type {import('../ext/js/display/display.js').Display} */ (/** @type {unknown} */ (display)));
        const openMediaInTab = vi.fn().mockResolvedValue(void 0);
        Reflect.set(contentManager, 'openMediaInTab', openMediaInTab);

        const generator = new StructuredContentGenerator(contentManager, window.document, /** @type {Window} */ (/** @type {unknown} */ (window)));
        const node = generator.createStructuredContent({
            tag: 'a',
            href: 'media:mdict-media/audio/ping.mp3',
            data: {tag: 'a', class: 'sound'},
            content: ['play'],
        }, 'Test Dictionary');

        window.document.body.appendChild(node);
        const link = node.querySelector('[data-sc-class="sound"]');
        if (!(link instanceof window.HTMLAnchorElement)) {
            throw new Error('Expected media link anchor');
        }
        link.dispatchEvent(new window.MouseEvent('click', {bubbles: true, cancelable: true}));

        expect(link.getAttribute('href')).toBe('#');
        expect(link.dataset.scClass).toBe('sound');
        expect(openMediaInTab).toHaveBeenCalledWith('mdict-media/audio/ping.mp3', 'Test Dictionary', /** @type {Window} */ (/** @type {unknown} */ (window)));
    });

    test('malformed media links fall back to the raw path in display mode', async () => {
        const display = {
            application: {
                api: {
                    getMedia: vi.fn(),
                },
            },
            setContent: vi.fn(),
        };
        const contentManager = new DisplayContentManager(/** @type {import('../ext/js/display/display.js').Display} */ (/** @type {unknown} */ (display)));
        const openMediaInTab = vi.fn().mockResolvedValue(void 0);
        Reflect.set(contentManager, 'openMediaInTab', openMediaInTab);

        const generator = new StructuredContentGenerator(contentManager, window.document, /** @type {Window} */ (/** @type {unknown} */ (window)));
        const node = generator.createStructuredContent({
            tag: 'a',
            href: 'media:mdict-media/audio/%E0%A4%A.mp3',
            data: {tag: 'a', class: 'sound'},
            content: ['play'],
        }, 'Test Dictionary');

        window.document.body.appendChild(node);
        const link = node.querySelector('[data-sc-class="sound"]');
        if (!(link instanceof window.HTMLAnchorElement)) {
            throw new Error('Expected media link anchor');
        }
        link.dispatchEvent(new window.MouseEvent('click', {bubbles: true, cancelable: true}));

        expect(link.getAttribute('href')).toBe('#');
        expect(openMediaInTab).toHaveBeenCalledWith('mdict-media/audio/%E0%A4%A.mp3', 'Test Dictionary', /** @type {Window} */ (/** @type {unknown} */ (window)));
    });
});
