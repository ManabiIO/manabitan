/*
 * Copyright (C) 2026  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
/* eslint-enable @typescript-eslint/ban-ts-comment */

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile as execFileCallback, spawnSync} from 'node:child_process';
import {lstat, mkdir, readFile, readdir, realpath, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {chromium} from '@playwright/test';
import {createDictionaryArchiveData} from '../../dev/dictionary-archive-util.js';
import {parseProcessRows, selectOwnedProcessTree} from './restart-interruption-process-tree.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const extensionPackagePath = path.join(root, 'builds', 'manabitan-chrome-playwright.zip');
const rawEvidenceDirectory = process.env.MANABITAN_RESTART_EVIDENCE_DIR;
assert.ok(rawEvidenceDirectory?.trim(), 'MANABITAN_RESTART_EVIDENCE_DIR must explicitly name a fresh evidence directory');
const outputDirectory = path.resolve(rawEvidenceDirectory);
const extensionPath = path.join(outputDirectory, 'unpacked-extension');
const manifestPath = path.join(extensionPath, 'manifest.json');
const reportPath = path.join(outputDirectory, 'restart-interruption-campaign.json');
const execFile = promisify(execFileCallback);
let activeExtensionId = '';
const title = 'Restart Campaign Fixture';
const oldExpression = '再起動証拠旧';
const newExpression = '再起動証拠新';
const oldGloss = 'RESTART_CAMPAIGN_REVISION_ONE_CONTENT_71D3';
const newGloss = 'RESTART_CAMPAIGN_REVISION_TWO_CONTENT_C92A';
const missingExpression = '再起動証拠には存在しない語';
const updateEntryCount = 50_000;
const timeoutMs = 300_000;

async function discoverExtensionId(context) {
    const parseId = (url) => /^chrome-extension:\/\/([^/]+)\//u.exec(String(url))?.[1] ?? '';
    const fromWorkers = () => context.serviceWorkers().map((worker) => parseId(worker.url())).find(Boolean) || '';
    let id = fromWorkers();
    if (id.length === 0) {
        await context.waitForEvent('serviceworker', {timeout: 30_000});
        id = fromWorkers();
    }
    assert.ok(id.length > 0, 'could not discover the loaded extension ID from its service worker');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(typeof manifest.key, 'string', 'chrome-playwright package must provide a stable extension key');
    const expectedIdHex = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex')
        .slice(0, 32);
    const expectedId = [...expectedIdHex].map((digit) => String.fromCharCode('a'.charCodeAt(0) + Number.parseInt(digit, 16))).join('');
    assert.equal(id, expectedId, 'runtime extension ID did not match the unpacked package manifest');
    return id;
}

async function writeFixture(directory, revision, sentinelExpression, sentinelGloss, fillerCount) {
    await mkdir(directory, {recursive: true});
    const index = {title, format: 3, revision, sequenced: true};
    const rows = [[sentinelExpression, 'さいきどうしょうこ', 'n', 'n', 1, [sentinelGloss], 1, '']];
    for (let i = 0; i < fillerCount; ++i) {
        rows.push([`更新語${String(i).padStart(6, '0')}`, 'こうしんご', 'n', 'n', 1, [`${revision}-inventory-${i}`], i + 2, '']);
    }
    await writeFile(path.join(directory, 'index.json'), JSON.stringify(index));
    await writeFile(path.join(directory, 'term_bank_1.json'), JSON.stringify(rows));
    return Buffer.from(await createDictionaryArchiveData(directory, title));
}

async function startServer(oldArchive, newArchive) {
    const observerEvents = [];
    let armedSession = null;
    let heldResponse = null;
    const server = createServer((request, response) => {
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        if (request.method === 'OPTIONS') {
            response.writeHead(204).end();
            return;
        }
        if (request.method === 'POST' && request.url === '/observer') {
            let body = '';
            request.setEncoding('utf8');
            request.on('data', (chunk) => { body += chunk; });
            request.on('end', () => {
                try {
                    const event = JSON.parse(body);
                    const observed = {...event, sessionId: armedSession?.sessionId ?? null, observedAtIso: new Date().toISOString()};
                    observerEvents.push(observed);
                    const dictionaryName = event.dictionaryName;
                    const matchingDictionary = dictionaryName === armedSession?.title ||
                    (dictionaryName?.startsWith(`${armedSession?.title} [update-staging `) && dictionaryName.endsWith(']'));
                    if (armedSession && matchingDictionary && event.fileName.endsWith('.mbtr') && event.bytes > 4096 && heldResponse === null) {
                        observed.held = true;
                        heldResponse = response;
                        return;
                    }
                    response.writeHead(204).end();
                } catch (error) {
                    response.writeHead(400).end(error instanceof Error ? error.message : String(error));
                }
            });
            return;
        }
        if (request.method === 'POST' && request.url === '/arm') {
            let body = '';
            request.setEncoding('utf8');
            request.on('data', (chunk) => { body += chunk; });
            request.on('end', () => {
                try {
                    assert.equal(heldResponse, null, 'cannot arm while an observer response is held');
                    armedSession = JSON.parse(body);
                    assert.equal(typeof armedSession.sessionId, 'string');
                    assert.equal(typeof armedSession.title, 'string');
                    response.writeHead(204).end();
                } catch (error) {
                    response.writeHead(400).end(error instanceof Error ? error.message : String(error));
                }
            });
            return;
        }
        if (request.method === 'POST' && request.url === '/release') {
            if (!heldResponse) {
                response.writeHead(409).end('no observer response is held');
                return;
            }
            const held = heldResponse;
            heldResponse = null;
            armedSession = null;
            held.writeHead(204).end();
            response.writeHead(204).end();
            return;
        }
        const archive = request.url === '/old.zip' ? oldArchive : (request.url === '/new.zip' ? newArchive : null);
        if (archive === null) {
            response.writeHead(404).end('not found');
            return;
        }
        response.writeHead(200, {'Content-Type': 'application/zip', 'Content-Length': String(archive.length)});
        response.end(archive);
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return {server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        observerEvents,
        disarmObserver: () => { armedSession = null; },
        releaseHeldObserver: () => {
            armedSession = null;
            if (heldResponse) {
                heldResponse.writeHead(204).end();
                heldResponse = null;
            }
        }};
}

async function instrumentPackageForTestObserver(observerUrl) {
    const storePath = path.join(extensionPath, 'js', 'dictionary', 'term-record-opfs-store.js');
    const storeStat = await lstat(storePath);
    assert.ok(storeStat.isFile() && !storeStat.isSymbolicLink(), 'test observer target must be a regular packaged source file');
    assert.equal(await realpath(storePath), storePath, 'test observer target must be addressed through its resolved real path');
    const source = await readFile(storePath, 'utf8');
    const originalHash = createHash('sha256').update(source).digest('hex');
    const target = 'await /** @type {FileSystemWritableFileStream} */ (state.writable).write(chunk);\n                writtenBytes += chunk.byteLength;';
    const replacement = `${target}\n                if (state.fileName.endsWith('.mbtr')) {\n                    const observerResponse = await fetch('${observerUrl}', {method: 'POST', mode: 'cors', body: JSON.stringify({fileName: state.fileName, dictionaryName: this._decodeShardInfoFromShardFileName(state.fileName)?.dictionaryName ?? null, bytes: chunk.byteLength, writeStartOffset})});\n                    if (!observerResponse.ok) { throw new Error('Test-only OPFS write observer rejected the completed record write'); }\n                }`;
    const occurrences = source.split(target).length - 1;
    assert.equal(occurrences, 2, `test observer instrumentation expected two record-write branches, found ${occurrences}`);
    const instrumented = source.split(target).join(replacement);
    await writeFile(storePath, instrumented);
    const packageFiles = [];
    const visit = async (directory) => {
        for (const entry of await readdir(directory, {withFileTypes: true})) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                await visit(entryPath);
            } else if (entry.isFile()) {
                packageFiles.push(path.relative(extensionPath, entryPath));
            }
        }
    };
    await visit(extensionPath);
    const packageTreeHash = createHash('sha256');
    for (const relativePath of packageFiles.sort()) {
        packageTreeHash.update(relativePath);
        packageTreeHash.update('\0');
        packageTreeHash.update(await readFile(path.join(extensionPath, relativePath)));
        packageTreeHash.update('\0');
    }
    return {
        sourcePath: path.relative(extensionPath, storePath),
        originalSha256: originalHash,
        instrumentedSha256: createHash('sha256').update(instrumented).digest('hex'),
        originalPackageZipSha256: createHash('sha256').update(await readFile(extensionPackagePath)).digest('hex'),
        instrumentedExtractedPackageTreeSha256: packageTreeHash.digest('hex'),
        replacements: occurrences,
        hook: 'await loopback observer POST after each awaited _writeChunksForShard FileSystemWritableFileStream.write(chunk) success, including the packaged store decoder dictionary name',
    };
}

async function send(page, action, params) {
    return await page.evaluate(({actionName, parameters}) => new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({action: actionName, params: parameters}, (response) => {
            const runtimeError = chrome.runtime.lastError;
            if (runtimeError) {
                reject(new Error(runtimeError.message || String(runtimeError)));
                return;
            }
            if (response && typeof response === 'object' && 'error' in response) {
                reject(new Error(JSON.stringify(response.error)));
                return;
            }
            resolve(response && typeof response === 'object' ? response.result : response);
        });
    }), {actionName: action, parameters: params});
}

