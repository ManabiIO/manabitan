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

import JSZip from 'jszip';
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
    expect(media, `Stored media: ${path}`).toHaveLength(1);
    expect(Buffer.from(media[0].content, 'base64')).toStrictEqual(Buffer.from(expected));
}

test('ZIP images with skipped metadata render pixels after import and reopening', async ({page, context, extensionId}) => {
    test.setTimeout(180_000);
    const title = 'Unknown image dimensions';
    const extensionBaseUrl = `chrome-extension://${extensionId}`;
    const png = makeFixturePng([20, 180, 40, 255]);
    const zip = new JSZip();
    zip.file('index.json', JSON.stringify({title, revision: '1', format: 3}));
    zip.file('image.png', png);
    zip.file('term_bank_1.json', JSON.stringify([
        ['Media', '', '', '', 0, [{
            type: 'structured-content',
            content: [
                {tag: 'img', path: 'image.png', width: 0, height: 0},
                {tag: 'img', path: 'image.png', width: 0.25, height: 0.125, sizeUnits: 'px'},
            ],
        }], 1, ''],
    ]));
    await importFiles(page, extensionBaseUrl, [{
        name: 'images.zip', mimeType: 'application/zip', buffer: await zip.generateAsync({type: 'nodebuffer'}),
    }], title);
    await assertStoredMedia(page, title, 'image.png', png);
    expect(JSON.stringify(await lookup(page, 'Media'))).toContain('"width":0,"height":0');
    await api(page, 'modifySettings', {
        targets: [{
            action: 'set',
            path: 'general.enableWanakana',
            value: false,
            scope: 'profile',
            optionsContext: {depth: 0, url: `${extensionBaseUrl}/search.html`},
        }],
        source: 'unknown-image-dimensions-test',
    });

    const reopened = await context.newPage();
    await page.close();
    await reopened.goto(`${extensionBaseUrl}/search.html`);
    await expect(reopened.locator('html')).toHaveAttribute('data-loaded', 'true', {timeout: 30_000});
    await assertStoredMedia(reopened, title, 'image.png', png);
    await reopened.locator('#search-textbox').fill('Media');
    await reopened.locator('#search-button').click();
    const canvases = reopened.locator('#dictionary-entries canvas.gloss-image');
    await expect(canvases).toHaveCount(2, {timeout: 30_000});
    await expect(canvases.first()).toHaveAttribute('width', '100');
    await expect(canvases.first()).toHaveAttribute('height', '100');
    await expect(canvases.nth(1)).toHaveAttribute('width', '1');
    await expect(canvases.nth(1)).toHaveAttribute('height', '1');
    await expect(canvases.first()).toBeVisible();
    // Transferred canvases cannot be read on the page. Decode a browser screenshot
    // in a separate canvas to verify the actual drawing worker's visible output.
    await expect(async () => {
        const screenshot = await canvases.first().screenshot();
        const pixel = await reopened.evaluate(async (bytes) => {
            const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], {type: 'image/png'}));
            try {
                const canvas = document.createElement('canvas');
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                const ctx = canvas.getContext('2d');
                if (ctx === null) { throw new Error('No screenshot canvas context'); }
                ctx.drawImage(bitmap, 0, 0);
                return [...ctx.getImageData(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1).data];
            } finally {
                bitmap.close();
            }
        }, [...screenshot]);
        expect(pixel).toStrictEqual([20, 180, 40, 255]);
    }).toPass({timeout: 30_000});
    await reopened.close();
});

