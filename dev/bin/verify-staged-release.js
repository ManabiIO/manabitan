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

import {createHash} from 'node:crypto';
import {lstat, readFile, readdir, realpath} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';
import {parseJson} from '../json.js';

const zipNames = [
    'manabitan-chrome.zip',
    'manabitan-chrome-dev.zip',
    'manabitan-chrome-playwright.zip',
    'manabitan-edge.zip',
    'manabitan-firefox.zip',
    'manabitan-firefox-dev.zip',
    'manabitan-firefox-android.zip',
];
const reportName = 'release-packages.json';
const sha256Pattern = /^[a-f0-9]{64}$/;

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {Record<string, unknown>}
 * @throws {Error}
 */
function object(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) { throw new Error(`Invalid ${label}`); }
    return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @returns {string}
 * @throws {Error}
 */
function assetName(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) || value.includes('..')) { throw new Error('Unsafe asset name'); }
    return value;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

/**
 * @param {unknown} value
 * @param {number} actual
 * @param {string} name
 * @throws {Error}
 */
function verifySize(value, actual, name) {
    if (typeof value !== 'undefined' && (!Number.isSafeInteger(value) || value !== actual)) { throw new Error(`Asset size mismatch: ${name}`); }
}

/**
 * @param {Uint8Array} bytes
 * @param {Map<string, string>} expected
 * @throws {Error}
 */
function verifyProvenanceSubjects(bytes, expected) {
    const lines = Buffer.from(bytes).toString('utf8').trim()
        .split('\n');
    if (lines.length !== 1) { throw new Error('Expected one signed provenance envelope'); }
    const envelope = object(parseJson(lines[0]), 'provenance envelope');
    if (envelope.payloadType !== 'application/vnd.in-toto+json' || typeof envelope.payload !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.payload) ||
    !Array.isArray(envelope.signatures) || envelope.signatures.length === 0) { throw new Error('Invalid signed provenance envelope'); }
    const statement = object(parseJson(Buffer.from(envelope.payload, 'base64').toString('utf8')), 'provenance statement');
    const {_type: statementType} = statement;
    if (!['https://in-toto.io/Statement/v0.1', 'https://in-toto.io/Statement/v1'].includes(/** @type {string} */ (statementType)) ||
    !['https://slsa.dev/provenance/v0.2', 'https://slsa.dev/provenance/v1'].includes(/** @type {string} */ (statement.predicateType)) ||
    !Array.isArray(statement.subject) || statement.subject.length !== expected.size) { throw new Error('Invalid provenance subject set'); }
    const seen = new Set();
    for (const value of /** @type {unknown[]} */ (statement.subject)) {
        const subject = object(value, 'provenance subject');
        const name = assetName(subject.name);
        const digest = object(subject.digest, 'provenance digest');
        if (seen.has(name) || !expected.has(name) || digest.sha256 !== expected.get(name)) { throw new Error(`Provenance subject mismatch: ${name}`); }
        seen.add(name);
    }
}

