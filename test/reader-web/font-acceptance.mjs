import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {expect} from '@playwright/test';

// This suite uses the actual built Reader and browser font loader. Computed
// stacks prove selection policy, not availability of proprietary Apple faces.
export async function runFontAcceptance({page, context, origin, bookURL, check, output}) {
    const css = () => page.locator('.book-content').first().evaluate((el) => {
        const style = getComputedStyle(el);
        return {font: style.fontFamily, writingMode: style.writingMode, size: style.fontSize};
    });
    const openSettings = async () => {
        await page.goto(origin + '/settings');
        await expect(page.locator('input[placeholder="System Japanese"]')).toBeVisible();
    };
    const choose = async (family, writingMode = 'horizontal-tb', viewMode = 'paginated') => {
        await openSettings();
        await page.locator('input[placeholder="System Japanese"]').fill(family);
        await page.locator(`button[title="${writingMode}"]`).click();
        await page.locator(`button[title="${viewMode}"]`).click();
        await expect.poll(() => page.evaluate(() => localStorage.getItem('fontFamilyGroupOne'))).toBe(family);
        await page.goto(bookURL);
        await expect(page.locator('.book-content').first()).toBeVisible();
        await expect(page.locator('.book-content').first()).toContainText('学校');
        await page.waitForFunction(() => document.fonts.status === 'loaded');
    };
    const fontCache = () => page.evaluate(async () => {
        const names = (await caches.keys()).filter((name) => name.startsWith('manabi-reader:') && name.endsWith(':packaged-fonts:v1'));
        const keys = [];
        for (const name of names) {
            for (const request of await (await caches.open(name)).keys()) {
                const response = await (await caches.open(name)).match(request);
                keys.push({url: request.url, bytes: (await response.arrayBuffer()).byteLength});
            }
        }
        return {names, keys};
    });
    for (const viewMode of ['paginated', 'continuous']) {
        for (const writingMode of ['horizontal-tb', 'vertical-rl']) {
            await check(`fonts: system Japanese ${writingMode} in ${viewMode} Reader`, async () => {
                await choose('System Japanese', writingMode, viewMode);
                const style = await css();
                assert.equal(style.writingMode, writingMode);
                assert.equal(style.font.split(',')[0].trim().replaceAll('"', ''), writingMode === 'vertical-rl' ? 'YuKyokasho' : 'YuKyokasho Yoko');
                assert.ok(style.font.indexOf('Hiragino Mincho ProN') < style.font.indexOf('Klee One'));
                assert.ok(await page.locator('.book-content ruby').count());
                await page.screenshot({path: path.join(output, `typography-${viewMode}-${writingMode}.png`)});
                return style;
            });
        }
    }
    await check('fonts: explicit Klee One uses the real packaged fallback', async () => {
        await choose('Klee One');
        assert.match((await css()).font, /^"?Klee One"?,/);
        const loaded = await page.evaluate(() => [...document.fonts].filter((face) => face.family.replaceAll('"','') === 'Klee One').map((face) => ({status: face.status, weight: face.weight})));
        assert.ok(loaded.some((face) => face.status === 'loaded'));
        const cdp = await context.newCDPSession(page);
        try {
            const {root} = await cdp.send('DOM.getDocument');
            const {nodeId} = await cdp.send('DOM.querySelector', {nodeId: root.nodeId, selector: '.book-content p'});
            const actual = await cdp.send('CSS.getPlatformFontsForNode', {nodeId});
            assert.ok(actual.fonts.some((font) => font.isCustomFont && /Klee/i.test(font.familyName) && font.glyphCount > 0));
            return {loaded, actual};
        } finally { await cdp.detach(); }
    });
    await check('fonts: only requested packaged font faces enter their own cache', async () => {
        const result = await fontCache();
        assert.equal(result.names.length, 1);
        assert.ok(result.keys.some((item) => /KleeOne-Regular.*\.woff2$/.test(item.url)));
        assert.ok(result.keys.length < 16, 'The entire optional catalog must not be downloaded');
        assert.ok(result.keys.every((item) => /\.woff2$/.test(item.url)));
        return result;
    });
    await check('fonts: controlled Reader retains Klee One for offline reload', async () => {
        assert.ok(await page.evaluate(() => !!navigator.serviceWorker.controller));
        await context.setOffline(true);
        try {
            await page.reload();
            await expect(page.locator('.book-content').first()).toContainText('学校');
            await page.waitForFunction(() => document.fonts.status === 'loaded');
            assert.ok(await page.evaluate(() => [...document.fonts].some((face) => face.family.replaceAll('"','') === 'Klee One' && face.status === 'loaded')));
        } finally { await context.setOffline(false); }
    });
    await check('fonts: existing explicit Noto choice survives settings reload', async () => {
        await choose('Noto Serif JP');
        assert.match((await css()).font, /^"?Noto Serif JP"?,/);
        await openSettings();
        await page.reload();
        await expect(page.locator('input[placeholder="System Japanese"]')).toHaveValue('Noto Serif JP');
    });
    await check('fonts: absent custom face falls back rather than blocking Reader', async () => {
        await choose('ReaderE2EMissingFont');
        const style = await css();
        assert.ok(style.font.includes('YuKyokasho Yoko') && style.font.includes('Klee One'));
        await page.locator('.book-content').first().click({position: {x:30,y:30}});
        await page.keyboard.press('PageDown');
        await expect(page.locator('.book-content').first()).toContainText('学校');
        return style;
    });
    await check('fonts: late font completion does not block initial reading', async () => {
        // A slow real asset response, not a replacement FontFaceSet/Reader store.
        await openSettings();
        await page.locator('input[placeholder="System Japanese"]').fill('Klee One SemiBold');
        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.clearBrowserCache');
        await cdp.detach();
        await page.evaluate(async () => {
            for (const name of await caches.keys()) {
                if (name.startsWith('manabi-reader:') && name.endsWith(':packaged-fonts:v1')) {
                    const cache = await caches.open(name);
                    for (const request of await cache.keys()) { if (/KleeOne-SemiBold/.test(request.url)) await cache.delete(request); }
                }
            }
        });
        await page.request.get(origin + '/__test-font-delay?ms=4000');
        try {
            await page.goto(bookURL);
            await expect(page.locator('.book-content').first()).toBeVisible();
            await expect.poll(() => page.evaluate(() => document.fonts.status)).toBe('loading');
            await page.locator('.book-content').first().click({position: {x:30,y:30}});
            await page.keyboard.press('PageDown');
            await page.waitForFunction(() => document.fonts.status === 'loaded');
            await expect(page.locator('.book-content').first()).toContainText('学校');
        } finally { await page.request.get(origin + '/__test-font-delay?ms=0'); }
    });
    await choose('System Japanese');
    await fs.writeFile(path.join(output, 'typography-cache.json'), JSON.stringify(await fontCache(), null, 2));
}
