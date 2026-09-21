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
import {INLINE_STYLE_SCOPE_TITLE, makeInlineStyleScopeFixture} from '../util/mdict-inline-style-fixture.js';
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

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function imagePaths(value) {
    const pending = [value];
    const paths = new Set();
    while (pending.length > 0) {
        const item = pending.pop();
        if (Array.isArray(item)) {
            pending.push(...item);
        } else if (typeof item === 'object' && item !== null) {
            const record = /** @type {Record<string, unknown>} */ (item);
            if (record.tag === 'img' && typeof record.path === 'string') { paths.add(record.path); }
            pending.push(...Object.values(record));
        }
    }
    return [...paths];
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} text
 * @returns {Promise<unknown>}
 */
async function lookup(page, text) {
    return await api(page, 'termsFind', {
        text,
        details: {matchType: 'exact', deinflect: false, primaryReading: ''},
        optionsContext: {depth: 0, url: page.url()},
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} extensionBaseUrl
 * @param {Array<{name: string, mimeType: string, buffer: Buffer}>} files
 * @param {string} title
 * @returns {Promise<void>}
 */
async function importFiles(page, extensionBaseUrl, files, title) {
    await page.goto(`${extensionBaseUrl}/settings.html`);
    await expect(page.locator('html')).toHaveAttribute('data-loaded', 'true', {timeout: 30_000});
    await page.locator('.settings-item[data-modal-action="show,dictionaries"]').click();
    await page.locator('button#dictionary-import-button').click();
    await page.locator('#dictionary-import-file-input').setInputFiles(files);
    await expect(page.locator('#dictionary-import-modal')).toBeHidden({timeout: 30_000});
    await expect(async () => {
        const info = /** @type {Array<{title: string}>} */ (await api(page, 'getDictionaryInfo'));
        expect(info.map((item) => item.title)).toStrictEqual([title]);
    }).toPass({timeout: 60_000});
    await expect(page.locator('id=dictionaries')).toHaveText('Dictionaries (1 installed, 1 enabled)', {timeout: 30_000});
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} title
 * @param {string} path
 * @param {Uint8Array} expected
 * @returns {Promise<void>}
 */
async function assertStoredMedia(page, title, path, expected) {
    const media = /** @type {Array<{content: string}>} */ (await api(page, 'getMedia', {targets: [{dictionary: title, path}]}));
    expect(media).toHaveLength(1);
    expect(Buffer.from(media[0].content, 'base64')).toStrictEqual(Buffer.from(expected));
}

test('MDX native cross-block import preserves aliases, senses and media through reload and reimport', async ({page, context, extensionId}) => {
    test.setTimeout(180_000);
    const extensionBaseUrl = `chrome-extension://${extensionId}`;
    const title = 'Native MDict browser regression';
    const red = makeFixturePng([255, 0, 0, 255]);
    const blue = makeFixturePng([0, 0, 255, 255]);
    const green = makeFixturePng([0, 255, 0, 255]);
    const mdx = makeMdictFixture([
        {key: '猫', value: `<div class="native-sense">first complete native definition 🐈<span class="native-inline" style="background-image:url(styles/images/green.png)">inline media</span><img src="data:image/png;base64,${Buffer.from(red).toString('base64')}"></div>`},
        {key: '猫', value: '<div>second independent native sense</div>'},
        {key: 'ねこ', value: '@@@LINK=猫'},
        {key: '別名', value: '@@@LINK=ねこ'},
        {key: '青', value: `<div>blue entry<img src="data:image/png;base64,${Buffer.from(blue).toString('base64')}"></div>`},
        {key: '緑', value: '<div>green MDD entry<img src="styles/images/green.png"></div>'},
    ], {title, recordBlockSize: 7, keysPerBlock: 1});
    const mdd = makeMdictFixture([
        {key: '\\styles\\theme.css', value: '.native-sense { color: rgb(12, 34, 56); background-image: url(images/green.png); }'},
        {key: '\\styles\\images\\green.png', value: green},
    ], {mdd: true, recordBlockSize: 11, keysPerBlock: 1});
    const files = [
        {name: 'native.MDX', mimeType: 'application/octet-stream', buffer: Buffer.from(mdx.bytes)},
        {name: 'native.MDD', mimeType: 'application/octet-stream', buffer: Buffer.from(mdd.bytes)},
    ];
    await importFiles(page, extensionBaseUrl, files, title);
    for (const query of ['猫', 'ねこ', '別名']) {
        await expect(async () => {
            const serialized = JSON.stringify(await lookup(page, query));
            expect(serialized).toContain('first complete native definition 🐈');
            expect(serialized).toContain('second independent native sense');
        }).toPass({timeout: 30_000});
    }
    const redPaths = imagePaths(await lookup(page, '猫'));
    const bluePaths = imagePaths(await lookup(page, '青'));
    expect(redPaths).toHaveLength(1);
    expect(bluePaths).toHaveLength(1);
    expect(redPaths[0]).not.toBe(bluePaths[0]);
    await assertStoredMedia(page, title, redPaths[0], red);
    await assertStoredMedia(page, title, bluePaths[0], blue);
    await assertStoredMedia(page, title, 'mdict-media/styles/images/green.png', green);

    await page.goto(`${extensionBaseUrl}/search.html`);
    await expect(page.locator('html')).toHaveAttribute('data-loaded', 'true', {timeout: 30_000});
    await page.locator('#search-textbox').fill('別名');
    await page.locator('#search-button').click();
    const entries = page.locator('#dictionary-entries');
    await expect(entries).toContainText('first complete native definition 🐈', {timeout: 30_000});
    await expect(entries).toContainText('second independent native sense');
    const nativeSense = entries.locator('[data-sc-class~="native-sense"]').first();
    await expect(nativeSense).toHaveCSS('color', 'rgb(12, 34, 56)');
    for (const target of [
        nativeSense,
        entries.locator('[data-sc-class~="native-inline"]').first(),
    ]) {
        await expect(async () => {
            const backgroundImage = await target.evaluate((element) => getComputedStyle(element).backgroundImage);
            expect(backgroundImage).toMatch(/^url\("blob:/u);
            const match = /^url\("([^"]+)"\)$/u.exec(backgroundImage);
            expect(match).not.toBeNull();
            const bytes = await page.evaluate(async (url) => {
                return [...new Uint8Array(await (await fetch(url)).arrayBuffer())];
            }, match?.[1] ?? '');
            expect(bytes).toStrictEqual([...green]);
        }).toPass({timeout: 30_000});
    }
    await expect(entries.locator('.gloss-image').first()).toBeVisible();

    // A new document must retrieve committed data, not the converter's in-memory map.
    const reopened = await context.newPage();
    await page.close();
    await reopened.goto(`${extensionBaseUrl}/search.html`);
    await expect(reopened.locator('html')).toHaveAttribute('data-loaded', 'true', {timeout: 30_000});
    expect(JSON.stringify(await lookup(reopened, '別名'))).toContain('second independent native sense');
    await assertStoredMedia(reopened, title, redPaths[0], red);
    await api(reopened, 'deleteDictionaryByTitle', {dictionaryTitle: title});
    expect(await api(reopened, 'getDictionaryInfo')).toStrictEqual([]);
    expect(JSON.stringify(await lookup(reopened, '別名'))).not.toContain('second independent native sense');
    await importFiles(reopened, extensionBaseUrl, files, title);
    expect(JSON.stringify(await lookup(reopened, '別名'))).toContain('second independent native sense');
    await assertStoredMedia(reopened, title, 'mdict-media/styles/images/green.png', green);
    await reopened.close();
});


test('MDX inline styles preserve functional roots, cascade and pseudo-elements without affecting a homograph', async ({page, extensionId}) => {
    test.setTimeout(90_000);
    const extensionBaseUrl = `chrome-extension://${extensionId}`;
    const fixture = makeInlineStyleScopeFixture();
    await importFiles(page, extensionBaseUrl, [
        {name: 'inline-scope.mdx', mimeType: 'application/octet-stream', buffer: Buffer.from(fixture.bytes)},
    ], INLINE_STYLE_SCOPE_TITLE);
    await page.goto(`${extensionBaseUrl}/search.html`);
    await expect(page.locator('html')).toHaveAttribute('data-loaded', 'true', {timeout: 30_000});
    await page.locator('#search-textbox').fill('猫');
    await page.locator('#search-button').click();
    const entries = page.locator('#dictionary-entries');
    await expect(entries).toContainText('functional root', {timeout: 30_000});
    await expect(entries).toContainText('unscoped entry');
    await expect(entries.locator('[data-sc-class~="functional"]').first()).toHaveCSS('color', 'rgb(11, 22, 33)');
    await expect(entries.locator('[data-sc-class~="where-root"]').first()).toHaveCSS('color', 'rgb(22, 33, 44)');
    await expect(entries.locator('[data-sc-class~="cascade"]').first()).toHaveCSS('color', 'rgb(33, 44, 55)');
    await expect(entries.locator('[data-sc-class~="nested"]').first()).toHaveCSS('font-weight', '700');
    await expect(entries.locator('[title="two  gaps"]').first()).toHaveCSS('color', 'rgb(12, 34, 56)');
    await expect(entries.locator('[title="two  gaps"]').first()).toHaveCSS('font-weight', '700');
    await expect(entries.locator('[title="tab\tgap"]').first()).toHaveCSS('color', 'rgb(23, 45, 67)');
    const scoped = entries.locator('[data-sc-class~="shared"]:not([data-sc-class~="outside"])').first();
    const outside = entries.locator('[data-sc-class~="outside"]').first();
    await expect(scoped).toHaveCSS('border-top-width', '3px');
    await expect(outside).toHaveCSS('border-top-width', '0px');
    expect(await scoped.evaluate((node) => getComputedStyle(node, '::before').content)).toBe('"scoped"');
    expect(await scoped.evaluate((node) => getComputedStyle(node, '::after').content)).toBe('"legacy"');
    expect(await outside.evaluate((node) => getComputedStyle(node, '::before').content)).toBe('none');
});
