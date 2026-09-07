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

import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {createBenchmarkEnvironment, extractImportResult, median, metricDelta, optionalMetric, parsePositiveInteger, percentDelta, roundMetric} from '../dev/perf/benchmark-support.js';
import {ensureFixtureFile, loadDictionaryFixtures} from '../dev/perf/dictionary-fixtures.js';

const fixtures = await loadDictionaryFixtures();
const fixture = fixtures.jmdict;
const execFileAsync = promisify(execFile);

/**
 * @returns {Record<string, any>}
 */
function validReport() {
    return {
        status: 'success',
        skippedVerification: false,
        benchmark: {
            dictionary: 'jmdict',
            pinnedDictionaries: true,
            productionImportDefaults: true,
            traceEnabled: false,
            authoritativeTiming: true,
            phaseProfiling: false,
            phaseScreenshots: false,
            processSampling: false,
            importFlags: null,
            validation: {title: fixture.expectedTitle, revision: fixture.revision, termRows: fixture.termRows, contentReadable: true, probeCount: 12},
        },
        phases: [{
            name: 'JMdict: total import',
            durationMs: 123.5,
            startMs: 100,
            endMs: 223.5,
            data: {kind: 'dictionary-import', dictionary: 'JMdict', browserTiming: {startedAtMs: 10, completedAtMs: 133.5, sequence: 1, sequenceBefore: 0, trigger: 'file-input-change', errorCount: 0}, importDebug: {hasResult: true, resultTitle: fixture.expectedTitle, errorCount: 0, addSettingsErrorCount: 0, usesFallbackStorage: false}},
        }, {
            name: 'Import JMdict via file input',
            startMs: 100,
            endMs: 140,
        }],
    };
}

describe('benchmark timing boundary', () => {
    test('includes time spent dispatching the file input', () => {
        expect(extractImportResult(validReport(), 'jmdict', fixture, false, null).totalImportMs).toBe(123.5);
    });
    test('rejects the old post-dispatch timing boundary', () => {
        const report = validReport();
        report.phases[0].startMs = 140;
        report.phases[0].durationMs = 83.5;
        expect(() => extractImportResult(report, 'jmdict', fixture, false, null)).toThrow('include file-input dispatch');
    });
    test('rejects absent or duplicated trigger measurements', () => {
        const report = validReport();
        report.phases.pop();
        expect(() => extractImportResult(report, 'jmdict', fixture, false, null)).toThrow('include file-input dispatch');
        const duplicate = validReport();
        duplicate.phases.push(duplicate.phases[1]);
        expect(() => extractImportResult(duplicate, 'jmdict', fixture, false, null)).toThrow('include file-input dispatch');
    });
    test('uses browser timing independently of automation overhead', () => {
        const report = validReport();
        report.phases[0].endMs = 1000;
        report.phases[0].durationMs = 900;
        const result = extractImportResult(report, 'jmdict', fixture, false, null);
        expect(result.totalImportMs).toBe(123.5);
        expect(result.automationObservedImportMs).toBe(900);
    });
    test.each([null, {startedAtMs: 1, completedAtMs: 2, sequence: 0, sequenceBefore: 0, trigger: 'file-input-change', errorCount: 0}])('rejects absent or stale browser timing', (timing) => {
        const report = validReport();
        report.phases[0].data.browserTiming = timing;
        expect(() => extractImportResult(report, 'jmdict', fixture, false, null)).toThrow('browser monotonic');
    });
});

describe('benchmark count arguments', () => {
    test.each(['', '0', '-1', '1.5', '5junk', 'NaN', 'Infinity', '1e3', ' 5', '5 ', '9007199254740992'])('rejects %j', (value) => {
        expect(() => parsePositiveInteger(value, '--runs')).toThrow('positive safe integer');
    });
    test('accepts positive safe integers without truncation', () => {
        expect(parsePositiveInteger('5', '--runs')).toBe(5);
        expect(parsePositiveInteger('9007199254740991', '--runs')).toBe(Number.MAX_SAFE_INTEGER);
    });
    test.each(['--runs', '--pairs'])('CLI rejects malformed %s before launching a browser', async (flag) => {
        const script = flag === '--runs' ? 'dev/perf/import-benchmark.js' : 'dev/perf/import-ab.js';
        await expect(execFileAsync(process.execPath, [script, 'jmdict', flag, '1.5'])).rejects.toThrow('positive safe integer');
    });
    test('A/B rejects a malformed explicit environment count', async () => {
        await expect(execFileAsync(process.execPath, ['dev/perf/import-ab.js', 'jmdict', '--flags', '{}'], {
            env: {...process.env, MANABITAN_AB_PAIR_ITERATIONS: '5junk'},
        })).rejects.toThrow('positive safe integer');
    });
});

