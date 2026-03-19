#!/usr/bin/env node
/*
 * Copyright (C) 2026  Manabitan authors
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

import path from 'node:path';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {access, mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {chromium} from '@playwright/test';
import {safePerformance} from '../../ext/js/core/safe-performance.js';
import {ManifestUtil} from '../../dev/manifest-util.js';
import {
    localEnglishMdxDictionaryTitle,
    localEnglishMdxFixtureFileName,
    localMdxDictionaryTitle,
    localMdxFixtureFileName,
} from '../playwright/mdx-import-harness.js';

const nodeMajorVersion = Number.parseInt(process.versions.node.split('.')[0], 10);
if (!Number.isFinite(nodeMajorVersion) || nodeMajorVersion < 22) {
    console.error(
        `Chromium MDX import benchmarks require Node.js 22 or newer. Detected ${process.version}. ` +
        'Use Node.js 22+ for deterministic benchmark collection.',
    );
    process.exit(1);
}

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dirname, '..', '..');
const extensionPath = path.join(root, 'ext');
const manifestPath = path.join(extensionPath, 'manifest.json');
const logTag = '[mdx-import-benchmark]';
const importTimeoutMs = 5 * 60 * 1000;

/**
 * @typedef {{
 *   label: string,
 *   files: string[],
 *   expectedTitles: string[],
 *   expectedDictionaryCount: number,
 *   inputBytes: number,
 * }} BenchCase
 */

/**
 * @typedef {{
 *   iterations: number,
 *   warmupIterations: number,
 *   reportFile: string,
 *   caseLabels: Set<string>,
 *   casesJson: string|null,
 *   casesFile: string|null,
 *   importFlags: Record<string, unknown>|null,
 *   help: boolean,
 * }} CliOptions
 */

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
 * @param {unknown} value
 * @returns {number}
 */
function asNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @param {number[]} values
 * @returns {number}
 */
function median(values) {
    if (values.length === 0) { return 0; }
    const sorted = [...values].sort((a, b) => a - b);
    const middleIndex = Math.floor(sorted.length / 2);
    if ((sorted.length % 2) === 1) {
        return sorted[middleIndex];
    }
    return (sorted[middleIndex - 1] + sorted[middleIndex]) / 2;
}

/**
 * @param {number} valueMs
 * @returns {string}
 */
function formatDurationMs(valueMs) {
    return `${valueMs.toFixed(1)}ms`;
}

/**
 * @param {number[]} values
 * @returns {{count: number, min: number, max: number, average: number, median: number}|null}
 */
function summarizeValues(values) {
    if (values.length === 0) { return null; }
    return {
        count: values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        average: values.reduce((sum, value) => sum + value, 0) / values.length,
        median: median(values),
    };
}

/**
 * @param {Array<Record<string, number>>} rows
 * @returns {Record<string, {count: number, min: number, max: number, average: number, median: number}>}
 */
