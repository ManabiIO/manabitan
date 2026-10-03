/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createMdxImportData} from '../../ext/js/dictionary/mdx/mdx-converter.js';
import {makeMdictFixture, makeFixturePng} from './mdict-binary-fixture.js';

/**
 * @param {unknown} value
 * @param {string} tag
 * @returns {Record<string, unknown>|undefined}
 */
function findNode(value, tag) {
    if (typeof value !== 'object' || value === null) { return void 0; }
    if (Reflect.get(value, 'tag') === tag) { return /** @type {Record<string, unknown>} */ (value); }
    for (const child of Object.values(value)) {
        const result = findNode(child, tag);
        if (typeof result !== 'undefined') { return result; }
    }
    return void 0;
}

const cases = ['mdict-media', 'MDICT-MEDIA'].flatMap((sourceDirectory) => [false, true].map((occupiedOutputDirectory) => ({sourceDirectory, occupiedOutputDirectory})));
for (const {sourceDirectory, occupiedOutputDirectory} of cases) {
    test(`MDD ${sourceDirectory} directory retains its resource identity (nested collision=${occupiedOutputDirectory})`, async () => {
        const png = makeFixturePng([0, 255, 0, 255]);
        const decoy = makeFixturePng([255, 0, 0, 255]);
        const text = new TextEncoder().encode('source resource');
        const mdx = makeMdictFixture([{key: 'Entry', value: '<div><img src="mdict-media/icon.png"><a href="mdict-media/info.txt">resource</a><style>.inline{background:url("mdict-media/icon.png")}</style></div>'}]);
        const entries = [
            {key: `\\${sourceDirectory}\\icon.png`, value: png},
            {key: `\\${sourceDirectory}\\info.txt`, value: text},
            {key: `\\${sourceDirectory}\\theme.css`, value: new TextEncoder().encode('.theme{background:url("icon.png")}')},
            {key: '\\icon.png', value: decoy},
            {key: '\\info.txt', value: new TextEncoder().encode('wrong resource')},
        ];
        if (occupiedOutputDirectory) {
            entries.push({key: `\\${sourceDirectory}\\converted-1\\reserved.txt`, value: text});
        }
        const mdd = makeMdictFixture(entries, {mdd: true});
        const {files, phaseTimings} = await createMdxImportData('resource-prefix.mdx', {}, mdx.bytes, [{name: 'resource-prefix.mdd', bytes: mdd.bytes}]);
        const bank = files.get('term_bank_1.json');
        assert.ok(bank instanceof Uint8Array);
        const rows = JSON.parse(new TextDecoder().decode(bank));
        const image = findNode(rows, 'img');
        assert.equal(typeof image?.path, 'string');
        const imagePath = /** @type {string} */ (image?.path);
        assert.deepEqual(files.get(imagePath), png, 'image must resolve the source directory, not the root decoy');
        const link = findNode(rows, 'a');
        assert.ok(link);
        assert.equal(typeof link.href, 'string');
        const linkPath = /** @type {string} */ (link.href).slice('media:'.length);
        assert.deepEqual(files.get(linkPath), text);
        const styles = new TextDecoder().decode(files.get('styles.css'));
        assert.ok(styles.includes(`/* Source: ${sourceDirectory}/theme.css */`), styles);
        const cssPaths = [...styles.matchAll(/url\("([^"]+)"\)/gu)].map((match) => match[1]);
        assert.equal(cssPaths.length, 2);
        for (const path of cssPaths) {
            assert.ok(path.startsWith('mdict-media/'), 'preserve the display media root');
            assert.deepEqual(files.get(path), png, 'inline and MDD CSS must resolve the same resource');
        }
        assert.equal(files.has('mdict-media/icon.png'), false, 'the root decoy must not be materialized');
        assert.equal(phaseTimings.find(({phase}) => phase === 'prepare-mdx:materialize-assets')?.details?.missingReferencedAssetCount, 0);
    });
}
