"""Research transport only; artifacts retain the resulting standalone test source."""
from pathlib import Path
p = Path('test/reader-web/run.mjs')
s = p.read_text()
def replace(old, new):
    global s
    assert s.count(old) == 1, old
    s = s.replace(old, new)
replace("extensionURL = new URL(sw.url()).origin;", "extensionURL = new URL(sw.url()).protocol + '//' + new URL(sw.url()).host;")
replace("await page.evaluate(async () => { await navigator.serviceWorker.ready; });", "await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.active, {timeout: 90000});")
replace("!!document.querySelector('.dictionary-import-progress:not([hidden])')", "!!document.querySelector('#dictionaries-modal .dictionary-import-progress:not([hidden]), #recommended-dictionaries-modal .dictionary-import-progress:not([hidden])')")
replace("    if (title) { await expect(page.getByText(title, {exact: true}).first()).toBeVisible({timeout: 60000}); }", "    if (title) { await expect(page.getByText(title, {exact: true}).first()).toBeVisible({timeout: 60000}); await expect(page.locator('[title=\"Import Files\"]').first()).toBeEnabled(); }")
marker = "        await check('reader: no automatic dictionary archive download before integration'"
assert s.count(marker)==1
extra = '''        await check('security: persisted cover URL does not fetch remote content', async () => {
            await page.evaluate(() => new Promise((resolve, reject) => {
                const open = indexedDB.open('books');
                open.onsuccess = () => { const db = open.result; const tx = db.transaction('data', 'readwrite'); const store = tx.objectStore('data'); const r = store.getAll();
                    r.onsuccess = () => { const book = r.result.find((b) => b.title === 'E2E Hostile EPUB'); book.coverImage = 'http://127.0.0.1:4173/probe-cover'; store.put(book); };
                    tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
                }; open.onerror = () => reject(open.error);
            }));
            const start = serverRequests.length;
            await page.goto(origin + '/manage');
            await expect(page.getByText('E2E Hostile EPUB', {exact: true}).first()).toBeVisible();
            // The src assertion is deterministic; the network assertion independently
            // catches requests issued before DOM inspection.
            assert.equal(await page.locator('img[src*="probe-cover"]').count(), 0);
            assert.deepEqual(serverRequests.slice(start).filter((u) => u.includes('/probe-cover')), []);
        });
        await check('security: persisted custom font name cannot escape its CSS declaration', async () => {
            await page.evaluate(() => localStorage.setItem('userfonts', JSON.stringify([{name: "x';}body{--e2e-injected:1}/*", fileName: 'x.woff2', path: '/userfonts/x.woff2'}])));
            try {
                await page.reload();
                await expect(page.getByText('E2E Hostile EPUB', {exact: true}).first()).toBeVisible();
                assert.equal(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--e2e-injected').trim()), '');
            } finally { await page.evaluate(() => localStorage.removeItem('userfonts')); await page.reload(); }
        });
        await check('security: custom font metadata cannot inject a remote font URL', async () => {
            await page.evaluate(() => localStorage.setItem('userfonts', JSON.stringify([{name:'Untrusted',fileName:'x.woff2',path:'https://untrusted.invalid/probe-font.woff2'}])));
            try { await page.reload(); await expect(page.getByText('E2E Hostile EPUB', {exact: true}).first()).toBeVisible(); assert.equal(await page.locator('style#ttu-userfonts').textContent().catch(() => ''), ''); }
            finally { await page.evaluate(() => localStorage.removeItem('userfonts')); await page.reload(); }
        });
'''
s = s.replace(marker, extra+marker)
p.write_text(s)
