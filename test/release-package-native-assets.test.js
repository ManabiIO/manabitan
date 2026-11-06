/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {execFile} from 'node:child_process';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import JSZip from 'jszip';
import {expect, test} from 'vitest';

const run = promisify(execFile);
const version = '26.11.6.0';
const wasm = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);

/**
 * @param {'missing'|'corrupt'|'valid'} scanner
 * @returns {Promise<string>}
 */
async function packageFixture(scanner) {
    const directory = await mkdtemp(join(tmpdir(), 'manabitan-package-audit-'));
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({manifest_version: 3, version}));
    zip.file('lib/term-bank-parser.wasm', wasm);
    zip.file('lib/zstd.wasm', wasm);
    if (scanner !== 'missing') { zip.file('lib/term-content-canonical-scan-v1.wasm', scanner === 'corrupt' ? Uint8Array.of(1, 2, 3) : wasm); }
    const path = join(directory, 'candidate.zip');
    await writeFile(path, await zip.generateAsync({type: 'nodebuffer'}));
    return path;
}

test.each(['missing', 'corrupt'])('release package audit rejects a %s canonical scanner', async (state) => {
    const path = await packageFixture(/** @type {'missing'|'corrupt'} */ (state));
    await expect(run(process.execPath, ['dev/bin/audit-release-packages.js', version, path])).rejects.toThrow(/native asset/u);
});

test('release package audit validates and records the canonical scanner alongside parser and codec', async () => {
    const path = await packageFixture('valid');
    const {stdout} = await run(process.execPath, ['dev/bin/audit-release-packages.js', version, path]);
    const report = JSON.parse(stdout);
    expect(report.packages[0].nativeAssets['lib/term-content-canonical-scan-v1.wasm']).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.keys(report.packages[0].nativeAssets)).toHaveLength(3);
});