function summarizeNamedMetrics(rows) {
    /** @type {Map<string, number[]>} */
    const valuesByName = new Map();
    for (const row of rows) {
        for (const [name, value] of Object.entries(row)) {
            const values = valuesByName.get(name) ?? [];
            values.push(value);
            valuesByName.set(name, values);
        }
    }
    return Object.fromEntries(
        [...valuesByName.entries()]
            .sort((a, b) => a[0].localeCompare(b[0], 'en'))
            .map(([name, values]) => {
                const summary = summarizeValues(values);
                return [name, summary];
            })
            .filter(([, value]) => value !== null),
    );
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isMdxPath(value) {
    return /\.mdx$/i.test(value);
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isMddPath(value) {
    return /(?:\.\d+)?\.mdd$/i.test(value);
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizePath(value) {
    const trimmed = String(value || '').trim();
    if (trimmed.length === 0) {
        return trimmed;
    }
    return path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function parseBoolean(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return !(normalized === '0' || normalized === 'false' || normalized === 'no');
}

/**
 * @param {string} extensionBaseUrl
 * @returns {string}
 */
function getSettingsPageUrl(extensionBaseUrl) {
    return `${extensionBaseUrl}/settings.html?popup-preview=false`;
}

/**
 * @returns {boolean}
 */
function shouldRunHeadless() {
    return parseBoolean(process.env.MANABITAN_CHROMIUM_HEADLESS ?? (process.platform === 'win32' ? '0' : '1'));
}

/**
 * @returns {boolean}
 */
function shouldHideWindow() {
    return parseBoolean(process.env.MANABITAN_CHROMIUM_HIDE_WINDOW ?? (process.platform === 'win32' ? '1' : '0'));
}

/**
 * @returns {string | null}
 */
function getConfiguredExtensionId() {
    if (!existsSync(manifestPath)) {
        return null;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const key = typeof manifest?.key === 'string' ? manifest.key : '';
    if (key.length === 0) {
        return null;
    }
    const bytes = Buffer.from(key, 'base64');
    const hash = createHash('sha256')
        .update(bytes)
        .digest('hex')
        .slice(0, 32);
    return [...hash].map((character) => String.fromCharCode('a'.charCodeAt(0) + Number.parseInt(character, 16))).join('');
}

/**
 * @param {import('@playwright/test').BrowserContext} context
 * @returns {Promise<string>}
 */
async function discoverExtensionId(context) {
    const parseId = (url) => {
        const match = /^chrome-extension:\/\/([^/]+)\//.exec(String(url));
        return match ? match[1] : null;
    };

    const getIdFromWorkers = () => {
        for (const worker of context.serviceWorkers()) {
            const id = parseId(worker.url());
            if (id !== null) {
                return id;
            }
        }
        return null;
    };

    let extensionId = getIdFromWorkers();
    if (extensionId !== null) {
        return extensionId;
    }

    await context.waitForEvent('serviceworker', {timeout: 30_000}).catch(() => {});
    extensionId = getIdFromWorkers();
    if (extensionId !== null) {
        return extensionId;
    }

    for (const page of context.pages()) {
        const pageId = parseId(page.url());
        if (pageId !== null) {
            return pageId;
        }
    }

    const configuredExtensionId = getConfiguredExtensionId();
    if (configuredExtensionId !== null) {
        return configuredExtensionId;
    }

    fail('Unable to discover Chromium extension ID');
}

/**
 * @param {string|undefined} rawValue
 * @param {number} fallback
 * @param {{minimum?: number}} [options]
 * @returns {number}
 */
function parseIntegerOption(rawValue, fallback, options = {}) {
    const minimum = Number.isFinite(options.minimum) ? Math.trunc(options.minimum) : 0;
    if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
        return fallback;
    }
    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isInteger(parsed) || parsed < minimum) {
        return fallback;
    }
    return parsed;
}

/**
 * @param {boolean} headless
 * @param {boolean} hideWindow
 * @returns {Promise<{context: import('@playwright/test').BrowserContext, cleanup: () => Promise<void>}>}
 */
async function launchExtensionContext(headless, hideWindow) {
    const originalManifest = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : null;
    const manifestUtil = new ManifestUtil();
    const variant = manifestUtil.getManifest('chrome-playwright');
    writeFileSync(
        manifestPath,
        ManifestUtil.createManifestString(variant).replace('$YOMITAN_VERSION', '0.0.0.0'),
        'utf8',
    );

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
 * @param {boolean} headless
 * @param {boolean} hideWindow
 * @returns {string}
 */
function getLaunchModeLabel(headless, hideWindow) {
    if (headless) { return 'headless'; }
    return hideWindow ? 'headed-hidden' : 'headed-visible';
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
            await page.goto(url, {waitUntil: 'domcontentloaded'});
        } catch (error) {
            lastError = error;
            if (!String(errorMessage(error)).includes('ERR_ABORTED')) {
                throw error;
            }
        }
        try {
            await page.waitForSelector(readySelector, {state: 'attached', timeout: 30_000});
            return;
        } catch (error) {
            if (attempt >= 10) {
                throw (lastError instanceof Error ? lastError : error);
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
async function getDictionaryErrorText(page) {
    return await page.evaluate(() => {
        const node = document.querySelector('#dictionary-error');
        if (!(node instanceof HTMLElement) || node.hidden) { return ''; }
        return (node.textContent || '').trim();
    });
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
 * @returns {Promise<unknown>}
 */
async function getLastImportDebug(page) {
    return await page.evaluate(() => Reflect.get(globalThis, '__manabitanLastImportDebug') ?? null);
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function getImportDebugHistory(page) {
    return await page.evaluate(() => {
        const historyRaw = Reflect.get(globalThis, '__manabitanImportDebugHistory');
        return Array.isArray(historyRaw) ? historyRaw : [];
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function getImportStepTimingHistory(page) {
    return await page.evaluate(() => {
        const historyRaw = Reflect.get(globalThis, '__manabitanImportStepTimingHistory');
        return Array.isArray(historyRaw) ? historyRaw : [];
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} label
 * @returns {Promise<void>}
 */
async function waitForImportCompletion(page, label) {
    const start = safePerformance.now();
    const deadline = start + importTimeoutMs;
    let sawStepText = false;
    let emptySince = null;
    while (safePerformance.now() < deadline) {
        const errorText = await getDictionaryErrorText(page);
        if (errorText.length > 0) {
            const lastImportDebug = await getLastImportDebug(page);
            fail(`${label} import reported error before completion: ${errorText}; lastImportDebug=${JSON.stringify(lastImportDebug)}`);
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
 * @param {string} observedName
 * @param {string} expectedName
 * @returns {boolean}
 */
function matchesDictionaryName(observedName, expectedName) {
    const observed = String(observedName || '').trim();
    const expected = String(expectedName || '').trim();
    if (observed.length === 0 || expected.length === 0) { return false; }
    if (observed === expected) { return true; }
    if (observed.startsWith(`${expected} `) || observed.startsWith(`${expected}.`)) { return true; }
    return observed.includes(expected);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {BenchCase} benchCase
 * @returns {Promise<unknown[]>}
 */
async function waitForImportedDictionaryInfo(page, benchCase) {
    const deadline = safePerformance.now() + 30_000;
    let lastInfo = [];
    while (safePerformance.now() < deadline) {
        const info = await getDictionaryInfoRuntime(page);
        if (!Array.isArray(info)) {
            await page.waitForTimeout(250);
            continue;
        }
        lastInfo = info;
        const importedTitles = info
            .map((entry) => String(entry?.title || '').trim())
            .filter((value) => value.length > 0);
        if (importedTitles.length < benchCase.expectedDictionaryCount) {
            await page.waitForTimeout(250);
            continue;
        }
        if (
            benchCase.expectedTitles.length > 0 &&
            !benchCase.expectedTitles.every((expectedTitle) => (
                importedTitles.some((importedTitle) => matchesDictionaryName(importedTitle, expectedTitle))
            ))
        ) {
            await page.waitForTimeout(250);
            continue;
        }
        return info;
    }
    fail(
        `Timed out waiting for imported dictionary metadata for ${benchCase.label}. ` +
        `expectedTitles=${JSON.stringify(benchCase.expectedTitles)} lastInfo=${JSON.stringify(lastInfo)}`,
    );
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} expectedCount
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function waitForImportDebugHistory(page, expectedCount) {
    const deadline = safePerformance.now() + 30_000;
    let lastHistory = [];
    while (safePerformance.now() < deadline) {
        const history = await getImportDebugHistory(page);
        lastHistory = history;
        if (
            history.length >= expectedCount &&
            history.slice(-expectedCount).every((entry) => entry && entry.hasResult === true)
        ) {
            return history;
        }
        await page.waitForTimeout(250);
    }
    fail(`Timed out waiting for import debug history. expectedCount=${String(expectedCount)} lastHistory=${JSON.stringify(lastHistory)}`);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} extensionBaseUrl
 * @returns {Promise<void>}
 */
async function purgeExtensionState(page, extensionBaseUrl) {
    await gotoExtensionPage(page, getSettingsPageUrl(extensionBaseUrl), '#dictionary-import-file-input');
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
 * @param {import('@playwright/test').Page} page
 * @param {Record<string, unknown>|null} importFlags
 * @returns {Promise<void>}
 */
async function prepareBenchmarkRun(page, importFlags) {
    await page.evaluate((flagsFromRunner) => {
        globalThis.manabitanImportUseSession = true;
        globalThis.manabitanDisableIntegrityCounts = true;
        globalThis.manabitanImportPerformanceFlags =
            flagsFromRunner && typeof flagsFromRunner === 'object' ?
                {...flagsFromRunner} :
                {};
        Reflect.set(globalThis, '__manabitanLastImportDebug', null);
        Reflect.set(globalThis, '__manabitanImportDebugHistory', []);
        Reflect.set(globalThis, '__manabitanImportStepTimingHistory', []);
    }, importFlags);
}

/**
 * @param {Record<string, unknown>[]} historyRaw
 * @param {'localPhaseTimings'|'importerPhaseTimings'} key
 * @returns {Record<string, number>}
 */
function aggregatePhaseTimings(historyRaw, key) {
    /** @type {Record<string, number>} */
    const totals = {};
    for (const entry of historyRaw) {
        const timingsRaw = Array.isArray(entry?.[key]) ? entry[key] : [];
        for (const timing of timingsRaw) {
            if (!(typeof timing === 'object' && timing !== null && !Array.isArray(timing))) {
                continue;
            }
            const phase = String(timing.phase || '').trim();
            const elapsedMs = asNumber(timing.elapsedMs);
            if (phase.length === 0) { continue; }
            totals[phase] = (totals[phase] ?? 0) + Math.max(0, elapsedMs);
        }
    }
    return totals;
}

/**
 * @param {Record<string, unknown>[]} historyRaw
 * @returns {{dictionaries: Array<Record<string, number|string>>, aggregate: Record<string, number>}}
 */
function summarizeImportStep4Breakdown(historyRaw) {
    const dictionaries = [];
    const aggregate = {
        termParseMs: 0,
        termSerializationMs: 0,
        bulkAddTermsMs: 0,
        bulkAddTagsMetaMs: 0,
        mediaResolveMs: 0,
        mediaWriteMs: 0,
        accountedMs: 0,
        otherMs: 0,
    };
    for (const entry of historyRaw) {
        const importerPhaseTimings = Array.isArray(entry?.importerPhaseTimings) ? entry.importerPhaseTimings : [];
        const importDataBanksTiming = importerPhaseTimings.find((timing) => timing && timing.phase === 'import-data-banks');
        let details = {};
        if (
            importDataBanksTiming &&
            typeof importDataBanksTiming === 'object' &&
            importDataBanksTiming !== null &&
            !Array.isArray(importDataBanksTiming.details)
        ) {
            details = importDataBanksTiming.details;
        }
        const dictionarySummary = {
            title: String(entry?.resultTitle || ''),
            termParseMs: Math.max(0, asNumber(details?.step4TermParseMs)),
            termSerializationMs: Math.max(0, asNumber(details?.step4TermSerializationMs)),
            bulkAddTermsMs: Math.max(0, asNumber(details?.step4BulkAddTermsMs)),
            bulkAddTagsMetaMs: Math.max(0, asNumber(details?.step4BulkAddTagsMetaMs)),
            mediaResolveMs: Math.max(0, asNumber(details?.step4MediaResolveMs)),
            mediaWriteMs: Math.max(0, asNumber(details?.step4MediaWriteMs)),
            accountedMs: Math.max(0, asNumber(details?.step4AccountedMs)),
            otherMs: Math.max(0, asNumber(details?.step4OtherMs)),
        };
        dictionaries.push(dictionarySummary);
        for (const [key, value] of Object.entries(dictionarySummary)) {
            if (key === 'title') { continue; }
            aggregate[key] += value;
        }
    }
    return {dictionaries, aggregate};
}

/**
 * @param {Record<string, unknown>[]} historyRaw
 * @returns {{aggregateByStep: Array<{stepDisplay: string, count: number, totalElapsedMs: number}>}}
 */
function summarizeImportStepTimingHistory(historyRaw) {
    /** @type {Map<string, {count: number, totalElapsedMs: number}>} */
    const aggregateByStep = new Map();
    for (const record of historyRaw) {
        const stepDisplay = String(record?.stepDisplay || '').trim();
        const elapsedMs = asNumber(record?.elapsedMs);
        if (stepDisplay.length === 0) { continue; }
        const aggregate = aggregateByStep.get(stepDisplay) ?? {count: 0, totalElapsedMs: 0};
        aggregate.count += 1;
        aggregate.totalElapsedMs += Math.max(0, elapsedMs);
        aggregateByStep.set(stepDisplay, aggregate);
    }
    return {
        aggregateByStep: [...aggregateByStep.entries()]
            .sort((a, b) => a[0].localeCompare(b[0], 'en'))
            .map(([stepDisplay, value]) => ({stepDisplay, ...value})),
    };
}

/**
 * @param {CliOptions} options
 * @returns {Promise<BenchCase[]>}
 */
async function loadBenchCases(options) {
    const localMdxFixturePath = path.join(root, 'test', 'data', 'dictionaries', localMdxFixtureFileName);
    const localEnglishMdxFixturePath = path.join(root, 'test', 'data', 'dictionaries', localEnglishMdxFixtureFileName);
    const defaultCasesRaw = [
        {
            label: 'local-yome-mdx',
            files: [localMdxFixturePath],
            expectedTitles: [localMdxDictionaryTitle],
        },
        {
            label: 'local-read-mdx',
            files: [localEnglishMdxFixturePath],
            expectedTitles: [localEnglishMdxDictionaryTitle],
        },
        {
            label: 'local-two-mdx-batch',
            files: [localMdxFixturePath, localEnglishMdxFixturePath],
            expectedTitles: [localMdxDictionaryTitle, localEnglishMdxDictionaryTitle],
        },
    ];

    const usingCasesJson = typeof options.casesJson === 'string';
    const usingCasesFile = typeof options.casesFile === 'string';
    if (usingCasesJson && usingCasesFile) {
        fail('Use only one of --cases-json or --cases-file');
    }

    /** @type {unknown[]} */
    let casesRaw = defaultCasesRaw;
    if (usingCasesJson) {
        const parsed = JSON.parse(options.casesJson);
        if (!Array.isArray(parsed)) {
            fail('--cases-json must decode to an array');
        }
        casesRaw = parsed;
    } else if (usingCasesFile) {
        const filePath = normalizePath(options.casesFile);
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (!Array.isArray(parsed)) {
            fail(`--cases-file must contain a JSON array: ${filePath}`);
        }
        casesRaw = parsed;
    }

    /** @type {BenchCase[]} */
    const benchCases = [];
    for (const [index, caseRaw] of casesRaw.entries()) {
        if (!(typeof caseRaw === 'object' && caseRaw !== null && !Array.isArray(caseRaw))) {
            fail(`Invalid benchmark case at index ${String(index)}: expected object`);
        }
        const label = String(caseRaw.label || '').trim() || `case-${String(index + 1)}`;
        const filesRaw = Array.isArray(caseRaw.files) ? caseRaw.files : [];
        if (filesRaw.length === 0) {
            fail(`Benchmark case "${label}" must include at least one file`);
        }
        const files = filesRaw.map((value) => normalizePath(String(value || ''))).filter((value) => value.length > 0);
        const mdxFileCount = files.filter((filePath) => isMdxPath(filePath)).length;
        if (mdxFileCount < 1) {
            fail(`Benchmark case "${label}" must include at least one .mdx file`);
        }
        if (!files.every((filePath) => isMdxPath(filePath) || isMddPath(filePath))) {
            fail(`Benchmark case "${label}" only supports .mdx and .mdd files`);
        }
        let inputBytes = 0;
        for (const filePath of files) {
            await access(filePath);
            const fileStats = await stat(filePath);
            inputBytes += fileStats.size;
        }
        const expectedTitles = Array.isArray(caseRaw.expectedTitles) ?
            caseRaw.expectedTitles.map((value) => String(value || '').trim()).filter((value) => value.length > 0) :
            [];
        benchCases.push({
            label,
            files,
            expectedTitles,
            expectedDictionaryCount: mdxFileCount,
            inputBytes,
        });
    }

    const filteredCases = options.caseLabels.size > 0 ?
        benchCases.filter(({label}) => options.caseLabels.has(label)) :
        benchCases;
    if (filteredCases.length === 0) {
        fail(`No benchmark cases matched requested labels: ${JSON.stringify([...options.caseLabels])}`);
    }
    return filteredCases;
}

/**
 * @param {string[]} argv
 * @returns {CliOptions}
 */
function parseCliArgs(argv) {
    const defaultReportFile = path.join(root, 'builds', 'chromium-mdx-import-benchmark.json');
    /** @type {CliOptions} */
    const options = {
        iterations: parseIntegerOption(process.env.MANABITAN_MDX_E2E_ITERATIONS, 5, {minimum: 1}),
        warmupIterations: parseIntegerOption(process.env.MANABITAN_MDX_E2E_WARMUP_ITERATIONS, 1, {minimum: 0}),
        reportFile: normalizePath(process.env.MANABITAN_MDX_E2E_REPORT ?? defaultReportFile),
        caseLabels: new Set(
            String(process.env.MANABITAN_MDX_E2E_CASES ?? '')
                .split(',')
                .map((value) => value.trim())
                .filter((value) => value.length > 0),
        ),
        casesJson: typeof process.env.MANABITAN_MDX_E2E_CASES_JSON === 'string' ? process.env.MANABITAN_MDX_E2E_CASES_JSON : null,
        casesFile: typeof process.env.MANABITAN_MDX_E2E_CASES_FILE === 'string' ? process.env.MANABITAN_MDX_E2E_CASES_FILE : null,
        importFlags: null,
        help: false,
    };

    const importFlagsRaw = process.env.MANABITAN_E2E_IMPORT_FLAGS_JSON;
    if (typeof importFlagsRaw === 'string' && importFlagsRaw.trim().length > 0) {
        const parsed = JSON.parse(importFlagsRaw);
        if (!(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))) {
            fail('MANABITAN_E2E_IMPORT_FLAGS_JSON must decode to an object');
        }
        options.importFlags = parsed;
    }

    for (let index = 0; index < argv.length; ++index) {
        const argument = String(argv[index] || '');
        const nextValue = () => {
            index += 1;
            if (index >= argv.length) {
                fail(`Missing value for ${argument}`);
            }
            return String(argv[index]);
        };
        if (argument === '--help' || argument === '-h') {
            options.help = true;
            continue;
        }
        if (argument === '--iterations') {
            options.iterations = parseIntegerOption(nextValue(), options.iterations, {minimum: 1});
            continue;
        }
        if (argument.startsWith('--iterations=')) {
            options.iterations = parseIntegerOption(argument.slice('--iterations='.length), options.iterations, {minimum: 1});
            continue;
        }
        if (argument === '--warmup') {
            options.warmupIterations = parseIntegerOption(nextValue(), options.warmupIterations, {minimum: 0});
            continue;
        }
        if (argument.startsWith('--warmup=')) {
            options.warmupIterations = parseIntegerOption(argument.slice('--warmup='.length), options.warmupIterations, {minimum: 0});
            continue;
        }
        if (argument === '--report-file') {
            options.reportFile = normalizePath(nextValue());
            continue;
        }
        if (argument.startsWith('--report-file=')) {
            options.reportFile = normalizePath(argument.slice('--report-file='.length));
            continue;
        }
        if (argument === '--case') {
            options.caseLabels.add(nextValue());
            continue;
        }
        if (argument.startsWith('--case=')) {
            options.caseLabels.add(argument.slice('--case='.length));
            continue;
        }
        if (argument === '--cases-json') {
            options.casesJson = nextValue();
            continue;
        }
        if (argument.startsWith('--cases-json=')) {
            options.casesJson = argument.slice('--cases-json='.length);
            continue;
        }
        if (argument === '--cases-file') {
            options.casesFile = nextValue();
            continue;
        }
        if (argument.startsWith('--cases-file=')) {
            options.casesFile = argument.slice('--cases-file='.length);
            continue;
        }
        if (argument === '--import-flags-json') {
            const parsed = JSON.parse(nextValue());
            if (!(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))) {
                fail('--import-flags-json must decode to an object');
            }
            options.importFlags = parsed;
            continue;
        }
        if (argument.startsWith('--import-flags-json=')) {
            const parsed = JSON.parse(argument.slice('--import-flags-json='.length));
            if (!(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))) {
                fail('--import-flags-json must decode to an object');
            }
            options.importFlags = parsed;
            continue;
        }
        fail(`Unknown argument: ${argument}`);
    }

    return options;
}

function printHelp() {
    console.log(`
${logTag} Chromium E2E MDX import benchmark runner

Usage:
  node ./test/chromium/mdx-import-benchmark.js [options]

Options:
  --iterations <n>         Number of measured iterations per case. Default: 5.
  --warmup <n>             Number of warmup iterations per case. Default: 1.
  --case <label>           Run only the named case. Repeat to include multiple labels.
  --report-file <path>     Write the JSON report to <path>.
  --cases-json <json>      JSON array of custom cases. Each case must include {"label","files"}.
  --cases-file <path>      Path to a JSON file containing the same custom case array.
  --import-flags-json <json>
                           Optional import performance flags passed to globalThis.manabitanImportPerformanceFlags.
  --help                   Show this help text.

Default built-in case labels:
  local-yome-mdx
  local-read-mdx
  local-two-mdx-batch

Custom case JSON format:
  [
    {
      "label": "freemdict-local",
      "files": ["/abs/path/dict.mdx", "/abs/path/dict.mdd"],
      "expectedTitles": ["My Dictionary"]
    }
  ]

Environment:
  MANABITAN_CHROMIUM_HEADLESS / MANABITAN_CHROMIUM_HIDE_WINDOW
  MANABITAN_MDX_E2E_ITERATIONS / MANABITAN_MDX_E2E_WARMUP_ITERATIONS
  MANABITAN_MDX_E2E_CASES / MANABITAN_MDX_E2E_CASES_JSON / MANABITAN_MDX_E2E_CASES_FILE
  MANABITAN_MDX_E2E_REPORT
  MANABITAN_E2E_IMPORT_FLAGS_JSON
`.trim());
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {BenchCase} benchCase
 * @param {'warmup'|'measured'} kind
 * @param {number} iteration
 * @param {Record<string, unknown>|null} importFlags
 * @returns {Promise<Record<string, unknown>>}
 */
async function runIteration(page, benchCase, kind, iteration, importFlags) {
    await prepareBenchmarkRun(page, importFlags);
    const startedAtIso = new Date().toISOString();
    const importStartedAtMs = safePerformance.now();
    await page.locator('#dictionary-import-file-input').setInputFiles(benchCase.files);
    await waitForImportCompletion(page, benchCase.label);
    const importCompletedAtMs = safePerformance.now();
    const dictionaryInfo = await waitForImportedDictionaryInfo(page, benchCase);
    const metadataReadyAtMs = safePerformance.now();
    const importDebugHistory = await waitForImportDebugHistory(page, benchCase.expectedDictionaryCount);
    const stepTimingHistory = await getImportStepTimingHistory(page);
    const lastImportDebug = await getLastImportDebug(page);
    const importedTitles = dictionaryInfo
        .map((entry) => String(entry?.title || '').trim())
        .filter((value) => value.length > 0);
    const localPhases = aggregatePhaseTimings(importDebugHistory, 'localPhaseTimings');
    const importerPhases = aggregatePhaseTimings(importDebugHistory, 'importerPhaseTimings');
    const step4Breakdown = summarizeImportStep4Breakdown(importDebugHistory);
    const stepTimingSummary = summarizeImportStepTimingHistory(stepTimingHistory);
    return {
        kind,
        iteration,
        startedAtIso,
        finishedAtIso: new Date().toISOString(),
        totalImportMs: Math.max(0, importCompletedAtMs - importStartedAtMs),
        metadataReadyMs: Math.max(0, metadataReadyAtMs - importStartedAtMs),
        importedTitles,
        importedDictionaryCount: importedTitles.length,
        lastImportDebug,
        localPhases,
        importerPhases,
        step4Breakdown,
        stepTimingSummary,
    };
}

/**
 * @param {Record<string, unknown>[]} measuredRuns
 * @returns {Record<string, unknown>}
 */
function summarizeMeasuredRuns(measuredRuns) {
    const totalImportMs = measuredRuns.map((run) => asNumber(run.totalImportMs));
    const metadataReadyMs = measuredRuns.map((run) => asNumber(run.metadataReadyMs));
    const localPhaseRows = measuredRuns.map((run) => /** @type {Record<string, number>} */ (run.localPhases ?? {}));
    const importerPhaseRows = measuredRuns.map((run) => /** @type {Record<string, number>} */ (run.importerPhases ?? {}));
    const step4Rows = measuredRuns.map((run) => /** @type {Record<string, number>} */ (run.step4Breakdown?.aggregate ?? {}));
    return {
        totalImportMs: summarizeValues(totalImportMs),
        metadataReadyMs: summarizeValues(metadataReadyMs),
        localPhases: summarizeNamedMetrics(localPhaseRows),
        importerPhases: summarizeNamedMetrics(importerPhaseRows),
        step4Aggregate: summarizeNamedMetrics(step4Rows),
    };
}

/**
 * @param {BenchCase} benchCase
 * @param {Record<string, unknown>} summary
 * @returns {void}
 */
function printCaseSummary(benchCase, summary) {
    const totalImportSummary = summary.totalImportMs;
    const metadataReadySummary = summary.metadataReadyMs;
    const convertSummary = summary.localPhases?.['convert-mdx'] ?? null;
    const importDataBanksSummary = summary.importerPhases?.['import-data-banks'] ?? null;
    const bulkAddSummary = summary.step4Aggregate?.bulkAddTermsMs ?? null;
    console.log(
        `${logTag} summary case=${benchCase.label} inputBytes=${String(benchCase.inputBytes)} ` +
        `totalImport.median=${totalImportSummary ? formatDurationMs(totalImportSummary.median) : 'n/a'} ` +
        `metadataReady.median=${metadataReadySummary ? formatDurationMs(metadataReadySummary.median) : 'n/a'} ` +
        `convertMdx.median=${convertSummary ? formatDurationMs(convertSummary.median) : 'n/a'} ` +
        `importDataBanks.median=${importDataBanksSummary ? formatDurationMs(importDataBanksSummary.median) : 'n/a'} ` +
        `bulkAddTerms.median=${bulkAddSummary ? formatDurationMs(bulkAddSummary.median) : 'n/a'}`,
    );
}

/**
 * @param {BenchCase} benchCase
 * @param {import('@playwright/test').Page} page
 * @param {string} extensionBaseUrl
 * @param {CliOptions} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function runBenchCase(benchCase, page, extensionBaseUrl, options) {
    console.log(
        `${logTag} case=${benchCase.label} files=${JSON.stringify(benchCase.files)} ` +
        `expectedTitles=${JSON.stringify(benchCase.expectedTitles)} inputBytes=${String(benchCase.inputBytes)}`,
    );
    /** @type {Record<string, unknown>[]} */
    const warmupRuns = [];
    /** @type {Record<string, unknown>[]} */
    const measuredRuns = [];

    for (let warmupIndex = 0; warmupIndex < options.warmupIterations; ++warmupIndex) {
        await purgeExtensionState(page, extensionBaseUrl);
        await gotoExtensionPage(page, getSettingsPageUrl(extensionBaseUrl), '#dictionary-import-file-input');
        await waitForSettingsPageReady(page);
        const run = await runIteration(page, benchCase, 'warmup', warmupIndex + 1, options.importFlags);
        warmupRuns.push(run);
        console.log(
            `${logTag} warmup case=${benchCase.label} iteration=${String(warmupIndex + 1)}/${String(options.warmupIterations)} ` +
            `total=${formatDurationMs(asNumber(run.totalImportMs))} ` +
            `convert=${formatDurationMs(asNumber(run.localPhases?.['convert-mdx']))} ` +
            `bulkAddTerms=${formatDurationMs(asNumber(run.step4Breakdown?.aggregate?.bulkAddTermsMs))}`,
        );
    }

    for (let iterationIndex = 0; iterationIndex < options.iterations; ++iterationIndex) {
        await purgeExtensionState(page, extensionBaseUrl);
        await gotoExtensionPage(page, getSettingsPageUrl(extensionBaseUrl), '#dictionary-import-file-input');
        await waitForSettingsPageReady(page);
        const run = await runIteration(page, benchCase, 'measured', iterationIndex + 1, options.importFlags);
        measuredRuns.push(run);
        console.log(
            `${logTag} measured case=${benchCase.label} iteration=${String(iterationIndex + 1)}/${String(options.iterations)} ` +
            `total=${formatDurationMs(asNumber(run.totalImportMs))} ` +
            `metadataReady=${formatDurationMs(asNumber(run.metadataReadyMs))} ` +
            `convert=${formatDurationMs(asNumber(run.localPhases?.['convert-mdx']))} ` +
            `importDataBanks=${formatDurationMs(asNumber(run.importerPhases?.['import-data-banks']))} ` +
            `bulkAddTerms=${formatDurationMs(asNumber(run.step4Breakdown?.aggregate?.bulkAddTermsMs))}`,
        );
    }

    await purgeExtensionState(page, extensionBaseUrl);
    const summary = summarizeMeasuredRuns(measuredRuns);
    printCaseSummary(benchCase, summary);
    return {
        label: benchCase.label,
        files: benchCase.files,
        expectedTitles: benchCase.expectedTitles,
        expectedDictionaryCount: benchCase.expectedDictionaryCount,
        inputBytes: benchCase.inputBytes,
        warmupRuns,
        measuredRuns,
        summary,
    };
}

/**
 * @returns {Promise<void>}
 */
async function main() {
    const options = parseCliArgs(process.argv.slice(2));
    if (options.help) {
        printHelp();
        return;
    }
    const benchCases = await loadBenchCases(options);
    const requestedHeadless = shouldRunHeadless();
    const requestedHideWindow = shouldHideWindow();
    console.log(
        `${logTag} cases=${benchCases.map(({label}) => label).join(', ')} ` +
        `iterations=${String(options.iterations)} warmup=${String(options.warmupIterations)} report=${options.reportFile}`,
    );

    const report = {
        version: 1,
        startedAtIso: new Date().toISOString(),
        finishedAtIso: null,
        nodeVersion: process.version,
        iterations: options.iterations,
        warmupIterations: options.warmupIterations,
        requestedHeadless,
        requestedHideWindow,
        launchMode: 'unknown',
        importFlags: options.importFlags,
        cases: benchCases.map(({label, files, expectedTitles, expectedDictionaryCount, inputBytes}) => ({
            label,
            files,
            expectedTitles,
            expectedDictionaryCount,
            inputBytes,
        })),
        scenarios: [],
        status: 'running',
        failureReason: '',
    };

    let cleanup = null;
    /** @type {Error|undefined} */
    let runError;
    try {
        /**
         * @param {boolean} headless
         * @param {boolean} hideWindow
         * @returns {Promise<{context: import('@playwright/test').BrowserContext, extensionBaseUrl: string, page: import('@playwright/test').Page}>}
         */
        const launchAndOpenSettings = async (headless, hideWindow) => {
            const launched = await launchExtensionContext(headless, hideWindow);
            cleanup = launched.cleanup;
            const {context} = launched;
            const extensionId = await discoverExtensionId(context);
            await closeWelcomePages(context);
            const extensionBaseUrl = `chrome-extension://${extensionId}`;
            const page = context.pages()[0] ?? await context.newPage();
            await gotoExtensionPage(page, getSettingsPageUrl(extensionBaseUrl), '#dictionary-import-file-input');
            await waitForSettingsPageReady(page);
            return {context, extensionBaseUrl, page};
        };

        let launchMode = getLaunchModeLabel(requestedHeadless, requestedHideWindow);
        let opened;
        try {
            opened = await launchAndOpenSettings(requestedHeadless, requestedHideWindow);
        } catch (error) {
            if (!requestedHeadless) {
                throw error;
            }
            if (cleanup !== null) {
                try {
                    await cleanup();
                } catch (_) {
                    // Ignore best-effort cleanup failures before fallback relaunch.
                }
                cleanup = null;
            }
            launchMode = 'headed-hidden-fallback';
            opened = await launchAndOpenSettings(false, true);
        }
        report.launchMode = launchMode;
        const {extensionBaseUrl, page} = opened;
        for (const benchCase of benchCases) {
            const scenario = await runBenchCase(benchCase, page, extensionBaseUrl, options);
            report.scenarios.push(scenario);
        }
        report.status = 'success';
    } catch (error) {
        report.status = 'failure';
        report.failureReason = errorMessage(error);
        runError = error instanceof Error ? error : new Error(String(error));
    } finally {
        report.finishedAtIso = new Date().toISOString();
        try {
            await mkdir(path.dirname(options.reportFile), {recursive: true});
            await writeFile(options.reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
            console.log(`${logTag} wrote report: ${options.reportFile}`);
        } catch (reportError) {
            console.error(`${logTag} failed to write report: ${errorMessage(reportError)}`);
        }
        if (cleanup !== null) {
            try {
                await cleanup();
            } catch (_) {
                // Ignore best-effort cleanup failures.
            }
        }
    }

    if (runError) {
        throw new Error(`${logTag} ${errorMessage(runError)}`);
    }
}

await main();