const [version, sourceCommit, metadataPath, assetsDirectory, resolvedTagCommit, ...extra] = process.argv.slice(2);
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '') ||
version === '0.0.0.0' || version.split('.').some((part) => Number(part) > 65535) ||
!/^[a-f0-9]{40}$/.test(sourceCommit ?? '') || !metadataPath || !assetsDirectory || extra.length > 0) {
    throw new Error('Usage: verify-staged-release.js VERSION SOURCE_SHA RELEASE_JSON ASSETS_DIRECTORY RESOLVED_TAG_COMMIT');
}
// Resolve the tag independently through the GitHub commits API; target_commitish
// alone does not establish where an already-existing tag points.
if (resolvedTagCommit !== sourceCommit) { throw new Error('Release tag source mismatch'); }
const release = object(parseJson(await readFile(metadataPath, 'utf8')), 'release metadata');
if (typeof release.id !== 'number' || !Number.isSafeInteger(release.id) || release.id <= 0) { throw new Error('Invalid release identity'); }
if (release.draft !== true || release.prerelease !== true || release.tag_name !== version) { throw new Error('Expected the intended draft prerelease'); }
if (typeof release.target_commitish !== 'string' || release.target_commitish.length === 0 ||
(/^[a-f0-9]{40}$/i.test(release.target_commitish) && release.target_commitish !== sourceCommit)) { throw new Error('Release target source mismatch'); }
if (!Array.isArray(release.assets)) { throw new Error('Missing release assets'); }
const assets = /** @type {Record<string, unknown>[]} */ (release.assets.map((value) => object(value, 'release asset')));
const names = assets.map((asset) => assetName(asset.name));
const provenanceNames = names.filter((name) => name.endsWith('.intoto.jsonl'));
const expectedNames = new Set([...zipNames, reportName, ...provenanceNames]);
if (provenanceNames.length !== 1 || names.length !== expectedNames.size || names.length !== zipNames.length + 2 ||
names.some((name) => !expectedNames.has(name)) || zipNames.some((name) => !names.includes(name)) || !names.includes(reportName)) { throw new Error('Release asset set mismatch'); }
const directory = await realpath(assetsDirectory);
const localNames = await readdir(directory);
if (localNames.length !== names.length || localNames.some((name) => !expectedNames.has(name))) { throw new Error('Downloaded asset set mismatch'); }
/** @type {Map<string, Uint8Array>} */
const contents = new Map();
for (const asset of assets) {
    const name = assetName(asset.name);
    const path = join(directory, name);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || dirname(await realpath(path)) !== directory) { throw new Error(`Unsafe asset file: ${name}`); }
    if (typeof asset.state !== 'undefined' && asset.state !== 'uploaded') { throw new Error(`Asset upload incomplete: ${name}`); }
    const bytes = await readFile(path);
    verifySize(asset.size, bytes.length, name);
    if (typeof asset.digest !== 'undefined' && asset.digest !== null && asset.digest !== `sha256:${hash(bytes)}`) { throw new Error(`Remote asset digest mismatch: ${name}`); }
    contents.set(name, bytes);
}
const reportBytes = contents.get(reportName);
if (typeof reportBytes === 'undefined') { throw new Error('Missing package audit'); }
const report = object(parseJson(Buffer.from(reportBytes).toString('utf8')), 'package audit');
if (report.version !== version || report.sourceCommit !== sourceCommit || report.unsigned !== true) { throw new Error('Package audit source/version mismatch'); }
if (!Array.isArray(report.packages) || report.packages.length !== zipNames.length) { throw new Error('Package audit set mismatch'); }
const subjects = new Map([[reportName, hash(reportBytes)]]);
for (const value of /** @type {unknown[]} */ (report.packages)) {
    const entry = object(value, 'package audit entry');
    if (typeof entry.path !== 'string') { throw new Error('Missing package audit path'); }
    const name = basename(entry.path);
    if ((entry.path !== name && entry.path !== `builds/${name}`) || !zipNames.includes(name) || subjects.has(name)) { throw new Error('Unsafe or duplicate package audit path'); }
    const bytes = contents.get(name);
    if (typeof bytes === 'undefined' || entry.version !== version || typeof entry.sha256 !== 'string' || !sha256Pattern.test(entry.sha256) || entry.sha256 !== hash(bytes)) { throw new Error(`Package hash/version mismatch: ${name}`); }
    verifySize(entry.size, bytes.length, name);
    subjects.set(name, entry.sha256);
}
const provenanceBytes = contents.get(provenanceNames[0]);
if (typeof provenanceBytes === 'undefined') { throw new Error('Missing provenance'); }
verifyProvenanceSubjects(provenanceBytes, subjects);
process.stdout.write(JSON.stringify({version,
    sourceCommit,
    releaseId: release.id,
    tagCommit: resolvedTagCommit,
    verifiedAssetCount: names.length,
    cryptographicProvenanceVerified: false,
    limitation: 'This verifies provenance subjects and asset integrity, not signatures, certificate identity or transparency-log inclusion. Verify cryptographic provenance separately before trusting its signer.'}, null, 2) + '\n');
