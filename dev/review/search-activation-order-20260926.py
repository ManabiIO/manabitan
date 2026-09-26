from pathlib import Path
import re

p = Path('test/playwright/integration.spec.js')
s = p.read_text()
old = '    await waitForSearchPageReady(page);\n    await page.bringToFront();\n    const searchTextbox'
assert s.count(old) == 1
s = s.replace(old, '    await waitForSearchPageReady(page);\n    const searchTextbox')
pattern = r'(?m)^( +)(await page\.goto\(`\$\{extensionBaseUrl\}/search\.html`\);)$'
s, count = re.subn(pattern, r'\1// Activate the tab before navigation, not after Search has acquired autofocus.\n\1await page.bringToFront();\n\1\2', s)
assert count == 8, count
old = '    await searchTextbox.focus();\n    await expect(searchTextbox).toBeFocused();\n    await searchTextbox.fill(query);\n    try {'
assert s.count(old) == 1
s = s.replace(old, '    try {\n        await searchTextbox.focus();\n        await expect(searchTextbox).toBeFocused();\n        await searchTextbox.fill(query);')
p.write_text(s)
