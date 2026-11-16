/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {mkdtemp, mkdir, readFile, writeFile, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute, join, relative} from 'node:path';
import JSZip from 'jszip';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import {afterEach, expect, test, vi} from 'vitest';
import {createZip} from '../dev/bin/build.js';

afterEach(() => { vi.restoreAllMocks(); });

/** @returns {Promise<{source: string, output: string}>} */
async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'manabitan-build-dry-run-'));
    const source = join(directory, 'ext');
    await mkdir(source);
    await writeFile(join(source, 'manifest.json'), JSON.stringify({manifest_version: 3, version: '26.11.16.0'}));
    await writeFile(join(source, 'included.txt'), 'current source');
    await writeFile(join(source, 'excluded.txt'), 'not part of this target');
    return {source, output: join(directory, 'candidate.zip')};
}

test('in-memory ZIP validation preserves an existing package byte for byte', async () => {
    const {source, output} = await fixture();
    const oldPackage = await new JSZip().file('previous.txt', 'retained release artifact').generateAsync({type: 'nodebuffer'});
    await writeFile(output, oldPackage);
    await createZip(source, ['excluded.txt'], output, [], null, true);
    expect(await readFile(output)).toEqual(oldPackage);
});

test('in-memory ZIP validation leaves an absent output absent', async () => {
    const {source, output} = await fixture();
    await createZip(source, ['excluded.txt'], output, [], null, true);
    await expect(access(output)).rejects.toMatchObject({code: 'ENOENT'});
});

test('an ordinary ZIP build still replaces the previous package and applies exclusions', async () => {
    const {source, output} = await fixture();
    await writeFile(output, 'previous output');
    await createZip(source, ['excluded.txt'], output, [], null, false);
    const zip = await JSZip.loadAsync(await readFile(output), {checkCRC32: true});
    expect(await zip.file('included.txt')?.async('string')).toBe('current source');
    expect(zip.file('excluded.txt')).toBeNull();
    expect(zip.file('previous.txt')).toBeNull();
});

test('a source read failure preserves the last good ZIP', async () => {
    const {source, output} = await fixture();
    await writeFile(output, 'last good package');
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => { throw new Error('source unavailable'); });
    await expect(createZip(source, [], output, [], null, false)).rejects.toThrow('source unavailable');
    expect(await readFile(output, 'utf8')).toBe('last good package');
});

test('a ZIP publication failure preserves the last good ZIP', async () => {
    const {source, output} = await fixture();
    await writeFile(output, 'last good package');
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('publication unavailable'); });
    await expect(createZip(source, [], output, [], null, false)).rejects.toThrow('publication unavailable');
    expect(await readFile(output, 'utf8')).toBe('last good package');
});

test('native archiving receives an absolute staging path and preserves the old ZIP until completion', async () => {
    const {source, output} = await fixture();
    await writeFile(output, 'last good package');
    const bytes = await new JSZip().file('native.txt', 'native output').generateAsync({type: 'nodebuffer'});
    const archive = vi.spyOn(childProcess, 'execFileSync').mockImplementation((_command, args) => {
        if (!Array.isArray(args)) { throw new Error('Missing archive arguments'); }
        const staged = args[1];
        expect(isAbsolute(staged)).toBe(true);
        expect(staged).not.toBe(output);
        expect(fs.readFileSync(output, 'utf8')).toBe('last good package');
        fs.writeFileSync(staged, bytes);
        return Buffer.alloc(0);
    });
    await createZip(source, [], relative(process.cwd(), output), ['fixture-archiver'], null, false);
    expect(archive).toHaveBeenCalledOnce();
    expect(await readFile(output)).toEqual(bytes);
});

test('failed native archiving and fallback leave the previous ZIP untouched', async () => {
    const {source, output} = await fixture();
    await writeFile(output, 'last good package');
    vi.spyOn(childProcess, 'execFileSync').mockImplementation((_command, args) => {
        if (!Array.isArray(args)) { throw new Error('Missing archive arguments'); }
        fs.writeFileSync(args[1], 'incomplete archive');
        throw new Error('native archiving failed');
    });
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => { throw new Error('fallback source unavailable'); });
    await expect(createZip(source, [], output, ['fixture-archiver'], null, false)).rejects.toThrow('fallback source unavailable');
    expect(await readFile(output, 'utf8')).toBe('last good package');
});

test('a later native archiver never updates a partial archive left by a failed attempt', async () => {
    const {source, output} = await fixture();
    await writeFile(output, 'last good package');
    const partial = await new JSZip().file('obsolete.txt', 'left by failed archiver').generateAsync({type: 'nodebuffer'});
    const current = await new JSZip().file('native.txt', 'current native output').generateAsync({type: 'nodebuffer'});
    const contaminated = await new JSZip().file('obsolete.txt', 'left by failed archiver').file('native.txt', 'current native output')
        .generateAsync({type: 'nodebuffer'});
    /** @type {string[]} */
    const paths = [];
    const archive = vi.spyOn(childProcess, 'execFileSync').mockImplementation((command, args) => {
        if (!Array.isArray(args)) { throw new Error('Missing archive arguments'); }
        const staged = args[1];
        paths.push(staged);
        expect(fs.readFileSync(output, 'utf8')).toBe('last good package');
        if (command === 'first-archiver') {
            fs.writeFileSync(staged, partial);
            throw new Error('native archive failed after creating partial output');
        }
        // 7-Zip's `a` command updates an existing archive and retains entries
        // absent from the next input set. Model that behavior after a failure.
        fs.writeFileSync(staged, fs.existsSync(staged) ? contaminated : current);
        return Buffer.alloc(0);
    });
    await createZip(source, [], output, ['first-archiver', 'second-archiver'], null, false);
    expect(archive).toHaveBeenCalledTimes(2);
    const zip = await JSZip.loadAsync(await readFile(output), {checkCRC32: true});
    expect(zip.file('obsolete.txt')).toBeNull();
    expect(await zip.file('native.txt')?.async('string')).toBe('current native output');
    expect(new Set(paths).size).toBe(2);
});

test('JSZip fallback replaces all partial native attempts with the selected source files', async () => {
    const {source, output} = await fixture();
    await writeFile(output, 'last good package');
    vi.spyOn(childProcess, 'execFileSync').mockImplementation((_command, args) => {
        if (!Array.isArray(args)) { throw new Error('Missing archive arguments'); }
        fs.writeFileSync(args[1], 'partial native archive');
        throw new Error('native attempt failed');
    });
    await createZip(source, ['excluded.txt'], output, ['first-archiver', 'second-archiver'], null, false);
    const zip = await JSZip.loadAsync(await readFile(output), {checkCRC32: true});
    expect(await zip.file('included.txt')?.async('string')).toBe('current source');
    expect(zip.file('excluded.txt')).toBeNull();
    expect(Object.keys(zip.files).sort()).toEqual(['included.txt', 'manifest.json']);
});
