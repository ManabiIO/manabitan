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

import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {expect, test} from 'vitest';

const run = promisify(execFile);
const version = '26.11.6.0';
const sourceCommit = 'a'.repeat(40);
const reportName = 'release-packages.json';
const provenanceName = 'multiple.intoto.jsonl';

/**
 * @param {string|Uint8Array} bytes
 * @returns {string}
 */
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'manabitan-staged-release-'));
    const assetsDirectory = join(directory, 'assets');
    const metadataPath = join(directory, 'release.json');
    await mkdir(assetsDirectory);
    // Deliberately not ZIPs: the verifier must hash, never execute or extract.
    /** @type {Map<string, Buffer>} */
    const files = new Map();
    for (const target of ['chrome', 'chrome-dev', 'chrome-playwright', 'edge', 'firefox', 'firefox-dev', 'firefox-android']) {
        files.set(`manabitan-${target}.zip`, Buffer.from(`fixture:${target}`));
    }
    const report = {version, sourceCommit, unsigned: true, packages: [...files].map(([name, bytes]) => ({path: `builds/${name}`, version, sha256: hash(bytes), size: bytes.length}))};
    files.set(reportName, Buffer.from(JSON.stringify(report)));
    const statement = {_type: 'https://in-toto.io/Statement/v0.1',
        predicateType: 'https://slsa.dev/provenance/v0.2',
        subject: [...files].map(([name, bytes]) => ({name, digest: {sha256: hash(bytes)}}))};
    const envelope = {payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(statement)).toString('base64'), signatures: [{keyid: '', sig: 'fixture-not-a-real-signature'}]};
    files.set(provenanceName, Buffer.from(JSON.stringify(envelope) + '\n'));
    const release = {id: 123,
        draft: true,
        prerelease: true,
        tag_name: version,
        target_commitish: sourceCommit,
        assets: [...files].map(([name, bytes]) => ({name, size: bytes.length, state: 'uploaded', digest: `sha256:${hash(bytes)}`}))};
    for (const [name, bytes] of files) { await writeFile(join(assetsDirectory, name), bytes); }
    await writeFile(metadataPath, JSON.stringify(release));
    return {directory, assetsDirectory, metadataPath, files, report, statement, envelope, release};
}

