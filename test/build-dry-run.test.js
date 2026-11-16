/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {mkdtemp, mkdir, readFile, writeFile, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import JSZip from 'jszip';
import {expect, test} from 'vitest';
import {createZip} from '../dev/bin/build.js';

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
