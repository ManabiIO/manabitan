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
import {snapshotTermBankExperiments} from '../../ext/js/dictionary/term-bank-experiments.js';

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
 * Requested flags in a report header are not proof that the worker received
 * them. Check every available worker/effective receipt, not a top-level echo.
 * Activation counters still need separate interpretation for eligibility.
 * @param {Record<string, unknown>} debug
 * @param {unknown} importFlags
 * @throws {Error}
 */
function validateExperimentReceipts(debug, importFlags) {
    const flags = asRecord(importFlags) ?? {};
    const expected = snapshotTermBankExperiments(/** @type {import('dictionary-importer').ImportExperiments} */ (flags));
    let receiptRequired = false;
    for (const key of Object.keys(flags)) {
        if (!key.startsWith('experimental')) { continue; }
        if (!Object.hasOwn(expected, key)) { throw new Error(`Unknown import experiment: ${key}`); }
        receiptRequired = true;
    }
    let receipts = 0;
    const phases = Array.isArray(debug.importerPhaseTimings) ? debug.importerPhaseTimings : [];
    const bankPhases = phases.map(asRecord).filter((phase) => phase?.phase === 'import-data-banks');
    if (bankPhases.length > 1) { throw new Error('Duplicate parser policy context'); }
    const bankDetails = asRecord(bankPhases[0]?.details);
    for (const phase of phases) {
        const details = asRecord(asRecord(phase)?.details);
        if (details === null) { continue; }
        for (const key of ['parserExperiments', 'fastPathParserEffectiveExperiments', 'fastPathParserExperiments', 'compressionExperiments']) {
            if (!Object.hasOwn(details, key)) { continue; }
            const effective = key === 'parserExperiments' || key === 'fastPathParserEffectiveExperiments';
            if (effective) { ++receipts; }
            const prefix = key === 'parserExperiments' ? 'parser' : 'fastPathParser';
            const sourceBytes = details[`${prefix}SourceUncompressedBytes`];
            const workerCount = details[`${prefix}ParallelWorkerCount`];
            // ParallelTermBankPipelineRun enables this key for image projection
            // at >=512 MiB. Establish that production path from independent
            // media/source/native receipts, never from the flag being checked.
            const largeProjectedNativeImport = (
                effective &&
                bankDetails?.useMediaPipeline === true &&
                bankDetails.hasArchiveImageMediaFiles === true &&
                flags.skipImageMetadata !== false &&
                flags.skipMediaImport !== true &&
                Number.isSafeInteger(workerCount) && Number(workerCount) > 0 &&
                details[`${prefix}ParallelSkipReason`] === null &&
                Number.isSafeInteger(sourceBytes) && Number(sourceBytes) >= 512 * 1024 * 1024
            );
            const roleExpected = largeProjectedNativeImport ? {...expected, experimentalNativeEscapedKeys: true} : expected;
            if (!isDeepStrictEqual(details[key], roleExpected)) {
                throw new Error(`Import experiment receipt mismatch: ${key}`);
            }
        }
    }
    if (receiptRequired && receipts === 0) { throw new Error('Missing import experiment worker receipts'); }
}

/**
 * @param {unknown} value
 * @param {string} dictionaryId
 * @param {import('./dictionary-fixtures.js').DictionaryFixture} fixture
 * @param {boolean} traceEnabled
 * @param {unknown} importFlags
 * @param {'all'|'sample'} [mediaCheck]
 * @returns {{totalImportMs: number, automationObservedImportMs: number, workerImportMs: number|null, stepTimingSummary: unknown, step4Breakdown: unknown, importDebug: Record<string, unknown>, validation: Record<string, unknown>}}
 * @throws {Error}
 */