/**
 * @param {Awaited<ReturnType<typeof fixture>>} value
 * @param {string} [tagCommit]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function verify(value, tagCommit = sourceCommit) {
    return run(process.execPath, ['dev/bin/verify-staged-release.js', version, sourceCommit, value.metadataPath, value.assetsDirectory, tagCommit], {encoding: 'utf8'});
}

test('verifies the exact staged asset set and explicitly limits signature claims', async () => {
    const value = await fixture();
    const {stdout} = await verify(value);
    expect(JSON.parse(stdout)).toMatchObject({version, sourceCommit, releaseId: 123, tagCommit: sourceCommit, verifiedAssetCount: 9, cryptographicProvenanceVerified: false});
});

test('accepts a branch target only with an independently resolved matching tag commit', async () => {
    const value = await fixture();
    value.release.target_commitish = 'main';
    await writeFile(value.metadataPath, JSON.stringify(value.release));
    await expect(verify(value)).resolves.toBeDefined();
    await expect(verify(value, 'b'.repeat(40))).rejects.toThrow(/tag source mismatch/u);
});

test.each(['missing', 'duplicate', 'extra', 'traversal'])('rejects %s remote assets', async (mode) => {
    const value = await fixture();
    switch (mode) {
        case 'missing': value.release.assets.pop(); break;
        case 'duplicate': value.release.assets.push(value.release.assets[0]); break;
        case 'extra': value.release.assets.push({...value.release.assets[0], name: 'unexpected.zip'}); break;
        case 'traversal': value.release.assets[0].name = '../manabitan-chrome.zip'; break;
    }
    await writeFile(value.metadataPath, JSON.stringify(value.release));
    await expect(verify(value)).rejects.toThrow(/asset set mismatch|Unsafe asset name/u);
});

test.each(['id', 'draft', 'prerelease', 'tag', 'target', 'size', 'state', 'digest'])('rejects invalid release %s', async (field) => {
    const value = await fixture();
    switch (field) {
        case 'id': value.release.id = -1; break;
        case 'draft': value.release.draft = false; break;
        case 'prerelease': value.release.prerelease = false; break;
        case 'tag': value.release.tag_name = '26.11.6.1'; break;
        case 'target': value.release.target_commitish = 'b'.repeat(40); break;
        case 'size': value.release.assets[0].size += 1; break;
        case 'state': value.release.assets[0].state = 'starter'; break;
        case 'digest': value.release.assets[0].digest = `sha256:${'0'.repeat(64)}`; break;
    }
    await writeFile(value.metadataPath, JSON.stringify(value.release));
    await expect(verify(value)).rejects.toThrow(/release identity|draft prerelease|source mismatch|size mismatch|upload incomplete|digest mismatch/u);
});

test.each(['source', 'version', 'hash', 'duplicate', 'traversal'])('rejects invalid package report %s', async (field) => {
    const value = await fixture();
    switch (field) {
        case 'source': value.report.sourceCommit = 'b'.repeat(40); break;
        case 'version': value.report.version = '26.11.6.1'; break;
        case 'hash': value.report.packages[0].sha256 = '0'.repeat(64); break;
        case 'duplicate': value.report.packages[1] = value.report.packages[0]; break;
        case 'traversal': value.report.packages[0].path = '../manabitan-chrome.zip'; break;
    }
    const bytes = Buffer.from(JSON.stringify(value.report));
    await writeFile(join(value.assetsDirectory, reportName), bytes);
    const asset = value.release.assets.find((entry) => entry.name === reportName);
    if (typeof asset === 'undefined') { throw new Error('Missing test report'); }
    asset.size = bytes.length;
    asset.digest = `sha256:${hash(bytes)}`;
    await writeFile(value.metadataPath, JSON.stringify(value.release));
    await expect(verify(value)).rejects.toThrow(/source\/version mismatch|hash\/version mismatch|duplicate package audit path/u);
});

test.each(['digest', 'missing', 'duplicate', 'traversal', 'unsigned'])('rejects invalid provenance %s', async (field) => {
    const value = await fixture();
    switch (field) {
        case 'digest': value.statement.subject[0].digest.sha256 = '0'.repeat(64); break;
        case 'missing': value.statement.subject.pop(); break;
        case 'duplicate': value.statement.subject[1] = value.statement.subject[0]; break;
        case 'traversal': value.statement.subject[0].name = '../manabitan-chrome.zip'; break;
        case 'unsigned': value.envelope.signatures = []; break;
    }
    value.envelope.payload = Buffer.from(JSON.stringify(value.statement)).toString('base64');
    const bytes = Buffer.from(JSON.stringify(value.envelope));
    await writeFile(join(value.assetsDirectory, provenanceName), bytes);
    const asset = value.release.assets.find((entry) => entry.name === provenanceName);
    if (typeof asset === 'undefined') { throw new Error('Missing test provenance'); }
    asset.size = bytes.length;
    asset.digest = `sha256:${hash(bytes)}`;
    await writeFile(value.metadataPath, JSON.stringify(value.release));
    await expect(verify(value)).rejects.toThrow(/provenance|Provenance|Unsafe asset name/u);
});

test('rejects symlink assets without reading their targets', async () => {
    const value = await fixture();
    const linkedDirectory = join(value.directory, 'linked-assets');
    await mkdir(linkedDirectory);
    for (const name of value.files.keys()) { await symlink(join(value.assetsDirectory, name), join(linkedDirectory, name)); }
    value.assetsDirectory = linkedDirectory;
    await expect(verify(value)).rejects.toThrow(/Unsafe asset file/u);
});

test('rejects an extra local file omitted from remote metadata', async () => {
    const value = await fixture();
    await writeFile(join(value.assetsDirectory, 'unexpected.zip'), 'unexpected');
    await expect(verify(value)).rejects.toThrow(/Downloaded asset set mismatch/u);
});
