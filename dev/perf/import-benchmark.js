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

import path from 'node:path';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {parseJson} from '../../ext/js/core/json.js';
import {getHostEnvironment} from './host-environment.js';
import {loadDictionaryFixtures} from './dictionary-fixtures.js';

const execFileAsync = promisify(execFile);
const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dirname, '..', '..');
const e2eScript = path.join(root, 'test', 'chromium', 'extension-two-dictionary-import.e2e.js');

/**
 * @returns {{dictionaryId: string, runs: number|null, trace: boolean, importFlagsJson: string|null, outputDir: string|null, skipBuild: boolean}}
 * @throws {Error}
 */
function parseArgs() {
    const args = process.argv.slice(2);
    let dictionaryId = '';
    let runs = null;
    let trace = false;
    let importFlagsJson = null;
    let outputDir = null;
    let skipBuild = false;
    for (let i = 0; i < args.length; ++i) {
        const arg = args[i];
        switch (arg) {
            case '--trace': {
                trace = true;

                break;
            }
            case '--no-build': {
                skipBuild = true;

                break;
            }
            case '--runs': {
                runs = Number.parseInt(args[++i] ?? '', 10);

                break;
            }
            case '--flags': {
                importFlagsJson = args[++i] ?? '';

                break;
            }
            case '--output': {
                outputDir = args[++i] ?? '';

                break;
            }
            default: if (arg.startsWith('--')) {
                throw new Error(`Unknown argument: ${arg}`);
            } else if (dictionaryId.length === 0) {
                dictionaryId = arg.trim().toLowerCase();
            } else {
                throw new Error(`Unexpected positional argument: ${arg}`);
            }
        }
    }
    return {dictionaryId: dictionaryId || 'jmdict', runs, trace, importFlagsJson, outputDir, skipBuild};
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {Record<string, string|undefined>} env
 * @returns {Promise<void>}
 */
async function runCommand(command, args, env) {
    await new Promise(
        /** @type {(resolve: (value: void|PromiseLike<void>) => void, reject: (reason?: unknown) => void) => void} */
        ((resolve, reject) => {
            const child = spawn(command, args, {cwd: root, env, stdio: 'inherit'});
            child.on('error', reject);
            child.on('exit', (code, signal) => {
                if (code === 0) {
                    resolve();
                    return;
                }
                reject(new Error(`Command failed code=${String(code)} signal=${String(signal)}: ${command} ${args.join(' ')}`));
            });
        }),
    );
}

/**
 * @returns {Promise<string|null>}
 */
async function getGitSha() {
    try {
        const {stdout} = await execFileAsync('git', ['rev-parse', 'HEAD'], {cwd: root});
        const value = stdout.trim();
        if (value.length > 0) {
            return value;
        }
    } catch (_) {
        // Exported performance bundles intentionally omit .git.
    }
    const explicitSourceSha = process.env.MANABITAN_PERF_SOURCE_SHA?.trim();
    if (explicitSourceSha) {
        return explicitSourceSha;
    }
    try {
        const bundleManifest = /** @type {{gitSha?: unknown}} */ (
            /** @type {unknown} */ (parseJson(await readFile(path.join(root, 'perf-bundle-manifest.json'), 'utf8')))
        );
        if (typeof bundleManifest.gitSha === 'string' && bundleManifest.gitSha.length > 0) {
            return bundleManifest.gitSha;
        }
    } catch (_) {
        // Normal source checkouts do not contain a bundle manifest.
    }
    return null;
}

/**
 * @param {number[]} values
 * @returns {{count: number, minMs: number, medianMs: number, p95Ms: number, maxMs: number}}
 */
function summarizeDurations(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const midpoint = Math.floor(sorted.length / 2);
    const medianMs = (sorted.length % 2) === 1 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
    const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
    return {
        count: sorted.length,
        minMs: sorted[0],
        medianMs,
        p95Ms: sorted[p95Index],
        maxMs: sorted.at(-1) ?? 0,
    };
}

/**
 * @param {Record<string, unknown>} report
 * @param {string} dictionaryLabel
 * @returns {{totalImportMs: number, stepTimingSummary: unknown, step4Breakdown: unknown, importDebug: unknown}}
 * @throws {Error}
 */
function extractImportResult(report, dictionaryLabel) {
    const phases = Array.isArray(report.phases) ? /** @type {unknown[]} */ (report.phases) : [];
    /** @type {Record<string, unknown>|null} */
    let phase = null;
    /** @type {Record<string, unknown>|null} */
    let phaseData = null;
    for (const item of phases) {
        if (!(item && typeof item === 'object' && !Array.isArray(item))) {
            continue;
        }
        const candidate = /** @type {Record<string, unknown>} */ (item);
        const dataRaw = candidate.data;
        const data = (dataRaw && typeof dataRaw === 'object' && !Array.isArray(dataRaw)) ?
            /** @type {Record<string, unknown>} */ (dataRaw) :
            null;
        if (candidate.name === `${dictionaryLabel}: total import` && data?.kind === 'dictionary-import') {
            phase = candidate;
            phaseData = data;
            break;
        }
    }
    if (!(phase && typeof phase.durationMs === 'number' && Number.isFinite(phase.durationMs))) {
        throw new Error(`Missing structured ${dictionaryLabel} total-import phase in E2E report`);
    }
    return {
        totalImportMs: phase.durationMs,
        stepTimingSummary: phaseData?.stepTimingSummary ?? null,
        step4Breakdown: phaseData?.step4Breakdown ?? null,
        importDebug: phaseData?.importDebug ?? null,
    };
}

const options = parseArgs();
const fixtures = await loadDictionaryFixtures();
const fixture = fixtures[options.dictionaryId];
if (!fixture) {
    throw new Error(`Unknown dictionary "${options.dictionaryId}". Expected one of: ${Object.keys(fixtures).join(', ')}`);
}
if (options.importFlagsJson !== null) {
    const parsedFlags = parseJson(options.importFlagsJson);
    if (!(parsedFlags && typeof parsedFlags === 'object' && !Array.isArray(parsedFlags))) {
        throw new Error('--flags must contain a JSON object');
    }
}
const runCount = options.runs ?? (options.trace ? 1 : 5);
if (!Number.isFinite(runCount) || runCount <= 0) {
    throw new Error(`Invalid --runs value: ${String(options.runs)}`);
}
if (options.trace && runCount !== 1) {
    throw new Error('Trace mode supports exactly one run; traces perturb timing and are not used for benchmark statistics');
}
const timestamp = new Date().toISOString().replaceAll(':', '')
    .replaceAll('.', '')
    .replaceAll('-', '');
const outputDir = path.resolve(root, options.outputDir ?? path.join('builds', 'perf', `${timestamp}-${options.dictionaryId}${options.trace ? '-trace' : ''}`));
await mkdir(outputDir, {recursive: true});
/** @type {Array<{index: number, reportPath: string, reportJsonPath: string, tracePath: string|null, browserVersion: unknown, totalImportMs: number, stepTimingSummary: unknown, step4Breakdown: unknown, importDebug: unknown}>} */
const runs = [];
for (let index = 1; index <= runCount; ++index) {
    const reportPath = path.join(outputDir, `run-${String(index)}.html`);
    const reportJsonPath = reportPath.replace(/\.html$/i, '.json');
    const tracePath = options.trace ? path.join(outputDir, `run-${String(index)}.trace.json`) : '';
    /** @type {Record<string, string|undefined>} */
    const env = {
        ...process.env,
        MANABITAN_CHROMIUM_HEADLESS: '1',
        MANABITAN_CHROMIUM_E2E_REPORT: reportPath,
        MANABITAN_E2E_IMPORT_BENCH_QUICK: '1',
        MANABITAN_E2E_IMPORT_BENCH_DICTIONARY: options.dictionaryId,
        MANABITAN_E2E_USE_PERF_DICTIONARY_LOCK: '1',
        MANABITAN_E2E_IMPORT_USE_PRODUCTION_DEFAULTS: '1',
        MANABITAN_E2E_PHASE_PROFILING: '0',
        MANABITAN_E2E_PHASE_SCREENSHOTS: '0',
        MANABITAN_E2E_PROCESS_SAMPLING: '0',
        MANABITAN_E2E_SKIP_BUILD: (options.skipBuild || index > 1) ? '1' : '0',
        MANABITAN_CHROMIUM_E2E_MAX_LOG_LINES: '10000',
    };
    if (options.importFlagsJson !== null) {
        env.MANABITAN_E2E_IMPORT_FLAGS_JSON = options.importFlagsJson;
    }
    if (tracePath.length > 0) {
        env.MANABITAN_E2E_IMPORT_TRACE_PATH = tracePath;
    }
    console.log(`[perf-import] ${fixture.label} run ${String(index)}/${String(runCount)}${options.trace ? ' (trace; timing is non-authoritative)' : ''}`);
    await runCommand(process.execPath, [e2eScript], env);
    const report = /** @type {Record<string, unknown>} */ (parseJson(await readFile(reportJsonPath, 'utf8')));
    if (report.status !== 'success') {
        throw new Error(`E2E report did not complete successfully: ${reportJsonPath} status=${String(report.status)}`);
    }
    runs.push({
        index,
        reportPath,
        reportJsonPath,
        tracePath: tracePath || null,
        browserVersion: report.browserVersion ?? null,
        ...extractImportResult(report, fixture.label),
    });
}
const summary = {
    schemaVersion: 1,
    dictionary: options.dictionaryId,
    fixture,
    authoritativeTiming: !options.trace,
    traceEnabled: options.trace,
    gitSha: await getGitSha(),
    hostEnvironment: getHostEnvironment(),
    browserVersion: runs[0]?.browserVersion ?? null,
    importFlags: options.importFlagsJson === null ? {} : parseJson(options.importFlagsJson),
    runs,
    timing: summarizeDurations(runs.map((run) => run.totalImportMs)),
};
const summaryPath = path.join(outputDir, 'summary.json');
await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
console.log(`[perf-import] ${fixture.label} ${options.trace ? 'trace captured' : `median=${summary.timing.medianMs.toFixed(1)}ms min=${summary.timing.minMs.toFixed(1)}ms p95=${summary.timing.p95Ms.toFixed(1)}ms`} (${String(runCount)} run${runCount === 1 ? '' : 's'})`);
console.log(`[perf-import] summary=${summaryPath}`);
