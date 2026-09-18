from pathlib import Path
p=Path('test/reader-web/run.mjs');s=p.read_text()
start=s.index('    const content = page.locator(\'.book-content\').first();',s.index('async function hoverWord(word)'))
end=s.index('    await page.mouse.move(1, 1);',start)
s=s[:start]+'''    await page.bringToFront();
    const content = page.locator('.book-content').first();
    await content.waitFor();
    await page.waitForFunction(() => document.documentElement.dataset.manabitanContentScriptPrepared === 'true');
    await page.waitForFunction(() => document.fonts.status === 'loaded');
    // Target visible, unobscured text. A prior popup may cover the first matching
    // word; hovering through that popup does not constitute a new book scan.
    const point = await content.evaluate(async (el, word) => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const candidates = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            if (node.parentElement?.closest('rt')) { continue; }
            let from = 0;
            while (from < node.textContent.length) {
                const at = node.textContent.indexOf(word, from);
                if (at < 0) { break; }
                candidates.push({node, at});
                from = at + word.length;
            }
        }
        const visiblePoint = () => {
            for (const {node, at} of candidates) {
                const range = document.createRange();
                range.setStart(node, at); range.setEnd(node, at + 1);
                const rect = range.getBoundingClientRect();
                const x = rect.x + rect.width / 2;
                const y = rect.y + rect.height / 2;
                if (!rect.width || !rect.height || x <= 0 || y <= 0 || x >= innerWidth || y >= innerHeight) { continue; }
                const hit = document.elementFromPoint(x, y);
                if (hit && (hit.contains(node) || node.parentElement.contains(hit))) { return {x, y}; }
            }
            return null;
        };
        let result = visiblePoint();
        if (result) { return result; }
        candidates[0]?.node.parentElement.scrollIntoView({block: 'center', inline: 'center'});
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        result = visiblePoint();
        if (!result) { throw new Error(`No unobscured rendered target text: ${word}`); }
        return result;
    }, word);
'''+s[end:]
p.write_text(s)