async function waitForSettings(page) {
    await page.goto(`chrome-extension://${activeExtensionId}/settings.html?popup-preview=false`);
    await page.waitForFunction(() => document.documentElement.dataset.loaded === 'true', null, {timeout: 30_000});
    const runtimeIdentity = await page.evaluate(() => ({origin: location.origin, runtimeId: chrome.runtime.id, href: location.href}));
    assert.equal(runtimeIdentity.origin, `chrome-extension://${activeExtensionId}`, 'settings page origin must match the discovered extension runtime');
    assert.equal(runtimeIdentity.runtimeId, activeExtensionId, 'settings page runtime ID must match the discovered service worker');
    const diagnostics = await send(page, 'debugDictionaryStorageState');
    assert.equal(diagnostics?.usesFallbackStorage, false, `fallback storage is forbidden: ${JSON.stringify(diagnostics)}`);
    const storage = diagnostics?.openStorageDiagnostics;
    const worker = storage?.runtimeContext;
    assert.ok(
        worker?.isDedicatedWorkerGlobalScope === true &&
        worker?.hasStorageGetDirectory === true &&
        worker?.hasCreateSyncAccessHandle === true &&
        storage?.mode === 'opfs-sahpool' &&
        storage?.hasOpfsSahpoolVfs === true &&
        storage?.opfsSahpoolInstallResult === 'installed',
        `dedicated-worker OPFS SAHpool was not ready: ${JSON.stringify(storage)}`,
    );
    return {runtimeIdentity, diagnostics};
}

