from pathlib import Path
import base64, gzip, hashlib, json, urllib.request

encoded=Path('test/reader-web/system-fonts.patch.gz.b64').read_text().strip()
encoded=encoded.replace('DEMNIEnvDi3', 'DEM'+'N'+'dzi3')
patch=gzip.decompress(base64.b64decode(encoded,validate=True))
assert hashlib.sha256(patch).hexdigest()=='d329381260fa56dbadcd249d8ab297d340bb4ffcdf3c6b47f3d9950700e28f8a'
Path('/tmp/system-fonts.patch').write_bytes(patch)
import subprocess
subprocess.run(['git','-C','reader-fixture','apply','/tmp/system-fonts.patch'],check=True)

# Retain the actual fallback's license with static output. This fetch is pinned
# to a verified source blob, not latest font data; no new font binary is added.
url='https://api.github.com/repos/fontworks-fonts/Klee/git/blobs/cb9ced3f0aad10958824080d84c391100bc53986'
with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'Manabi-Reader-qualification'}),timeout=30) as response:
    license_data=base64.b64decode(json.load(response)['content'])
assert hashlib.sha1(b'blob '+str(len(license_data)).encode()+b'\0'+license_data).hexdigest()=='cb9ced3f0aad10958824080d84c391100bc53986'
license_file=Path('reader-fixture/apps/web/static/legal/Klee-One-OFL.txt')
license_file.parent.mkdir(parents=True,exist_ok=True)
license_file.write_bytes(license_data)

p=Path('test/reader-web/run.mjs');s=p.read_text()
s=s.replace("import {chromium, expect} from '@playwright/test';", "import {chromium, expect} from '@playwright/test';\nimport {runFontAcceptance} from './font-acceptance.mjs';")
s=s.replace('let activeRoot = root;', 'let activeRoot = root;\nlet fontResponseDelay = 0;\nconst remoteFontRequests = [];')
needle="    serverRequests.push(url.pathname);"
assert s.count(needle)==1
s=s.replace(needle,needle+"\n    if (url.pathname === '/__test-font-delay') { fontResponseDelay = Math.min(6000,Math.max(0,Number(url.searchParams.get('ms'))||0)); res.writeHead(200).end('ok'); return; }\n    if (/\\.woff2?$/.test(url.pathname) && fontResponseDelay) { await new Promise((resolve) => setTimeout(resolve,fontResponseDelay)); }")
needle="    ctx.on('page', watch);"
assert s.count(needle)==1
s=s.replace(needle,needle+"\n    ctx.on('request', (request) => { if (/https:\\/\\/fonts\\.(?:googleapis|gstatic)\\.com/.test(request.url())) remoteFontRequests.push(request.url()); });")
needle='    if (shell) {'
assert s.count(needle)==1
s=s.replace(needle,needle+'''
        await check('fonts: clean library and installed shell request zero font files', async () => {
            await controlSW();
            const requests = serverRequests.filter((url) => /\\.(woff2?|ttf|otf)$/.test(url));
            assert.deepEqual(requests, []);
            const cachesAtStart = await page.evaluate(async () => {
                const result = {};
                for (const name of await caches.keys()) {
                    result[name] = (await (await caches.open(name)).keys()).map((request) => request.url);
                }
                return result;
            });
            for (const [name, keys] of Object.entries(cachesAtStart)) {
                if (name.includes(':shell:')) assert.ok(keys.every((url) => !/\\.(woff2?|ttf|otf)$/.test(url)));
            }
            return cachesAtStart;
        });
''')
needle="    await close('reader-second-session');"
assert s.count(needle)==1
s=s.replace(needle,"    await runFontAcceptance({page, context, origin, bookURL, check, output});\n"+needle)
needle="    await check('browser: no uncaught application page exceptions'"
assert s.count(needle)==1
s=s.replace(needle,"    await check('fonts: no external Google Fonts stylesheet or binary requests', async () => { assert.deepEqual(remoteFontRequests, []); });\n"+needle)
p.write_text(s)

p=Path('test/reader-web/font-acceptance.mjs');s=p.read_text()
s=s.replace("            const {root} = await cdp.send('DOM.getDocument');", "            await cdp.send('DOM.enable');\n            await cdp.send('CSS.enable');\n            const {root} = await cdp.send('DOM.getDocument');")
p.write_text(s)
