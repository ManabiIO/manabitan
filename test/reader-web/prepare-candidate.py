from pathlib import Path
import subprocess
# Qualification uses the same standalone runtime files subsequently delivered
# as Reader patches; no Reader store or browser implementation is mocked.
p=Path('test/reader-web/qualify.sh'); s=p.read_text()
needle='git -C reader-fixture apply /tmp/reader-runtime.patch'
assert s.count(needle)==1
s=s.replace(needle, needle+'\ngit -C reader-fixture apply "$GITHUB_WORKSPACE/test/reader-web/reader-local-media.patch"\npython3 test/reader-web/fix-htmlz-section.py')
needle='python3 test/reader-web/prepare-harness.py'
assert s.count(needle)==1
s=s.replace(needle, needle+'\npython3 test/reader-web/refine-browser-assertions.py')
# Before/after inspection established that pnpm 12 prepends one executable
# tool document; the entire application dependency document is identical.
needle="fs.writeFileSync(`reader-web-results/pnpm-lock-${name}.json`,JSON.stringify(docs.map((d)=>d.toJSON()),null,2));"
s=s.replace(needle,needle+"\n  if(name==='after'){const before=parseAllDocuments(fs.readFileSync('reader-web-results/pnpm-lock-before.yaml','utf8')).map((d)=>d.toJSON());const after=docs.map((d)=>d.toJSON());if(JSON.stringify(after.slice(1))!==JSON.stringify(before)){throw new Error('Application lock document changed');}}")
s=s.replace('npx playwright install --with-deps chromium', 'git -C reader-fixture diff --binary -- apps/web package.json pnpm-lock.yaml > reader-web-results/reader-composed-runtime.patch\nnpx playwright install --with-deps chromium')
p.write_text(s)
