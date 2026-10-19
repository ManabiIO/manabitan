/*
 * Copyright (C) 2023-2025  Yomitan Authors
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

import {chromium} from '@playwright/test';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import {access, mkdir, mkdtemp, readFile, realpath, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {safePerformance} from '../../ext/js/core/safe-performance.js';
import {createDictionaryArchiveData} from '../../dev/dictionary-archive-util.js';
import {applyAnkiDedupeOptions, dedupeDictionaryTitle, dedupeSearchTerm, getAnkiDedupeMatrix, isExpectedWriteResult, normalizeExpectedButtonState} from '../e2e/anki-dedupe-matrix.js';
import {startAnkiMockHttpServer} from '../e2e/anki-mock-http-server.js';
import {createAnkiMockState} from '../e2e/anki-mock-state.js';
import {writeCombinedTabbedReport} from '../e2e/report-tabs.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dirname, '..', '..');
const execFileAsync = promisify(execFile);
const logTag = '[chromium-anki-dedupe-e2e]';

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
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

/**
 * @returns {{
 *   startedAtIso: string,
 *   finishedAtIso: string,
 *   status: 'running'|'success'|'failure',
 *   failureReason: string,
 *   extensionBaseUrl: string,
 *   ankiConnectUrl: string,
 *   scenarios: Array<Record<string, unknown>>,
 * }}
 */
function createReport() {
    return {
        startedAtIso: new Date().toISOString(),
        finishedAtIso: '',
        status: 'running',
        failureReason: '',
        extensionBaseUrl: '',
        ankiConnectUrl: '',
        sourceIdentity: null,
        packageIdentity: null,
        browserIdentity: null,
        runtimeDiagnostics: null,
        scenarios: [],
    };
}

/**
 * @param {ReturnType<typeof createReport>} report
 * @returns {string}
 */
