/*
 * Copyright (C) 2026  Yomitan Authors
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

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck

import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
import {createWriteStream, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {mkdir, rm, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {safePerformance} from '../../ext/js/core/safe-performance.js';
import {ManifestUtil} from '../../dev/manifest-util.js';
import {
    cleanupCaseTempDir,
    cleanupTempRoot,
    DEFAULT_FREEMDICT_DAV_URL,
    DEFAULT_FREEMDICT_SHARE_URL,
    discoverDirectoryWorkItems,
    loadJsonFile,
    matchesWorkItem,
    normalizeDavDirectoryUrl,
    parseCliArgs,
    parseDavMultistatus,
    sanitizeCaseIdForPath,
    shouldTraverseDirectory,
    writeJsonFileAtomic,
} from './freemdict-import-soak-util.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dirname, '..', '..');
const extensionPath = path.join(root, 'ext');
const manifestPath = path.join(extensionPath, 'manifest.json');
const logTag = '[freemdict-import-soak]';
const importTimeoutMs = 15 * 60 * 1000;

/**
 * @param {unknown} value
 * @returns {string}
 */
function errorMessage(value) {
    return value instanceof Error ? value.message : String(value);
}

/**
 * @param {string} message
 */
function fail(message) {
    throw new Error(`${logTag} ${message}`);
}

/**
 * @returns {string | null}
 */
function getConfiguredExtensionId() {
    if (!existsSync(manifestPath)) {
        return null;
    }

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof manifest?.key !== 'string' || manifest.key.length === 0) {
        return null;
    }

    const hash = createHash('sha256')
        .update(Buffer.from(manifest.key, 'base64'))
        .digest('hex')
        .slice(0, 32);
    return [...hash].map((character) => String.fromCharCode('a'.charCodeAt(0) + Number.parseInt(character, 16))).join('');
}

/**
 * @returns {boolean}
 */
function shouldRunHeadless() {
    const value = String(process.env.MANABITAN_CHROMIUM_HEADLESS ?? (process.platform === 'win32' ? '0' : '1')).trim().toLowerCase();
    return !(value === '0' || value === 'false' || value === 'no');
}

/**
 * @returns {boolean}
 */
function shouldHideWindow() {
    const value = String(process.env.MANABITAN_CHROMIUM_HIDE_WINDOW ?? (process.platform === 'win32' ? '1' : '0')).trim().toLowerCase();
    return !(value === '0' || value === 'false' || value === 'no');
}

/**
 * @returns {Promise<{context: import('@playwright/test').BrowserContext, cleanup: () => Promise<void>}>}
 */
async function launchExtensionContext() {
    const originalManifest = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : null;
    const manifestUtil = new ManifestUtil();
    const variant = manifestUtil.getManifest('chrome-playwright');
    writeFileSync(
        manifestPath,
        ManifestUtil.createManifestString(variant).replace('$YOMITAN_VERSION', '0.0.0.0'),
        'utf8',
    );

    const headless = shouldRunHeadless();
    /** @type {string[]} */
    const args = [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--disable-crash-reporter',
        '--disable-crashpad',
    ];
    if (!headless && shouldHideWindow()) {
        args.push('--window-position=3000,3000', '--window-size=1280,800', '--start-minimized');
    }

    const context = await chromium.launchPersistentContext('', {
        headless,
        args,
    });

    return {
        context,
        cleanup: async () => {
            await context.close();
            if (originalManifest === null) {
                await rm(manifestPath, {force: true});
            } else {
                writeFileSync(manifestPath, originalManifest, 'utf8');
            }
        },
    };
}

/**
 * @param {import('@playwright/test').BrowserContext} context
 * @returns {Promise<string>}
 */
async function discoverExtensionId(context) {
    const configuredExtensionId = getConfiguredExtensionId();
    if (configuredExtensionId !== null) {
        return configuredExtensionId;
    }

    const parseId = (url) => {
        const match = /^chrome-extension:\/\/([^/]+)\//.exec(String(url));
        return match ? match[1] : null;
    };

    for (const worker of context.serviceWorkers()) {
        const id = parseId(worker.url());
        if (id !== null) {
            return id;
        }
    }

    await context.waitForEvent('serviceworker', {timeout: 15_000});
    for (const worker of context.serviceWorkers()) {
        const id = parseId(worker.url());
        if (id !== null) {
            return id;
        }
    }

    fail('Unable to discover Chromium extension ID');
}

