from pathlib import Path
p=Path('test/reader-web/run.mjs');s=p.read_text()
old="await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.active, {timeout: 90000});"
assert s.count(old)==1
s=s.replace(old,"await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === 'activated', undefined, {timeout: 90000});")
p.write_text(s)
p=Path('test/reader-web/font-acceptance.mjs');s=p.read_text()
old="await page.locator('input[placeholder=\"System Japanese\"]').fill('Klee One SemiBold');"
assert s.count(old)==1
s=s.replace(old,old+"\n        await page.locator('button[title=\"toggle\"]').click();")
old="""            await page.waitForFunction(() => document.fonts.status === 'loaded');
            await expect(page.locator('.book-content').first()).toContainText('学校');
        } finally { await page.request.get(origin + '/__test-font-delay?ms=0'); }"""
new="""            await page.waitForFunction(() => document.fonts.status === 'loaded');
            await expect(page.locator('.book-content').first()).toContainText('学校');
            await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const ruby = page.locator('.book-content ruby').first();
            await ruby.scrollIntoViewIfNeeded();
            const revealed = await ruby.evaluate((element) => element.classList.contains('reveal-rt'));
            await ruby.click();
            await expect.poll(() => ruby.evaluate((element) => element.classList.contains('reveal-rt'))).toBe(!revealed);
        } finally { await page.request.get(origin + '/__test-font-delay?ms=0'); }"""
assert s.count(old)==1;s=s.replace(old,new)
p.write_text(s)
