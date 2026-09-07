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

import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {parseJson} from '../../ext/js/core/json.js';
import {loadDictionaryFixtures} from '../../dev/perf/dictionary-fixtures.js';
import {createBenchmarkEnvironment, extractImportResult, getSourceProvenance, asRecord, optionalMetric, parsePositiveInteger, median, metricDelta, percentDelta, roundMetric} from '../../dev/perf/benchmark-support.js';

const execFileAsync = promisify(execFile);
const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dirname, '..', '..');
const buildsDir = path.join(root, 'builds');

function parseCliArgs() {
    const args = process.argv.slice(2);
    let dictionaryId = '';
    let pairCount = null;
    let flagsJson = null;
    let label = '';
    for (let i = 0; i < args.length; ++i) {
        const arg = args[i];
        switch (arg) {
            case '--pairs': {
                pairCount = parsePositiveInteger(args[++i] ?? '', '--pairs');

                break;
            }
            case '--flags': {
                flagsJson = args[++i] ?? '';

                break;
            }
            case '--label': {
                label = args[++i] ?? '';

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
    return {dictionaryId: dictionaryId || 'jmdict', pairCount, flagsJson, label};
}

const cli = parseCliArgs();
const fixtures = await loadDictionaryFixtures();
const fixture = fixtures[cli.dictionaryId];
if (!fixture) { throw new Error(`Unknown dictionary: ${cli.dictionaryId}`); }
const timestamp = new Date().toISOString()
    .replaceAll(':', '')
    .replaceAll('.', '')
    .replaceAll('-', '');
const baselineImportFlags = {};
const referenceIterations = Number.parseInt(process.env.MANABITAN_AB_REFERENCE_ITERATIONS ?? '10', 10);
const iterationPercent = Number.parseFloat(process.env.MANABITAN_AB_ITERATION_PERCENT ?? '10');
const pairIterationsOverride = cli.pairCount ?? (typeof process.env.MANABITAN_AB_PAIR_ITERATIONS === 'string' ? parsePositiveInteger(process.env.MANABITAN_AB_PAIR_ITERATIONS, 'MANABITAN_AB_PAIR_ITERATIONS') : null);
const pairIterationsFromPercent = Math.round(referenceIterations * (iterationPercent / 100));
const pairIterations = pairIterationsOverride !== null ?
    pairIterationsOverride :
    Math.max(1, Number.isFinite(pairIterationsFromPercent) ? pairIterationsFromPercent : 1);
const quickMode = (process.env.MANABITAN_AB_QUICK_MODE ?? '1').trim() !== '0';
if (!quickMode) { throw new Error('A/B timing requires quick single-dictionary mode'); }
const collectBulkAddBytesMetrics = (process.env.MANABITAN_AB_BULKADD_BYTES_METRICS ?? '1').trim() !== '0';

/**
 * @typedef {object} VariantSpec
 * @property {string} id
 * @property {string} label
 * @property {Record<string, unknown>} importFlags
 * @property {string} targetedMetricLabel
 */

/**
 * @type {VariantSpec[]}
 */
const variants = [];
if (cli.flagsJson !== null) {
    const parsedFlags = parseJson(cli.flagsJson);
    if (!(parsedFlags && typeof parsedFlags === 'object' && !Array.isArray(parsedFlags))) {
        throw new Error('--flags must contain a JSON object');
    }
    variants.push({
        id: 'cli-variant',
        label: cli.label || 'CLI variant',
        importFlags: /** @type {Record<string, unknown>} */ (parsedFlags),
        targetedMetricLabel: 'step4 bulkAdd terms',
    });
}

/**
 * @param {string} reportPath
 * @returns {string}
 */
function toJsonPath(reportPath) {
    return reportPath.replace(/\.html$/i, '.json');
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
 * @param {unknown} logsRaw
 * @returns {{rows: number, totalMs: number, estimatedBytes: number, bytesPerRow: number, rowsPerSecond: number, msPerKRows: number}}
 */
function summarizeBulkAddTermsLogs(logsRaw) {
    const logs = Array.isArray(logsRaw) ? logsRaw : [];
    const pattern = /bulkAdd terms done rows=(\d+) total=([\d.]+)ms[\s\S]*?\sbps=([\d.]+)/;
    let rows = 0;
    let totalMs = 0;
    let estimatedBytes = 0;
    for (const entry of logs) {
        const text = String(entry);
        const match = text.match(pattern);
        if (!match) { continue; }
        const batchRows = asNumber(match[1]);
        const batchTotalMs = asNumber(match[2]);
        const batchBytesPerSecond = asNumber(match[3]);
        rows += batchRows;
        totalMs += batchTotalMs;
        estimatedBytes += batchBytesPerSecond * (batchTotalMs / 1000);
    }
    const bytesPerRow = rows > 0 ? (estimatedBytes / rows) : 0;
    const rowsPerSecond = totalMs > 0 ? ((rows * 1000) / totalMs) : 0;
    const msPerKRows = rows > 0 ? ((totalMs * 1000) / rows) : 0;
    return {rows, totalMs, estimatedBytes, bytesPerRow, rowsPerSecond, msPerKRows};
}

/**
 * @param {Record<string, unknown>} report
 * @param {unknown} flags
 * @returns {{totalImportMs: number, workerImportMs: number|null, step4BulkAddTermsMs: number|null, step4AccountedMs: number|null, bulkAddTermsPayloadBytesPerRow: number|null, bulkAddTermsEstimatedBytes: number|null, bulkAddTermsRowsPerSecond: number|null, bulkAddTermsMsPerKRows: number|null}}
 */
function summarizeReport(report, flags) {
    const result = extractImportResult(report, cli.dictionaryId, fixture, false, flags);
    const aggregate = asRecord(asRecord(result.step4Breakdown)?.aggregate);
    const bulk = summarizeBulkAddTermsLogs(report.logs);
    return {
        totalImportMs: result.totalImportMs,
        workerImportMs: result.workerImportMs,
        step4BulkAddTermsMs: optionalMetric(aggregate?.bulkAddTermsMs),
        step4AccountedMs: optionalMetric(aggregate?.accountedMs),
        bulkAddTermsPayloadBytesPerRow: bulk.rows > 0 ? bulk.bytesPerRow : null,
        bulkAddTermsEstimatedBytes: bulk.rows > 0 ? bulk.estimatedBytes : null,
        bulkAddTermsRowsPerSecond: bulk.rows > 0 ? bulk.rowsPerSecond : null,
        bulkAddTermsMsPerKRows: bulk.rows > 0 ? bulk.msPerKRows : null,
    };
}

/**
 * @param {string} runId
 * @param {Record<string, string>} envOverrides
 * @returns {Promise<{runId: string, reportPath: string, reportJsonPath: string, summary: ReturnType<typeof summarizeReport>}>}
 * @throws {Error}
 */
async function runOnce(runId, envOverrides) {
    const reportPath = envOverrides.MANABITAN_CHROMIUM_E2E_REPORT;
    if (typeof reportPath !== 'string' || reportPath.length === 0) {
        throw new Error(`Missing report path for ${runId}`);
    }
    const reportJsonPath = toJsonPath(reportPath);
    await rm(reportJsonPath, {force: true});
    console.log(`[flags-ab] running runId="${runId}" report=${reportPath}`);
    await execFileAsync(
        process.execPath,
        ['./test/chromium/extension-two-dictionary-import.e2e.js'],
        {
            cwd: root,
            env: createBenchmarkEnvironment(process.env, envOverrides),
            timeout: 10 * 60 * 1000,
            killSignal: 'SIGTERM',
            maxBuffer: 64 * 1024 * 1024,
        },
    );
    const reportRaw = await readFile(reportJsonPath, 'utf8');
    const report = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (parseJson(reportRaw)));
    return {
        runId,
        reportPath,
        reportJsonPath,
        summary: summarizeReport(report, envOverrides.MANABITAN_E2E_IMPORT_FLAGS_JSON ? parseJson(envOverrides.MANABITAN_E2E_IMPORT_FLAGS_JSON) : null),
    };
}

/**
 * @param {VariantSpec} variant
 * @param {boolean} skipBuildForFirstBaseline
 * @returns {Promise<{variant: VariantSpec, runPairs: Array<{iteration: number, baseline: Awaited<ReturnType<typeof runOnce>>, variant: Awaited<ReturnType<typeof runOnce>>, deltas: {totalImportMsDelta: number|null, totalImportPercentDelta: number|null, targetedMetricDelta: number|null, targetedMetricPercentDelta: number|null, bulkAddPayloadBytesPerRowDelta: number|null, bulkAddPayloadBytesPerRowPercentDelta: number|null, bulkAddRowsPerSecondDelta: number|null, bulkAddRowsPerSecondPercentDelta: number|null, bulkAddMsPerKRowsDelta: number|null, bulkAddMsPerKRowsPercentDelta: number|null}}>, medians: {baselineWorkerImportMs: number|null, variantWorkerImportMs: number|null, workerImportPercentDelta: number|null, baselineTotalImportMs: number|null, variantTotalImportMs: number|null, baselineTargetedMetricMs: number|null, variantTargetedMetricMs: number|null, totalImportMsDelta: number|null, totalImportPercentDelta: number|null, targetedMetricDelta: number|null, targetedMetricPercentDelta: number|null, baselineBulkAddPayloadBytesPerRow: number|null, variantBulkAddPayloadBytesPerRow: number|null, bulkAddPayloadBytesPerRowDelta: number|null, bulkAddPayloadBytesPerRowPercentDelta: number|null, baselineBulkAddRowsPerSecond: number|null, variantBulkAddRowsPerSecond: number|null, bulkAddRowsPerSecondDelta: number|null, bulkAddRowsPerSecondPercentDelta: number|null, baselineBulkAddMsPerKRows: number|null, variantBulkAddMsPerKRows: number|null, bulkAddMsPerKRowsDelta: number|null, bulkAddMsPerKRowsPercentDelta: number|null}}>}
 */
async function runPairedVariant(variant, skipBuildForFirstBaseline) {
    /** @type {Array<{iteration: number, baseline: Awaited<ReturnType<typeof runOnce>>, variant: Awaited<ReturnType<typeof runOnce>>, deltas: {totalImportMsDelta: number|null, totalImportPercentDelta: number|null, targetedMetricDelta: number|null, targetedMetricPercentDelta: number|null, bulkAddPayloadBytesPerRowDelta: number|null, bulkAddPayloadBytesPerRowPercentDelta: number|null, bulkAddRowsPerSecondDelta: number|null, bulkAddRowsPerSecondPercentDelta: number|null, bulkAddMsPerKRowsDelta: number|null, bulkAddMsPerKRowsPercentDelta: number|null}}>} */
    const runPairs = [];
    const baselineTotals = [];
    const variantTotals = [];
    const baselineTargeted = [];
    const variantTargeted = [];
    const baselineBulkAddPayloadBytesPerRowValues = [];
    const variantBulkAddPayloadBytesPerRowValues = [];
    const baselineBulkAddRowsPerSecondValues = [];
    const variantBulkAddRowsPerSecondValues = [];
    const baselineBulkAddMsPerKRowsValues = [];
    const variantBulkAddMsPerKRowsValues = [];
    const totalDeltas = [];
    const targetedDeltas = [];
    const totalPercentDeltas = [];
    const targetedPercentDeltas = [];
    const bulkAddPayloadBytesPerRowDeltas = [];
    const bulkAddPayloadBytesPerRowPercentDeltas = [];
    const bulkAddRowsPerSecondDeltas = [];
    const bulkAddRowsPerSecondPercentDeltas = [];
    const bulkAddMsPerKRowsDeltas = [];
    const bulkAddMsPerKRowsPercentDeltas = [];

    for (let iteration = 1; iteration <= pairIterations; ++iteration) {
        const runIdPrefix = `${variant.id}-iter${String(iteration)}`;
        const baselineReportPath = path.join(buildsDir, `chromium-e2e-import-report-iso-${runIdPrefix}-baseline-${timestamp}.html`);
        const variantReportPath = path.join(buildsDir, `chromium-e2e-import-report-iso-${runIdPrefix}-variant-${timestamp}.html`);
        const baselineRunImportFlags = {
            ...baselineImportFlags,
            ...(collectBulkAddBytesMetrics ? {debugImportLogging: true} : {}),
        };
        const variantImportFlags = {
            ...baselineImportFlags,
            ...variant.importFlags,
            ...(collectBulkAddBytesMetrics ? {debugImportLogging: true} : {}),
        };
        const commonEnv = {
            MANABITAN_E2E_IMPORT_BENCH_QUICK: quickMode ? '1' : '0',
            MANABITAN_E2E_IMPORT_BENCH_DICTIONARY: quickMode ? cli.dictionaryId : '',
            MANABITAN_E2E_USE_PERF_DICTIONARY_LOCK: '1',
            MANABITAN_E2E_IMPORT_USE_PRODUCTION_DEFAULTS: '1',
            MANABITAN_E2E_PHASE_PROFILING: '0',
            MANABITAN_E2E_PHASE_SCREENSHOTS: '0',
            MANABITAN_E2E_PROCESS_SAMPLING: '0',
            MANABITAN_CHROMIUM_E2E_MAX_LOG_LINES: collectBulkAddBytesMetrics ? '10000' : '1000',
        };
        const runBaseline = async (/** @type {boolean} */ skipBuild) => await runOnce(`${runIdPrefix}:baseline`, {
            ...commonEnv,
            MANABITAN_CHROMIUM_E2E_REPORT: baselineReportPath,
            MANABITAN_E2E_SKIP_BUILD: skipBuild ? '1' : '0',
            ...(Object.keys(baselineRunImportFlags).length > 0 ?
{
    MANABITAN_E2E_IMPORT_FLAGS_JSON: JSON.stringify(baselineRunImportFlags),
} :
{}),
        });
        const runVariant = async (/** @type {boolean} */ skipBuild) => await runOnce(`${runIdPrefix}:variant`, {
            ...commonEnv,
            MANABITAN_CHROMIUM_E2E_REPORT: variantReportPath,
            MANABITAN_E2E_SKIP_BUILD: skipBuild ? '1' : '0',
            ...(Object.keys(variantImportFlags).length > 0 ?
{
    MANABITAN_E2E_IMPORT_FLAGS_JSON: JSON.stringify(variantImportFlags),
} :
{}),
        });
        const variantFirst = (iteration % 2) === 0;
        const skipFirstBuild = iteration > 1 || skipBuildForFirstBaseline;
        let baseline;
        let variantRun;
        if (variantFirst) {
            variantRun = await runVariant(skipFirstBuild);
            baseline = await runBaseline(true);
        } else {
            baseline = await runBaseline(skipFirstBuild);
            variantRun = await runVariant(true);
        }
        const totalImportMsDelta = variantRun.summary.totalImportMs - baseline.summary.totalImportMs;
        const totalImportPercentDelta = percentDelta(baseline.summary.totalImportMs, variantRun.summary.totalImportMs);
        const targetedMetricDelta = metricDelta(baseline.summary.step4BulkAddTermsMs, variantRun.summary.step4BulkAddTermsMs);
        const targetedMetricPercentDelta = percentDelta(baseline.summary.step4BulkAddTermsMs, variantRun.summary.step4BulkAddTermsMs);
        const bulkAddPayloadBytesPerRowDelta = metricDelta(baseline.summary.bulkAddTermsPayloadBytesPerRow, variantRun.summary.bulkAddTermsPayloadBytesPerRow);
        const bulkAddPayloadBytesPerRowPercentDelta = percentDelta(baseline.summary.bulkAddTermsPayloadBytesPerRow, variantRun.summary.bulkAddTermsPayloadBytesPerRow);
        const bulkAddRowsPerSecondDelta = metricDelta(baseline.summary.bulkAddTermsRowsPerSecond, variantRun.summary.bulkAddTermsRowsPerSecond);
        const bulkAddRowsPerSecondPercentDelta = percentDelta(baseline.summary.bulkAddTermsRowsPerSecond, variantRun.summary.bulkAddTermsRowsPerSecond);
        const bulkAddMsPerKRowsDelta = metricDelta(baseline.summary.bulkAddTermsMsPerKRows, variantRun.summary.bulkAddTermsMsPerKRows);
        const bulkAddMsPerKRowsPercentDelta = percentDelta(baseline.summary.bulkAddTermsMsPerKRows, variantRun.summary.bulkAddTermsMsPerKRows);
        runPairs.push({
            iteration,
            baseline,
            variant: variantRun,
            deltas: {
                totalImportMsDelta,
                totalImportPercentDelta,
                targetedMetricDelta,
                targetedMetricPercentDelta,
                bulkAddPayloadBytesPerRowDelta,
                bulkAddPayloadBytesPerRowPercentDelta,
                bulkAddRowsPerSecondDelta,
                bulkAddRowsPerSecondPercentDelta,
                bulkAddMsPerKRowsDelta,
                bulkAddMsPerKRowsPercentDelta,
            },
        });
        baselineTotals.push(baseline.summary.totalImportMs);
        variantTotals.push(variantRun.summary.totalImportMs);
        baselineTargeted.push(baseline.summary.step4BulkAddTermsMs);
        variantTargeted.push(variantRun.summary.step4BulkAddTermsMs);
        baselineBulkAddPayloadBytesPerRowValues.push(baseline.summary.bulkAddTermsPayloadBytesPerRow);
        variantBulkAddPayloadBytesPerRowValues.push(variantRun.summary.bulkAddTermsPayloadBytesPerRow);
        baselineBulkAddRowsPerSecondValues.push(baseline.summary.bulkAddTermsRowsPerSecond);
        variantBulkAddRowsPerSecondValues.push(variantRun.summary.bulkAddTermsRowsPerSecond);
        baselineBulkAddMsPerKRowsValues.push(baseline.summary.bulkAddTermsMsPerKRows);
        variantBulkAddMsPerKRowsValues.push(variantRun.summary.bulkAddTermsMsPerKRows);
        totalDeltas.push(totalImportMsDelta);
        targetedDeltas.push(targetedMetricDelta);
        totalPercentDeltas.push(totalImportPercentDelta);
        targetedPercentDeltas.push(targetedMetricPercentDelta);
        bulkAddPayloadBytesPerRowDeltas.push(bulkAddPayloadBytesPerRowDelta);
        bulkAddPayloadBytesPerRowPercentDeltas.push(bulkAddPayloadBytesPerRowPercentDelta);
        bulkAddRowsPerSecondDeltas.push(bulkAddRowsPerSecondDelta);
        bulkAddRowsPerSecondPercentDeltas.push(bulkAddRowsPerSecondPercentDelta);
        bulkAddMsPerKRowsDeltas.push(bulkAddMsPerKRowsDelta);
        bulkAddMsPerKRowsPercentDeltas.push(bulkAddMsPerKRowsPercentDelta);
    }

    const medians = {
        baselineWorkerImportMs: median(runPairs.map((pair) => pair.baseline.summary.workerImportMs)),
        variantWorkerImportMs: median(runPairs.map((pair) => pair.variant.summary.workerImportMs)),
        workerImportPercentDelta: median(runPairs.map((pair) => percentDelta(pair.baseline.summary.workerImportMs, pair.variant.summary.workerImportMs))),
        baselineTotalImportMs: median(baselineTotals),
        variantTotalImportMs: median(variantTotals),
        baselineTargetedMetricMs: median(baselineTargeted),
        variantTargetedMetricMs: median(variantTargeted),
        totalImportMsDelta: median(totalDeltas),
        totalImportPercentDelta: median(totalPercentDeltas),
        targetedMetricDelta: median(targetedDeltas),
        targetedMetricPercentDelta: median(targetedPercentDeltas),
        baselineBulkAddPayloadBytesPerRow: median(baselineBulkAddPayloadBytesPerRowValues),
        variantBulkAddPayloadBytesPerRow: median(variantBulkAddPayloadBytesPerRowValues),
        bulkAddPayloadBytesPerRowDelta: median(bulkAddPayloadBytesPerRowDeltas),
        bulkAddPayloadBytesPerRowPercentDelta: median(bulkAddPayloadBytesPerRowPercentDeltas),
        baselineBulkAddRowsPerSecond: median(baselineBulkAddRowsPerSecondValues),
        variantBulkAddRowsPerSecond: median(variantBulkAddRowsPerSecondValues),
        bulkAddRowsPerSecondDelta: median(bulkAddRowsPerSecondDeltas),
        bulkAddRowsPerSecondPercentDelta: median(bulkAddRowsPerSecondPercentDeltas),
        baselineBulkAddMsPerKRows: median(baselineBulkAddMsPerKRowsValues),
        variantBulkAddMsPerKRows: median(variantBulkAddMsPerKRowsValues),
        bulkAddMsPerKRowsDelta: median(bulkAddMsPerKRowsDeltas),
        bulkAddMsPerKRowsPercentDelta: median(bulkAddMsPerKRowsPercentDeltas),
    };

    return {variant, runPairs, medians};
}

/**
 * @returns {Promise<void>}
 * @throws {Error}
 */
async function main() {
    if (!Number.isFinite(pairIterations) || pairIterations < 1) {
        throw new Error(`Invalid pair iteration count derived from referenceIterations=${String(referenceIterations)} iterationPercent=${String(iterationPercent)}`);
    }
    if (variants.length === 0) {
        throw new Error("No A/B variant configured. Pass --flags JSON (for example: --flags '{\"zipMaxWorkers\":3}').");
    }
    await mkdir(buildsDir, {recursive: true});

    /** @type {Array<{ok: true, result: Awaited<ReturnType<typeof runPairedVariant>>} | {ok: false, variant: VariantSpec, error: string}>} */
    const results = [];
    for (let i = 0; i < variants.length; ++i) {
        const variant = variants[i];
        const skipBuildForFirstBaseline = i > 0;
        try {
            const result = await runPairedVariant(variant, skipBuildForFirstBaseline);
            results.push({ok: true, result});
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            results.push({ok: false, variant, error});
            console.error(`[flags-ab] variant failed id="${variant.id}" error=${error}`);
        }
    }

    const summary = {
        schemaVersion: 2,
        source: await getSourceProvenance(root),
        authoritativeTiming: !collectBulkAddBytesMetrics,
        fixture,
        timestamp,
        dictionary: cli.dictionaryId,
        baselineImportFlags,
        variants,
        referenceIterations,
        iterationPercent,
        pairIterations,
        quickMode,
        collectBulkAddBytesMetrics,
        note: 'Each variant is paired with an immediate baseline; order alternates AB/BA by iteration to reduce drift. "Payload bytes/row" is data density, not speed.',
        results: results.map((entry) => {
            if (!entry.ok) {
                return {
                    id: entry.variant.id,
                    label: entry.variant.label,
                    targetedMetricLabel: entry.variant.targetedMetricLabel,
                    importFlags: entry.variant.importFlags,
                    status: 'failed',
                    error: entry.error,
                };
            }
            return {
                id: entry.result.variant.id,
                label: entry.result.variant.label,
                targetedMetricLabel: entry.result.variant.targetedMetricLabel,
                importFlags: entry.result.variant.importFlags,
                status: 'ok',
                medians: entry.result.medians,
                runPairs: entry.result.runPairs,
            };
        }),
    };
    const summaryPath = path.join(buildsDir, `chromium-e2e-import-flags-isolated-summary-${timestamp}.json`);
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

    if (results.some((entry) => !entry.ok)) { process.exitCode = 1; }
    console.log('[flags-ab] summary');
    console.log(JSON.stringify({
        timestamp,
        dictionary: cli.dictionaryId,
        referenceIterations,
        iterationPercent,
        pairIterations,
        quickMode,
        collectBulkAddBytesMetrics,
        baselineImportFlags,
        variants: results.map((entry) => {
            if (!entry.ok) {
                return {
                    id: entry.variant.id,
                    label: entry.variant.label,
                    status: 'failed',
                    error: entry.error,
                };
            }
            const result = entry.result;
            return {
                id: result.variant.id,
                label: result.variant.label,
                targetedMetricLabel: result.variant.targetedMetricLabel,
                status: 'ok',
                totalImportMs: {
                    baselineMedian: roundMetric(result.medians.baselineTotalImportMs),
                    variantMedian: roundMetric(result.medians.variantTotalImportMs),
                    deltaMedian: roundMetric(result.medians.totalImportMsDelta),
                    percentDeltaMedian: roundMetric(result.medians.totalImportPercentDelta, 2),
                },
                targetedMetricMs: {
                    baselineMedian: roundMetric(result.medians.baselineTargetedMetricMs),
                    variantMedian: roundMetric(result.medians.variantTargetedMetricMs),
                    deltaMedian: roundMetric(result.medians.targetedMetricDelta),
                    percentDeltaMedian: roundMetric(result.medians.targetedMetricPercentDelta, 2),
                },
                bulkAddPayloadBytesPerRow: {
                    baselineMedian: roundMetric(result.medians.baselineBulkAddPayloadBytesPerRow, 2),
                    variantMedian: roundMetric(result.medians.variantBulkAddPayloadBytesPerRow, 2),
                    deltaMedian: roundMetric(result.medians.bulkAddPayloadBytesPerRowDelta, 2),
                    percentDeltaMedian: roundMetric(result.medians.bulkAddPayloadBytesPerRowPercentDelta, 2),
                },
                bulkAddRowsPerSecond: {
                    baselineMedian: roundMetric(result.medians.baselineBulkAddRowsPerSecond, 1),
                    variantMedian: roundMetric(result.medians.variantBulkAddRowsPerSecond, 1),
                    deltaMedian: roundMetric(result.medians.bulkAddRowsPerSecondDelta, 1),
                    percentDeltaMedian: roundMetric(result.medians.bulkAddRowsPerSecondPercentDelta, 2),
                },
                bulkAddMsPerKRows: {
                    baselineMedian: roundMetric(result.medians.baselineBulkAddMsPerKRows, 2),
                    variantMedian: roundMetric(result.medians.variantBulkAddMsPerKRows, 2),
                    deltaMedian: roundMetric(result.medians.bulkAddMsPerKRowsDelta, 2),
                    percentDeltaMedian: roundMetric(result.medians.bulkAddMsPerKRowsPercentDelta, 2),
                },
            };
        }),
        summaryPath,
    }, null, 2));
}

await main();
