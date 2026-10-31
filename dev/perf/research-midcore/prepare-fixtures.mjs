import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {access, mkdir, readFile, realpath, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'));
const cache = path.join(root, 'builds/e2e-dictionary-cache');
await mkdir(cache, {recursive: true});
assert.equal(await realpath(cache), cache);
const fixtures = JSON.parse(await readFile(path.join(root, 'test/perf/dictionaries.lock.json'), 'utf8')).dictionaries;
const sha = (data) => createHash('sha256').update(data).digest('hex');
const receipts = {};
for (const [id, fixture] of Object.entries(fixtures)) {
    const file = path.join(cache, fixture.cacheFile);
    let exists = true;
    try { await access(file); } catch (error) { if (error.code !== 'ENOENT') { throw error; } exists = false; }
    let bytes;
    if (exists) {
        assert.equal(await realpath(file), file);
        bytes = await readFile(file);
    } else {
        const response = await fetch(fixture.url, {signal: AbortSignal.timeout(120000)});
        assert.ok(response.ok, `${id}: HTTP ${response.status}`);
        bytes = Buffer.from(await response.arrayBuffer());
    }
    assert.equal(bytes.length, fixture.sizeBytes, `${id} fixture size`);
    assert.equal(sha(bytes), fixture.sha256, `${id} fixture SHA`);
    if (!exists) { await writeFile(file, bytes, {flag: 'wx'}); }
    receipts[id] = {sha256: sha(bytes), sizeBytes: bytes.length, path: file, url: fixture.url};
}
await writeFile(process.env.MIDCORE_FIXTURE_RECEIPT, JSON.stringify(receipts, null, 2) + '\n', {flag: 'wx'});
