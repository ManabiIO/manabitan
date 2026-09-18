from pathlib import Path
import hashlib
root=Path('reader-fixture')
p=root/'apps/web/src/lib/components/book-reader/book-reader.svelte';s=p.read_text()
assert s.count('mergeMap')==4
s=s.replace('mergeMap','switchMap')
s=s.replace('  const reactiveElements$ = iffBrowser', '  // Content and font reflows replace the listener lifetime; accumulating\n  // subscriptions here makes one ruby click toggle twice after a late font.\n  const reactiveElements$ = iffBrowser')
p.write_text(s)
p=root/'apps/web/src/lib/components/book-reader/reactive-elements.ts';s=p.read_text()
old="""      const spoilerLabelEl = document.createElement('span');
      spoilerLabelEl.title = 'Show Image';
      spoilerLabelEl.classList.add('spoiler-label');
      spoilerLabelEl.setAttribute('aria-hidden', 'true');
      spoilerLabelEl.innerText = 'ネタバレ';
      el.appendChild(spoilerLabelEl);"""
new="""      // Rebinding the same content after a font reflow must not append a
      // second label. The previous stream's listeners have been unsubscribed.
      const spoilerLabelEl =
        el.querySelector<HTMLElement>(':scope > .spoiler-label') ?? document.createElement('span');
      spoilerLabelEl.title = 'Show Image';
      spoilerLabelEl.classList.add('spoiler-label');
      spoilerLabelEl.setAttribute('aria-hidden', 'true');
      spoilerLabelEl.innerText = 'ネタバレ';
      if (!spoilerLabelEl.parentNode) el.appendChild(spoilerLabelEl);"""
assert s.count(old)==1;s=s.replace(old,new).replace('el.removeChild(spoilerLabelEl);','spoilerLabelEl.remove();');p.write_text(s)
p=root/'apps/web/src/lib/service-worker/reader-service-worker.mjs';s=p.read_text()
s=s.replace('  const fontsPrefix = `${prefix}remote-fonts:`;', '  const fontsPrefix = `${prefix}remote-fonts:`;\n  const staticFontsPrefix = `${prefix}static-fonts:`;')
s=s.replace('  const fontsName = `${fontsPrefix}${config.version}`;', '  const fontsName = `${fontsPrefix}${config.version}`;\n  const staticFontsName = `${staticFontsPrefix}${config.version}`;')
s=s.replace('  const fontAssets = new Set(', '''  // SvelteKit's build list is content-hashed; public/static files are not.
  // Only immutable built URLs may survive upgrades in the stable cache.
  const immutableFontAssets = new Set(
    config.build
      .map((path) => new URL(path, scope))
      .filter((url) => inScope(url) && isPackagedFont(url))
      .map((url) => url.href)
  );
  const fontAssets = new Set(''')
s=s.replace('(key.startsWith(fontsPrefix) && key !== fontsName)', '(key.startsWith(fontsPrefix) && key !== fontsName) ||\n                  (key.startsWith(staticFontsPrefix) && key !== staticFontsName)')
s=s.replace('keys.filter((key) => !fontAssets.has(key.url))','keys.filter((key) => !immutableFontAssets.has(key.url))')
s=s.replace('      cache = await storage.open(packagedFontsName);', '      cache = await storage.open(\n        immutableFontAssets.has(key) ? packagedFontsName : staticFontsName\n      );')
p.write_text(s)
expected={
 'apps/web/src/lib/components/book-reader/book-reader.svelte':'0defdffd35d26e182cafdf402534788f8f151a55',
 'apps/web/src/lib/components/book-reader/reactive-elements.ts':'9f3674a2d6aa92ef64c2c36ff52b216fd90b009f',
 'apps/web/src/lib/service-worker/reader-service-worker.mjs':'77c6dca6968c1f918e62852423d900c42ad38eee'
}
for file,digest in expected.items():
 data=(root/file).read_bytes()
 assert hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()==digest,file

# Cold registration deliberately does not claim the existing page. Check
# installation/cache budgets here, and controlled navigation in the PWA tests.
p=Path('test/reader-web/run.mjs');s=p.read_text()
old="""await check('fonts: clean library and installed shell request zero font files', async () => {
            await controlSW();"""
new="""await check('fonts: clean library and installed shell request zero font files', async () => {
            await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === 'activated', undefined, {timeout: 30000});"""
assert s.count(old)==1;s=s.replace(old,new);p.write_text(s)
p=Path('test/reader-web/font-acceptance.mjs');s=p.read_text()
old="        await page.locator('button[title=\"toggle\"]').click();"
new="""        const hideFurigana = page.locator('section').filter({has: page.locator('h2').filter({hasText: /^Hide furigana$/})});
        await hideFurigana.locator('button[title="true"]').click();
        await page.locator('button[title="toggle"]').click();"""
assert s.count(old)==1;s=s.replace(old,new);p.write_text(s)