/**
 * @param {import('@playwright/test').BrowserContext} context
 * @returns {Promise<void>}
 */
async function closeWelcomePages(context) {
    for (const page of context.pages()) {
        if (page.url().endsWith('/welcome.html')) {
            await page.close();
        }
    }
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} url
 * @param {string} readySelector
 * @returns {Promise<void>}
 */
async function gotoExtensionPage(page, url, readySelector) {
    let lastError;
    for (let attempt = 1; attempt <= 10; ++attempt) {
        try {
            await page.goto(url);
            await page.waitForSelector(readySelector, {state: 'attached', timeout: 30_000});
            return;
        } catch (error) {
            lastError = error;
            if (!String(errorMessage(error)).includes('ERR_ABORTED') || attempt >= 10) {
                throw error;
            }
            await page.waitForTimeout(500);
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} action
 * @param {Record<string, unknown>|undefined} params
 * @returns {Promise<unknown>}
 */
async function sendRuntimeMessage(page, action, params = void 0) {
    return await page.evaluate(async ({actionName, paramsValue}) => {
        return await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({action: actionName, params: paramsValue}, (response) => {
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
        });
    }, {actionName: action, paramsValue: params});
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<void>}
 */
async function waitForSettingsPageReady(page) {
    const deadline = safePerformance.now() + 30_000;
    while (safePerformance.now() < deadline) {
        const ready = await page.evaluate(() => {
            const html = document.documentElement;
            const dictionaries = document.querySelector('#dictionaries');
            const fileInput = document.querySelector('#dictionary-import-file-input');
            return (
                html instanceof HTMLElement &&
                html.dataset.loaded === 'true' &&
                dictionaries instanceof HTMLElement &&
                dictionaries.hidden === false &&
                fileInput instanceof HTMLInputElement
            );
        });
        if (ready) {
            return;
        }
        await page.waitForTimeout(250);
    }
    fail('Timed out waiting for settings page readiness');
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<unknown[]>}
 */
async function getDictionaryInfoRuntime(page) {
    return await sendRuntimeMessage(page, 'getDictionaryInfo', void 0);
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string>}
 */
async function getImportProgressLabel(page) {
    return await page.evaluate(() => {
        const selectors = [
            '#recommended-dictionaries-modal .dictionary-import-progress',
            '#dictionaries-modal .dictionary-import-progress',
        ];
        for (const selector of selectors) {
            const container = document.querySelector(selector);
            if (!(container instanceof HTMLElement) || container.hidden) { continue; }
            const label = container.querySelector('.progress-info');
            if (!(label instanceof HTMLElement)) { continue; }
            const text = (label.textContent || '').trim();
            if (text.length > 0) { return text; }
        }
        return '';
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<boolean>}
 */
async function isImportUiIdle(page) {
    return await page.evaluate(() => {
        const fileInput = document.querySelector('#dictionary-import-file-input');
        if (fileInput instanceof HTMLInputElement && fileInput.disabled) {
            return false;
        }
        const activeProgress = document.querySelector(
            '#dictionaries-modal .dictionary-import-progress:not([hidden]), #recommended-dictionaries-modal .dictionary-import-progress:not([hidden])',
        );
        return activeProgress === null;
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string>}
 */
async function getDictionaryErrorText(page) {
    return await page.evaluate(() => {
        const node = document.querySelector('#dictionary-error');
        if (!(node instanceof HTMLElement) || node.hidden) { return ''; }
        return (node.textContent || '').trim();
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<unknown>}
 */
async function getOpfsOpenDiagnostics(page) {
    try {
        return await page.evaluate(async () => {
            const mod = await import('/js/dictionary/sqlite-wasm.js');
            if (typeof mod.getLastOpenStorageDiagnostics !== 'function') {
                return null;
            }
            return mod.getLastOpenStorageDiagnostics();
        });
    } catch (_) {
        return null;
    }
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<unknown>}
 */
async function getLastImportDebug(page) {
    try {
        return await page.evaluate(() => Reflect.get(globalThis, '__manabitanLastImportDebug') ?? null);
    } catch (_) {
        return null;
    }
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} label
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function waitForImportCompletion(page, label, timeoutMs) {
    const start = safePerformance.now();
    const deadline = start + timeoutMs;
    let sawStepText = false;
    let emptySince = null;
    while (safePerformance.now() < deadline) {
        const errorText = await getDictionaryErrorText(page);
        if (errorText.length > 0) {
            const opfsDiagnostics = await getOpfsOpenDiagnostics(page);
            const lastImportDebug = await getLastImportDebug(page);
            fail(
                `${label} import reported error before completion: ${errorText}; ` +
                `opfsOpenDiagnostics=${JSON.stringify(opfsDiagnostics)}; lastImportDebug=${JSON.stringify(lastImportDebug)}`,
            );
        }
        const progressLabel = await getImportProgressLabel(page);
        if (progressLabel.includes('Step ')) {
            sawStepText = true;
            emptySince = null;
        }
        if (sawStepText && progressLabel.length === 0) {
            emptySince ??= safePerformance.now();
            if (safePerformance.now() - emptySince >= 2000 && await isImportUiIdle(page)) {
                return;
            }
        }
        await page.waitForTimeout(250);
    }
    fail(`Timed out waiting for ${label} import completion`);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} timeoutMs
 * @returns {Promise<unknown[]>}
 */
async function waitForImportedDictionaryInfo(page, timeoutMs = 30_000) {
    const deadline = safePerformance.now() + timeoutMs;
    while (safePerformance.now() < deadline) {
        const info = await getDictionaryInfoRuntime(page);
        if (Array.isArray(info) && info.length > 0) {
            return info;
        }
        await page.waitForTimeout(250);
    }
    fail('Timed out waiting for imported dictionary metadata');
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} extensionBaseUrl
 * @returns {Promise<void>}
 */
async function purgeExtensionState(page, extensionBaseUrl) {
    await gotoExtensionPage(page, `${extensionBaseUrl}/settings.html`, '#dictionary-import-file-input');
    await waitForSettingsPageReady(page);
    let lastError = null;
    for (let attempt = 1; attempt <= 3; ++attempt) {
        try {
            await sendRuntimeMessage(page, 'purgeDatabase', void 0);
            try {
                await sendRuntimeMessage(page, 'triggerDatabaseUpdated', {type: 'dictionary', cause: 'purge'});
            } catch (_) {
                // Best effort UI refresh hint.
            }
            await page.reload();
            await waitForSettingsPageReady(page);
            const deadline = safePerformance.now() + 30_000;
            while (safePerformance.now() < deadline) {
                const info = await getDictionaryInfoRuntime(page);
                if (Array.isArray(info) && info.length === 0) {
                    return;
                }
                await page.waitForTimeout(250);
            }
            fail('Timed out waiting for purgeDatabase to clear installed dictionaries');
        } catch (error) {
            lastError = error;
            await page.reload();
            await waitForSettingsPageReady(page);
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * @param {string} url
 * @param {string} destinationPath
 * @returns {Promise<{downloadedBytes: number, contentType: string|null}>}
 */
async function downloadFileToPath(url, destinationPath) {
    await mkdir(path.dirname(destinationPath), {recursive: true});
    const response = await fetch(url);
    if (!response.ok) {
        fail(`Failed to download ${url}: ${String(response.status)} ${response.statusText}`);
    }
    if (response.body === null) {
        fail(`Download returned an empty response body for ${url}`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(destinationPath));
    const fileStats = await stat(destinationPath);
    return {
        downloadedBytes: fileStats.size,
        contentType: response.headers.get('content-type'),
    };
}

/**
 * @param {string} rootDavUrl
 * @param {string} directoryUrl
 * @returns {Promise<import('./freemdict-import-soak-util.js').DavEntry[]>}
 */
async function fetchDavListing(rootDavUrl, directoryUrl) {
    const normalizedDirectoryUrl = normalizeDavDirectoryUrl(directoryUrl);
    const response = await fetch(normalizedDirectoryUrl, {
        method: 'PROPFIND',
        headers: {
            Depth: '1',
        },
    });
    if (!response.ok) {
        fail(`Failed to enumerate ${normalizedDirectoryUrl}: ${String(response.status)} ${response.statusText}`);
    }
    const xml = await response.text();
    return parseDavMultistatus(xml, normalizedDirectoryUrl, rootDavUrl);
}

/**
 * @param {string} rootDavUrl
 * @returns {{version: number, shareUrl: string, rootDavUrl: string, createdAtIso: string, updatedAtIso: string, queue: import('./freemdict-import-soak-util.js').WorkItem[]}}
 */
function createInitialState(rootDavUrl) {
    return {
        version: 1,
        shareUrl: DEFAULT_FREEMDICT_SHARE_URL,
        rootDavUrl,
        createdAtIso: new Date().toISOString(),
        updatedAtIso: new Date().toISOString(),
        queue: [{
            type: 'directory',
            id: 'dir:.',
            url: rootDavUrl,
            relativePath: '',
        }],
    };
}

/**
 * @param {string} rootDavUrl
 * @returns {{
 *   version: number,
 *   shareUrl: string,
 *   rootDavUrl: string,
 *   createdAtIso: string,
 *   updatedAtIso: string,
 *   completedAtIso: string|null,
 *   entries: Array<Record<string, unknown>>,
 *   counts: {passed: number, failed: number, skipped: number},
 * }}
 */
function createInitialReport(rootDavUrl) {
    return {
        version: 1,
        shareUrl: DEFAULT_FREEMDICT_SHARE_URL,
        rootDavUrl,
        createdAtIso: new Date().toISOString(),
        updatedAtIso: new Date().toISOString(),
        completedAtIso: null,
        entries: [],
        counts: {
            passed: 0,
            failed: 0,
            skipped: 0,
        },
    };
}

/**
 * @param {ReturnType<typeof createInitialReport>} report
 * @returns {Set<string>}
 */
function getReportedEntryIds(report) {
    return new Set(
        (Array.isArray(report.entries) ? report.entries : [])
            .map((entry) => String(entry?.id || '').trim())
            .filter((value) => value.length > 0),
    );
}

/**
 * @param {ReturnType<typeof createInitialReport>} report
 * @param {Record<string, unknown>} entry
 * @returns {void}
 */
function appendReportEntry(report, entry) {
    report.entries.push(entry);
    switch (entry.status) {
        case 'passed':
            report.counts.passed += 1;
            break;
        case 'failed':
            report.counts.failed += 1;
            break;
        default:
            report.counts.skipped += 1;
            break;
    }
    report.updatedAtIso = new Date().toISOString();
    report.completedAtIso = null;
}

/**
 * @param {ReturnType<typeof createInitialState>} state
 * @param {string} stateFile
 * @returns {Promise<void>}
 */
async function persistState(state, stateFile) {
    state.updatedAtIso = new Date().toISOString();
    await writeJsonFileAtomic(stateFile, state);
}

/**
 * @param {ReturnType<typeof createInitialReport>} report
 * @param {string} reportFile
 * @returns {Promise<void>}
 */
async function persistReport(report, reportFile) {
    report.updatedAtIso = new Date().toISOString();
    await writeJsonFileAtomic(reportFile, report);
}

/**
 * @param {import('./freemdict-import-soak-util.js').CaseWorkItem} item
 * @param {string} tempRoot
 * @param {boolean} keepFailed
 * @param {import('@playwright/test').Page} page
 * @param {string} extensionBaseUrl
 * @returns {Promise<Record<string, unknown>>}
 */
async function processCase(item, tempRoot, keepFailed, page, extensionBaseUrl) {
    const startedAtIso = new Date().toISOString();
    const startedAtMs = safePerformance.now();
    const tempDirectory = path.join(tempRoot, sanitizeCaseIdForPath(item.id));
    /** @type {Array<Record<string, unknown>>} */
    const downloadedFiles = [];
    /** @type {'passed'|'failed'} */
    let status = 'failed';
    /** @type {Record<string, unknown>|null} */
    let result = null;

    await rm(tempDirectory, {recursive: true, force: true});
    await mkdir(tempDirectory, {recursive: true});

    try {
        await purgeExtensionState(page, extensionBaseUrl);

        /** @type {string[]} */
        const importPaths = [];
        for (const [index, file] of item.files.entries()) {
            const destinationPath = path.join(tempDirectory, `${String(index).padStart(2, '0')}-${path.basename(file.relativePath)}`);
            const downloadResult = await downloadFileToPath(file.url, destinationPath);
            importPaths.push(destinationPath);
            downloadedFiles.push({
                url: file.url,
                relativePath: file.relativePath,
                localPath: destinationPath,
                downloadedBytes: downloadResult.downloadedBytes,
                contentType: downloadResult.contentType ?? file.contentType ?? null,
            });
        }

        await gotoExtensionPage(page, `${extensionBaseUrl}/settings.html`, '#dictionary-import-file-input');
        await waitForSettingsPageReady(page);
        await page.locator('#dictionary-import-file-input').setInputFiles(importPaths);
        await waitForImportCompletion(page, item.relativePath, importTimeoutMs);

        const dictionaryInfo = await waitForImportedDictionaryInfo(page);
        status = 'passed';
        result = {
            id: item.id,
            type: item.caseType,
            status,
            relativePath: item.relativePath,
            startedAtIso,
            finishedAtIso: new Date().toISOString(),
            elapsedMs: Math.max(0, safePerformance.now() - startedAtMs),
            files: downloadedFiles,
            importedDictionaryCount: dictionaryInfo.length,
            importedDictionaries: dictionaryInfo.map((dictionary) => ({
                title: String(dictionary?.title || ''),
                revision: String(dictionary?.revision || ''),
                version: Number(dictionary?.version || 0),
            })),
            tempDirectory,
            tempDirectoryCleaned: true,
        };
    } catch (error) {
        result = {
            id: item.id,
            type: item.caseType,
            status,
            relativePath: item.relativePath,
            startedAtIso,
            finishedAtIso: new Date().toISOString(),
            elapsedMs: Math.max(0, safePerformance.now() - startedAtMs),
            files: downloadedFiles,
            error: errorMessage(error),
            tempDirectory,
            tempDirectoryCleaned: !keepFailed,
        };
    } finally {
        try {
            await purgeExtensionState(page, extensionBaseUrl);
        } catch (cleanupError) {
            if (result !== null) {
                result.cleanupError = errorMessage(cleanupError);
            }
        }
        const preserve = keepFailed && status === 'failed';
        await cleanupCaseTempDir(tempDirectory, {preserve});
        if (result !== null) {
            result.tempDirectoryCleaned = !preserve;
            if (preserve) {
                result.preservedTempDirectory = tempDirectory;
            }
        }
    }

    return /** @type {Record<string, unknown>} */ (result);
}

/**
 * @param {import('./freemdict-import-soak-util.js').SkipWorkItem} item
 * @returns {Record<string, unknown>}
 */
function createSkipReportEntry(item) {
    return {
        id: item.id,
        type: 'skip',
        status: 'skipped',
        relativePath: item.relativePath,
        reason: item.reason,
        files: item.files,
        finishedAtIso: new Date().toISOString(),
    };
}

function printHelp() {
    console.log(`
${logTag} Sequential FreeMdict import soak runner

Options:
  --resume                  Resume from the checkpoint file (default behavior).
  --limit <n>               Process at most <n> supported dictionary cases this run.
  --match <text>            Only process/report items whose share path contains <text>.
  --state-file <path>       Override the checkpoint file path.
  --report-file <path>      Override the JSON report file path.
  --temp-dir <path>         Override the download temp directory path.
  --keep-failed             Preserve downloaded files for failed cases.
  --help                    Show this help text.
`.trim());
}

/**
 * @returns {Promise<void>}
 */
async function main() {
    const defaultStateFile = path.join(root, 'builds', 'freemdict-import-soak-state.json');
    const defaultReportFile = path.join(root, 'builds', 'freemdict-import-soak-report.json');
    const defaultTempDir = path.join(root, 'builds', 'freemdict-import-soak-tmp');
    const cliArgs = parseCliArgs(process.argv.slice(2), {
        stateFile: defaultStateFile,
        reportFile: defaultReportFile,
        tempDir: defaultTempDir,
    });
    if (cliArgs.help) {
        printHelp();
        return;
    }

    const rootDavUrl = normalizeDavDirectoryUrl(DEFAULT_FREEMDICT_DAV_URL);
    const fallbackState = createInitialState(rootDavUrl);
    const fallbackReport = createInitialReport(rootDavUrl);
    const state = await loadJsonFile(cliArgs.stateFile, fallbackState);
    const report = await loadJsonFile(cliArgs.reportFile, fallbackReport);
    const reportedEntryIds = getReportedEntryIds(report);

    if (!Array.isArray(state.queue)) {
        state.queue = fallbackState.queue;
    }
    if (state.queue.length === 0) {
        report.completedAtIso ??= new Date().toISOString();
        await persistReport(report, cliArgs.reportFile);
        console.log(`${logTag} no pending work remains`);
        return;
    }

    await cleanupTempRoot(cliArgs.tempDir, {removeAll: !cliArgs.keepFailed});
    await mkdir(cliArgs.tempDir, {recursive: true});

    let cleanup = null;
    /** @type {Error|undefined} */
    let runError;
    let processedCasesThisRun = 0;
    let interrupted = false;
    const onInterrupt = () => {
        interrupted = true;
    };
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onInterrupt);

    try {
        const launched = await launchExtensionContext();
        cleanup = launched.cleanup;
        const {context} = launched;
        await closeWelcomePages(context);
        const extensionId = await discoverExtensionId(context);
        const extensionBaseUrl = `chrome-extension://${extensionId}`;
        const page = context.pages()[0] ?? await context.newPage();
        await gotoExtensionPage(page, `${extensionBaseUrl}/settings.html`, '#dictionary-import-file-input');
        await waitForSettingsPageReady(page);
        await purgeExtensionState(page, extensionBaseUrl);

        while (state.queue.length > 0) {
            if (interrupted) {
                console.warn(`${logTag} interrupt received; stopping after current checkpoint`);
                break;
            }

            const current = state.queue[0];
            if (current.type !== 'directory' && reportedEntryIds.has(current.id)) {
                state.queue.shift();
                await persistState(state, cliArgs.stateFile);
                continue;
            }

            if (current.type === 'directory') {
                if (!shouldTraverseDirectory(current, cliArgs.match)) {
                    state.queue.shift();
                    await persistState(state, cliArgs.stateFile);
                    continue;
                }
                console.log(`${logTag} enumerate ${current.relativePath || '.'}`);
                const listing = await fetchDavListing(rootDavUrl, current.url);
                const discoveredItems = discoverDirectoryWorkItems(rootDavUrl, current.url, listing);
                state.queue.splice(0, 1, ...discoveredItems);
                await persistState(state, cliArgs.stateFile);
                continue;
            }

            if (!matchesWorkItem(current, cliArgs.match)) {
                state.queue.shift();
                await persistState(state, cliArgs.stateFile);
                continue;
            }

            if (current.type === 'case' && cliArgs.limit !== null && processedCasesThisRun >= cliArgs.limit) {
                break;
            }

            let entry;
            if (current.type === 'skip') {
                entry = createSkipReportEntry(current);
                console.log(`${logTag} skip ${current.relativePath} (${current.reason})`);
            } else {
                console.log(`${logTag} import ${current.relativePath}`);
                entry = await processCase(current, cliArgs.tempDir, cliArgs.keepFailed, page, extensionBaseUrl);
                processedCasesThisRun += 1;
                console.log(`${logTag} ${entry.status} ${current.relativePath}`);
            }

            appendReportEntry(report, entry);
            reportedEntryIds.add(String(entry.id || ''));
            await persistReport(report, cliArgs.reportFile);
            state.queue.shift();
            await persistState(state, cliArgs.stateFile);
        }

        if (state.queue.length === 0) {
            report.completedAtIso = new Date().toISOString();
            await persistReport(report, cliArgs.reportFile);
            console.log(`${logTag} completed full crawl`);
        } else if (cliArgs.limit !== null && processedCasesThisRun >= cliArgs.limit) {
            console.log(`${logTag} limit reached after ${String(processedCasesThisRun)} case(s)`);
        }
    } catch (error) {
        runError = new Error(`${logTag} ${errorMessage(error)}`);
    } finally {
        try {
            await cleanupTempRoot(cliArgs.tempDir, {removeAll: !cliArgs.keepFailed});
        } catch (_) {
            // Ignore best-effort temp cleanup failures.
        }
        if (cleanup !== null) {
            try {
                await cleanup();
            } catch (_) {
                // Ignore best-effort browser cleanup failures.
            }
        }
        process.removeListener('SIGINT', onInterrupt);
        process.removeListener('SIGTERM', onInterrupt);
    }

    if (runError) {
        throw runError;
    }
}

await main();
