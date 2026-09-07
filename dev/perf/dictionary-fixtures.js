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
import path from 'node:path';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {parseJson} from '../../ext/js/core/json.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dirname, '..', '..');
const lockPath = path.join(root, 'test', 'perf', 'dictionaries.lock.json');

/**
 * @typedef {{label: string, cacheFile: string, release: string, url: string, sha256: string, sizeBytes: number, expectedTitle: string, revision: string, termRows: number}} DictionaryFixture
 */

/**
 * @returns {Promise<Record<string, DictionaryFixture>>}
 */
export async function loadDictionaryFixtures() {
    const raw = await readFile(lockPath, 'utf8');
    const parsed = /** @type {Record<string, unknown>} */ (parseJson(raw));
    if (parsed.schemaVersion !== 1 || !(parsed.dictionaries && typeof parsed.dictionaries === 'object')) {
        throw new Error(`Unsupported performance dictionary lock file: ${lockPath}`);
    }
    return /** @type {Record<string, DictionaryFixture>} */ (parsed.dictionaries);
}

/**
 * @param {Buffer} bytes
 * @returns {string}
 */
function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

/**
 * @param {DictionaryFixture} fixture
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function verifyFixtureFile(fixture, filePath) {
    try {
        const bytes = await readFile(filePath);
        return bytes.byteLength === fixture.sizeBytes && sha256(bytes) === fixture.sha256;
    } catch (_) {
        return false;
    }
}

/**
 * @param {DictionaryFixture} fixture
 * @param {string} filePath
 * @returns {Promise<void>}
 */
async function ensureFixtureFile(fixture, filePath) {
    if (await verifyFixtureFile(fixture, filePath)) {
        return;
    }
    await rm(filePath, {force: true});
    const response = await fetch(fixture.url);
    if (!response.ok) {
        throw new Error(`Failed to download pinned dictionary ${fixture.label}: ${String(response.status)} ${response.statusText}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength !== fixture.sizeBytes || sha256(bytes) !== fixture.sha256) {
        throw new Error(`Pinned dictionary integrity mismatch for ${fixture.label} (${fixture.url})`);
    }
    await writeFile(filePath, bytes);
}

/**
 * Ensures all locked real-dictionary performance fixtures are available and
 * integrity checked. Existing valid files require no network access.
 * @param {string} cacheDir
 * @returns {Promise<{jitendexPath: string, jmnedictPath: string, jmdictPath: string, fixtures: Record<string, DictionaryFixture>}>}
 */
export async function ensurePinnedDictionaryCache(cacheDir) {
    const fixtures = await loadDictionaryFixtures();
    for (const id of ['jitendex', 'jmnedict', 'jmdict']) {
        if (!(id in fixtures)) {
            throw new Error(`Performance dictionary lock is missing ${id}`);
        }
    }
    await mkdir(cacheDir, {recursive: true});
    /** @type {Record<string, string>} */
    const paths = {};
    for (const [id, fixture] of Object.entries(fixtures)) {
        const filePath = path.join(cacheDir, fixture.cacheFile);
        await ensureFixtureFile(fixture, filePath);
        paths[id] = filePath;
    }
    return {
        jitendexPath: paths.jitendex,
        jmnedictPath: paths.jmnedict,
        jmdictPath: paths.jmdict,
        fixtures,
    };
}
