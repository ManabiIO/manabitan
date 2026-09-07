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
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {parseJson} from '../../ext/js/core/json.js';
import {getHostEnvironment} from './host-environment.js';
import {loadDictionaryFixtures} from './dictionary-fixtures.js';
import {createBenchmarkEnvironment, extractImportResult, getSourceProvenance, parsePositiveInteger} from './benchmark-support.js';

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
                runs = parsePositiveInteger(args[++i] ?? '', '--runs');

                break;
            }
            case '--flags': {
                importFlagsJson = args[++i] ?? '';

                break;
            }
            case '--output': {
                outputDir = args[++i] ?? '';
                if (outputDir.length === 0 || outputDir.startsWith('--')) { throw new Error('--output requires a directory'); }

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
            const child = spawn(command, args, {cwd: root, env, stdio: 'inherit', timeout: 10 * 60 * 1000, killSignal: 'SIGTERM'});
            child.on('error', reject);
            child.on('close', (code, signal) => {
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
await rm(path.join(outputDir, 'summary.json'), {force: true});
/** @type {Array<{index: number, reportPath: string, reportJsonPath: string, tracePath: string|null, browserVersion: unknown, totalImportMs: number, workerImportMs: number|null, stepTimingSummary: unknown, step4Breakdown: unknown, importDebug: unknown}>} */
const runs = [];
for (let index = 1; index <= runCount; ++index) {
    const reportPath = path.join(outputDir, `run-${String(index)}.html`);
    const reportJsonPath = reportPath.replace(/\.html$/i, '.json');
    const tracePath = options.trace ? path.join(outputDir, `run-${String(index)}.trace.json`) : '';
    /** @type {Record<string, string|undefined>} */
    const env = createBenchmarkEnvironment(process.env, {
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
    });
    if (options.importFlagsJson !== null) {
        env.MANABITAN_E2E_IMPORT_FLAGS_JSON = options.importFlagsJson;
    }
    if (tracePath.length > 0) {
        env.MANABITAN_E2E_IMPORT_TRACE_PATH = tracePath;
    }
    await rm(reportJsonPath, {force: true});
    if (tracePath.length > 0) { await rm(tracePath, {force: true}); }
    console.log(`[perf-import] ${fixture.label} run ${String(index)}/${String(runCount)}${options.trace ? ' (trace; timing is non-authoritative)' : ''}`);
    await runCommand(process.execPath, [e2eScript], env);
    if (tracePath.length > 0 && (await stat(tracePath)).size === 0) { throw new Error('Import trace is empty'); }
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
        ...extractImportResult(report, options.dictionaryId, fixture, options.trace, options.importFlagsJson === null ? null : parseJson(options.importFlagsJson)),
    });
}
const source = await getSourceProvenance(root);
const summary = {
    schemaVersion: 2,
    dictionary: options.dictionaryId,
    fixture,
    authoritativeTiming: !options.trace,
    traceEnabled: options.trace,
    gitSha: source.gitSha,
    source,
    hostEnvironment: getHostEnvironment(),
    browserVersion: runs[0]?.browserVersion ?? null,
    importFlags: options.importFlagsJson === null ? null : parseJson(options.importFlagsJson),
    runs,
    timingBoundary: 'file-input import to observed visible completion; excludes diagnostic reads and post-import validation',
    timing: summarizeDurations(runs.map((run) => run.totalImportMs)),
    workerTiming: runs.every((run) => run.workerImportMs !== null) ? summarizeDurations(/** @type {number[]} */ (runs.map((run) => run.workerImportMs))) : null,
};
const summaryPath = path.join(outputDir, 'summary.json');
await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
console.log(`[perf-import] ${fixture.label} ${options.trace ? 'trace captured' : `median=${summary.timing.medianMs.toFixed(1)}ms min=${summary.timing.minMs.toFixed(1)}ms p95=${summary.timing.p95Ms.toFixed(1)}ms`} (${String(runCount)} run${runCount === 1 ? '' : 's'})`);
console.log(`[perf-import] summary=${summaryPath}`);