async function importFile(page, filePath) {
    await page.waitForSelector('#dictionary-import-file-input', {state: 'attached'});
    await page.setInputFiles('#dictionary-import-file-input', filePath);
}

async function waitForImport(page, expectedRevision) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        let rows;
        try {
            rows = await send(page, 'getDictionaryInfo');
        } catch (error) {
            if (!(error instanceof Error) || !error.message.includes('dictionary import is in progress')) { throw error; }
            await page.waitForTimeout(100);
            continue;
        }
        const row = Array.isArray(rows) ? rows.find((item) => item?.title === title && item?.revision === expectedRevision && item?.importSuccess === true) : null;
        if (row) { return row; }
        const state = await page.evaluate(() => ({
            label: document.querySelector('#dictionaries-modal .dictionary-import-progress .progress-info')?.textContent?.trim() || '',
            error: document.querySelector('#dictionary-error:not([hidden])')?.textContent?.trim() || '',
        }));
        assert.equal(state.error, '', `import UI failed: ${state.error}`);
        await page.waitForTimeout(100);
    }
    throw new Error(`Timed out waiting for published revision ${expectedRevision}`);
}

async function setDictionaryEnabled(page) {
    const result = await page.evaluate(async (dictionaryTitle) => {
        const sendMessage = (action, params) => new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({action, params}, (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                if (response && typeof response === 'object' && 'error' in response) {
                    reject(new Error(JSON.stringify(response.error)));
                    return;
                }
                resolve(response?.result ?? response);
            });
        });
        const full = await sendMessage('optionsGetFull');
        const next = structuredClone(full);
        const dictionaries = next.profiles?.[0]?.options?.dictionaries;
        if (!Array.isArray(dictionaries)) { throw new Error('profile dictionary options are unavailable'); }
        let item = dictionaries.find((entry) => entry?.name === dictionaryTitle);
        if (!item) {
            item = {name: dictionaryTitle, enabled: true};
            dictionaries.push(item);
        }
        item.enabled = true;
        await sendMessage('setAllSettings', {value: next, source: 'restart-interruption-campaign'});
        return {enabled: item.enabled, name: item.name};
    }, title);
    assert.deepEqual(result, {enabled: true, name: title});
}

async function lookup(page, expression) {
    return await send(page, 'termsFind', {
        text: expression,
        details: {primaryReading: '', matchType: 'exact', deinflect: false},
        optionsContext: {index: 0},
    });
}

