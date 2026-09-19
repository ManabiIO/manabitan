/* SPDX-License-Identifier: GPL-3.0-or-later */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = path.join(root, 'builds/manabitan-web');
await fs.rm(output, {recursive: true, force: true});
await fs.mkdir(output, {recursive: true});
for (const name of ['js', 'lib', 'data', 'fonts']) await fs.cp(path.join(root, 'ext', name), path.join(output, name), {recursive: true});
// Term lookups do not use the separate 18 MB kanji stroke-order display face.
await fs.rm(path.join(output, 'data/fonts/kanji-stroke-orders.ttf'), {force: true});
await fs.mkdir(path.join(output, 'css'), {recursive: true});
await fs.copyFile(path.join(root, 'ext/css/structured-content.css'), path.join(output, 'css/structured-content.css'));
for (const required of ['lib/sqlite/sqlite3.wasm', 'lib/resvg.wasm']) await fs.access(path.join(output, required));
const entryPoints = (await fs.readdir(path.join(root, 'ext/web'))).filter((p) => p.endsWith('.ts')).map((p) => path.join(root, 'ext/web', p));
await build({entryPoints, outdir: path.join(output, 'web'), platform: 'browser', format: 'esm', target: 'es2022', bundle: false});
await fs.copyFile(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));
let revision = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
const assets = [];
async function walk(dir) {
    for (const e of await fs.readdir(dir, {withFileTypes: true})) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else { const data = await fs.readFile(p); assets.push({path: path.relative(output, p).split(path.sep).join('/'), bytes: data.byteLength, sha256: createHash('sha256').update(data).digest('hex')}); }
    }
}
await walk(output);
const {DEFAULT_DICTIONARY} = await import(pathToFileURL(path.join(output, 'web/presets.js')).href);
await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify({package: 'manabitan-web', apiVersion: 1, revision, defaultDictionary: DEFAULT_DICTIONARY,
    client: 'web/client.js', scanner: 'web/scanner.js', renderer: 'web/render.js', presets: 'web/presets.js', style: 'css/structured-content.css', assets}, null, 2));
console.log(`Built static ManabiTan web runtime: ${assets.length} assets, revision ${revision}`);
