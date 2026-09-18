from pathlib import Path
p=Path('test/reader-web/run.mjs');s=p.read_text()
s=s.replace("await importBook('plain.txt', 'plain.txt'); await openBook('plain.txt');", "await importBook('plain.txt', 'plain'); await openBook('plain');")
old="book.elementHtml += '<img src=\"http://127.0.0.1:4173/probe-restored\" onerror=\"window.__restoredExecuted=true\"/><p>復元テスト</p>';"
new="book.elementHtml = book.elementHtml.replace('</h1>', '</h1><img src=\"http://127.0.0.1:4173/probe-restored\" onerror=\"window.__restoredExecuted=true\"/><p>復元テスト</p>');"
assert s.count(old)==1
s=s.replace(old,new)
old="await expect(page.locator('.book-content rt').first()).toHaveText('がっこう');"
assert s.count(old)==1
s=s.replace(old,old+" await expect(page.locator('.book-content h1')).toHaveText('E2E HTMLZ'); await expect(page.locator('.book-content')).toContainText('導入の文章'); await expect(page.locator('.book-content')).toContainText('末尾の文章');")
s=s.replace("assert.equal(await page.locator('style#ttu-userfonts').textContent().catch(() => ''), '');", "assert.equal(await page.locator('style#ttu-userfonts').count(), 0);")
marker="                await check('integration: Reader reload does not lose extension lookup'"
assert s.count(marker)==1
s=s.replace(marker,"""                await check('integration: a second Reader tab shares extension dictionary safely', async () => {
                    const firstPage = page;
                    const secondPage = await context.newPage();
                    try {
                        page = secondPage;
                        await page.goto(bookURL);
                        const popup = await hoverWord('猫');
                        await expect(popup.locator('body')).toContainText(/cat/i);
                        page = firstPage;
                        await hoverWord('学校');
                    } finally { page = firstPage; await secondPage.close(); }
                });
"""+marker)
# This assertion checks runtime exceptions, rather than silently recording them.
s=s.replace("} catch (error) { results.push({name: 'harness fatal'", "    await check('browser: no uncaught application page exceptions', async () => { assert.deepEqual(browserErrors, []); });\n} catch (error) { results.push({name: 'harness fatal'")
p.write_text(s)
