/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {execFile} from 'node:child_process';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import JSZip from 'jszip';
import {expect, test} from 'vitest';
import {ManifestUtil} from '../dev/manifest-util.js';

const run = promisify(execFile);
const version = '26.11.6.0';
const wasm = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);

/**
 * @param {'missing'|'corrupt'|'valid'} scanner
 * @param {string} [variant]
 * @param {(manifest: import('dev/manifest').Manifest) => void} [mutate]
 * @param {'missing'|'corrupt'|'valid'} [fields]
 * @returns {Promise<string>}
 */
async function packageFixture(scanner, variant = 'chrome', mutate = () => {}, fields = 'valid') {
    const directory = await mkdtemp(join(tmpdir(), 'manabitan-package-audit-'));
    const zip = new JSZip();
    const manifest = new ManifestUtil().getManifest(variant);
    manifest.version = version;
    mutate(manifest);
    zip.file('manifest.json', JSON.stringify(manifest));
    zip.file('lib/term-bank-parser.wasm', wasm);
    zip.file('lib/zstd.wasm', wasm);
    zip.file('js/dictionary/zstd-trainer.wasm', await readFile(new URL('../ext/js/dictionary/zstd-trainer.wasm', import.meta.url)));
    zip.file('js/dictionary/zstd-trainer.LICENSE', await readFile(new URL('../ext/js/dictionary/zstd-trainer.LICENSE', import.meta.url)));
    /* eslint-disable-next-line @stylistic/semi */
    if (fields !== 'missing') { zip.file('lib/term-record-fields.wasm', fields === 'corrupt' ? Uint8Array.of(1, 2, 3) : wasm) }
    if (scanner !== 'missing') { zip.file('lib/term-content-canonical-scan-v1.wasm', scanner === 'corrupt' ? Uint8Array.of(1, 2, 3) : wasm); }
    const path = join(directory, `manabitan-${variant}.zip`);
    await writeFile(path, await zip.generateAsync({type: 'nodebuffer'}));
    return path;
}

test.each(['missing', 'corrupt'])('release package audit rejects a %s canonical scanner', async (state) => {
    const path = await packageFixture(/** @type {'missing'|'corrupt'} */ (state));
    await expect(run(process.execPath, ['dev/bin/audit-release-packages.js', version, path])).rejects.toThrow(/native asset/u);
});

/* eslint-disable @stylistic/semi */
test.each(['missing', 'corrupt'])('release package audit rejects a %s record-field encoder', async (state) => {
    const path = await packageFixture('valid', 'chrome', () => {}, /** @type {'missing'|'corrupt'} */ (state))
    await expect(run(process.execPath, ['dev/bin/audit-release-packages.js', version, path])).rejects.toThrow(/native asset/u)
})

test.each(['missing', 'corrupt'])('release package audit rejects a %s trainer', async (state) => {
    const path = await packageFixture('valid')
    const zip = await JSZip.loadAsync(await readFile(path))
    if (state === 'missing') {
        zip.remove('js/dictionary/zstd-trainer.wasm')
    } else {
        zip.file('js/dictionary/zstd-trainer.wasm', Uint8Array.of(1, 2, 3))
    }
    await writeFile(path, await zip.generateAsync({type: 'nodebuffer'}))
    await expect(run(process.execPath, ['dev/bin/audit-release-packages.js', version, path])).rejects.toThrow(/native asset/u)
})

test('release package audit rejects a missing trainer license', async () => {
    const path = await packageFixture('valid')
    const zip = await JSZip.loadAsync(await readFile(path))
    zip.remove('js/dictionary/zstd-trainer.LICENSE')
    await writeFile(path, await zip.generateAsync({type: 'nodebuffer'}))
    await expect(run(process.execPath, ['dev/bin/audit-release-packages.js', version, path])).rejects.toThrow(/third-party license notice/u)
})
/* eslint-enable @stylistic/semi */

test('release package audit records scanner, field encoder, parser, codec and trainer', async () => {
    const path = await packageFixture('valid');
    const {stdout} = await run(process.execPath, ['dev/bin/audit-release-packages.js', version, path]);
    const report = JSON.parse(stdout);
    expect(report.packages[0].nativeAssets['lib/term-content-canonical-scan-v1.wasm']).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.keys(report.packages[0].nativeAssets).sort()).toEqual(['js/dictionary/zstd-trainer.wasm', 'lib/term-bank-parser.wasm', 'lib/term-content-canonical-scan-v1.wasm', 'lib/term-record-fields.wasm', 'lib/zstd.wasm']);
    expect(report.packages[0].licenseAssets['js/dictionary/zstd-trainer.LICENSE']).toMatch(/^[0-9a-f]{64}$/u);
});

test.each(['chrome', 'chrome-dev', 'chrome-playwright', 'edge', 'firefox', 'firefox-dev', 'firefox-android'])('release audit accepts the canonical %s package', async (variant) => {
    const path = await packageFixture('valid', variant);
    await expect(run(process.execPath, ['dev/bin/audit-release-packages.js', version, path])).resolves.toHaveProperty('stdout');
});

test.each(['base', 'safari'])('release audit rejects the non-package %s variant', async (variant) => {
    const path = await packageFixture('valid', variant);
    await expect(run(process.execPath, ['dev/bin/audit-release-packages.js', version, path])).rejects.toThrow(/Unknown release package name/u);
});

test('release audit rejects a package from a different version', async () => {
    const path = await packageFixture('valid');
    await expect(run(process.execPath, ['dev/bin/audit-release-packages.js', '26.11.6.1', path])).rejects.toThrow(/version mismatch/u);
});

test.each([
    {name: 'MV2 package', variant: 'chrome', mutate: (/** @type {import('dev/manifest').Manifest} */ manifest) => { manifest.manifest_version = 2; }},
    {name: 'wrong stable Gecko ID', variant: 'firefox', mutate: (/** @type {import('dev/manifest').Manifest} */ manifest) => { manifest.browser_specific_settings.gecko.id = 'wrong@example.invalid'; }},
    {name: 'stable ID in development package', variant: 'firefox-dev', mutate: (/** @type {import('dev/manifest').Manifest} */ manifest) => { manifest.browser_specific_settings.gecko.id = '{1e12d533-8e72-4ec5-9edc-cd50e26d7d43}'; }},
    {name: 'wrong Android Gecko ID', variant: 'firefox-android', mutate: (/** @type {import('dev/manifest').Manifest} */ manifest) => { manifest.browser_specific_settings.gecko.id = 'wrong@example.invalid'; }},
    {name: 'missing Playwright identity', variant: 'chrome-playwright', mutate: (/** @type {import('dev/manifest').Manifest} */ manifest) => { delete manifest.key; }},
    {name: 'development name on stable package', variant: 'chrome', mutate: (/** @type {import('dev/manifest').Manifest} */ manifest) => { manifest.name += ' (dev)'; }},
])('release audit rejects a $name', async ({variant, mutate}) => {
    const path = await packageFixture('valid', variant, mutate);
    await expect(run(process.execPath, ['dev/bin/audit-release-packages.js', version, path])).rejects.toThrow(/manifest/u);
});