describe('benchmark environment isolation', () => {
    test('removes inherited flags, traces, browser selection, early exits and skipped checks', () => {
        const parent = {
            PATH: '/bin',
            PLAYWRIGHT_BROWSERS_PATH: '/cache',
            MANABITAN_E2E_IMPORT_FLAGS_JSON: '{"zipMaxWorkers":99}',
            MANABITAN_E2E_IMPORT_TRACE_PATH: '/unrequested-trace',
            MANABITAN_E2E_STOP_AFTER_INITIAL_IMPORTS: '1',
            MANABITAN_E2E_CONTENT_PROBE_LIMIT: '1',
            MANABITAN_E2E_STRICT_RUNTIME: '0',
            MANABITAN_CHROMIUM_BROWSER: 'edge',
            MANABITAN_CHROMIUM_HEADLESS: '0',
        };
        const original = {...parent};
        const env = createBenchmarkEnvironment(parent, {});
        expect(parent).toEqual(original);
        expect(env).toEqual({
            PATH: '/bin',
            PLAYWRIGHT_BROWSERS_PATH: '/cache',
            MANABITAN_E2E_STRICT_RUNTIME: '1',
            MANABITAN_CHROMIUM_BROWSER: 'chromium',
            MANABITAN_CHROMIUM_HEADLESS: '1',
            MANABITAN_CHROMIUM_ALLOW_HEADED_FALLBACK: '0',
        });
    });
    test('restores only explicitly requested overrides', () => {
        const env = createBenchmarkEnvironment({MANABITAN_E2E_IMPORT_FLAGS_JSON: 'inherited'}, {
            MANABITAN_E2E_IMPORT_FLAGS_JSON: '{"zipMaxWorkers":3}',
            MANABITAN_E2E_IMPORT_TRACE_PATH: '/explicit-trace',
        });
        expect(env.MANABITAN_E2E_IMPORT_FLAGS_JSON).toBe('{"zipMaxWorkers":3}');
        expect(env.MANABITAN_E2E_IMPORT_TRACE_PATH).toBe('/explicit-trace');
    });
});

describe('benchmark report acceptance', () => {
    test('accepts the exact validated fixture and retains missing diagnostics as null', () => {
        expect(extractImportResult(validReport(), 'jmdict', fixture, false, null)).toMatchObject({totalImportMs: 123.5, step4Breakdown: null});
    });
    test.each([null, [], {}, {status: 'failed'}])('rejects malformed or failed reports: %j', (report) => {
        expect(() => extractImportResult(report, 'jmdict', fixture, false, null)).toThrow();
    });
    test.each([
        ['dictionary', 'jitendex'],
        ['pinnedDictionaries', false],
        ['productionImportDefaults', false],
        ['traceEnabled', true],
        ['authoritativeTiming', false],
        ['phaseProfiling', true],
        ['phaseScreenshots', true],
        ['processSampling', true],
        ['importFlags', {}],
    ])('rejects configuration mismatch: %s', (key, value) => {
        const report = validReport();
        report.benchmark[key] = value;
        expect(() => extractImportResult(report, 'jmdict', fixture, false, null)).toThrow('configuration');
    });
    test.each([0, -1, Number.NaN, Infinity, '123', null])('rejects invalid duration: %j', (durationMs) => {
        const report = validReport();
        report.phases[0].durationMs = durationMs;
        expect(() => extractImportResult(report, 'jmdict', fixture, false, null)).toThrow('total-import');
    });
    test('rejects skipped verification', () => {
        const report = validReport();
        report.skippedVerification = true;
        expect(() => extractImportResult(report, 'jmdict', fixture, false, null)).toThrow('verification');
    });
    test('rejects duplicate matching phases', () => {
        const report = validReport();
        report.phases.push(structuredClone(report.phases[0]));
        expect(() => extractImportResult(report, 'jmdict', fixture, false, null)).toThrow('total-import');
    });
    test('rejects a successful report for the wrong dictionary', () => {
        const report = validReport();
        report.phases[0].name = 'Jitendex: total import';
        expect(() => extractImportResult(report, 'jmdict', fixture, false, null)).toThrow('total-import');
    });
    test.each([['hasResult', false], ['resultTitle', 'JMdict stale'], ['errorCount', 1], ['addSettingsErrorCount', 1], ['usesFallbackStorage', true]])('rejects invalid completion: %s', (key, value) => {
        const report = validReport();
        report.phases[0].data.importDebug[key] = value;
        expect(() => extractImportResult(report, 'jmdict', fixture, false, null)).toThrow('error-free');
    });
    test.each([['title', 'wrong'], ['revision', 'wrong'], ['termRows', 1], ['contentReadable', false], ['probeCount', 1]])('rejects invalid persisted fixture: %s', (key, value) => {
        const report = validReport();
        report.benchmark.validation[key] = value;
        expect(() => extractImportResult(report, 'jmdict', fixture, false, null)).toThrow('post-import');
    });
    test('accepts trace reports only when explicitly requested and non-authoritative', () => {
        const report = validReport();
        report.benchmark.traceEnabled = true;
        report.benchmark.authoritativeTiming = false;
        expect(extractImportResult(report, 'jmdict', fixture, true, null).totalImportMs).toBe(123.5);
    });
});

