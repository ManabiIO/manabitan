/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
/* eslint-enable @typescript-eslint/ban-ts-comment */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstat, mkdir, readFile, readdir, realpath, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '@playwright/test';
import JSZip from 'jszip';
import {getChromiumLaunchOptions} from '../e2e/chromium-launch-options.js';

const oldZip = process.env.MANABITAN_UPGRADE_OLD_ZIP;
const newZip = process.env.MANABITAN_UPGRADE_NEW_ZIP;
const rawEvidence = process.env.MANABITAN_UPGRADE_EVIDENCE_DIR;
assert.ok(oldZip && newZip && rawEvidence, 'Explicit old/new package ZIPs and a fresh evidence directory are required');
const evidence = path.resolve(rawEvidence);
assert.equal(await realpath(evidence), evidence);
assert.ok((await lstat(evidence)).isDirectory());
assert.deepEqual(await readdir(evidence), [], 'Evidence directory must be fresh');
const unpacked = path.join(evidence, 'extension');
const profile = path.join(evidence, 'profile');
const title = 'Released Upgrade Fixture';
const expression = '移行検証';
const marker = 'RELEASED_SCHEMA_UPGRADE_GLOSSARY_6C21';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = {sourceCommit: process.env.GITHUB_SHA ?? null, status: 'running', stages: []};
let context = null;
let extensionId = '';
const persist = async () => await writeFile(path.join(evidence, 'upgrade-report.json'), JSON.stringify(report, null, 2));

async function extract(zipPath, target) {
    const bytes = await readFile(zipPath);
    const zip = await JSZip.loadAsync(bytes, {checkCRC32: true});
    await mkdir(target);
    for (const entry of Object.values(zip.files)) {
        if (entry.dir) { continue; }
        const destination = path.resolve(target, entry.name);
        assert.ok(destination.startsWith(target + path.sep), 'Package path escaped the owned extraction directory');
        await mkdir(path.dirname(destination), {recursive: true});
        await writeFile(destination, await entry.async('nodebuffer'), {flag: 'wx'});
    }
    return {sha256: hash(bytes), manifest: JSON.parse(await readFile(path.join(target, 'manifest.json'), 'utf8'))};
}

async function send(page, action, params = {}) {
    let timer;
    try {
        return await Promise.race([page.evaluate(({action, params}) => new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({action, params}, (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else if (response?.error) {
                    reject(new Error(JSON.stringify(response.error)));
                } else {
                    resolve(response?.result);
                }
            });
        }), {action, params}), new Promise((resolve, reject) => {
            timer = setTimeout(() => { reject(new Error(`Timed out waiting for RPC ${action}`)); }, 30000);
        })]);
    } finally { clearTimeout(timer); }
}

