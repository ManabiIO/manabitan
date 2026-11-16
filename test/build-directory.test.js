/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import fs from 'node:fs';
import {mkdtemp, mkdir, writeFile, readFile, access, symlink, lstat, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import JSZip from 'jszip';
import {afterEach, expect, test, vi} from 'vitest';
import {build, createDirectory, createZip} from '../dev/bin/build.js';
import {ManifestUtil} from '../dev/manifest-util.js';
import {getAllFiles} from '../dev/util.js';

afterEach(() => { vi.restoreAllMocks(); });

/** @returns {Promise<{directory: string, source: string, builds: string, output: string, run: () => Promise<void>}>} */
async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'manabitan-directory-build-'));
    const source = join(directory, 'ext');
    const builds = join(directory, 'builds');
    const output = join(builds, 'manabitan-firefox-android');
    for (const name of ['background.html', 'included.txt', 'sw.js', 'offscreen.html', 'js/background/offscreen.js', 'js/background/offscreen-main.js']) {
        const path = join(source, name);
        await mkdir(dirname(path), {recursive: true});
        await writeFile(path, `fixture:${name}`);
    }
    const run = () => build(builds, source, new ManifestUtil(), ['firefox-android'], join(source, 'manifest.json'), false, false, '26.11.16.0');
    return {directory, source, builds, output, run};
}

test('Firefox Android directory builds honor inherited Firefox file exclusions', async () => {
    const value = await fixture();
    await value.run();
    for (const name of ['sw.js', 'offscreen.html', 'js/background/offscreen.js', 'js/background/offscreen-main.js']) {
        await expect(access(join(value.output, name))).rejects.toMatchObject({code: 'ENOENT'});
    }
    expect(await readFile(join(value.output, 'background.html'), 'utf8')).toBe('fixture:background.html');
    const manifest = JSON.parse(await readFile(join(value.output, 'manifest.json'), 'utf8'));
    expect(manifest.version).toBe('26.11.16.0');
    expect(manifest.background.page).toBe('background.html');
    expect(manifest.background.service_worker).toBeUndefined();
});

test('rebuilding a directory target removes obsolete files from the previous output', async () => {
    const value = await fixture();
    await mkdir(value.output, {recursive: true});
    await writeFile(join(value.output, 'obsolete.js'), 'obsolete source');
    await value.run();
    await expect(access(join(value.output, 'obsolete.js'))).rejects.toMatchObject({code: 'ENOENT'});
    expect(await readFile(join(value.output, 'included.txt'), 'utf8')).toBe('fixture:included.txt');
});

test('directory builds materialize linked libraries into portable regular files', async () => {
    const value = await fixture();
    const cache = join(value.directory, 'library-cache');
    await mkdir(cache);
    const wasm = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
    await writeFile(join(cache, 'native.wasm'), wasm);
    await symlink(cache, join(value.source, 'lib'), process.platform === 'win32' ? 'junction' : 'dir');
    await value.run();
    expect((await lstat(join(value.output, 'lib'))).isSymbolicLink()).toBe(false);
    expect((await lstat(join(value.output, 'lib/native.wasm'))).isFile()).toBe(true);
    expect(await readFile(join(value.output, 'lib/native.wasm'))).toEqual(Buffer.from(wasm));
    expect(fs.realpathSync(join(value.source, 'lib'))).toBe(fs.realpathSync(cache));
});

test('directory and ZIP targets contain the same selected files and bytes', async () => {
    const value = await fixture();
    await mkdir(value.builds);
    const excluded = new ManifestUtil().getVariantFileExclusions('firefox-android');
    const archive = join(value.builds, 'comparison.zip');
    await createDirectory(value.source, excluded, value.output, false);
    await createZip(value.source, excluded, archive, [], null, false);
    const zip = await JSZip.loadAsync(await readFile(archive), {checkCRC32: true});
    const names = Object.values(zip.files).filter((file) => !file.dir).map((file) => file.name)
        .sort();
    expect(getAllFiles(value.output).map((name) => name.replace(/\\/g, '/')).sort()).toEqual(names);
    for (const name of names) {
        expect(await readFile(join(value.output, name))).toEqual(await zip.files[name].async('nodebuffer'));
    }
});

test('failed directory copying leaves the previous build intact', async () => {
    const value = await fixture();
    await mkdir(value.output, {recursive: true});
    await writeFile(join(value.output, 'previous.txt'), 'last good output');
    vi.spyOn(fs, 'copyFileSync').mockImplementationOnce(() => { throw new Error('copy failed'); });
    await expect(value.run()).rejects.toThrow('copy failed');
    expect(await readFile(join(value.output, 'previous.txt'), 'utf8')).toBe('last good output');
    expect(await readdir(value.builds)).toEqual(['manabitan-firefox-android']);
});

test('failed directory publication restores the previous output and allows a retry', async () => {
    const value = await fixture();
    await mkdir(value.output, {recursive: true});
    await writeFile(join(value.output, 'previous.txt'), 'last good output');
    const rename = fs.renameSync;
    const failure = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (String(from).includes(join('new', 'manabitan-firefox-android')) && to === value.output) { throw new Error('publish failed'); }
        return rename(from, to);
    });
    await expect(value.run()).rejects.toThrow('publish failed');
    expect(await readFile(join(value.output, 'previous.txt'), 'utf8')).toBe('last good output');
    expect(await readdir(value.builds)).toEqual(['manabitan-firefox-android']);
    failure.mockRestore();
    await value.run();
    await expect(access(join(value.output, 'previous.txt'))).rejects.toMatchObject({code: 'ENOENT'});
    expect(await readFile(join(value.output, 'included.txt'), 'utf8')).toBe('fixture:included.txt');
});

test('a failed rollback retains the last good output in the reported backup directory', async () => {
    const value = await fixture();
    await mkdir(value.output, {recursive: true});
    await writeFile(join(value.output, 'previous.txt'), 'last good output');
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (to === value.output) { throw new Error('destination unavailable'); }
        return rename(from, to);
    });
    await expect(value.run()).rejects.toThrow('previous output retained at');
    const retained = await readdir(value.builds);
    expect(retained).toHaveLength(1);
    expect(await readFile(join(value.builds, retained[0], 'previous/previous.txt'), 'utf8')).toBe('last good output');
});

test('directory dry runs preserve previous output without staging new files', async () => {
    const value = await fixture();
    await mkdir(value.output, {recursive: true});
    await writeFile(join(value.output, 'previous.txt'), 'last good output');
    await createDirectory(value.source, [], value.output, true);
    expect(await readdir(value.builds)).toEqual(['manabitan-firefox-android']);
    expect(await readFile(join(value.output, 'previous.txt'), 'utf8')).toBe('last good output');
});

test('a linked output directory is rejected without modifying its external target', async () => {
    const value = await fixture();
    const external = join(value.directory, 'external');
    await mkdir(external);
    await writeFile(join(external, 'previous.txt'), 'external data');
    await mkdir(value.builds);
    await symlink(external, value.output, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(value.run()).rejects.toThrow('Unexpected build output type');
    expect((await lstat(value.output)).isSymbolicLink()).toBe(true);
    expect(await readdir(external)).toEqual(['previous.txt']);
});