async function inventory(page) {
    const [dictionaryInfo, counts] = await Promise.all([
        send(page, 'getDictionaryInfo'),
        send(page, 'getDictionaryCounts', {dictionaryNames: [title], getTotal: false}),
    ]);
    const row = Array.isArray(dictionaryInfo) ? dictionaryInfo.find((item) => item?.title === title) : null;
    const dictionaryCounts = counts?.counts?.[0] ?? null;
    return {dictionaryInfo, row, counts: dictionaryCounts};
}

function assertLookup(result, expression, glossary) {
    const entries = result?.dictionaryEntries ?? [];
    assert.ok(Array.isArray(entries), `invalid termsFind response: ${JSON.stringify(result)}`);
    assert.ok(
        entries.some((entry) => JSON.stringify(entry).includes(expression) && JSON.stringify(entry).includes(glossary)),
        `exact lookup/content oracle failed for ${expression}: ${JSON.stringify(entries).slice(0, 3000)}`,
    );
}

async function opfsState(page) {
    return await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const journal = await (async () => {
            try {
                const handle = await root.getFileHandle('manabitan-dictionary-import-journal.json');
                return await (await handle.getFile()).text();
            } catch (error) {
                if (error?.name === 'NotFoundError') { return null; }
                throw error;
            }
        })();
        const records = [];
        try {
            const directory = await root.getDirectoryHandle('manabitan-term-records');
            for await (const [name, handle] of directory.entries()) {
                if (handle.kind === 'file' && (name.endsWith('.mbtr') || name.endsWith('.mbtr.mbti'))) {
                    const file = await handle.getFile();
                    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
                    const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
                    records.push({name, size: file.size, sha256});
                }
            }
        } catch (error) {
            if (error?.name !== 'NotFoundError') { throw error; }
        }
        return {journal, records: records.sort((a, b) => a.name.localeCompare(b.name))};
    });
}

async function readImportJournal(page) {
    return await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        try {
            const handle = await root.getFileHandle('manabitan-dictionary-import-journal.json');
            return await (await handle.getFile()).text();
        } catch (error) {
            if (error?.name === 'NotFoundError') { return null; }
            throw error;
        }
    });
}

function chromiumProcesses(profilePath, expectedExecutable) {
    const result = spawnSync('ps', ['-ww', '-axo', 'pid=,ppid=,lstart=,command='], {encoding: 'utf8'});
    assert.equal(result.status, 0, `ps failed: ${result.stderr}`);
    return selectOwnedProcessTree(parseProcessRows(result.stdout), profilePath, expectedExecutable, process.platform === 'darwin');
}

function captureBrowserProcessTree(profilePath, expectedExecutable) {
    return chromiumProcesses(profilePath, expectedExecutable);
}

async function waitForCapturedProcessesToExit(processes, phase) {
    assert.ok(processes.length > 0, `no Chromium processes were captured before ${phase}`);
    const identities = new Map(processes.map(({pid, startedAt}) => [pid, startedAt]));
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        const current = spawnSync('ps', ['-ww', '-axo', 'pid=,lstart='], {encoding: 'utf8'});
        assert.equal(current.status, 0, `ps failed while waiting for ${phase}: ${current.stderr}`);
        const present = new Set(current.stdout.split('\n').map((line) => {
            const match = /^\s*(\d+)\s+(.{24})\s*$/u.exec(line);
            return match ? `${match[1]}:${match[2]}` : '';
        }));
        const remaining = [...identities].filter(([pid, startedAt]) => present.has(`${pid}:${startedAt}`));
        if (remaining.length === 0) {
            return processes.map(({pid}) => pid).sort((a, b) => a - b);
        }
        await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
    throw new Error(`Captured Chromium process identities remained after ${phase}: ${JSON.stringify(processes)}`);
}