async function launch(name, expectedVersion) {
    context = await chromium.launchPersistentContext(profile, getChromiumLaunchOptions({
        channel: 'chromium',
        headless: true,
        args: [`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`],
    }));
    let worker = context.serviceWorkers()[0];
    if (!worker) { worker = await context.waitForEvent('serviceworker', {timeout: 30000}); }
    const id = /^chrome-extension:\/\/([^/]+)\//u.exec(worker.url())?.[1];
    assert.ok(id);
    if (extensionId) { assert.equal(id, extensionId, 'Upgrade changed extension identity'); }
    extensionId = id;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/settings.html?popup-preview=false`);
    await page.waitForFunction(() => document.documentElement.dataset.loaded === 'true', null, {timeout: 60000});
    assert.equal(await page.evaluate(() => chrome.runtime.getManifest().version), expectedVersion);
    const diagnostics = await send(page, 'debugDictionaryStorageState');
    assert.equal(diagnostics.usesFallbackStorage, false);
    assert.equal(diagnostics.openStorageDiagnostics?.mode, 'opfs-sahpool');
    report.stages.push({name, version: expectedVersion, extensionId: id, opfs: true, browserVersion: context.browser()?.version() ?? null});
    await persist();
    return page;
}

async function close() {
    const owned = context;
    context = null;
    if (owned) { await owned.close(); }
}

async function published(page, healthy) {
    await page.waitForFunction(async ({title, healthy}) => {
        const response = await new Promise((resolve) => { chrome.runtime.sendMessage({action: 'getDictionaryInfo', params: {}}, resolve); });
        return !response?.error && response?.result?.some((row) => row.title === title && row.importSuccess === true &&
        (!healthy || (row.storageHealth === 'available' && typeof row.storageGenerationId === 'string')));
    }, {title, healthy}, {timeout: 120000});
    const result = (await send(page, 'getDictionaryInfo')).find((row) => row.title === title);
    assert.ok(result);
    return result;
}

async function lookup(page) {
    const result = await send(page, 'termsFind', {
        text: expression, details: {primaryReading: '', matchType: 'exact', deinflect: false}, optionsContext: {index: 0},
    });
    assert.ok(result.dictionaryEntries.some((entry) => JSON.stringify(entry).includes(marker)), 'Fresh lookup did not return the fixture glossary');
}

function preserved(before, after) {
    const current = after.profiles[0].options;
    for (const previousEntry of before.profiles[0].options.dictionaries) {
        const entry = current.dictionaries.find((item) => item.name === previousEntry.name && item.alias === previousEntry.alias);
        assert.ok(entry, 'Dictionary preference row was pruned');
        for (const [key, value] of Object.entries(previousEntry)) { assert.deepEqual(entry[key], value, `Changed dictionary preference ${key}`); }
    }
    assert.equal(current.general.mainDictionary, title);
    assert.equal(current.general.sortFrequencyDictionary, title);
    assert.deepEqual(current.anki.tags, ['schema-upgrade-preserved']);
}

try {
    report.oldPackage = await extract(oldZip, unpacked);
    assert.equal(report.oldPackage.manifest.version, '26.3.31.46', 'Expected the actual pinned published package');
    const candidate = path.join(evidence, 'candidate');
    report.newPackage = await extract(newZip, candidate);
    const zip = new JSZip();
    zip.file('index.json', JSON.stringify({title, format: 3, revision: 'one', sequenced: true}));
    zip.file('term_bank_1.json', JSON.stringify([[expression, 'いこうけんしょう', '', '', 1, [marker], 1, '']]));
    const fixture = await zip.generateAsync({type: 'nodebuffer'});
    const fixturePath = path.join(evidence, 'fixture.zip');
    await writeFile(fixturePath, fixture, {flag: 'wx'});
    report.fixtureSha256 = hash(fixture);
    let page = await launch('published-release-initial', report.oldPackage.manifest.version);
    await page.setInputFiles('#dictionary-import-file-input', fixturePath);
    await published(page, false);
    let options = await send(page, 'optionsGetFull');
    const dictionaryIndex = options.profiles[0].options.dictionaries.findIndex((row) => row.name === title);
    assert.ok(dictionaryIndex >= 0);
    const targets = [
        {path: `profiles[0].options.dictionaries[${dictionaryIndex}].alias`, value: 'Preserved release alias'},
        {path: `profiles[0].options.dictionaries[${dictionaryIndex}].enabled`, value: true},
        {path: `profiles[0].options.dictionaries[${dictionaryIndex}].styles`, value: '.definition {color: rgb(1, 2, 3)}'},
        {path: 'profiles[0].options.general.mainDictionary', value: title},
        {path: 'profiles[0].options.general.sortFrequencyDictionary', value: title},
        {path: 'profiles[0].options.anki.tags', value: ['schema-upgrade-preserved']},
    ].map((target) => ({...target, action: 'set', scope: 'global', optionsContext: null}));
    const changes = await send(page, 'modifySettings', {source: 'schema-upgrade-qualification', targets});
    assert.ok(Array.isArray(changes) && changes.every((item) => !item.error));
    options = await send(page, 'optionsGetFull');
    await lookup(page);
    report.stages.push({name: 'published-release-import-and-lookup', passed: true});
    await close();
    await rename(unpacked, path.join(evidence, 'published-extension'));
    await rename(candidate, unpacked);
    for (const name of ['upgrade', 'pending-reimport-restart']) {
        page = await launch(name, report.newPackage.manifest.version);
        const row = (await send(page, 'getDictionaryInfo')).find((item) => item.title === title);
        assert.equal(row?.storageHealth, 'reimportRequired');
        assert.match(row.storageHealthReason, /storage was upgraded/i);
        preserved(options, await send(page, 'optionsGetFull'));
        report.stages.push({name: name + '-inventory-and-preferences-retained', passed: true, reason: row.storageHealthReason});
        if (name === 'upgrade') { await close(); }
    }
    // Exercise the existing replacement-from-file flow, not an ordinary
    // duplicate import or a database-only reconstruction.
    await page.locator('.settings-item[data-modal-action="show,dictionaries"]').first().click();
    await page.locator('#dictionaries-modal:not([hidden])').waitFor();
    const warning = page.locator('.dictionary-integrity-button-error[title="Re-import required"]').first();
    await warning.click();
    await page.locator('#dictionary-details-modal:not([hidden])').waitFor();
    assert.match(await page.locator('#dictionary-details-modal .dictionary-storage-error-notification').textContent(), /storage was upgraded/i);
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#dictionary-details-modal .dictionary-reimport-button').click();
    await (await chooser).setFiles(fixturePath);
    await published(page, true);
    preserved(options, await send(page, 'optionsGetFull'));
    await lookup(page);
    report.stages.push({name: 'replacement-from-original-file-and-fresh-lookup', passed: true});
    await close();
    page = await launch('restored-restart', report.newPackage.manifest.version);
    await published(page, true);
    preserved(options, await send(page, 'optionsGetFull'));
    await lookup(page);
    report.status = 'success';
} catch (error) {
    report.status = 'failure';
    report.error = error instanceof Error ? error.stack : String(error);
    throw error;
} finally {
    await close();
    report.finishedAt = new Date().toISOString();
    await persist();
}