test('MDX audio-only resources survive import, reopening and a real media-link click', async ({page, context, extensionId}) => {
    test.setTimeout(180_000);
    const title = 'MDict audio regression';
    const extensionBaseUrl = `chrome-extension://${extensionId}`;
    // Valid mono, unsigned 8-bit PCM; no dependency on a browser audio encoder.
    const wav = Buffer.alloc(76, 128);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(8000, 28);
    wav.writeUInt16LE(1, 32);
    wav.writeUInt16LE(8, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(wav.length - 44, 40);
    const mdx = makeMdictFixture([{
        key: '\u97f3\u58f0',
        value: '<a class="audio" href="audio/ping%252Fname.WAV">play audio</a><a href="sound://disabled.wav">disabled sound</a>',
    }], {title});
    const mdd = makeMdictFixture([
        {key: '\\audio\\ping%2Fname.WAV', value: wav},
        {key: '\\disabled.wav', value: wav},
    ], {mdd: true, recordBlockSize: 11, keysPerBlock: 1});
    await importFiles(page, extensionBaseUrl, [
        {name: 'audio.mdx', mimeType: 'application/octet-stream', buffer: Buffer.from(mdx.bytes)},
        {name: 'audio.mdd', mimeType: 'application/octet-stream', buffer: Buffer.from(mdd.bytes)},
    ], title);
    const path = 'mdict-media/audio/ping%2Fname.WAV';
    await assertStoredMedia(page, title, path, wav);
    expect(await api(page, 'getMedia', {targets: [{dictionary: title, path: 'mdict-media/disabled.wav'}]})).toStrictEqual([]);
    const reopened = await context.newPage();
    await page.close();
    await reopened.goto(`${extensionBaseUrl}/search.html`);
    await expect(reopened.locator('html')).toHaveAttribute('data-loaded', 'true', {timeout: 30_000});
    await assertStoredMedia(reopened, title, path, wav);
    await reopened.locator('#search-textbox').fill('\u97f3\u58f0');
    await reopened.locator('#search-button').click();
    const link = reopened.locator('#dictionary-entries [data-sc-class~="audio"]').first();
    await expect(link).toHaveText('play audio', {timeout: 30_000});
    const opened = context.waitForEvent('page');
    await link.click();
    const mediaTab = await opened;
    await mediaTab.waitForURL(/^blob:/u);
    await mediaTab.waitForLoadState('domcontentloaded');
    const fetched = await mediaTab.evaluate(async () => {
        const response = await fetch(location.href);
        return {type: response.headers.get('content-type'), bytes: [...new Uint8Array(await response.arrayBuffer())], hasOpener: window.opener !== null};
    });
    expect(fetched.type).toBe('audio/wav');
    expect(fetched.bytes).toStrictEqual([...wav]);
    expect(fetched.hasOpener).toBe(false);
    // Chromium's native audio document can use a video element as its player.
    const playback = await mediaTab.locator('audio, video').evaluate(async (element) => {
        const audio = /** @type {HTMLMediaElement} */ (element);
        await new Promise((resolve) => {
            const timer = setTimeout(resolve, 10_000);
            const settled = () => {
                clearTimeout(timer);
                resolve(void 0);
            };
            audio.addEventListener('loadedmetadata', settled, {once: true});
            audio.addEventListener('error', settled, {once: true});
            audio.load();
        });
        return {readyState: audio.readyState, error: audio.error?.message ?? null, source: audio.currentSrc, preload: audio.preload};
    });
    expect(playback.error).toBeNull();
    expect(playback.readyState, JSON.stringify(playback)).toBeGreaterThanOrEqual(1);
    await mediaTab.close();
    await reopened.close();
});

test('MDX stylesheet media preserves special filename identities after import and reopening', async ({page, context, extensionId}) => {
    test.setTimeout(180_000);
    const title = 'MDict CSS filename regression';
    const extensionBaseUrl = `chrome-extension://${extensionId}`;
    const assets = [
        'slash%2Fname.png',
        'backslash%5Cname.png',
        'literal%20name.png',
        'double%252Fname.png',
        'bad%ZZname.png',
        'hash#name.png',
        'query?name.png',
        'literal name.png',
    ].map((name, index) => ({name, bytes: makeFixturePng([index * 30, 255 - index * 30, 100, 255])}));
    const mdx = makeMdictFixture([{
        key: 'Media',
        value: assets.map((_asset, index) => `<span class="media${index}">media ${index}</span>`).join(''),
    }], {title});
    const stylesheet = assets.map(({name}, index) => (
        `.media${index}{background-image:url("images/${encodeURIComponent(name)}")}`
    )).join('\n');
    const mdd = makeMdictFixture([
        {key: '\\styles\\theme.css', value: stylesheet},
        ...assets.map(({name, bytes}) => ({key: `\\styles\\images\\${name}`, value: bytes})),
    ], {mdd: true, recordBlockSize: 11, keysPerBlock: 1});
    await importFiles(page, extensionBaseUrl, [
        {name: 'filenames.mdx', mimeType: 'application/octet-stream', buffer: Buffer.from(mdx.bytes)},
        {name: 'filenames.mdd', mimeType: 'application/octet-stream', buffer: Buffer.from(mdd.bytes)},
    ], title);
    for (const {name, bytes} of assets) {
        await assertStoredMedia(page, title, `mdict-media/styles/images/${name}`, bytes);
    }
    await api(page, 'modifySettings', {
        targets: [{
            action: 'set',
            path: 'general.enableWanakana',
            value: false,
            scope: 'profile',
            optionsContext: {depth: 0, url: `${extensionBaseUrl}/search.html`},
        }],
        source: 'test',
    });
    /**
     * @param {import('@playwright/test').Page} searchPage
     * @returns {Promise<void>}
     */
    const assertRenderedMedia = async (searchPage) => {
        await searchPage.goto(`${extensionBaseUrl}/search.html`);
        await expect(searchPage.locator('html')).toHaveAttribute('data-loaded', 'true', {timeout: 30_000});
        await expect(searchPage.locator('#wanakana-enable')).not.toBeChecked();
        await searchPage.locator('#search-textbox').fill('Media');
        await searchPage.locator('#search-button').click();
        await expect(searchPage.locator('#dictionary-entries')).toContainText('media 0', {timeout: 30_000});
        for (const [index, {bytes}] of assets.entries()) {
            const target = searchPage.locator(`[data-sc-class~="media${index}"]`).first();
            await expect(async () => {
                const background = await target.evaluate((element) => getComputedStyle(element).backgroundImage);
                const match = /^url\("(blob:[^"]+)"\)$/u.exec(background);
                expect(match).not.toBeNull();
                const renderedBytes = await searchPage.evaluate(async (url) => (
                    [...new Uint8Array(await (await fetch(url)).arrayBuffer())]
                ), match?.[1] ?? '');
                expect(renderedBytes).toStrictEqual([...bytes]);
            }).toPass({timeout: 30_000});
        }
    };
    await assertRenderedMedia(page);
    const reopened = await context.newPage();
    await page.close();
    await assertRenderedMedia(reopened);
    await reopened.close();
});

