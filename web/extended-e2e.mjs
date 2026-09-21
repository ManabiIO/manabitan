/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import {expect} from '@playwright/test';

/**
 *
 * @param root0
 * @param root0.context
 * @param root0.page
 * @param root0.origin
 * @param root0.fixtures
 * @param root0.check
 * @param root0.importFile
 * @param root0.dictionary
 * @param root0.requests
 */
export async function runExtended({context, page, origin, fixtures, check, importFile, dictionary, requests}) {
    await check('recommendations reuse the existing ManabiTan Japanese catalog', async () => {
        const catalog = await page.evaluate(async () => (await import('/vendor/web/presets.js')).recommendedDictionaries());
        assert.ok(catalog.some((d) => d.name === 'Jitendex'));
        assert.ok(catalog.some((d) => d.name === 'JMnedict'));
        assert.ok(catalog.some((d) => d.category === 'frequency'));
    });
    await check('pre-aborted import is rejected without changing storage', async () => {
        const error = await page.evaluate(async () => {
            const c = new AbortController(); c.abort();
            return runtime.importDictionary(new Blob(['cancelled']), {signal: c.signal}).then(() => null, (e) => e.name);
        });
        assert.equal(error, 'AbortError');
    });
    await check('in-flight custom import cancellation rolls back and allows retry', async () => {
        await page.evaluate(() => { window.cancelDuringImport = true; });
        await page.locator('#archive').setInputFiles(path.join(fixtures, 'web-interrupted.zip'));
        await page.waitForFunction(() => window.importDone, {}, {timeout: 120000});
        assert.match(await page.evaluate(() => window.importError), /cancel/i);
        await page.evaluate(() => { window.cancelDuringImport = false; });
        const status = await page.evaluate(() => runtime.status());
        assert.ok(!status.dictionaries.some((d) => d.title === 'Web Interrupted'));
        assert.ok(status.dictionaries.some((d) => d.title === dictionary));
        assert.ok((await page.evaluate(() => runtime.lookup('猫'))).dictionaryEntries.length);
    });
    await check('abrupt tab death during import recovers both SQL and sidecar storage', async () => {
        await page.evaluate(() => runtime.close());
        const tab = await context.newPage();
        await tab.goto(origin); await tab.waitForFunction(() => window.hostReady);
        await tab.evaluate(() => runtime.open());
        await tab.locator('#archive').setInputFiles(path.join(fixtures, 'web-interrupted.zip'));
        await tab.waitForFunction(() => window.progress?.count > 20 && window.progress.index > 0 && !window.importDone, {}, {timeout: 30000});
        await tab.close();
        await page.evaluate(async () => { window.runtime = createRuntime(); await runtime.open(); });
        const status = await page.evaluate(() => runtime.status());
        assert.ok(!status.dictionaries.some((d) => d.title === 'Web Interrupted'));
        assert.ok(status.dictionaries.some((d) => d.title === dictionary));
        assert.ok((await page.evaluate(() => runtime.lookup('猫'))).dictionaryEntries.length);
    });
    await check('real structured-content media remains image-only and links are constrained', async () => {
        const imported = await importFile('web-media.zip');
        assert.equal(imported.summary.importSuccess, true);
        assert.deepEqual(imported.warnings, [], 'The valid media fixture must import without warnings');
        // Verify the real worker/storage boundary before diagnosing display.
        // An existing image element alone does not prove its bytes survived import.
        const media = await page.evaluate(async () => {
            const value = await runtime.media('Web Media', 'pixel.png');
            if (!value) { return null; }
            const bytes = new Uint8Array(value.content);
            let decoded;
            try {
                const image = await createImageBitmap(new Blob([bytes], {type: value.mediaType}));
                try { decoded = {width: image.width, height: image.height}; } finally { image.close(); }
            } catch (error) { decoded = {error: String(error)}; }
            return {mediaType: value.mediaType, bytes: bytes.byteLength, signature: [...bytes.subarray(0, 8)], decoded};
        });
        assert.ok(media, 'The imported dictionary must contain pixel.png');
        assert.equal(media.mediaType, 'image/png');
        assert.deepEqual(media.signature, [137, 80, 78, 71, 13, 10, 26, 10]);
        assert.deepEqual(media.decoded, {width: 1, height: 1}, JSON.stringify(media));
        const start = requests.length;
        await page.evaluate(() => find('画像検査'));
        await expect(page.locator('#result .gloss-image')).toHaveCount(1);
        try {
            await expect.poll(() => page.locator('#result .gloss-image').evaluate((el) => el.complete && el.naturalWidth > 0)).toBe(true);
        } catch (error) {
            const imageState = await page.locator('#result .gloss-image').evaluate((el) => ({
                tag: el.tagName,
                complete: el.complete,
                naturalWidth: el.naturalWidth,
                naturalHeight: el.naturalHeight,
                hasSource: el.hasAttribute('src'),
                loadState: el.closest('.gloss-image-link')?.getAttribute('data-image-load-state'),
            }));
            throw new Error(`Imported media decoded but its rendered image did not load: ${JSON.stringify({media, imageState})}`, {cause: error});
        }
        assert.equal(await page.locator('#result .gloss-image-link').getAttribute('href'), null);
        assert.equal(await page.locator('#result a[href^="javascript:"]').count(), 0);
        assert.equal(await page.locator('#result [onerror], #result script').count(), 0);
        await expect(page.locator('#result')).toContainText('<img onerror=');
        assert.equal(await page.evaluate(() => window.__dictionaryExecuted), undefined);
        assert.deepEqual(requests.slice(start).filter((url) => url.includes('/dictionary-probe')), []);
        const link = page.locator('#result a').filter({hasText: '学校を見る'});
        await link.click(); await expect(page.locator('#result .headword').first()).toContainText('学校');
    });
    await check('default archive size mismatch fails before import', async () => {
        const code = await page.evaluate(async () => (await import('/vendor/web/presets.js')).downloadDefaultDictionary(new URL('/short-default.zip', location.href)).then(() => null, (e) => e.code));
        assert.equal(code, 'integrity');
    });
    await check('full Jitendex static archive is checksum-verified and imported locally', async () => {
        const expected = JSON.parse(await fs.readFile(path.join(fixtures, 'jitendex.json'), 'utf8'));
        const imported = await page.evaluate(async () => {
            const presets = await import('/vendor/web/presets.js');
            const archive = await presets.downloadDefaultDictionary(new URL('/default.zip', location.href));
            const result = await runtime.importDictionary(archive);
            await runtime.setDefault('installed', result.summary.title);
            return result;
        });
        assert.equal(imported.summary.importSuccess, true);
        const at = imported.status.dictionaries.findIndex((d) => d.title === imported.summary.title);
        assert.equal(imported.status.counts.counts[at].terms, expected.termRows);
        await page.evaluate(() => find('猫'));
        await expect(page.locator('#result')).toContainText(imported.summary.title);
        await page.evaluate((title) => runtime.deleteDictionary(title), imported.summary.title);
        const after = await page.evaluate(() => runtime.status());
        assert.equal(after.preferences.defaultChoice, 'deleted');
        return {title: imported.summary.title, terms: expected.termRows};
    });
}
