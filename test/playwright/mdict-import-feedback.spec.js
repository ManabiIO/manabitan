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

import {makeFixturePng, makeMdictFixture} from '../util/mdict-binary-fixture.js';
import {expect, test} from './playwright-util.js';

/**
 * @template [T=unknown]
 * @param {import('@playwright/test').Page} page
 * @param {string} action
 * @param {Record<string, unknown>} [params]
 * @returns {Promise<T>}
 */
async function api(page, action, params = {}) {
    return await page.evaluate(async (message) => {
        return await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(message, (/** @type {{error?: {message?: string}, result?: T}|undefined} */ response) => {
                const error = chrome.runtime.lastError ?? response?.error;
                if (error) {
                    reject(new Error(error.message ?? 'Runtime API failed'));
                } else {
                    resolve(/** @type {T} */ (response?.result));
                }
            });
        });
    }, {action, params});
}

test('MDX numeric sets retain resource precedence and show conversion notes separately', async ({page, extensionId}) => {
    test.setTimeout(180_000);
    const title = 'Numeric MDict integration';
    const red = makeFixturePng([255, 0, 0, 255]);
    const blue = makeFixturePng([0, 0, 255, 255]);
    const mdx = makeMdictFixture([
        {key: 'cat', value: '<div>A complete definition<img src="shared.png"></div>'},
        {key: 'orphan', value: '@@@LINK=absent'},
    ], {title, recordBlockSize: 7});
    const base = makeMdictFixture([{key: 'shared.png', value: red}], {mdd: true, recordBlockSize: 7});
    const volume = makeMdictFixture([{key: 'shared.png', value: blue}], {mdd: true, recordBlockSize: 7});
    await page.goto(`chrome-extension://${extensionId}/settings.html`);
    await expect(page.locator('html')).toHaveAttribute('data-loaded', 'true', {timeout: 30_000});
    await page.locator('.settings-item[data-modal-action="show,dictionaries"]').click();
    await page.locator('#dictionary-import-button').click();
    await expect(page.locator('#mdict-import-summary')).toContainText('Dictionary audio is not enabled');
    await expect(page.locator('#dictionary-import-modal a[href="/mdict.html"]')).toBeVisible();
    for (const width of [390, 320]) {
        await page.setViewportSize({width, height: 844});
        expect(await page.locator('.dictionary-import-scroll-body').evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        const footer = page.locator('#dictionary-import-modal .modal-footer');
        await expect(footer).toBeVisible();
    }

    // Put the numbered resource first: selection order must not decide ownership.
    await page.locator('#dictionary-import-file-input').setInputFiles([
        {name: 'Book.2024.1.mdd', mimeType: 'application/octet-stream', buffer: Buffer.from(volume.bytes)},
        {name: 'Book.2024.mdx', mimeType: 'application/octet-stream', buffer: Buffer.from(mdx.bytes)},
        {name: 'Book.2024.mdd', mimeType: 'application/octet-stream', buffer: Buffer.from(base.bytes)},
    ]);
    await expect(page.locator('#dictionary-import-modal')).toBeHidden({timeout: 30_000});
    await expect(async () => {
        const info = /** @type {Array<{title: string}>} */ (await api(page, 'getDictionaryInfo'));
        expect(info.map((item) => item.title)).toStrictEqual([title]);
    }).toPass({timeout: 60_000});
    await expect(page.locator('id=dictionaries')).toHaveText('Dictionaries (1 installed, 1 enabled)', {timeout: 30_000});
    const notes = page.locator('#dictionaries-modal .mdict-import-warnings');
    await expect(notes).toBeVisible();
    await expect(notes).toHaveAttribute('role', 'status');
    await expect(notes).toContainText('Book.2024.mdx');
    await expect(notes).toContainText('1 redirect alias could not be resolved');
    await expect(notes).toContainText('Installation status is shown separately');
    await expect(page.locator('#dictionary-error')).toBeHidden();
    const media = /** @type {Array<{content: string}>} */ (await api(page, 'getMedia', {
        targets: [{dictionary: title, path: 'mdict-media/shared.png'}],
    }));
    expect(media).toHaveLength(1);
    expect(Buffer.from(media[0].content, 'base64')).toStrictEqual(Buffer.from(red));
    // A clean new session clears conversion notes without deleting the first dictionary.
    const cleanTitle = 'Clean MDict integration';
    const clean = makeMdictFixture([{key: 'dog', value: 'A dog'}], {title: cleanTitle});
    await page.locator('#dictionary-import-button').click();
    await page.locator('#dictionary-import-file-input').setInputFiles([
        {name: 'Clean.mdx', mimeType: 'application/octet-stream', buffer: Buffer.from(clean.bytes)},
    ]);
    await expect(async () => {
        const info = /** @type {Array<{title: string}>} */ (await api(page, 'getDictionaryInfo'));
        expect(info.map((item) => item.title).sort()).toStrictEqual([title, cleanTitle].sort());
    }).toPass({timeout: 60_000});
    await expect(notes).toBeHidden();
    await expect(notes).toHaveText('');
    await expect(page.locator('#dictionary-error')).toBeHidden();
});