async function killBrowserProcessTree(processes) {
    const rootProcess = processes.find(({command}) => !/--type=|crashpad_handler/u.test(command));
    assert.ok(rootProcess);
    const signalledPids = [];
    const alreadyExitedPids = [];
    for (const {pid} of processes.toReversed()) {
        const current = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'pid=,lstart=,command='], {encoding: 'utf8'});
        const match = /^\s*(\d+)\s+(.{24})\s+(.*)$/u.exec(current.stdout.trim());
        const captured = processes.find((entry) => entry.pid === pid);
        if (!match || match[2] !== captured.startedAt || match[3] !== captured.command) {
            alreadyExitedPids.push(pid);
            continue;
        }
        assert.equal(current.status, 0, `could not verify captured process ${pid} before SIGKILL`);
        try {
            process.kill(pid, 'SIGKILL');
            signalledPids.push(pid);
        } catch (error) {
            if (error?.code !== 'ESRCH') { throw error; }
            alreadyExitedPids.push(pid);
        }
    }
    assert.ok(signalledPids.includes(rootProcess.pid), `Chromium root exited before SIGKILL, so no forced-interruption event was witnessed: ${JSON.stringify({signalledPids, alreadyExitedPids})}`);
    const exitedPids = await waitForCapturedProcessesToExit(processes, 'SIGKILL');
    return {rootPid: rootProcess.pid, signalledPids, alreadyExitedPids, exitedPids};
}

async function closeContext(context, killed = false) {
    if (context === null) { return null; }
    try {
        await context.close();
        return null;
    } catch (error) {
        if (killed) { return {expectedKilledContextCloseError: error instanceof Error ? error.message : String(error)}; }
        return {contextCloseError: error instanceof Error ? error.message : String(error)};
    }
}

