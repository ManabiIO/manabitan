/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import fs from 'node:fs';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, expect, test, vi} from 'vitest';
import {build, getBuildPlan, main} from '../dev/bin/build.js';
import {buildLibs} from '../dev/build-libs.js';
import {ManifestUtil} from '../dev/manifest-util.js';

vi.mock('../dev/build-libs.js', () => ({buildLibs: vi.fn(async () => {})}));
afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

const packageTargets = ['chrome', 'chrome-dev', 'chrome-playwright', 'firefox', 'firefox-dev', 'firefox-android', 'edge'];

test.each([
    {name: 'no options', argv: []},
    {name: 'all targets', argv: ['--all']},
    {name: 'dry-run option alone', argv: ['--dryRun']},
    {name: 'ZIP dry-run options alone', argv: ['--dryRun', '--dryRunBuildZip']},
    {name: 'version option alone', argv: ['--version', '26.11.16.0']},
])('$name selects all packaged targets', ({argv}) => {
    expect(getBuildPlan(argv, new ManifestUtil()).variantNames).toEqual(packageTargets);
});

test.each([
    {argv: ['--manifest', 'firefox'], manifestName: 'firefox'},
    {argv: ['--manifest', 'base'], manifestName: 'base'},
    {argv: ['--default'], manifestName: null},
    {argv: ['--default', '--manifest', 'ignored'], manifestName: null},
])('manifest-only command $argv remains supported', ({argv, manifestName}) => {
    expect(getBuildPlan(argv, new ManifestUtil())).toMatchObject({variantNames: [], manifestName});
});

test('explicit targets retain their order and independent manifest restoration', () => {
    expect(getBuildPlan(['firefox', 'chrome', '--manifest', 'base'], new ManifestUtil())).toMatchObject({variantNames: ['firefox', 'chrome'], manifestName: 'base'});
    expect(getBuildPlan(['--target', 'chrome', '--manifest', 'firefox'], new ManifestUtil())).toMatchObject({variantNames: ['chrome'], manifestName: 'firefox'});
});

test.each([
    {name: 'unknown target', argv: ['--target', 'chrom']},
    {name: 'blank target', argv: ['--target', '']},
    {name: 'manifest-only base as a package target', argv: ['--target', 'base']},
    {name: 'variant without a package output', argv: ['--target', 'safari']},
    {name: 'unknown restore manifest', argv: ['--manifest', 'firfox']},
])('$name fails before library generation or manifest/output writes', async ({argv}) => {
    const writes = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    const directories = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => { throw new Error('Unexpected directory write'); });
    await expect(main(argv)).rejects.toThrow(/Unknown|not buildable|package output/u);
    expect(buildLibs).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(directories).not.toHaveBeenCalled();
});

test.each([
    {name: 'empty target list', targets: []},
    {name: 'unknown target', targets: ['chrom']},
    {name: 'valid target followed by a typo', targets: ['chrome', 'chrom']},
    {name: 'non-buildable target', targets: ['base']},
    {name: 'target without an output', targets: ['safari']},
])('$name cannot overwrite an existing package or manifest', async ({targets}) => {
    const directory = await mkdtemp(join(tmpdir(), 'manabitan-build-arguments-'));
    const source = join(directory, 'ext');
    const output = join(directory, 'builds');
    await mkdir(source);
    await mkdir(output);
    const manifest = join(source, 'manifest.json');
    const archive = join(output, 'manabitan-chrome.zip');
    await writeFile(manifest, 'previous manifest');
    await writeFile(join(source, 'background.html'), 'fixture background');
    await writeFile(archive, 'previous package');
    await expect(build(output, source, new ManifestUtil(), targets, manifest, false, false, '26.11.16.0')).rejects.toThrow();
    expect(await readFile(manifest, 'utf8')).toBe('previous manifest');
    expect(await readFile(archive, 'utf8')).toBe('previous package');
});
