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

import {isDeepStrictEqual, promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {parseJson} from '../../ext/js/core/json.js';

/**
 * @param {string} value
 * @param {string} label
 * @returns {number}
 * @throws {Error}
 */
export function parsePositiveInteger(value, label) {
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error(`${label} must be a positive safe integer, got ${JSON.stringify(value)}`);
    }
    return Number(value);
}

/**
 * Drop inherited harness controls, including flags, traces, early exits and
 * skipped checks. Keep normal runtime settings (PATH, browser cache, etc.).
 * @param {Record<string, string|undefined>} parent
 * @param {Record<string, string|undefined>} overrides
 * @returns {Record<string, string|undefined>}
 */
export function createBenchmarkEnvironment(parent, overrides) {
    const env = {...parent};
    for (const key of Object.keys(env)) {
        if (/^MANABITAN_(?:E2E_|CHROMIUM_)/.test(key)) {
            delete env[key];
        }
    }
    return {
        ...env,
        MANABITAN_CHROMIUM_BROWSER: 'chromium',
        MANABITAN_CHROMIUM_HEADLESS: '1',
        MANABITAN_CHROMIUM_ALLOW_HEADED_FALLBACK: '0',
        MANABITAN_E2E_STRICT_RUNTIME: '1',
        ...overrides,
    };
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>|null}
 */
export function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ?
        /** @type {Record<string, unknown>} */ (value) :
        null;
}

/**
 * Missing diagnostic metrics are not measurements of zero work.
 * @param {unknown} value
 * @returns {number|null}
 */
export function optionalMetric(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * @param {unknown} value
 * @param {string} dictionaryId
 * @param {import('./dictionary-fixtures.js').DictionaryFixture} fixture
 * @param {boolean} traceEnabled
 * @param {unknown} importFlags
 * @returns {{totalImportMs: number, workerImportMs: number|null, stepTimingSummary: unknown, step4Breakdown: unknown, importDebug: Record<string, unknown>, validation: Record<string, unknown>}}
 * @throws {Error}
 */
export function extractImportResult(value, dictionaryId, fixture, traceEnabled, importFlags) {
    const report = asRecord(value);
    if (report?.status !== 'success' || report.skippedVerification !== false) {
        throw new Error('Import report failed or skipped verification');
    }
    const benchmark = asRecord(report.benchmark);
    if (benchmark?.dictionary !== dictionaryId || benchmark.pinnedDictionaries !== true ||
    benchmark.productionImportDefaults !== true || benchmark.traceEnabled !== traceEnabled ||
    benchmark.authoritativeTiming !== !traceEnabled ||
    benchmark.phaseProfiling !== false || benchmark.phaseScreenshots !== false || benchmark.processSampling !== false ||
    !isDeepStrictEqual(benchmark.importFlags, importFlags)) {
        throw new Error('Import report benchmark configuration does not match the requested run');
    }
    const phases = Array.isArray(report.phases) ? report.phases.map(asRecord) : [];
    const matching = phases.filter((phase) => phase?.name === `${fixture.label}: total import`);
    const phase = matching[0];
    const data = asRecord(phase?.data);
    const duration = optionalMetric(phase?.durationMs);
    if (matching.length !== 1 || data?.kind !== 'dictionary-import' || data.dictionary !== fixture.label || duration === null || duration <= 0) {
        throw new Error(`Missing, duplicate or invalid ${fixture.label} total-import phase`);
    }
    const debug = asRecord(data.importDebug);
    if (debug?.hasResult !== true || debug.resultTitle !== fixture.expectedTitle || debug.errorCount !== 0 || debug.addSettingsErrorCount !== 0 || debug.usesFallbackStorage !== false) {
        throw new Error(`Import completion did not confirm an error-free ${fixture.expectedTitle}`);
    }
    const validation = asRecord(benchmark.validation);
    if (validation?.title !== fixture.expectedTitle || validation.revision !== fixture.revision ||
    validation.termRows !== fixture.termRows || validation.contentReadable !== true ||
    typeof validation.probeCount !== 'number' || validation.probeCount < 12) {
        throw new Error(`Missing or invalid post-import validation for ${fixture.expectedTitle}`);
    }
    const localPhases = Array.isArray(debug.localPhaseTimings) ? debug.localPhaseTimings.map(asRecord) : [];
    const workerPhases = localPhases.filter((entry) => entry?.phase === 'worker-import-dictionary');
    return {
        totalImportMs: duration,
        workerImportMs: workerPhases.length === 1 ? optionalMetric(workerPhases[0]?.elapsedMs) : null,
        stepTimingSummary: data.stepTimingSummary ?? null,
        step4Breakdown: data.step4Breakdown ?? null,
        importDebug: debug,
        validation,
    };
}

/**
 * @param {number|null} base
 * @param {number|null} next
 * @returns {number|null}
 */
export function metricDelta(base, next) {
    return base === null || next === null ? null : next - base;
}

/**
 * @param {number|null} base
 * @param {number|null} next
 * @returns {number|null}
 */
export function percentDelta(base, next) {
    return base === null || next === null || base <= 0 ? null : ((next - base) / base) * 100;
}

/**
 * Do not silently use a subset of pairs when a diagnostic is unavailable.
 * @param {(number|null)[]} values
 * @returns {number|null}
 */
export function median(values) {
    if (values.length === 0 || values.some((value) => value === null || !Number.isFinite(value))) { return null; }
    const sorted = /** @type {number[]} */ ([...values]).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * @param {number|null} value
 * @param {number} [digits]
 * @returns {number|null}
 */
export function roundMetric(value, digits = 0) {
    return value === null ? null : Number(value.toFixed(digits));
}


/**
 * Distinguish source lineage from a modified snapshot, and identify the actual
 * harness and built extension bytes even when a bundle intentionally lacks Git.
 * @param {string} root
 * @returns {Promise<{gitSha: string|null, dirty: boolean|null, sha256: Record<string, string|null>}>}
 */
export async function getSourceProvenance(root) {
    let gitSha = null;
    let dirty = null;
    try {
        const run = promisify(execFile);
        const {stdout} = await run('git', ['rev-parse', 'HEAD'], {cwd: root});
        gitSha = stdout.trim();
        const status = await run('git', ['status', '--porcelain'], {cwd: root});
        dirty = status.stdout.trim().length > 0;
    } catch {
        try {
            const manifest = asRecord(parseJson(await readFile(path.join(root, 'perf-bundle-manifest.json'), 'utf8')));
            gitSha = typeof manifest?.gitSha === 'string' ? manifest.gitSha : null;
            dirty = typeof manifest?.dirty === 'boolean' ? manifest.dirty : null;
        } catch {
            // Missing provenance remains unknown; never imply a clean checkout.
        }
    }
    /** @type {Record<string, string|null>} */
    const sha256 = {};
    for (const file of [
        'package-lock.json',
        'test/perf/dictionaries.lock.json',
        'dev/perf/benchmark-support.js',
        'dev/perf/dictionary-fixtures.js',
        'dev/perf/import-benchmark.js',
        'test/chromium/import-flags-ab-benchmark.js',
        'test/chromium/extension-two-dictionary-import.e2e.js',
        'builds/manabitan-chrome-dev.zip',
    ]) {
        try {
            sha256[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
        } catch {
            sha256[file] = null;
        }
    }
    return {gitSha, dirty, sha256};
}
