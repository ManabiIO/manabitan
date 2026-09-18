from pathlib import Path
p=Path('test/reader-web/run.mjs');s=p.read_text()
old="""    await expect(page.locator('iframe.yomitan-popup').first()).toBeVisible({timeout: 20000});
    const popup = page.frameLocator('iframe.yomitan-popup').first();
    await expect(popup.locator('body')).toContainText(installedTitle, {timeout: 20000});
    return popup;"""
new="""    await expect.poll(async () => (await visiblePopupFrames()).length, {timeout: 20000}).toBe(1);
    const [popup] = await visiblePopupFrames();
    await expect(popup.locator('body')).toContainText(installedTitle, {timeout: 20000});
    await expect(popup.locator('.headword-term').first()).toContainText(word === '食べました' ? '食べる' : word);
    return popup;"""
assert s.count(old)==1;s=s.replace(old,new)
marker='async function hoverWord(word) {'
helper="""// ManabiTan intentionally uses a closed shadow root. Inspect its actual
// browser frame/owner handle; do not weaken the extension by changing attachShadow.
async function visiblePopupFrames() {
    const result = [];
    for (const frame of page.frames()) {
        if (!frame.url().startsWith(extensionURL + '/popup.html')) { continue; }
        const element = await frame.frameElement();
        try { if (await element.isVisible()) { result.push(frame); } }
        finally { await element.dispose(); }
    }
    return result;
}
"""
assert s.count(marker)==1;s=s.replace(marker,helper+marker)
old="assert.equal(await page.locator('iframe.yomitan-popup:visible').count(), 1);"
assert s.count(old)==1;s=s.replace(old,"assert.equal((await visiblePopupFrames()).length, 1);")
marker="        await check('reader: no automatic dictionary archive download before integration'"
extra="""        await check('security: selected font family cannot inject a second CSS declaration', async () => {
            await page.evaluate(() => localStorage.setItem('fontFamilyGroupOne', 'serif; --e2e-preload-injected: 1'));
            try {
                await page.reload();
                await expect(page.getByText('E2E Hostile EPUB', {exact: true}).first()).toBeVisible();
                assert.equal(await page.evaluate(() => [...document.querySelectorAll('span')].some((el) => el.style.getPropertyValue('--e2e-preload-injected').trim() === '1')), false);
            } finally { await page.evaluate(() => localStorage.removeItem('fontFamilyGroupOne')); await page.reload(); }
        });
"""
assert s.count(marker)==1;s=s.replace(marker,extra+marker)
p.write_text(s)
p=Path('reader-fixture/apps/web/src/routes/+layout.svelte');s=p.read_text();old="<span style={`font-family: ${$fontFamilyGroupOne$ || 'Noto Serif JP'}`} />"
assert s.count(old)==1;s=s.replace(old,"<span style:font-family={$fontFamilyGroupOne$ || 'Noto Serif JP'} />");p.write_text(s)