test('MDX bare tags and ID-only elements retain stylesheet rules and CSS media after reopening', async ({page, context, extensionId}) => {
    test.setTimeout(180_000);
    const title = 'MDict bare tag regression';
    const extensionBaseUrl = `chrome-extension://${extensionId}`;
    const png = makeFixturePng([12, 34, 56, 255]);
    const mdx = makeMdictFixture([{
        key: '\u732b',
        value: '<p>paragraph <em>emphasis</em></p><span>bare image</span><div id="hero">ID image</div><img src="styles/icon.png">',
    }], {title});
    const mdd = makeMdictFixture([
        {key: '\\styles\\theme.css', value: 'p{color:rgb(12,34,56)} em{color:rgb(65,43,21)} span,#hero{background-image:url(icon.png)} img{border:3px solid rgb(12,34,56)}'},
        {key: '\\styles\\icon.png', value: png},
    ], {mdd: true, recordBlockSize: 11, keysPerBlock: 1});
    await importFiles(page, extensionBaseUrl, [
        {name: 'bare-tags.mdx', mimeType: 'application/octet-stream', buffer: Buffer.from(mdx.bytes)},
        {name: 'bare-tags.mdd', mimeType: 'application/octet-stream', buffer: Buffer.from(mdd.bytes)},
    ], title);
    await assertStoredMedia(page, title, 'mdict-media/styles/icon.png', png);
    /**
     * @param {import('@playwright/test').Page} searchPage
     * @returns {Promise<void>}
     */
    const assertRendered = async (searchPage) => {
        await searchPage.goto(`${extensionBaseUrl}/search.html`);
        await expect(searchPage.locator('html')).toHaveAttribute('data-loaded', 'true', {timeout: 30_000});
        await searchPage.locator('#search-textbox').fill('\u732b');
        await searchPage.locator('#search-button').click();
        await expect(searchPage.locator('#dictionary-entries [data-sc-tag="p"]')).toHaveCSS('color', 'rgb(12, 34, 56)', {timeout: 30_000});
        await expect(searchPage.locator('#dictionary-entries [data-sc-tag="em"]')).toHaveCSS('color', 'rgb(65, 43, 21)');
        await expect(searchPage.locator('#dictionary-entries [data-sc-tag="img"]')).toHaveCSS('border-top-width', '3px');
        for (const selector of ['[data-sc-tag="span"]', '[data-sc-id="hero"]']) {
            const target = searchPage.locator(`#dictionary-entries ${selector}`);
            await expect(target).not.toHaveAttribute('data-sc-class');
            await expect(async () => {
                const background = await target.evaluate((element) => getComputedStyle(element).backgroundImage);
                const match = /^url\("(blob:[^"]+)"\)$/u.exec(background);
                expect(match).not.toBeNull();
                const bytes = await searchPage.evaluate(async (url) => (
                    [...new Uint8Array(await (await fetch(url)).arrayBuffer())]
                ), match?.[1] ?? '');
                expect(bytes).toStrictEqual([...png]);
            }).toPass({timeout: 30_000});
        }
    };
    await assertRendered(page);
    const reopened = await context.newPage();
    await page.close();
    await assertRendered(reopened);
    await reopened.close();
});