export function extractImportResult(value, dictionaryId, fixture, traceEnabled, importFlags, mediaCheck = 'all') {
    const report = asRecord(value);
    if (report?.status !== 'success' || report.skippedVerification !== false) {
        throw new Error('Import report failed or skipped verification');
    }
    const benchmark = asRecord(report.benchmark);
    if (benchmark?.dictionary !== dictionaryId || benchmark.pinnedDictionaries !== true ||
    benchmark.productionImportDefaults !== true || benchmark.traceEnabled !== traceEnabled ||
    benchmark.authoritativeTiming !== !traceEnabled ||
    benchmark.phaseProfiling !== false || benchmark.phaseScreenshots !== false || benchmark.processSampling !== false ||
    (benchmark.mediaCheck ?? 'all') !== mediaCheck ||
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
    const triggers = phases.filter((entry) => entry?.name === `Import ${fixture.label} via file input`);
    const trigger = triggers[0];
    const start = optionalMetric(phase?.startMs);
    const end = optionalMetric(phase?.endMs);
    const triggerStart = optionalMetric(trigger?.startMs);
    const triggerEnd = optionalMetric(trigger?.endMs);
    if (triggers.length !== 1 || start === null || end === null || triggerStart === null || triggerEnd === null ||
    start !== triggerStart || triggerEnd < triggerStart || end < triggerEnd || Math.abs(duration - (end - start)) > 0.001) {
        throw new Error('Total-import timing must include file-input dispatch through visible completion');
    }
    const browserTiming = asRecord(data.browserTiming);
    const browserStart = optionalMetric(browserTiming?.startedAtMs);
    const browserEnd = optionalMetric(browserTiming?.completedAtMs);
    if (browserStart === null || browserEnd === null || browserEnd <= browserStart ||
    browserTiming?.trigger !== 'file-input-change' || browserTiming.errorCount !== 0 ||
    !Number.isSafeInteger(browserTiming.sequence) || !Number.isSafeInteger(browserTiming.sequenceBefore) ||
    Number(browserTiming.sequence) <= Number(browserTiming.sequenceBefore)) {
        throw new Error('Missing current-operation browser monotonic import timing');
    }
    const debug = asRecord(data.importDebug);
    if (debug?.hasResult !== true || debug.resultTitle !== fixture.expectedTitle || debug.errorCount !== 0 || debug.addSettingsErrorCount !== 0 || debug.usesFallbackStorage !== false) {
        throw new Error(`Import completion did not confirm an error-free ${fixture.expectedTitle}`);
    }
    validateExperimentReceipts(debug, importFlags);
    const validation = asRecord(benchmark.validation);
    const probeTerms = Array.isArray(validation?.probeTerms) ? validation.probeTerms : [];
    const probeSet = new Set(probeTerms);
    if (validation?.title !== fixture.expectedTitle || validation.revision !== fixture.revision ||
    validation.termRows !== fixture.termRows || validation.contentReadable !== true ||
    validation.probeCount !== 12 || probeTerms.length !== 12 || probeSet.size !== 12 ||
    probeTerms.some((term) => typeof term !== 'string' || term.length === 0)) {
        throw new Error(`Missing or invalid post-import validation for ${fixture.expectedTitle}`);
    }
    const restart = asRecord(validation.restart);
    if (restart?.title !== fixture.expectedTitle || restart.revision !== fixture.revision ||
    restart.termRows !== fixture.termRows || restart.contentReadable !== true || restart.probeCount !== probeTerms.length) {
        throw new Error(`Missing or invalid restart validation for ${fixture.expectedTitle}`);
    }
    const lookup = asRecord(validation.lookup);
    const observations = Array.isArray(lookup?.observations) ? lookup.observations.map(asRecord) : [];
    const observationKeys = new Set();
    const invalidLookup = observations.length !== 72 || observations.some((row) => {
        if (row === null || typeof row.pass !== 'number' || !Number.isSafeInteger(row.pass) || row.pass < 0 || row.pass >= 6 ||
        typeof row.term !== 'string' || !probeSet.has(row.term) ||
        row.originalTextLength !== row.term.length || row.hasExactHeadwordMatch !== true ||
        optionalMetric(row.elapsedMs) === null || typeof row.results !== 'number' || !Number.isSafeInteger(row.results) || row.results <= 0 ||
        typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)) { return true; }
        const key = JSON.stringify([row.pass, row.term]);
        if (observationKeys.has(key)) { return true; }
        observationKeys.add(key);
        return false;
    });
    if (invalidLookup) {
        throw new Error(`Missing or invalid storage/lookup observations for ${fixture.expectedTitle}`);
    }
    if (typeof fixture.mediaFiles === 'number') {
        const media = asRecord(validation.media);
        const expectedFiles = mediaCheck === 'all' ? fixture.mediaFiles : Math.min(fixture.mediaFiles, 64);
        if (media?.mode !== mediaCheck || media.totalFiles !== fixture.mediaFiles || media.totalBytes !== fixture.mediaBytes ||
        media.files !== expectedFiles || restart?.mediaFiles !== fixture.mediaFiles ||
        typeof media.bytes !== 'number' || !Number.isSafeInteger(media.bytes) || media.bytes < 0 || media.bytes > Number(fixture.mediaBytes) ||
        (expectedFiles > 0 && media.bytes === 0) ||
        (mediaCheck === 'all' && media.bytes !== fixture.mediaBytes) ||
        typeof media.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(media.sha256) ||
        (expectedFiles === 0 && (media.bytes !== 0 || media.sha256 !== createHash('sha256').digest('hex')))) {
            throw new Error(`Missing or invalid persisted media validation for ${fixture.expectedTitle}`);
        }
        const storage = asRecord(validation.storage);
        if (typeof storage?.bytes !== 'number' || !Number.isSafeInteger(storage.bytes) || storage.bytes <= 0) {
            throw new Error(`Missing or invalid storage/lookup observations for ${fixture.expectedTitle}`);
        }
    }
    const localPhases = Array.isArray(debug.localPhaseTimings) ? debug.localPhaseTimings.map(asRecord) : [];
    const workerPhases = localPhases.filter((entry) => entry?.phase === 'worker-import-dictionary');
    return {
        totalImportMs: browserEnd - browserStart,
        automationObservedImportMs: duration,
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
        'dev/perf/import-media-validation.js',
        'test/chromium/import-flags-ab-benchmark.js',
        'test/chromium/extension-two-dictionary-import.e2e.js',
        'test/e2e/import-timing.js',
        'ext/js/pages/settings/dictionary-import-controller.js',
        'builds/manabitan-chrome-dev.zip',
        'builds/manabitan-chrome.zip',
    ]) {
        try {
            sha256[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
        } catch {
            sha256[file] = null;
        }
    }
    return {gitSha, dirty, sha256};
}