function renderReportHtml(report) {
    const rows = report.scenarios.map((scenario) => {
        const passed = scenario.pass === true;
        const className = passed ? 'row-pass' : 'row-fail';
        return `
            <tr class="${className}">
                <td>${escapeHtml(String(scenario.id || ''))}</td>
                <td>${escapeHtml(String(scenario.description || ''))}</td>
                <td>${escapeHtml(String(passed ? 'PASS' : 'FAIL'))}</td>
                <td><pre>${escapeHtml(JSON.stringify(scenario.expected, null, 2))}</pre></td>
                <td><pre>${escapeHtml(JSON.stringify(scenario.observed, null, 2))}</pre></td>
            </tr>
        `;
    }).join('\n');

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Chromium Anki Deduplication E2E Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; margin: 24px; color: #111827; }
    .meta { margin-bottom: 16px; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; background: #f9fafb; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #e5e7eb; padding: 8px; vertical-align: top; text-align: left; }
    th { background: #f3f4f6; }
    .row-pass { background: #ecfdf5; }
    .row-fail { background: #fef2f2; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
  <h1>Chromium Anki Deduplication E2E Report</h1>
  <div class="meta">
    <div><strong>Started:</strong> ${escapeHtml(report.startedAtIso)}</div>
    <div><strong>Finished:</strong> ${escapeHtml(report.finishedAtIso)}</div>
    <div><strong>Status:</strong> ${escapeHtml(report.status)}</div>
    <div><strong>Failure:</strong> ${escapeHtml(report.failureReason || 'none')}</div>
    <div><strong>Extension Base URL:</strong> ${escapeHtml(report.extensionBaseUrl)}</div>
    <div><strong>AnkiConnect URL:</strong> ${escapeHtml(report.ankiConnectUrl)}</div>
    <div><strong>Source:</strong> ${escapeHtml(report.sourceIdentity ? `${report.sourceIdentity.commit} (${report.sourceIdentity.tree})` : 'unknown')}</div>
    <div><strong>Package SHA-256:</strong> ${escapeHtml(report.packageIdentity?.sha256 || 'unknown')}</div>
    <div><strong>Browser:</strong> ${escapeHtml(report.browserIdentity ? `${report.browserIdentity.version} at ${report.browserIdentity.executablePath}` : 'unknown')}</div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Scenario</th>
        <th>Description</th>
        <th>Result</th>
        <th>Expected</th>
        <th>Observed</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</body>
</html>`;
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
 * @param {string} extensionPath
 * @param {string} userDataDir
 * @returns {Promise<{context: import('@playwright/test').BrowserContext, headless: boolean, args: string[]}>}
 */
async function launchExtensionContext(extensionPath, userDataDir) {
    const headless = shouldRunHeadless();
    /** @type {string[]} */
    const args = [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
    ];
    if (process.platform === 'darwin') { args.push('--disable-features=MacAppCodeSignClone'); }
    if (!headless && shouldHideWindow()) {
        args.push('--window-position=3000,3000', '--window-size=1280,800', '--start-minimized');
    }

    const context = await chromium.launchPersistentContext(userDataDir, {
        channel: 'chromium',
        headless,
        args,
    });
    return {context, headless, args};
}

/**
 * @param {import('@playwright/test').BrowserContext} context
 * @param {string} userDataDir
 * @param {string} extensionPath
 * @returns {Promise<string>}
 */
async function discoverExtensionId(context, userDataDir, extensionPath) {
    const parseId = (url) => {
        const match = /^chrome-extension:\/\/([^/]+)\//.exec(String(url));
        return match ? match[1] : null;
    };

    if (context.serviceWorkers().length === 0) {
        await context.waitForEvent('serviceworker', {timeout: 15_000}).catch(() => {});
    }
    for (const worker of context.serviceWorkers()) {
        const id = parseId(worker.url());
        if (id !== null) {
            return id;
        }
    }
    for (const page of context.pages()) {
        const id = parseId(page.url());
        if (id !== null) {
            return id;
        }
    }
    const extensionId = await readExtensionIdFromProfilePreferences(userDataDir, extensionPath);
    if (extensionId !== null) {
        return extensionId;
    }
    fail('Unable to discover extension id');
}

/**
 * @param {string} userDataDir
 * @param {string} extensionPath
 * @returns {Promise<string | null>}
 */
async function readExtensionIdFromProfilePreferences(userDataDir, extensionPath) {
    let manifestName = '';
    try {
        const manifest = JSON.parse(await readFile(path.join(extensionPath, 'manifest.json'), 'utf8'));
        manifestName = String(manifest?.name || '').trim();
    } catch (_) {
        return null;
    }
    const preferencesPaths = [
        path.join(userDataDir, 'Default', 'Preferences'),
        path.join(userDataDir, 'Preferences'),
    ];
    for (const preferencesPath of preferencesPaths) {
        try {
            const preferences = JSON.parse(await readFile(preferencesPath, 'utf8'));
            const settings = preferences?.extensions?.settings;
            if (!(settings && typeof settings === 'object' && !Array.isArray(settings))) {
                continue;
            }
            for (const [candidateId, value] of Object.entries(settings)) {
                if (!(value && typeof value === 'object' && !Array.isArray(value))) {
                    continue;
                }
                const candidatePath = String(value.path || '').trim();
                const normalizedCandidatePath = candidatePath.length > 0 ? path.resolve(userDataDir, candidatePath) : '';
                const candidateManifest = value.manifest && typeof value.manifest === 'object' && !Array.isArray(value.manifest) ? value.manifest : null;
                const candidateName = String(candidateManifest?.name || '').trim();
                if (normalizedCandidatePath === extensionPath || (manifestName.length > 0 && candidateName === manifestName)) {
                    return candidateId;
                }
            }
        } catch (_) {
            // Preferences may not exist until Chromium finishes extension registration.
        }
    }
    return null;
}

/**
 * @param {string} userDataDir
 * @returns {Promise<string>}
 */
async function readBrowserCommandLine(userDataDir) {
    const psArgs = process.platform === 'darwin' ? ['-axww', '-o', 'pid=,command='] : ['-eww', '-o', 'pid=,args='];
    const {stdout} = await execFileAsync('ps', psArgs);
    const executablePath = chromium.executablePath();
    const profileArgument = `--user-data-dir=${userDataDir}`;
    const commandLine = stdout.split('\n').map((line) => line.trim()).find((line) => (
        line.includes(executablePath) && line.includes(profileArgument)
    ));
    return commandLine || '';
}

/**
 * @param {string} ownedPath
 * @param {string} expectedPrefix
 * @returns {Promise<string>}
 */
async function moveOwnedPathToTrash(ownedPath, expectedPrefix) {
    const resolvedPath = await realpath(ownedPath);
    const resolvedTempDir = await realpath(os.tmpdir());
    if (path.dirname(resolvedPath) !== resolvedTempDir || !path.basename(resolvedPath).startsWith(expectedPrefix)) {
        fail(`Refusing to move unexpected temporary path to Trash: ${resolvedPath}`);
    }
    const trashDir = path.join(os.homedir(), '.Trash');
    await mkdir(trashDir, {recursive: true});
    const resolvedTrashDir = await realpath(trashDir);
    const destination = path.join(resolvedTrashDir, `${path.basename(resolvedPath)}-${Date.now()}-${process.pid}`);
    await rename(resolvedPath, destination);
    return destination;
}

/**
 * @returns {Promise<{packagePath: string, packageSha256: string, extensionPath: string, packageTempPath: string}>}
 */
async function buildAndExtractExtensionPackage() {
    const packagePath = path.join(root, 'builds', 'manabitan-chrome-playwright.zip');
    await execFileAsync(process.execPath, ['./dev/bin/build.js', '--target', 'chrome-playwright'], {
        cwd: root,
        maxBuffer: 20 * 1024 * 1024,
    });
    await access(packagePath);
    const packageBytes = await readFile(packagePath);
    const packageSha256 = createHash('sha256').update(packageBytes).digest('hex');
    const packageTempPath = await mkdtemp(path.join(os.tmpdir(), 'manabitan-chromium-anki-extension-'));
    try {
        await execFileAsync('unzip', ['-oq', packagePath, '-d', packageTempPath]);
    } catch (error) {
        try {
            await moveOwnedPathToTrash(packageTempPath, 'manabitan-chromium-anki-extension-');
        } catch (cleanupError) {
            throw new Error(`Package extraction failed: ${errorMessage(error)}; temporary extraction cleanup failed: ${errorMessage(cleanupError)}`, {cause: error});
        }
        throw error;
    }
    return {packagePath, packageSha256, extensionPath: packageTempPath, packageTempPath};
}

/**
 * @returns {Promise<{commit: string, tree: string}>}
 */
async function getSourceIdentity() {
    const [{stdout: commit}, {stdout: tree}] = await Promise.all([
        execFileAsync('git', ['rev-parse', 'HEAD'], {cwd: root}),
        execFileAsync('git', ['rev-parse', 'HEAD^{tree}'], {cwd: root}),
    ]);
    const [{stdout: status}, {stdout: diff}] = await Promise.all([
        execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=no'], {cwd: root}),
        execFileAsync('git', ['diff', '--binary', 'HEAD'], {cwd: root, maxBuffer: 20 * 1024 * 1024}),
    ]);
    return {
        commit: commit.trim(),
        tree: tree.trim(),
        workingTreeDirty: status.trim().length > 0,
        diffSha256: createHash('sha256').update(diff).digest('hex'),
        nodeVersion: process.version,
    };
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
            await page.waitForFunction(() => document.documentElement.dataset.loaded === 'true', {}, {timeout: 30_000});
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
    const paramsJson = params === void 0 ? null : JSON.stringify(params);
    return await page.evaluate(async ({actionName, serializedParams}) => {
        const paramsValue = serializedParams === null ? void 0 : JSON.parse(serializedParams);
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
    }, {actionName: action, serializedParams: paramsJson});
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} extensionBaseUrl
 * @returns {Promise<void>}
 */
async function importDictionaryFixture(page, extensionBaseUrl) {
    await gotoExtensionPage(page, `${extensionBaseUrl}/settings.html`, '#dictionary-import-file-input');
    await sendRuntimeMessage(page, 'purgeDatabase', void 0);
    const archive = Buffer.from(await createDictionaryArchiveData(
        path.join(root, 'test', 'data', 'dictionaries', 'valid-dictionary1'),
        dedupeDictionaryTitle,
    ));
    await page.locator('#dictionary-import-file-input').setInputFiles({
        name: 'anki-dedupe-fixture.zip',
        mimeType: 'application/zip',
        buffer: archive,
    });
    await sendRuntimeMessage(page, 'triggerDatabaseUpdated', {type: 'dictionary', cause: 'import'});
    const deadline = safePerformance.now() + 60_000;
    while (safePerformance.now() < deadline) {
        const dictionaryInfo = /** @type {Array<{title: string}>} */ (await sendRuntimeMessage(page, 'getDictionaryInfo', void 0));
        if (Array.isArray(dictionaryInfo) && dictionaryInfo.some((item) => String(item?.title || '') === dedupeDictionaryTitle)) {
            return;
        }
        await page.waitForTimeout(200);
    }
    fail(`Timed out waiting for dictionary import: ${dedupeDictionaryTitle}`);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} ankiConnectUrl
 * @param {import('../e2e/anki-dedupe-matrix.js').DedupeScenarioOptions} scenarioOptions
 * @returns {Promise<void>}
 */
async function applyScenarioOptions(page, ankiConnectUrl, scenarioOptions) {
    const optionsFull = /** @type {import('settings').Options} */ (await sendRuntimeMessage(page, 'optionsGetFull', void 0));
    applyAnkiDedupeOptions(optionsFull, ankiConnectUrl, scenarioOptions);
    await sendRuntimeMessage(page, 'setAllSettings', {value: optionsFull, source: 'chromium-anki-dedupe-e2e'});
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} extensionBaseUrl
 * @returns {Promise<void>}
 */
async function openSearchAndLookup(page, extensionBaseUrl) {
    await gotoExtensionPage(page, `${extensionBaseUrl}/search.html`, '#search-textbox');
    await page.fill('#search-textbox', dedupeSearchTerm);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
        const entry = document.querySelector('.entry');
        if (entry instanceof HTMLElement) { return true; }
        const noResults = document.querySelector('#no-results');
        return noResults instanceof HTMLElement && !noResults.hidden;
    }, {timeout: 30_000});
    const hasEntry = await page.evaluate(() => document.querySelector('.entry') instanceof HTMLElement);
    if (!hasEntry) {
        fail(`Search returned no entry for fixture term: ${dedupeSearchTerm}`);
    }
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ready: boolean, disabled: boolean, title: string, icon: string, overwrite: boolean, viewNoteIds: string|null}>}
 */
async function getSaveButtonState(page) {
    return await page.evaluate(() => {
        const saveButton = document.querySelector('.entry .note-actions-container .action-button[data-action="save-note"]');
        if (!(saveButton instanceof HTMLButtonElement)) {
            return {ready: false, disabled: true, title: '', icon: '', overwrite: false, viewNoteIds: null};
        }
        const iconNode = saveButton.querySelector('.action-icon');
        const icon = iconNode instanceof HTMLElement ? String(iconNode.dataset.icon || '') : '';
        const actionContainer = saveButton.closest('.action-button-container');
        const viewButton = actionContainer?.querySelector('.action-button[data-action="view-note"]');
        const viewNoteIdsRaw = viewButton instanceof HTMLElement ? String(viewButton.dataset.noteIds || '') : '';
        const viewNoteIds = viewNoteIdsRaw.trim().length > 0 ? viewNoteIdsRaw.trim().split(/\s+/).join(' ') : null;
        return {
            ready: true,
            disabled: saveButton.disabled,
            title: String(saveButton.title || ''),
            icon,
            overwrite: saveButton.dataset.overwrite === 'true',
            viewNoteIds,
        };
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {import('../e2e/anki-dedupe-matrix.js').DedupeExpectedButtonState} expectedState
 * @param {number} [timeoutMs]
 * @returns {Promise<{ready: boolean, disabled: boolean, title: string, icon: string, overwrite: boolean, viewNoteIds: string|null}>}
 */
async function waitForExpectedButtonState(page, expectedState, timeoutMs = 15_000) {
    const expected = normalizeExpectedButtonState(expectedState);
    const deadline = safePerformance.now() + timeoutMs;
    let lastState = await getSaveButtonState(page);
    while (safePerformance.now() < deadline) {
        lastState = await getSaveButtonState(page);
        if (
            lastState.ready &&
            lastState.disabled === expected.disabled &&
            (typeof expected.title === 'undefined' || lastState.title === expected.title) &&
            (typeof expected.icon === 'undefined' || lastState.icon === expected.icon) &&
            (typeof expected.overwrite === 'undefined' || lastState.overwrite === expected.overwrite) &&
            (typeof expected.viewNoteIds === 'undefined' || lastState.viewNoteIds === expected.viewNoteIds)
        ) {
            return lastState;
        }
        await page.waitForTimeout(200);
    }
    fail(`Timed out waiting for expected save button state. expected=${JSON.stringify(expected)} observed=${JSON.stringify(lastState)}`);
}

/**
 * @param {{actions: Array<{action: string}>}} scenarioState
 * @returns {Array<'addNote'|'updateNoteFields'>}
 */
function getWriteActions(scenarioState) {
    const output = [];
    for (const row of scenarioState.actions) {
        if (row.action === 'addNote' || row.action === 'updateNoteFields') {
            output.push(row.action);
        }
    }
    return output;
}

/**
 * @param {{actions: Array<{action: string, error: string|null, result: unknown}>}} scenarioState
 * @returns {Array<{action: string, error: string|null, result: unknown}>}
 */
function getWriteAttempts(scenarioState) {
    return scenarioState.actions.filter(({action}) => action === 'addNote' || action === 'updateNoteFields');
}

/**
 * @param {'addNote'|'updateNoteFields'|'none'} expectedAction
 * @param {Array<{action: string, error: string|null, result: unknown}>} observedAttempts
 * @returns {boolean}
 */
function isExpectedWriteAction(expectedAction, observedAttempts) {
    return isExpectedWriteResult(expectedAction, observedAttempts);
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<void>}
 */
async function clickSaveButton(page) {
    await page.click('.entry .note-actions-container .action-button[data-action="save-note"]');
}

/**
 * @returns {Promise<void>}
 */
async function main() {
    const report = createReport();
    const reportPath = process.env.MANABITAN_CHROMIUM_ANKI_DEDUPE_REPORT ?? path.join(root, 'builds', 'chromium-e2e-anki-dedupe-report.html');
    const reportJsonPath = reportPath.replace(/\.html$/i, '.json');
    const firefoxReportPath = path.join(root, 'builds', 'firefox-e2e-anki-dedupe-report.html');
    const combinedReportPath = path.join(root, 'builds', 'extension-e2e-anki-dedupe-report.html');
    const mockState = createAnkiMockState();
    const localServer = await startAnkiMockHttpServer(mockState);
    report.ankiConnectUrl = localServer.ankiConnectUrl;

    let context = null;
    let packageTempPath = null;
    let userDataDir = null;
    /** @type {Error|undefined} */
    let runError;
    try {
        if (process.versions.node !== '22.22.0') {
            fail(`Chromium Anki qualification requires Node.js 22.22.0; current runtime is ${process.version}`);
        }
        report.sourceIdentity = await getSourceIdentity();
        const builtPackage = await buildAndExtractExtensionPackage();
        packageTempPath = builtPackage.packageTempPath;
        userDataDir = await mkdtemp(path.join(os.tmpdir(), 'manabitan-chromium-anki-profile-'));
        report.packageIdentity = {
            path: builtPackage.packagePath,
            sha256: builtPackage.packageSha256,
            extractedPath: builtPackage.extensionPath,
        };
        const launched = await launchExtensionContext(builtPackage.extensionPath, userDataDir);
        context = launched.context;
        report.browserIdentity = {
            channel: 'chromium',
            headless: launched.headless,
            requestedArgs: launched.args,
            version: context.browser()?.version() ?? '',
            executablePath: chromium.executablePath(),
            userDataDir,
            commandLine: await readBrowserCommandLine(userDataDir),
        };
        if (report.browserIdentity.commandLine.length === 0) {
            fail(`Unable to capture Chromium command line for profile ${userDataDir}`);
        }

        for (const page of context.pages()) {
            if (page.url().endsWith('/welcome.html')) {
                await page.close();
            }
        }

        const extensionId = await discoverExtensionId(context, userDataDir, builtPackage.extensionPath);
        const extensionBaseUrl = `chrome-extension://${extensionId}`;
        report.extensionBaseUrl = extensionBaseUrl;
        const page = context.pages()[0] ?? await context.newPage();

        await gotoExtensionPage(page, `${extensionBaseUrl}/settings.html`, '#dictionary-import-file-input');
        const runtimeIdentity = await page.evaluate(() => ({origin: location.origin, runtimeId: chrome.runtime?.id ?? ''}));
        if (runtimeIdentity.origin !== extensionBaseUrl || runtimeIdentity.runtimeId !== extensionId) {
            fail(`Chromium extension origin/runtime identity mismatch: ${JSON.stringify(runtimeIdentity)}`);
        }

        const runtimeDiagnostics = await sendRuntimeMessage(page, 'debugDictionaryStorageState');
        report.runtimeDiagnostics = runtimeDiagnostics;
        const storageDiagnostics = runtimeDiagnostics?.openStorageDiagnostics;
        const worker = storageDiagnostics?.runtimeContext;
        const opfsReady = (
            runtimeDiagnostics?.usesFallbackStorage === false &&
            worker?.hasStorageGetDirectory === true &&
            worker?.isDedicatedWorkerGlobalScope === true &&
            worker?.hasCreateSyncAccessHandle === true &&
            storageDiagnostics?.hasOpfsSahpoolVfs === true &&
            storageDiagnostics?.opfsSahpoolInstallResult === 'installed' &&
            storageDiagnostics?.mode === 'opfs-sahpool'
        );
        if (!opfsReady) {
            fail(`Chromium Anki matrix OPFS runtime check failed: ${JSON.stringify(runtimeDiagnostics)}`);
        }
        await importDictionaryFixture(page, extensionBaseUrl);

        const matrix = getAnkiDedupeMatrix();
        for (const scenario of matrix) {
            const startedAt = safePerformance.now();
            try {
                mockState.beginScenario(scenario.id, scenario.seedNotes);
                await applyScenarioOptions(page, localServer.ankiConnectUrl, scenario.options);
                await openSearchAndLookup(page, extensionBaseUrl);
                const observedButtonState = await waitForExpectedButtonState(page, scenario.expected.button);
                const clickAttempted = !observedButtonState.disabled;
                if (clickAttempted) {
                    await clickSaveButton(page);
                    await page.waitForTimeout(800);
                } else {
                    await page.waitForTimeout(300);
                }
                const scenarioState = mockState.getScenarioState();
                const writeActions = getWriteActions(scenarioState);
                const pass = isExpectedWriteAction(scenario.expected.writeAction, getWriteAttempts(scenarioState));
                const endedAt = safePerformance.now();
                report.scenarios.push({
                    id: scenario.id,
                    description: scenario.description,
                    pass,
                    durationMs: Math.max(0, endedAt - startedAt),
                    expected: scenario.expected,
                    observed: {
                        button: observedButtonState,
                        clickAttempted,
                        writeActions,
                    },
                    actionLog: scenarioState.actions,
                    snapshots: scenarioState.snapshots,
                });
                console.log(`${logTag} scenario ${scenario.id} => ${pass ? 'PASS' : 'FAIL'}`);
            } catch (scenarioError) {
                const scenarioState = mockState.getScenarioState();
                const endedAt = safePerformance.now();
                report.scenarios.push({
                    id: scenario.id,
                    description: scenario.description,
                    pass: false,
                    durationMs: Math.max(0, endedAt - startedAt),
                    expected: scenario.expected,
                    observed: {
                        error: errorMessage(scenarioError),
                        writeActions: getWriteActions(scenarioState),
                    },
                    actionLog: scenarioState.actions,
                    snapshots: scenarioState.snapshots,
                });
                console.log(`${logTag} scenario ${scenario.id} => FAIL (${errorMessage(scenarioError)})`);
            }
        }

        if (report.scenarios.some((item) => item.pass !== true)) {
            const failedIds = report.scenarios.filter((item) => item.pass !== true).map((item) => item.id);
            fail(`Dedupe matrix failures: ${JSON.stringify(failedIds)}`);
        }
        report.status = 'success';
    } catch (e) {
        report.status = 'failure';
        report.failureReason = errorMessage(e);
        runError = new Error(`${logTag} ${report.failureReason}`);
    } finally {
        try {
            await localServer.close();
        } catch (cleanupError) {
            console.error(`${logTag} mock server cleanup failed: ${errorMessage(cleanupError)}`);
            runError ??= new Error(`${logTag} mock server cleanup failed: ${errorMessage(cleanupError)}`);
            report.status = 'failure';
            report.failureReason ||= errorMessage(runError);
        }
        if (context !== null) {
            try {
                await context.close();
            } catch (cleanupError) {
                console.error(`${logTag} browser cleanup failed: ${errorMessage(cleanupError)}`);
                try {
                    await context.browser()?.close();
                } catch (browserCleanupError) {
                    console.error(`${logTag} browser process cleanup failed: ${errorMessage(browserCleanupError)}`);
                }
                runError ??= new Error(`${logTag} browser cleanup failed: ${errorMessage(cleanupError)}`);
                report.status = 'failure';
                report.failureReason ||= errorMessage(runError);
            }
        }
        for (const [ownedPath, expectedPrefix] of [
            [userDataDir, 'manabitan-chromium-anki-profile-'],
            [packageTempPath, 'manabitan-chromium-anki-extension-'],
        ]) {
            if (ownedPath === null) {
                continue;
            }
            try {
                const trashedPath = await moveOwnedPathToTrash(ownedPath, expectedPrefix);
                console.log(`${logTag} moved temporary browser data to Trash: ${trashedPath}`);
            } catch (cleanupError) {
                console.error(`${logTag} temporary data cleanup failed: ${errorMessage(cleanupError)}`);
                runError ??= new Error(`${logTag} temporary data cleanup failed: ${errorMessage(cleanupError)}`);
                report.status = 'failure';
                report.failureReason ||= errorMessage(runError);
            }
        }
        report.finishedAtIso = new Date().toISOString();
        try {
            await mkdir(path.dirname(reportPath), {recursive: true});
            await writeFile(reportPath, renderReportHtml(report), 'utf8');
            await writeFile(reportJsonPath, JSON.stringify(report, null, 2), 'utf8');
            await writeCombinedTabbedReport({
                chromiumReportPath: reportPath,
                firefoxReportPath,
                outputPath: combinedReportPath,
            });
            console.log(`${logTag} wrote report: ${reportPath}`);
            console.log(`${logTag} wrote report json: ${reportJsonPath}`);
            console.log(`${logTag} wrote combined report: ${combinedReportPath}`);
        } catch (reportError) {
            console.error(`${logTag} failed to write final report: ${errorMessage(reportError)}`);
            runError ??= new Error(`${logTag} failed to write final report: ${errorMessage(reportError)}`);
        }
    }

    if (runError) {
        throw runError;
    }
}

await main();