test('MDX imports every key from many small blocks and retains boundary lookups after reload', async ({page, extensionId}) => {
    test.setTimeout(180_000);
    const title = 'MDict many-key-block regression';
    const entries = Array.from({length: 4096}, (_, index) => ({
        key: `\u9805\u76ee${String(index).padStart(4, '0')}`,
        value: `complete definition ${index}`,
    }));
    const {bytes} = makeMdictFixture(entries, {title, keysPerBlock: 4, recordBlockSize: 32768});
    await importFiles(page, `chrome-extension://${extensionId}`, [
        {name: 'many-key-blocks.mdx', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes)},
    ], title);
    const counts = /** @type {import('dictionary-database').DictionaryCounts} */ (await api(page, 'getDictionaryCounts', {
        dictionaryNames: [title], getTotal: false,
    }));
    expect(counts.counts).toHaveLength(1);
    expect(counts.counts[0].terms).toBe(entries.length);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-loaded', 'true', {timeout: 30_000});
    for (const index of [0, 3, 4, entries.length - 1]) {
        const entry = entries[index];
        await expect(async () => {
            expect(JSON.stringify(await lookup(page, entry.key))).toContain(entry.value);
        }).toPass({timeout: 30_000});
    }
});

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
        {key: 'Source', value: '<div>MDD embedded-name collision<img src="embedded/image/000001.png"></div>'},
    ], {title, recordBlockSize: 7, keysPerBlock: 1, headerQuote: "'", spacedHeaderAttributes: true});
    const mdd = makeMdictFixture([
        {key: '\\styles\\theme.css', value: '.native-sense { color: rgb(12, 34, 56); background-image: url(images/green.png); }'},
        {key: '\\styles\\images\\green.png', value: green},
        {key: '\\embedded\\image\\000001.png', value: green},
    ], {mdd: true, recordBlockSize: 11, keysPerBlock: 1, headerQuote: "'", spacedHeaderAttributes: true});
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
    const sourcePaths = imagePaths(await lookup(page, 'Source'));
    expect(redPaths).toHaveLength(1);
    expect(bluePaths).toHaveLength(1);
    expect(sourcePaths).toStrictEqual(['mdict-media/embedded/image/000001.png']);
    expect(redPaths[0]).not.toBe(bluePaths[0]);
    expect(redPaths[0]).not.toBe(sourcePaths[0]);
    expect(bluePaths[0]).not.toBe(sourcePaths[0]);
    await assertStoredMedia(page, title, redPaths[0], red);
    await assertStoredMedia(page, title, bluePaths[0], blue);
    await assertStoredMedia(page, title, sourcePaths[0], green);
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
    await assertStoredMedia(reopened, title, sourcePaths[0], green);
    await api(reopened, 'deleteDictionaryByTitle', {dictionaryTitle: title});
    expect(await api(reopened, 'getDictionaryInfo')).toStrictEqual([]);
    expect(JSON.stringify(await lookup(reopened, '別名'))).not.toContain('second independent native sense');
    await importFiles(reopened, extensionBaseUrl, files, title);
    expect(JSON.stringify(await lookup(reopened, '別名'))).toContain('second independent native sense');
    await assertStoredMedia(reopened, title, 'mdict-media/styles/images/green.png', green);
    await assertStoredMedia(reopened, title, redPaths[0], red);
    await assertStoredMedia(reopened, title, sourcePaths[0], green);
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
    await expect.poll(() => scoped.evaluate((node) => getComputedStyle(node, '::before').content)).toBe('"scoped"');
    await expect.poll(() => scoped.evaluate((node) => getComputedStyle(node, '::after').content)).toBe('"legacy"');
    await expect.poll(() => outside.evaluate((node) => getComputedStyle(node, '::before').content)).toBe('none');
});
