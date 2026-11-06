/*
 * Copyright (C) 2024-2026  Yomitan Authors
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

import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, realpath, rename} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {parseJson} from '../json.js';

const addonId = '{accbebce-862b-48a9-bb9a-1da9ad1f8702}';

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 * @throws {Error}
 */
function object(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) { throw new Error('Malformed Firefox update feed'); }
    return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @returns {number[]}
 * @throws {Error}
 */
function versionParts(value) {
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) || value === '0.0.0.0') { throw new Error('Invalid browser version'); }
    const parts = value.split('.').map(Number);
    if (parts.some((part) => part > 65535)) { throw new Error('Invalid browser version'); }
    return parts;
}

/**
 * @param {string} version
 * @param {unknown} url
 * @param {unknown} hash
 * @throws {Error}
 */
function validateAsset(version, url, hash) {
    if (url !== `https://github.com/ManabiIO/manabitan/releases/download/${version}/manabitan-firefox-dev.xpi`) { throw new Error('Unsafe Firefox download URL'); }
    if (typeof hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(hash)) { throw new Error('Invalid Firefox update hash'); }
}

/**
 * @param {string} path
 * @returns {Promise<import('node:fs').Stats|null>}
 * @throws {Error}
 */
async function fileState(path) {
    try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) { throw new Error('Unsafe Firefox update feed file'); }
        return stat;
    } catch (error) {
        if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') { return null; }
        throw error;
    }
}

const [metadataPath, version, url, hash, ...extra] = process.argv.slice(2);
if (!metadataPath || extra.length > 0) { throw new Error('Usage: update-firefox-development-feed.js METADATA_PATH VERSION DOWNLOAD_URL SHA256_HASH'); }
const parts = versionParts(version);
validateAsset(version, url, hash);
const path = resolve(metadataPath);
const directory = dirname(path);
if (basename(path) !== 'updates.json' || await realpath(directory) !== directory) { throw new Error('Unsafe Firefox update feed path'); }
const initial = await fileState(path);
/** @type {Record<string, unknown>} */
let feed = {addons: {}};
if (initial !== null) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = await file.stat();
        if (stat.dev !== initial.dev || stat.ino !== initial.ino) { throw new Error('Firefox update feed changed during validation'); }
        feed = object(parseJson(await file.readFile('utf8')));
    } finally { await file.close(); }
}
const addons = object(feed.addons);
const own = Object.hasOwn(addons, addonId) ? object(addons[addonId]) : {updates: []};
if (!Array.isArray(own.updates)) { throw new Error('Malformed Firefox update list'); }
let equal = false;
for (const value of /** @type {unknown[]} */ (own.updates)) {
    const update = object(value);
    const previous = versionParts(update.version);
    validateAsset(/** @type {string} */ (update.version), update.update_link, update.update_hash);
    const index = parts.findIndex((part, i) => part !== previous[i]);
    if (index !== -1 && parts[index] < previous[index]) { throw new Error('Refusing Firefox update feed downgrade'); }
    if (index === -1) {
        if (update.update_link !== url || update.update_hash !== hash) { throw new Error('Existing Firefox version has different asset identity'); }
        equal = true;
    }
}
if (!equal) {
    addons[addonId] = {...own, updates: [{version, update_link: url, update_hash: hash}]};
    const temporary = join(directory, `.updates-${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', initial === null ? 0o644 : initial.mode & 0o777);
    try {
        await file.writeFile(JSON.stringify(feed, null, 4) + '\n');
        await file.sync();
    } finally { await file.close(); }
    const current = await fileState(path);
    if ((initial === null) !== (current === null) || (initial !== null && current !== null &&
    (initial.dev !== current.dev || initial.ino !== current.ino || initial.mtimeMs !== current.mtimeMs || initial.size !== current.size))) { throw new Error('Firefox update feed changed during validation'); }
    await rename(temporary, path);
}
process.stdout.write(JSON.stringify({version, changed: !equal}) + '\n');
