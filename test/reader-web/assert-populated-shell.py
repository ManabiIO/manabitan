from pathlib import Path
p=Path('test/reader-web/run.mjs');s=p.read_text()
old="            const requests = serverRequests.filter((url) => /\\.(woff2?|ttf|otf)$/.test(url));"
assert s.count(old)==1
new="""            // CacheStorage.open may expose an empty shell while addAll is
            // still committing. Inspect a populated shell, not an empty cache.
            await expect.poll(() => page.evaluate(async (origin) => {
                for (const name of await caches.keys()) {
                    if (!name.startsWith('manabi-reader:') || !name.includes(':shell:')) continue;
                    const cache = await caches.open(name);
                    if (await cache.match(origin + '/manage') && await cache.match(origin + '/b')) return true;
                }
                return false;
            }, origin), {timeout: 30000}).toBe(true);
"""+old
p.write_text(s.replace(old,new))