describe('missing diagnostic metrics', () => {
    test.each([null, undefined, '0', Number.NaN, Infinity, -1])('does not coerce %j to zero', (value) => {
        expect(optionalMetric(value)).toBeNull();
    });
    test('preserves genuine zero and fractional measurements', () => {
        expect(optionalMetric(0)).toBe(0);
        expect(optionalMetric(1.5)).toBe(1.5);
    });
    test('propagates unavailability through summaries and deltas', () => {
        expect(metricDelta(null, 2)).toBeNull();
        expect(percentDelta(0, 2)).toBeNull();
        expect(median([1, null, 3])).toBeNull();
        expect(median([])).toBeNull();
        expect(roundMetric(null)).toBeNull();
        expect(median([4, 1, 3, 2])).toBe(2.5);
        expect(metricDelta(2, 1)).toBe(-1);
        expect(percentDelta(2, 1)).toBe(-50);
    });
});


describe('atomic pinned fixture installation', () => {
    /** @type {string[]} */
    const temporaryDirectories = [];
    afterEach(async () => {
        vi.restoreAllMocks();
        await Promise.all(temporaryDirectories.splice(0).map(async (dir) => await rm(dir, {recursive: true, force: true})));
    });

    /**
     * @returns {Promise<{filePath: string, dir: string, bytes: Buffer, sampleFixture: import('../dev/perf/dictionary-fixtures.js').DictionaryFixture}>}
     */
    async function setup() {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'manabitan-fixture-test-'));
        temporaryDirectories.push(dir);
        const bytes = Buffer.from('test archive');
        const sampleFixture = {...fixture, sizeBytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex')};
        return {dir, filePath: path.join(dir, 'fixture.zip'), bytes, sampleFixture};
    }

    test('does not fetch an already verified cache file', async () => {
        const {filePath, bytes, sampleFixture} = await setup();
        await writeFile(filePath, bytes);
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        await ensureFixtureFile(sampleFixture, filePath);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
    test('preserves the existing path when downloaded bytes fail integrity', async () => {
        const {filePath, dir, sampleFixture} = await setup();
        await writeFile(filePath, 'old bytes');
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('wrong bytes'));
        await expect(ensureFixtureFile(sampleFixture, filePath)).rejects.toThrow('integrity mismatch');
        expect(await readFile(filePath, 'utf8')).toBe('old bytes');
        expect(await readdir(dir)).toEqual(['fixture.zip']);
    });
    test('rejects HTTP errors without removing the old cache file', async () => {
        const {filePath, sampleFixture} = await setup();
        await writeFile(filePath, 'old bytes');
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('missing', {status: 404}));
        await expect(ensureFixtureFile(sampleFixture, filePath)).rejects.toThrow('404');
        expect(await readFile(filePath, 'utf8')).toBe('old bytes');
    });
    test('atomically replaces corrupt cache bytes without leaving temporary files', async () => {
        const {filePath, dir, bytes, sampleFixture} = await setup();
        await writeFile(filePath, 'old bytes');
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(bytes));
        await ensureFixtureFile(sampleFixture, filePath);
        expect(await readFile(filePath)).toEqual(bytes);
        expect(await readdir(dir)).toEqual(['fixture.zip']);
    });
    test('concurrent preparation of the same fixture leaves one verified file', async () => {
        const {filePath, dir, bytes, sampleFixture} = await setup();
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(bytes));
        await Promise.all([ensureFixtureFile(sampleFixture, filePath), ensureFixtureFile(sampleFixture, filePath)]);
        expect(await readFile(filePath)).toEqual(bytes);
        expect(await readdir(dir)).toEqual(['fixture.zip']);
    });
});
