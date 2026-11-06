/*
 * Copyright (C) 2026  Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import JSZip from 'jszip';
import {parseJson} from '../json.js';

const [version, ...paths] = process.argv.slice(2);
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '') ||
version.split('.').some((part) => Number(part) > 65535) || version === '0.0.0.0' || paths.length === 0) {
    throw new Error('Expected a valid nonzero four-part browser version and package ZIP paths');
}
const hash = (/** @type {Uint8Array|string} */ bytes) => createHash('sha256').update(bytes).digest('hex');
const packages = [];
for (const path of paths) {
    const bytes = await readFile(path);
    const zip = await JSZip.loadAsync(bytes, {checkCRC32: true});
    const manifest = /** @type {unknown} */ (parseJson(await zip.file('manifest.json')?.async('string') ?? 'null'));
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest) || !('version' in manifest) || manifest.version !== version) { throw new Error(`Package version mismatch: ${path}`); }
    const files = Object.values(zip.files).filter((file) => !file.dir).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const tree = createHash('sha256');
    /** @type {Record<string, string>} */
    const nativeAssets = {};
    for (const file of files) {
        const content = await file.async('uint8array');
        const digest = hash(content);
        tree.update(`${file.name}\0${digest}\n`);
        if (file.name === 'lib/term-bank-parser.wasm' || file.name === 'lib/zstd.wasm') {
            if (!WebAssembly.validate(content)) { throw new Error(`Invalid native asset: ${path}:${file.name}`); }
            nativeAssets[file.name] = digest;
        }
    }
    if (Object.keys(nativeAssets).length !== 2) { throw new Error(`Package is missing a required native asset: ${path}`); }
    packages.push({path, version, manifestVersion: 'manifest_version' in manifest ? manifest.manifest_version : null, sha256: hash(bytes), treeSha256: tree.digest('hex'), fileCount: files.length, nativeAssets});
}
process.stdout.write(JSON.stringify({version, sourceCommit: process.env.GITHUB_SHA ?? null, unsigned: true, packages}, null, 2) + '\n');