async function main() {
    assert.ok(!process.platform.startsWith('win'), 'this runner uses macOS/Linux ps process inspection');
    const evidenceStat = await lstat(outputDirectory);
    assert.ok(evidenceStat.isDirectory() && !evidenceStat.isSymbolicLink(), 'evidence path must be an existing real directory');
    assert.equal(await realpath(outputDirectory), outputDirectory, 'evidence directory must be addressed through its resolved real path');
    const fixtures = path.join(outputDirectory, 'fixtures');
    const profilePath = path.join(outputDirectory, 'profiles', 'chromium-restart-campaign');
    for (const freshPath of [fixtures, profilePath, extensionPath, reportPath, path.join(outputDirectory, 'profiles')]) {
        try {
            await lstat(freshPath);
            assert.fail(`campaign path already exists and is not fresh: ${freshPath}`);
        } catch (error) {
            if (error?.code !== 'ENOENT') { throw error; }
        }
    }
    const packageBytes = await readFile(extensionPackagePath);
    const {stdout: packageManifestText} = await execFile('unzip', ['-p', extensionPackagePath, 'manifest.json']);
    const packageManifest = JSON.parse(packageManifestText);
    assert.equal(typeof packageManifest.key, 'string', 'chrome-playwright package must contain its stable extension key');
    await mkdir(fixtures);
    await mkdir(path.dirname(profilePath));
    await mkdir(extensionPath);
    await execFile('unzip', ['-q', extensionPackagePath, '-d', extensionPath]);
    assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')), packageManifest, 'unpacked manifest differs from the built package');
    const oldArchive = await writeFixture(path.join(fixtures, 'revision-one'), 'revision-one-71d3', oldExpression, oldGloss, 2);
    const newArchive = await writeFixture(path.join(fixtures, 'revision-two'), 'revision-two-c92a', newExpression, newGloss, updateEntryCount);
    const fixtureHashes = {
        revisionOneSha256: createHash('sha256').update(oldArchive).digest('hex'),
        revisionTwoSha256: createHash('sha256').update(newArchive).digest('hex'),
    };
    /** @type {import('@playwright/test').BrowserContext|null} */
    let context = null;
    const [sourceHead, sourceTree, sourceStatus] = await Promise.all([
        execFile('git', ['rev-parse', 'HEAD'], {cwd: root}).then(({stdout}) => stdout.trim()),
        execFile('git', ['rev-parse', 'HEAD^{tree}'], {cwd: root}).then(({stdout}) => stdout.trim()),
        execFile('git', ['status', '--porcelain=v1'], {cwd: root}).then(({stdout}) => stdout.trim()),
    ]);
    const report = {
        startedAtIso: new Date().toISOString(),
        sourceHead,
        sourceTree,
        sourceStatus,
        nodeVersion: process.version,
        nodeExecutable: process.execPath,
        browserName: 'Chromium',
        browserExecutable: chromium.executablePath(),
        packagePath: extensionPackagePath,
        packageSha256: createHash('sha256').update(packageBytes).digest('hex'),
        packageManifestVersion: packageManifest.version,
        harnessSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
        profilePath,
        fixtureHashes,
        testOnlyPackageObserver: null,
        launches: [],
        phases: [],
        status: 'running',
    };
    let server = null;
    let baseUrl = '';
    let observerEvents = [];
    let disarmObserver = () => {};
    let releaseHeldObserver = () => {};
    try {
        ({server, baseUrl, observerEvents, disarmObserver, releaseHeldObserver} = await startServer(oldArchive, newArchive));
        report.testOnlyPackageObserver = await instrumentPackageForTestObserver(`${baseUrl}/observer`);
        const launch = async () => await chromium.launchPersistentContext(profilePath, {
            channel: 'chromium',
            headless: true,
            args: [
                `--disable-extensions-except=${extensionPath}`,
                `--load-extension=${extensionPath}`,
                ...(process.platform === 'darwin' ? ['--disable-features=MacAppCodeSignClone'] : []),
            ],
        });
        context = await launch();
        activeExtensionId = await discoverExtensionId(context);
        report.runtimeExtensionId = activeExtensionId;
        report.browserVersion = context.browser()?.version() ?? null;
        let page = context.pages()[0] ?? await context.newPage();
        const initialRuntime = await waitForSettings(page);
        report.launches.push({name: 'initial', serviceWorkerExtensionId: activeExtensionId, ...initialRuntime});
        const initialArchivePath = path.join(fixtures, 'revision-one.zip');
        await writeFile(initialArchivePath, oldArchive);
        await importFile(page, initialArchivePath);
        const oldPublished = await waitForImport(page, 'revision-one-71d3');
        await setDictionaryEnabled(page);
        const oldInventory = await inventory(page);
        assert.equal(oldInventory.row?.storageHealth, 'available');
        assert.equal(oldInventory.row?.storageGenerationId?.length > 0, true);
        assert.equal(oldInventory.counts?.terms, 3);
        assertLookup(await lookup(page, oldExpression), oldExpression, oldGloss);
        assert.equal((await lookup(page, missingExpression))?.dictionaryEntries?.length, 0, 'ordinary miss must remain empty');
        report.phases.push({
            name: 'completed import baseline',
            status: 'passed',
            revision: oldPublished.revision,
            generationId: oldPublished.storageGenerationId,
            inventory: oldInventory.counts,
            exactContent: oldGloss,
            missCount: 0,
        });

        const baselineOpfs = await opfsState(page);
        observerEvents.length = 0;
        await page.goto(`chrome-extension://${activeExtensionId}/settings.html?popup-preview=false`);
        await page.waitForFunction(() => document.documentElement.dataset.loaded === 'true', null, {timeout: 30_000});
        await page.evaluate(() => {
            const trigger = [...document.querySelectorAll('.settings-item[data-modal-action="show,dictionaries"]')]
                .find((item) => (item.querySelector('.settings-item-label')?.textContent || '').includes('Configure installed and enabled dictionaries'));
            if (!(trigger instanceof HTMLElement)) { throw new Error('installed dictionary modal trigger missing'); }
            trigger.click();
        });
        await page.waitForSelector('#dictionaries-modal:not([hidden])', {timeout: 30_000});
        await page.evaluate(({dictionaryTitle, downloadUrl}) => {
            const modal = document.querySelector('#dictionary-confirm-update-modal');
            const button = document.querySelector('#dictionary-confirm-update-button');
            if (!(modal instanceof HTMLElement) || !(button instanceof HTMLElement)) { throw new Error('update controls missing'); }
            modal.dataset.dictionaryTitle = dictionaryTitle;
            modal.dataset.downloadUrl = downloadUrl;
            setTimeout(() => button.click(), 0);
        }, {dictionaryTitle: title, downloadUrl: `${baseUrl}/new.zip`});
        const killDeadline = Date.now() + timeoutMs;
        let killBoundary = null;
        let armedSessionId = null;
        let journalParseRetryCount = 0;
        let lastJournalParseError = null;
        while (Date.now() < killDeadline) {
            const [label, journalText] = await Promise.all([
                page.evaluate(() => document.querySelector('#dictionaries-modal .dictionary-import-progress .progress-info')?.textContent?.trim() || ''),
                readImportJournal(page),
            ]);
            if (journalText !== null) {
                let journal = null;
                try {
                    journal = JSON.parse(journalText);
                } catch (error) {
                    if (!(error instanceof SyntaxError)) { throw error; }
                    ++journalParseRetryCount;
                    lastJournalParseError = error.message;
                }
                if (journal !== null) {
                    assert.equal(journal.version, 1, `unexpected journal version: ${JSON.stringify(journal)}`);
                    assert.equal(typeof journal.sessionId, 'string');
                    assert.ok(journal.sessionId.length > 0);
                    assert.ok(Number.isSafeInteger(journal.createdAt) && journal.createdAt > 0);
                    assert.ok(Array.isArray(journal.recordCheckpoint?.shards));
                    assert.ok(Array.isArray(journal.contentCheckpoint?.segments));
                    assert.equal(journal.recordCheckpoint.shards.length, baselineOpfs.records.length, 'journal must checkpoint every pre-import term-record and lookup-index file');
                    for (const priorShard of journal.recordCheckpoint.shards) {
                        const observed = baselineOpfs.records.find(({name}) => name === priorShard.fileName);
                        assert.ok(observed, `journal pre-import checkpoint references a missing pre-import shard: ${priorShard.fileName}`);
                        assert.equal(priorShard.fileLength, observed.size, `journal checkpoint length differs for ${priorShard.fileName}`);
                    }
                    if (armedSessionId === null) {
                        armedSessionId = journal.sessionId;
                        const armResponse = await fetch(`${baseUrl}/arm`, {method: 'POST', body: JSON.stringify({sessionId: armedSessionId, title})});
                        assert.equal(armResponse.status, 204, 'test-only observer gate failed to arm for the active update session');
                    }
                    assert.equal(journal.sessionId, armedSessionId, 'active update session changed while observer gate was armed');
                    const observedWrites = observerEvents.filter(({fileName, dictionaryName, bytes, sessionId, held}) => sessionId === armedSessionId && fileName.endsWith('.mbtr') && (dictionaryName === title || (dictionaryName?.startsWith(`${title} [update-staging `) && dictionaryName.endsWith(']'))) && Number.isSafeInteger(bytes) && bytes > 4096 && held === true);
                    const observedWrite = observedWrites[observedWrites.length - 1];
                    if (observedWrite) {
                        const checkpointEntry = journal.recordCheckpoint.shards.find(({fileName}) => fileName === observedWrite.fileName) ?? null;
                        assert.equal(checkpointEntry, null, 'interrupted session write must target a new staging shard rather than a checkpointed old shard');
                        killBoundary = {
                            observedAtIso: new Date().toISOString(),
                            label,
                            journal,
                            observedWrite,
                            checkpointEntry,
                            observerEventCount: observedWrites.length,
                            journalParseRetryCount,
                            lastJournalParseError,
                            observerMechanism: `controlled test-only pause: instrumented extracted package awaits a held loopback response after FileSystemWritableFileStream.write(chunk); the packaged store decoder reports the dictionary name, and active session journal plus new staging shard are validated before release and SIGKILL; UI phase was ${label}`,
                        };
                        break;
                    }
                }
            }
            const error = await page.evaluate(() => document.querySelector('#dictionary-error:not([hidden])')?.textContent?.trim() || '');
            assert.equal(error, '', `update UI failed before the kill boundary: ${error}`);
            await page.waitForTimeout(10);
        }
        assert.ok(killBoundary, `did not observe a held test-only post-write response plus the matching active journal and new staging shard; journal parse retries=${journalParseRetryCount}, last parse error=${String(lastJournalParseError)}`);
        report.phases.push({name: 'controlled test-only post-write interruption boundary', status: 'observed', ...killBoundary});
        const updateKillProcesses = captureBrowserProcessTree(profilePath, chromium.executablePath());
        report.phases.push({name: 'captured owned Chromium process tree before SIGKILL', status: 'observed', processes: updateKillProcesses});
        const updateKill = await killBrowserProcessTree(updateKillProcesses);
        report.phases.push({name: 'SIGKILL active Chromium process tree after successful term-record write before publication (test-only gate)', status: 'passed', ...updateKill});
        disarmObserver();
        releaseHeldObserver();
        const killedClose = await closeContext(context, true);
        report.killedContextClose = killedClose;
        context = null;
        context = await launch();
        activeExtensionId = await discoverExtensionId(context);
        assert.equal(activeExtensionId, report.runtimeExtensionId, 'recovery launch extension ID must match the initial launch');
        page = context.pages()[0] ?? await context.newPage();
        const recoveredRuntime = await waitForSettings(page);
        report.launches.push({name: 'recovery', serviceWorkerExtensionId: activeExtensionId, ...recoveredRuntime});
        const recoveredStorage = recoveredRuntime.diagnostics;
        const recovered = await inventory(page);
        assert.ok(recovered.row, `restart lost dictionary metadata: ${JSON.stringify(recovered)}`);
        assert.equal(recovered.row.importSuccess, true, 'published dictionary metadata must be complete');
        assert.equal(recovered.row.storageHealth, 'available');
        const afterInfo = recovered.dictionaryInfo.filter((row) => String(row?.title || '').includes(title));
        assert.equal(afterInfo.length, 1, `transient/mixed dictionary rows remained: ${JSON.stringify(afterInfo)}`);
        const revision = recovered.row.revision;
        if (revision === 'revision-one-71d3') {
            assert.notEqual(recovered.row.storageGenerationId, killBoundary.journal.sessionId);
            assert.equal(recovered.row.storageGenerationId, oldPublished.storageGenerationId);
            assert.equal(recovered.counts?.terms, 3);
            assertLookup(await lookup(page, oldExpression), oldExpression, oldGloss);
            assert.equal((await lookup(page, newExpression))?.dictionaryEntries?.length, 0);
        } else {
            assert.equal(revision, 'revision-two-c92a', `unexpected recovered revision: ${String(revision)}`);
            assert.equal(recovered.row.storageGenerationId, killBoundary.journal.sessionId, 'published recovery generation must be the witnessed interrupted session');
            assert.notEqual(recovered.row.storageGenerationId, oldPublished.storageGenerationId);
            assert.equal(recovered.counts?.terms, updateEntryCount + 1);
            assertLookup(await lookup(page, newExpression), newExpression, newGloss);
            assert.equal((await lookup(page, oldExpression))?.dictionaryEntries?.length, 0);
        }
        assert.equal((await lookup(page, missingExpression))?.dictionaryEntries?.length, 0);
        report.phases.push({
            name: 'restart recovery all-or-nothing generation oracle',
            status: 'passed',
            revision,
            generationId: recovered.row.storageGenerationId,
            inventory: recovered.counts,
            exactExpression: revision.startsWith('revision-one') ? oldExpression : newExpression,
            exactContent: revision.startsWith('revision-one') ? oldGloss : newGloss,
            absentExpression: revision.startsWith('revision-one') ? newExpression : oldExpression,
            missCount: 0,
            noTransientRows: true,
            strictOpfs: recoveredStorage.usesFallbackStorage === false && recoveredStorage.openStorageDiagnostics?.mode === 'opfs-sahpool' && recoveredStorage.openStorageDiagnostics?.hasOpfsSahpoolVfs === true && recoveredStorage.openStorageDiagnostics?.opfsSahpoolInstallResult === 'installed',
        });

        report.status = 'success';
    } catch (error) {
        report.status = 'failure';
        report.failureReason = error instanceof Error ? error.stack || error.message : String(error);
        throw error;
    } finally {
        let finalProcesses = [];
        const cleanupFailures = [];
        if (context !== null) {
            try { finalProcesses = captureBrowserProcessTree(profilePath, chromium.executablePath()); } catch (error) {
                cleanupFailures.push(error instanceof Error ? error.message : String(error));
            }
        }
        const closeResult = await closeContext(context, false);
        if (closeResult) { cleanupFailures.push(closeResult.contextCloseError); }
        if (finalProcesses.length > 0) {
            if (closeResult) {
                try {
                    report.finalShutdownFallback = await killBrowserProcessTree(finalProcesses);
                } catch (error) {
                    cleanupFailures.push(error instanceof Error ? error.message : String(error));
                }
            } else {
                try {
                    report.finalShutdown = {exitedPids: await waitForCapturedProcessesToExit(finalProcesses, 'final context shutdown')};
                } catch (error) {
                    cleanupFailures.push(error instanceof Error ? error.message : String(error));
                    try {
                        report.finalShutdownFallback = await killBrowserProcessTree(finalProcesses);
                    } catch (fallbackError) {
                        cleanupFailures.push(fallbackError instanceof Error ? fallbackError.message : String(fallbackError));
                    }
                }
            }
        }
        if (cleanupFailures.length > 0) { report.cleanupFailure = cleanupFailures.join('\n'); }
        if (report.cleanupFailure) { report.status = 'failure'; }
        disarmObserver();
        releaseHeldObserver();
        if (server !== null) {
            server.closeAllConnections();
            await Promise.race([
                new Promise((resolve) => { server.close(() => resolve()); }),
                new Promise((resolve) => { setTimeout(resolve, 2_000); }),
            ]);
        }
        report.finishedAtIso = new Date().toISOString();
        await writeFile(reportPath, JSON.stringify(report, null, 2));
        if (report.cleanupFailure) { process.exitCode = 1; }
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
});
