from pathlib import Path
p=Path('test/reader-web/run.mjs');s=p.read_text()
s=s.replace('let bookmarkSnapshot;', 'let bookmarkSnapshot;\nlet readingOffset = 0;\nasync function readingPosition() { return page.locator(\'.book-content\').first().evaluate((el) => Math.max(Math.abs(el.scrollTop), Math.abs(el.scrollLeft))); }')
needle="await page.locator('.book-content').first().click({position: {x: 30, y: 30}}); await page.keyboard.press('b');"
assert s.count(needle)==1
s=s.replace(needle,"await page.locator('.book-content').first().click({position: {x: 30, y: 30}}); for (let i=0;i<3;++i) { const before=await readingPosition(); await page.keyboard.press('PageDown'); await expect.poll(readingPosition).toBeGreaterThan(before); } readingOffset=await readingPosition(); await page.keyboard.press('b');")
needle="bookmarkSnapshot = await getBookmarks(); return bookmarkSnapshot;"
assert s.count(needle)==1
s=s.replace(needle,"await expect.poll(async () => Math.max(...(await getBookmarks()).map((b) => b.exploredCharCount))).toBeGreaterThan(0); bookmarkSnapshot = await getBookmarks(); return {bookmarks: bookmarkSnapshot, readingOffset};")
needle='assert.deepEqual(await getBookmarks(), bookmarkSnapshot);'
assert s.count(needle)==2
s=s.replace(needle,needle+" await expect.poll(readingPosition).toBeGreaterThan(0); await expect.poll(async () => Math.abs((await readingPosition())-readingOffset)).toBeLessThanOrEqual(2);")
s=s.replace("error: String(e)}", "error: String(e.stack || e)}")
p.write_text(s)
