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
import {link, mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {expect, test} from 'vitest';

const run = promisify(execFile);
const addonId = '{accbebce-862b-48a9-bb9a-1da9ad1f8702}';
const version = '26.11.6.0';
const hash = `sha256:${'a'.repeat(64)}`;
/**
 * @param {string} value
 * @returns {string}
 */
function url(value) { return `https://github.com/ManabiIO/manabitan/releases/download/${value}/manabitan-firefox-dev.xpi`; }
/**
 * @param {string} value
 * @returns {{version: string, update_link: string, update_hash: string}}
 */
function update(value) { return {version: value, update_link: url(value), update_hash: hash}; }

/**
 * @param {unknown} [feed]
 * @returns {Promise<{directory: string, path: string}>}
 */
async function fixture(feed) {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'manabitan-firefox-feed-')));
    const path = join(directory, 'updates.json');
    if (typeof feed !== 'undefined') { await writeFile(path, JSON.stringify(feed)); }
    return {directory, path};
}

/**
 * @param {string} path
 * @param {string} [value]
 * @param {string} [download]
 * @param {string} [digest]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function publish(path, value = version, download = url(value), digest = hash) {
    return run(process.execPath, ['dev/bin/update-firefox-development-feed.js', path, value, download, digest], {encoding: 'utf8'});
}

test('creates the first feed with the exact signed asset identity', async () => {
    const value = await fixture();
    const {stdout} = await publish(value.path);
    expect(JSON.parse(stdout)).toEqual({version, changed: true});
    expect(JSON.parse(await readFile(value.path, 'utf8'))).toEqual({addons: {[addonId]: {updates: [update(version)]}}});
    expect(await readdir(value.directory)).toEqual(['updates.json']);
});

test('preserves unrelated addons, feed properties, and own addon properties when upgrading', async () => {
    const feed = {custom: {keep: true}, addons: {other: {updates: [{arbitrary: true}]}, [addonId]: {custom: 'keep', updates: [update('26.11.5.9')]}}};
    const value = await fixture(feed);
    await publish(value.path);
    feed.addons[addonId].updates = [update(version)];
    expect(JSON.parse(await readFile(value.path, 'utf8'))).toEqual(feed);
});

test('matching version is byte-for-byte idempotent and does not replace the file', async () => {
    const value = await fixture({addons: {[addonId]: {updates: [update(version)]}}});
    const before = await readFile(value.path);
    const initial = await stat(value.path);
    expect(JSON.parse((await publish(value.path)).stdout)).toEqual({version, changed: false});
    expect(await readFile(value.path)).toEqual(before);
    expect((await stat(value.path)).ino).toBe(initial.ino);
});

test.each([
    ['26.9.30.99', '26.10.1.0'],
    ['26.11.6.9', '26.11.6.10'],
    ['9.65535.65535.65535', '10.0.0.0'],
])('compares version components numerically: %s before %s', async (older, newer) => {
    const value = await fixture({addons: {[addonId]: {updates: [update(older)]}}});
    await publish(value.path, newer);
    const before = await readFile(value.path);
    await expect(publish(value.path, older)).rejects.toThrow(/downgrade/u);
    expect(await readFile(value.path)).toEqual(before);
});

test('rejects a downgrade even when an earlier feed item matches the proposed version', async () => {
    const value = await fixture({addons: {[addonId]: {updates: [update(version), update('26.11.6.1')]}}});
    const before = await readFile(value.path);
    await expect(publish(value.path)).rejects.toThrow(/downgrade/u);
    expect(await readFile(value.path)).toEqual(before);
});

test('rejects a different hash for an already published version without changing bytes', async () => {
    const value = await fixture({addons: {[addonId]: {updates: [update(version)]}}});
    const before = await readFile(value.path);
    await expect(publish(value.path, version, url(version), `sha256:${'b'.repeat(64)}`)).rejects.toThrow(/different asset identity/u);
    expect(await readFile(value.path)).toEqual(before);
});

test.each(['0.0.0.0', '26.01.6.0', '26.11.6', '26.11.6.-1', '65536.0.0.0', '99999999999999999999.0.0.0', '26.11.6.0\n'])('rejects invalid new version %j before creating a file', async (invalid) => {
    const value = await fixture();
    await expect(publish(value.path, invalid)).rejects.toThrow(/Invalid browser version/u);
    expect(await readdir(value.directory)).toEqual([]);
});

test.each([
    'http://github.com/ManabiIO/manabitan/releases/download/26.11.6.0/manabitan-firefox-dev.xpi',
    'https://github.com.evil.example/ManabiIO/manabitan/releases/download/26.11.6.0/manabitan-firefox-dev.xpi',
    'https://github.com/other/manabitan/releases/download/26.11.6.0/manabitan-firefox-dev.xpi',
    'https://github.com/ManabiIO/manabitan/releases/download/26.11.6.1/manabitan-firefox-dev.xpi',
    `${url(version)}?download=1`,
    `${url(version)}#fragment`,
    url(version).replace('firefox-dev.xpi', 'firefox.xpi'),
])('rejects unsafe or mismatched URL %s without touching the feed', async (download) => {
    const value = await fixture({addons: {}});
    const before = await readFile(value.path);
    await expect(publish(value.path, version, download)).rejects.toThrow(/Unsafe Firefox download URL/u);
    expect(await readFile(value.path)).toEqual(before);
});

test.each(['a'.repeat(64), `sha256:${'A'.repeat(64)}`, 'sha256:123', `sha512:${'a'.repeat(64)}`, `${hash}\n`])('rejects invalid hash %j without touching the feed', async (digest) => {
    const value = await fixture({addons: {}});
    const before = await readFile(value.path);
    await expect(publish(value.path, version, url(version), digest)).rejects.toThrow(/Invalid Firefox update hash/u);
    expect(await readFile(value.path)).toEqual(before);
});

test.each([null,
    [],
    {},
    {addons: []},
    {addons: {[addonId]: null}},
    {addons: {[addonId]: {updates: {}}}},
    {addons: {[addonId]: {updates: [null]}}},
    {addons: {[addonId]: {updates: [update('26.01.6.0')]}}},
    {addons: {[addonId]: {updates: [{...update(version), update_link: 'https://example.com/unsigned.xpi'}]}}},
    {addons: {[addonId]: {updates: [{...update(version), update_hash: 'bad'}]}}}])('rejects malformed existing feed %# without touching bytes', async (feed) => {
    const value = await fixture(feed);
    const before = await readFile(value.path);
    await expect(publish(value.path)).rejects.toThrow();
    expect(await readFile(value.path)).toEqual(before);
    expect(await readdir(value.directory)).toEqual(['updates.json']);
});

test('rejects invalid JSON without touching existing bytes', async () => {
    const value = await fixture();
    await writeFile(value.path, '{bad json');
    await expect(publish(value.path)).rejects.toThrow();
    expect(await readFile(value.path, 'utf8')).toBe('{bad json');
});

test('rejects symlink and hardlink targets without modifying the original', async () => {
    const value = await fixture();
    const target = join(value.directory, 'original.json');
    await writeFile(target, '{"addons":{}}');
    await symlink(target, value.path);
    await expect(publish(value.path)).rejects.toThrow(/Unsafe Firefox update feed file/u);
    const linked = join(value.directory, 'hardlinked');
    await mkdir(linked);
    await link(target, join(linked, 'updates.json'));
    await expect(publish(join(linked, 'updates.json'))).rejects.toThrow(/Unsafe Firefox update feed file/u);
    expect(await readFile(target, 'utf8')).toBe('{"addons":{}}');
});

test('rejects symlink parents, directory targets, and unrelated output filenames', async () => {
    const value = await fixture();
    const linked = `${value.directory}-link`;
    await symlink(value.directory, linked);
    await expect(publish(join(linked, 'updates.json'))).rejects.toThrow(/Unsafe Firefox update feed path/u);
    await mkdir(value.path);
    await expect(publish(value.path)).rejects.toThrow(/Unsafe Firefox update feed file/u);
    const unrelated = join(value.directory, 'unrelated.json');
    await writeFile(unrelated, 'preserve');
    await expect(publish(unrelated)).rejects.toThrow(/Unsafe Firefox update feed path/u);
    expect(await readFile(unrelated, 'utf8')).toBe('preserve');
});
