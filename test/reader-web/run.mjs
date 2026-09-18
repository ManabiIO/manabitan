// Real-origin browser tests. No Reader store, Worker, SQLite or lookup mocks.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {chromium, expect} from '@playwright/test';

const root = path.resolve(process.env.READER_BUILD);
const secondRoot = path.resolve(process.env.READER_BUILD_B || root);
const extension = path.resolve(process.env.MANABITAN_EXTENSION);
const fixtures = path.resolve(process.env.READER_FIXTURES);
const output = path.resolve(process.env.E2E_OUTPUT || 'reader-web-results');
const profileRoot = path.resolve(process.env.RUNNER_TEMP || '/tmp', `reader-e2e-${Date.now()}`);
await fs.mkdir(output, {recursive: true});
await fs.mkdir(profileRoot, {recursive: true});
const results = [];
const browserErrors = [];
const requests = [];
let activeRoot = root;
let context;
let page;
let settings;
let bookURL;
let extensionURL;
let installedTitle;
let beforeUpgradeShell;
let bookmarkSnapshot;
const mime = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf'};
const serverRequests = [];
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    serverRequests.push(url.pathname);
    try {
        const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        const resolved = path.resolve(activeRoot, relative);
        if (resolved !== activeRoot && !resolved.startsWith(activeRoot + path.sep)) { res.writeHead(403).end(); return; }
        let file = resolved;
        let stat = await fs.stat(file).catch(() => null);
        if (stat?.isDirectory()) { file = path.join(file, 'index.html'); stat = await fs.stat(file).catch(() => null); }
        if (!stat?.isFile()) { file = resolved + '.html'; stat = await fs.stat(file).catch(() => null); }
        if (!stat?.isFile()) { res.writeHead(404).end('not found'); return; }
        const data = await fs.readFile(file);
        // This is an ordinary static host, deliberately without COOP/COEP.
        res.writeHead(200, {'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache'}).end(data);
    } catch { res.writeHead(400).end(); }
});
await new Promise((resolve) => server.listen(4173, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:4173';

async function save() {
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({results, browserErrors, requests, serverRequests, embeddedRuntime: {status: 'blocked', reason: 'Reader has no embedded ManabiTan web runtime/provider UI yet. Extension E2E does not satisfy this gate.'}}, null, 2));
}
async function check(name, fn) {
    const start = Date.now();
    try {
        const detail = await fn();
        results.push({name, status: 'passed', milliseconds: Date.now() - start, detail});
        console.log(`PASS ${name}`);
        await save();
        return true;
    } catch (error) {
        results.push({name, status: 'failed', milliseconds: Date.now() - start, error: String(error?.stack || error)});
        console.error(`FAIL ${name}: ${error}`);
        if (page && !page.isClosed()) {
            await page.screenshot({path: path.join(output, `${results.length}-failure.png`)}).catch(() => {});
            await fs.writeFile(path.join(output, `${results.length}-page.html`), await page.content().catch(() => '')).catch(() => {});
        }
        await save();
        return false;
    }
}
async function launch(name, withExtension = false) {
    const ctx = await chromium.launchPersistentContext(path.join(profileRoot, name), {
        channel: 'chromium', headless: true, viewport: {width: 1280, height: 900},
        args: withExtension ? [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] : [],
    });
    ctx.setDefaultTimeout(20000);
    ctx.setDefaultNavigationTimeout(30000);
    await ctx.tracing.start({screenshots: true, snapshots: true, sources: false});
    ctx.on('page', watch);
    ctx.pages().forEach(watch);
    return ctx;
}
function watch(p) {
    p.on('pageerror', (e) => browserErrors.push({url: p.url(), error: String(e)}));
    p.on('request', (r) => { if (/probe-|jitendex|JMdict.*zip/i.test(r.url())) { requests.push({url: r.url(), method: r.method()}); } });
}
async function close(name) {
    if (!context) { return; }
    await context.tracing.stop({path: path.join(output, `${name}-trace.zip`)}).catch(() => {});
    await context.close();
    context = null;
}
async function books(p = page) {
    return p.evaluate(() => new Promise((resolve, reject) => {
        const open = indexedDB.open('books');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('data');
            const request = tx.objectStore('data').getAll();
            request.onerror = () => { db.close(); reject(request.error); };
            request.onsuccess = () => { const result = request.result.map(({id, title, elementHtml, coverImage}) => ({id, title, htmlLength: elementHtml?.length, coverType: typeof coverImage})); db.close(); resolve(result); };
        };
    }));
}
async function getBookmarks() {
    return page.evaluate(() => new Promise((resolve, reject) => {
        const open = indexedDB.open('books');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => { const db = open.result; const r = db.transaction('bookmark').objectStore('bookmark').getAll(); r.onerror = () => reject(r.error); r.onsuccess = () => { db.close(); resolve(r.result); }; };
    }));
}
async function importBook(filename, title) {
    await page.goto(origin + '/manage');
    await expect(page.locator('[title="Import Files"]').first()).toBeVisible();
    const input = page.locator('input[type=file][accept*=".epub"]').first();
    if (await input.count()) { await input.setInputFiles(path.join(fixtures, filename)); }
    else {
        const chooser = page.waitForEvent('filechooser');
        await page.locator('[title="Import Files"]').first().click();
        await (await chooser).setFiles(path.join(fixtures, filename));
    }
    if (title) { await expect(page.getByText(title, {exact: true}).first()).toBeVisible({timeout: 60000}); }
}
async function openBook(title) {
    await page.getByText(title, {exact: true}).first().click();
    await expect(page.locator('.book-content').first()).toBeVisible();
    await expect(page.locator('.book-content').first()).not.toHaveText('');
}
async function controlSW() {
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) { await page.reload(); }
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}
async function send(action, params) {
    return settings.evaluate(({action, params}) => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Extension API timeout: ${action}`)), 15000);
        chrome.runtime.sendMessage({action, params}, (response) => {
            clearTimeout(timeout);
            const error = chrome.runtime.lastError;
            if (error) { reject(new Error(error.message)); return; }
            if (!response || typeof response !== 'object') { reject(new Error('Invalid extension response')); return; }
            if (response.error) { reject(new Error(JSON.stringify(response.error))); return; }
            resolve(response.result);
        });
    }), {action, params});
}
async function openSettings() {
    settings = await context.newPage();
    await settings.goto(extensionURL + '/settings.html?popup-preview=false');
    await settings.waitForFunction(() => document.documentElement.dataset.loaded === 'true');
}
async function findTerm(text) {
    return send('termsFind', {text, details: {primaryReading: ''}, optionsContext: {index: 0}});
}
async function enableDictionary(enabled) {
    const options = await send('optionsGetFull');
    for (const profile of options.profiles) {
        const row = profile.options.dictionaries.find((d) => d.name === installedTitle);
        assert.ok(row, 'Imported dictionary must have a real settings row');
        row.enabled = enabled;
        profile.options.general.enable = true;
    }
    await send('setAllSettings', {value: options, source: 'reader-web-e2e'});
}
async function hoverWord(word) {
    const content = page.locator('.book-content').first();
    await content.waitFor();
    // Derive coordinates from actual rendered text, not the scanner API.
    const point = await content.evaluate((el, word) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            if (node.parentElement?.closest('rt')) { continue; }
            const at = node.textContent.indexOf(word);
            if (at < 0) { continue; }
            node.parentElement.scrollIntoView({block: 'center', inline: 'center'});
            const r = document.createRange(); r.setStart(node, at); r.setEnd(node, at + 1);
            const rect = r.getBoundingClientRect();
            if (rect.width && rect.height) { return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2}; }
        }
        throw new Error(`No visible target text: ${word}`);
    }, word);
    await page.bringToFront();
    await page.mouse.move(1, 1);
    await page.keyboard.down('Shift');
    try { await page.mouse.move(point.x, point.y, {steps: 12}); }
    finally { await page.keyboard.up('Shift'); }
    await expect(page.locator('iframe.yomitan-popup').first()).toBeVisible({timeout: 20000});
    const popup = page.frameLocator('iframe.yomitan-popup').first();
    await expect(popup.locator('body')).toContainText(installedTitle, {timeout: 20000});
    return popup;
}

try {
    context = await launch('reader');
    page = context.pages()[0] || await context.newPage();
    const shell = await check('reader: clean static shell and no extension globals', async () => {
        await page.goto(origin + '/manage');
        await expect(page).toHaveTitle(/Manabi Reader/);
        await expect(page.locator('[title="Import Files"]').first()).toBeVisible();
        assert.equal(await page.evaluate(() => !!globalThis.chrome?.runtime?.id), false);
        return {browser: context.browser()?.version(), crossOriginIsolated: await page.evaluate(() => crossOriginIsolated)};
    });
    if (shell) {
        const imported = await check('reader: Japanese EPUB import through real UI and IndexedDB', async () => {
            await importBook('japanese.epub', 'E2E Japanese EPUB');
            const rows = await books(); assert.ok(rows.some((r) => r.title === 'E2E Japanese EPUB')); return rows;
        });
        if (imported) {
            const opened = await check('reader: open imported EPUB through Svelte route', async () => { await openBook('E2E Japanese EPUB'); bookURL = page.url(); });
            if (opened) {
                await check('reader: ruby and furigana survive real rendering', async () => { await expect(page.locator('.book-content ruby').first()).toContainText('猫'); await expect(page.locator('.book-content rt').first()).toHaveText('ねこ'); });
                await check('reader: table and footnote structures survive', async () => { await expect(page.locator('.book-content td').first()).toHaveText('表の内容'); await expect(page.locator('.book-content a[href*="#"]').first()).toBeAttached(); await expect(page.locator('.book-content')).toContainText('脚注の内容'); });
                await check('reader: imported image loads from a live local object URL', async () => { const images = page.locator('.book-content img'); assert.ok(await images.count()); await expect.poll(() => images.first().evaluate((i) => i.complete && i.naturalWidth > 0)).toBe(true); assert.match(await images.first().getAttribute('src'), /^blob:/); });
                await check('reader: bookmark is written through the reading UI', async () => { await page.locator('.book-content').first().click({position: {x: 30, y: 30}}); await page.keyboard.press('b'); await expect.poll(async () => (await getBookmarks()).length).toBeGreaterThan(0); bookmarkSnapshot = await getBookmarks(); return bookmarkSnapshot; });
                await check('reader: book and bookmark survive reload', async () => { await page.reload(); await expect(page.locator('.book-content')).toContainText('猫'); assert.deepEqual(await getBookmarks(), bookmarkSnapshot); });
                await check('pwa: real service worker controls Reader', async () => { await controlSW(); beforeUpgradeShell = (await page.evaluate(() => caches.keys())).find((k) => k.includes(':shell:')); assert.ok(beforeUpgradeShell?.startsWith('manabi-reader:')); return beforeUpgradeShell; });
                await check('pwa: unrelated cache and dictionary sentinel retained', async () => { await page.evaluate(async () => { for (const name of ['other-app-cache', 'manabitan-dictionary-test']) { const c = await caches.open(name); await c.put('/e2e-sentinel', new Response('keep')); } }); });
                await check('pwa: installed Reader reopens an imported book offline', async () => { await context.setOffline(true); try { await page.reload(); await expect(page.locator('.book-content')).toContainText('猫'); assert.ok((await books()).length); } finally { await context.setOffline(false); } });
                await check('reader: a second tab sees the same persisted library', async () => { const other = await context.newPage(); try { await other.goto(origin + '/manage'); await expect(other.getByText('E2E Japanese EPUB', {exact: true}).first()).toBeVisible(); assert.equal((await books(other)).length, (await books()).length); } finally { await other.close(); } });
                await check('pwa: actual second-build worker waits for the old tab', async () => { assert.notEqual(root, secondRoot); activeRoot = secondRoot; await page.evaluate(async () => { const reg = await navigator.serviceWorker.getRegistration(); await reg.update(); }); await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting); assert.equal(await page.evaluate(() => navigator.serviceWorker.controller.state), 'activated'); assert.ok((await page.evaluate(() => caches.keys())).includes(beforeUpgradeShell)); });
            }
            await close('reader-first-session');
            context = await launch('reader'); page = context.pages()[0] || await context.newPage();
            await check('reader: full browser restart retains books and bookmark', async () => { await page.goto(bookURL || origin + '/manage'); await expect(page.locator('.book-content')).toContainText('猫'); assert.deepEqual(await getBookmarks(), bookmarkSnapshot); });
            await check('pwa: update activation preserves foreign caches and book data', async () => { await controlSW(); await expect.poll(() => page.evaluate(() => caches.keys())).not.toContain(beforeUpgradeShell); for (const name of ['other-app-cache', 'manabitan-dictionary-test']) { assert.equal(await page.evaluate(async (n) => (await (await caches.open(n)).match('/e2e-sentinel'))?.text(), name), 'keep'); } assert.ok((await books()).length); });
        }
        await check('reader: HTMLZ import uses production archive workers and renderer', async () => { await importBook('htmlbook.htmlz', 'E2E HTMLZ'); await openBook('E2E HTMLZ'); await expect(page.locator('.book-content rt').first()).toHaveText('がっこう'); });
        await check('reader: UTF-8 text import and rendering', async () => { await importBook('plain.txt', 'plain.txt'); await openBook('plain.txt'); await expect(page.locator('.book-content')).toContainText('学校'); });
        await check('security: hostile EPUB cannot execute or fetch embedded resources', async () => { const start = serverRequests.length; await importBook('malicious.epub', 'E2E Hostile EPUB'); await openBook('E2E Hostile EPUB'); await expect(page.locator('.book-content')).toContainText('安全な本文'); assert.equal(await page.evaluate(() => globalThis.__epubExecuted), undefined); assert.equal(await page.locator('.book-content script, .book-content iframe, .book-content [onerror]').count(), 0); assert.deepEqual(serverRequests.slice(start).filter((u) => u.includes('/probe-')), []); });
        for (const filename of ['traversal.epub', 'truncated.epub']) {
            await check(`security: ${filename} rejected without partial library write`, async () => { const count = (await books()).length; await importBook(filename); await expect(page.getByText(/Bookimport failed|Error\(s\) occurred during bookimport/).first()).toBeVisible(); assert.equal((await books()).length, count); });
        }
        await check('security: hostile saved HTML is sanitized again on reload', async () => { const id = await page.evaluate(() => new Promise((resolve, reject) => { const r = indexedDB.open('books'); r.onsuccess = () => { const db = r.result; const tx = db.transaction('data', 'readwrite'); const store = tx.objectStore('data'); const all = store.getAll(); let id; all.onsuccess = () => { const book = all.result.find((b) => b.title === 'E2E Hostile EPUB'); id = book.id; book.elementHtml += '<img src="http://127.0.0.1:4173/probe-restored" onerror="window.__restoredExecuted=true"/><p>復元テスト</p>'; store.put(book); }; tx.oncomplete = () => { db.close(); resolve(id); }; tx.onerror = () => reject(tx.error); }; })); const start = serverRequests.length; await page.goto(origin + '/b?id=' + id); await expect(page.locator('.book-content')).toContainText('復元テスト'); assert.equal(await page.evaluate(() => globalThis.__restoredExecuted), undefined); assert.deepEqual(serverRequests.slice(start).filter((u) => u.includes('/probe-')), []); });
        await check('reader: no automatic dictionary archive download before integration', async () => { assert.deepEqual(requests.filter((r) => /jitendex|JMdict.*zip/i.test(r.url)), []); });
    }
    await close('reader-second-session');

    context = await launch('extension', true); page = context.pages()[0] || await context.newPage();
    const ready = await check('manabitan: fresh real extension starts without preinstalled dictionaries', async () => { let sw = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension:')); if (!sw) { sw = await context.waitForEvent('serviceworker', {predicate: (w) => w.url().startsWith('chrome-extension:')}); } extensionURL = new URL(sw.url()).origin; await openSettings(); assert.deepEqual(await send('getDictionaryInfo'), []); });
    if (ready) {
        const installed = await check('manabitan: install full standard JMdict English through settings UI', async () => { const metadata = JSON.parse(await fs.readFile(path.join(fixtures, 'jmdict.json'))); await settings.setInputFiles('#dictionary-import-file-input', path.join(fixtures, 'JMdict_english.zip')); const deadline = Date.now() + 600000; let completion; while (Date.now() < deadline) { const state = await settings.evaluate(() => ({completion: globalThis.__manabitanLastImportCompletion, error: document.querySelector('#dictionary-error:not([hidden])')?.textContent?.trim(), busy: !!document.querySelector('.dictionary-import-progress:not([hidden])')})); if (state.error) { throw new Error(state.error); } if (state.completion && !state.busy) { completion = state.completion; break; } await settings.waitForTimeout(300); } assert.ok(completion, 'Import must finish, not merely create a dictionary row'); assert.equal(completion.errorCount || 0, 0); const info = await send('getDictionaryInfo'); installedTitle = info.find((d) => /JMdict/i.test(d.title))?.title; assert.ok(installedTitle); const counts = await send('getDictionaryCounts', {dictionaryNames: [installedTitle], getTotal: false}); assert.equal(counts.counts[0].terms, metadata.termRows); return {completion, info, counts, fixture: metadata}; });
        if (installed) {
            await check('manabitan: stored dictionary is enabled via its existing settings contract', async () => { await enableDictionary(true); });
            for (const term of ['猫', '学校', '食べました']) {
                await check(`manabitan: real lookup/deinflection ${term}`, async () => { const r = await findTerm(term); assert.ok(r.dictionaryEntries?.length); assert.ok(JSON.stringify(r).includes(installedTitle)); if (term === '食べました') { assert.ok(JSON.stringify(r).includes('食べる')); } return {entryCount: r.dictionaryEntries.length}; });
            }
            const imported = await check('integration: import EPUB with ManabiTan installed', async () => { await importBook('japanese.epub', 'E2E Japanese EPUB'); await openBook('E2E Japanese EPUB'); bookURL = page.url(); });
            if (imported) {
                await check('integration: real Shift-hover popup over Reader Japanese text', async () => { const popup = await hoverWord('猫'); await expect(popup.locator('body')).toContainText(/cat/i); await page.screenshot({path: path.join(output, 'reader-jmdict-popup.png')}); });
                await check('integration: repeated scans leave one visible popup', async () => { for (const term of ['学校', '猫', '学校']) { await hoverWord(term); } assert.equal(await page.locator('iframe.yomitan-popup:visible').count(), 1); });
                await check('integration: Reader reload does not lose extension lookup', async () => { await page.reload(); await hoverWord('猫'); });
                await check('integration: offline Reader and dictionary popup', async () => { await controlSW(); await context.setOffline(true); try { await page.reload(); const popup = await hoverWord('猫'); await expect(popup.locator('body')).toContainText(/cat/i); } finally { await context.setOffline(false); } });
            }
            await close('extension-first-session');
            context = await launch('extension', true); page = context.pages()[0] || await context.newPage(); await openSettings();
            await check('manabitan: full browser restart preserves JMdict and lookup', async () => { const info = await send('getDictionaryInfo'); assert.ok(info.some((d) => d.title === installedTitle)); assert.ok((await findTerm('猫')).dictionaryEntries.length); });
            await check('integration: popup works after browser restart', async () => { await page.goto(bookURL); await hoverWord('猫'); });
            await check('manabitan: disabling dictionary removes its lookup results', async () => { await enableDictionary(false); assert.equal((await findTerm('猫')).dictionaryEntries.length, 0); });
            await check('manabitan: re-enabling restores existing dictionary without reimport', async () => { await enableDictionary(true); assert.ok((await findTerm('猫')).dictionaryEntries.length); });
            await check('manabitan: delete dictionary through production backend', async () => { await send('deleteDictionaryByTitle', {dictionaryTitle: installedTitle}); assert.equal((await send('getDictionaryInfo')).length, 0); assert.equal((await findTerm('猫')).dictionaryEntries.length, 0); });
            await check('manabitan: deleted dictionary stays deleted after settings reload', async () => { await settings.reload(); await settings.waitForFunction(() => document.documentElement.dataset.loaded === 'true'); assert.equal((await send('getDictionaryInfo')).length, 0); });
        }
    }
} catch (error) { results.push({name: 'harness fatal', status: 'failed', error: String(error?.stack || error)}); console.error(error); }
finally {
    await close('final-session');
    await save();
    server.close();
    // Browser profiles contain real OPFS data and must never be uploaded as evidence.
    await fs.rm(profileRoot, {recursive: true, force: true});
}
if (results.some((r) => r.status !== 'passed')) { process.exitCode = 1; }
