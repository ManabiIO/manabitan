/* Temporary benchmark adapter. Product source is never written. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {readFile, realpath, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createProcessTreeSampler} from './process-tree-memory.mjs';
import {getHostEnvironment} from '../host-environment.js';
import {snapshotTermBankExperiments} from '../../../ext/js/dictionary/term-bank-experiments.js';
import {pathToFileURL, fileURLToPath} from 'node:url';

export const SOURCE_COMMIT = '4505cff924f8bb8d8422e718c645fbf555dcea19';
export const FIXTURES = Object.freeze({
    jmdict: {sha256: '7681ee09f9edfef48a5e50773565da237424eb750bdb0e1e59660784ecd53e8a'},
    jitendex: {sha256: '8364e69e7bd0881c42011e96af921a7399d7fe06e2bf4fff4da6d18affff74fc'},
});
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const positiveInt = (value, label) => {
    const number = Number(value);
    assert(Number.isSafeInteger(number) && number > 0, `${label} must be a positive integer`);
    return number;
};

function uniqueSlice(text, start, end) {
    const first = text.indexOf(start);
    assert(first >= 0 && text.indexOf(start, first + start.length) < 0, `Missing/ambiguous extraction start: ${start}`);
    const last = text.indexOf(end, first + start.length);
    assert(last >= 0, `Missing extraction end: ${end}`);
    return text.slice(first, last);
}

export function transformHarness(text, source, resolvePackage) {
    // Reuse upstream declarations in memory. Do not keep a 4,500-line fork or
    // execute upstream main, its samplers, screenshots, or forced exit.
    let helpers = uniqueSlice(text, '/*\n * Copyright', 'async function main() {');
    helpers = helpers.replace(/^import (.+?) from '([^']+)';$/gm, (line, bindings, specifier) => {
        const target = specifier.startsWith('node:') ? specifier : specifier.startsWith('.') ?
            pathToFileURL(path.resolve(source, 'test/firefox', specifier)).href :
            pathToFileURL(resolvePackage(specifier)).href;
        return `import ${bindings} from ${JSON.stringify(target)};`;
    });
    const dirnameStatement = 'const dirname = path.dirname(fileURLToPath(import.meta.url));';
    assert(helpers.includes(dirnameStatement));
    helpers = helpers.replace(dirnameStatement, `const dirname = ${JSON.stringify(path.join(source, 'test/firefox'))};`);
    const setup = uniqueSlice(text, '    const firefoxOptions = new firefox.Options();', '    console.log(`[firefox-e2e] addon package:');
    assert(!setup.includes('new Builder') && !setup.includes('process.exit'));
    return `${helpers}\nexport {By, Builder, Browser, firefox, navigateToExtensionPage, waitForExtensionBaseUrl, importDictionariesViaFileInput, isOpfsRuntimeAvailable};\n` +
        `export async function createAdapterFirefoxOptions() {\nconst configuredFirefoxProfileDir = '';\n${setup}\nreturn {firefoxOptions, headless, selectedFirefoxBinary};\n}\n`;
}

export async function loadHarness(source) {
    const require = createRequire(path.join(source, 'package.json'));
    const filename = path.join(source, 'test/firefox/extension-two-dictionary-import.e2e.js');
    const text = await readFile(filename, 'utf8');
    const transformed = transformHarness(text, source, require.resolve);
    const module = await import(`data:text/javascript;base64,${Buffer.from(transformed).toString('base64')}`);
    const timingPath = path.join(source, 'test/e2e/import-timing.js');
    const {armBrowserImportTiming} = await import(pathToFileURL(timingPath).href);
    return {module, armBrowserImportTiming, identity: {harnessSha256: sha256(text), timingSha256: sha256(await readFile(timingPath))}};
}

async function loadZip(source, bytes) {
    const require = createRequire(path.join(source, 'package.json'));
    const JSZip = require('jszip');
    return await JSZip.loadAsync(bytes, {checkCRC32: true});
}

export async function fixtureOracle(source, filename, dataset) {
    assert(FIXTURES[dataset], 'Dataset must be jmdict or jitendex');
    const resolved = await realpath(filename);
    const bytes = await readFile(resolved);
    assert.equal(sha256(bytes), FIXTURES[dataset].sha256, 'Fixture differs from exact pinned source ZIP');
    const zip = await loadZip(source, bytes);
    const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
    assert(!names.some((name) => /manabitan.*(?:artifact|manifest)|\.mt(?:b|r|c)$/i.test(name)), 'Precompiled artifacts are forbidden');
    const index = JSON.parse(await zip.file('index.json').async('string'));
    const counts = {terms: 0, termMeta: 0, kanji: 0, kanjiMeta: 0, tagMeta: 0, media: 0};
    let bankCount = 0;
    let uncompressedBytes = 0;
    let compressedBytes = 0;
    let probe = null;
    const probeTerms = new Set();
    const referencedMedia = new Set();
    const imagePath = (value) => {
        if (typeof value === 'string' && /\.(?:apng|avif|bmp|gif|ico|cur|jpg|jpeg|jfif|pjpeg|pjp|png|svg|tif|tiff|webp)$/i.test(value)) {
            assert(zip.file(value), `Referenced media missing from pinned archive: ${value}`);
            referencedMedia.add(value);
        }
    };
    const structuredImages = (content) => {
        if (Array.isArray(content)) { for (const item of content) { structuredImages(item); } return; }
        if (!content || typeof content !== 'object') { return; }
        if (content.tag === 'img') { imagePath(content.path); return; }
        structuredImages(content.content);
    };
    for (const name of names) {
        const match = /^(term|term_meta|kanji|kanji_meta|tag)_bank_\d+\.json$/.exec(name);
        if (!match) { continue; }
        const entry = zip.files[name];
        const raw = await entry.async('nodebuffer');
        const rows = JSON.parse(raw.toString('utf8'));
        assert(Array.isArray(rows), `Non-array bank ${name}`);
        const key = {term: 'terms', term_meta: 'termMeta', kanji: 'kanji', kanji_meta: 'kanjiMeta', tag: 'tagMeta'}[match[1]];
        counts[key] += rows.length;
        if (key === 'terms') {
            ++bankCount;
            uncompressedBytes += raw.byteLength;
            compressedBytes += entry._data.compressedSize;
            probe ??= rows.find((row) => typeof row[0] === 'string' && row[0].length > 0 && Array.isArray(row[5]) && row[5].length > 0)?.[0] ?? null;
            for (const row of rows) {
                if (probeTerms.size < 12 && typeof row[0] === 'string' && row[0].length > 0 && Array.isArray(row[5]) && row[5].length > 0) { probeTerms.add(row[0]); }
                for (const glossary of row[5]) {
                    if (glossary?.type === 'image') { imagePath(glossary.path); }
                    else if (glossary?.type === 'structured-content') { structuredImages(glossary.content); }
                }
            }
        }
    }
    counts.media = referencedMedia.size;
    assert(bankCount >= 4 && counts.terms > 0 && probe, 'Fixture lacks the intended parallel source workload');
    return {path: resolved, dataset, sha256: sha256(bytes), bytes: bytes.length, title: index.title, revision: index.revision, bankCount, uncompressedBytes, compressedBytes, counts, probe, probeTerms: [...probeTerms]};
}

export async function packageOracle(source, filename, expectedSha256) {
    assert(/^[0-9a-f]{64}$/.test(expectedSha256), '--package-sha256 is required');
    const resolved = await realpath(filename);
    const bytes = await readFile(resolved);
    assert.equal(sha256(bytes), expectedSha256, 'Package checksum mismatch');
    const zip = await loadZip(source, bytes);
    const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
    assert.equal(manifest.browser_specific_settings?.gecko?.id, '{accbebce-862b-48a9-bb9a-1da9ad1f8702}', 'Use the exact firefox-dev package');
    const verifiedAssets = {};
    for (const name of ['js/dictionary/dictionary-importer.js', 'js/dictionary/term-bank-wasm-parser.js', 'js/dictionary/term-bank-wasm-parser-worker.js', 'js/dictionary/term-bank-experiments.js', 'js/pages/settings/dictionary-import-controller.js', 'lib/term-bank-parser.wasm']) {
        const entry = zip.file(name);
        assert(entry, `Package lacks ${name}`);
        const packaged = await entry.async('nodebuffer');
        assert.equal(sha256(packaged), sha256(await readFile(path.join(source, 'ext', name))), `Stale package asset ${name}`);
        verifiedAssets[name] = sha256(packaged);
    }
    return {path: resolved, sha256: sha256(bytes), bytes: bytes.length, manifest, verifiedAssets};
}

export function validateRoute(debug, fixture, workers3, expectedWorkers) {
    assert.equal(debug?.hasResult, true);
    assert.equal(debug.resultTitle, fixture.title);
    assert.equal(debug.errorCount, 0);
    assert.equal(debug.addSettingsErrorCount, 0);
    assert.equal(debug.usesFallbackStorage, false);
    const phases = debug.importerPhaseTimings.filter((phase) => phase.phase.startsWith('term-file-fast-path:'));
    assert.equal(phases.length, 1, 'Require one complete compressed source-run; fallback/batching is not this benchmark');
    const details = phases[0].details;
    assert.equal(details.parserExperiments?.experimentalParserWorkers3, workers3, 'Requested experiment did not reach parser');
    assert.equal(details.parserParallelWorkerCount, expectedWorkers, 'Wrong effective parser width');
    assert.equal(details.batchedFileCount, fixture.bankCount);
    assert.equal(details.rows, fixture.counts.terms);
    assert.equal(details.parserSourceCompressedBytes, fixture.compressedBytes);
    assert.equal(details.parserSourceUncompressedBytes, fixture.uncompressedBytes);
    assert.equal(details.parserParallelSkipReason ?? null, null, 'Parallel parser fell back');
    const pipeline = details.parserParallelPipelineGroupsPerWorker;
    assert.equal(pipeline, fixture.counts.media > 0 ? 3 : 4, 'Wrong media/plain source pipeline width');
    const groups = Math.min(fixture.bankCount, Math.max(expectedWorkers * pipeline, Math.ceil(fixture.uncompressedBytes / (24 * 1024 * 1024))));
    assert.equal(details.parserParallelGroupCount, groups, 'Wrong effective source group count');
    return {workers: expectedWorkers, pipelineGroupsPerWorker: pipeline, groups, details};
}

async function backend(driver, action, params) {
    const result = await driver.executeAsyncScript(function(action, params) {
        const done = arguments[arguments.length - 1];
        const runtime = globalThis.chrome?.runtime ?? globalThis.browser?.runtime;
        runtime.sendMessage({action, params}, (response) => {
            if (runtime.lastError) { done({adapterError: runtime.lastError.message}); return; }
            if (response?.error) { done({adapterError: JSON.stringify(response.error)}); return; }
            done({value: response?.result});
        });
    }, action, params);
    assert(!result?.adapterError, result?.adapterError);
    return result.value;
}

export function findReadableRows(value, dictionary, found = []) {
    if (!value || typeof value !== 'object') { return found; }
    if (Array.isArray(value.rowSample)) {
        for (const row of value.rowSample) {
            if (row.dictionary !== dictionary) { continue; }
            if (Number(row.glossaryLength) > 0 || (typeof row.rawContentPreview === 'string' && row.rawContentPreview.length > 0 && !/^<read-(?:null|failed)>$/.test(row.rawContentPreview))) { found.push(row); }
        }
    }
    for (const child of Object.values(value)) { if (child && typeof child === 'object') { findReadableRows(child, dictionary, found); } }
    return found;
}

export async function runBrowser(config, fixture, packageIdentity, harness, report) {
    const {module: h, armBrowserImportTiming} = harness;
    const options = await h.createAdapterFirefoxOptions();
    const service = new h.firefox.ServiceBuilder();
    service.addArguments('--allow-system-access');
    let driver = null;
    let memorySampler = null;
    let memoryStopped = false;
    let runError = null;
    let cleanupPromise = null;
    let interrupted = false;
    const cleanup = () => {
        if (driver === null) { return Promise.resolve(); }
        cleanupPromise ??= driver.quit();
        return cleanupPromise;
    };
    const onSignal = () => {
        interrupted = true;
        process.exitCode = 1;
        void cleanup().catch(() => {});
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
        driver = new h.Builder().forBrowser(h.Browser.FIREFOX).setFirefoxOptions(options.firefoxOptions).setFirefoxService(service).build();
        assert(!interrupted, 'Benchmark interrupted before browser startup');
        await driver.getWindowHandle();
        await driver.manage().setTimeouts({script: config.timeoutMs, pageLoad: 30_000, implicit: 0});
        const capabilities = await driver.getCapabilities();
        report.browser = {name: capabilities.get('browserName'), version: capabilities.get('browserVersion'), platform: capabilities.get('platformName'), binary: options.selectedFirefoxBinary || 'selenium-default', headless: options.headless, geckodriverVersion: capabilities.get('moz:geckodriverVersion') ?? null};
        const browserRootPid = Number(capabilities.get('moz:processID'));
        assert(Number.isSafeInteger(browserRootPid) && browserRootPid > 0, 'Missing owned Firefox root PID');
        const addonId = await driver.installAddon(packageIdentity.path, true);
        assert.equal(addonId, packageIdentity.manifest.browser_specific_settings.gecko.id);
        const baseUrl = await h.waitForExtensionBaseUrl(driver, addonId);
        await h.navigateToExtensionPage(driver, `${baseUrl}/settings.html`, h.By.css('#dictionary-import-file-input'));
        const before = await backend(driver, 'getDictionaryInfo');
        assert.deepEqual(before, [], 'Fresh WebDriver profile must have empty dictionary storage');
        report.runtime = await driver.executeScript('return {userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,deviceMemory:navigator.deviceMemory??null,hasStorageGetDirectory:typeof navigator.storage?.getDirectory==="function",crossOriginIsolated:globalThis.crossOriginIsolated,hasSharedArrayBuffer:typeof SharedArrayBuffer==="function",hasAtomics:typeof Atomics==="object"};');
        const storage = await backend(driver, 'debugDictionaryStorageState');
        report.storageBefore = storage;
        assert.equal(storage.usesFallbackStorage, false);
        const od = storage.openStorageDiagnostics;
        assert(h.isOpfsRuntimeAvailable({...report.runtime, openStorageDiagnostics: od, hasOpfsSahpoolVfs: od?.hasOpfsSahpoolVfs, opfsSahpoolInstallResult: od?.opfsSahpoolInstallResult, openStorageMode: od?.mode}), `Strict OPFS prerequisite failed: ${JSON.stringify(storage)}`);
        assert(report.runtime.hasSharedArrayBuffer && report.runtime.hasAtomics, 'Missing Firefox shared memory primitives');
        const cpus = report.runtime.hardwareConcurrency;
        assert(Number.isInteger(cpus) && cpus >= 4 && cpus < 8, `Parser3 comparison requires a real 4–7 logical CPU browser; saw ${cpus}`);
        assert(report.runtime.deviceMemory === null || report.runtime.deviceMemory > 4, 'Constrained memory tier is ineligible');
        assert.equal(config.expectedWorkers, config.workers3 ? 3 : 2, 'Expected width does not match current midcore policy');
        report.requestedFlags = {experimentalParserWorkers3: config.workers3};
        const flagsError = await driver.executeAsyncScript(function(flags) {
            const done = arguments[arguments.length - 1];
            globalThis.manabitanImportPerformanceFlags = flags;
            globalThis.__manabitanLastImportDebug = null;
            globalThis.__manabitanImportDebugHistory = [];
            chrome.storage.local.set({manabitanDiagnosticsEnabled: false, manabitanDiagnosticsVerbosity: 'off'}, () => done(chrome.runtime.lastError?.message ?? null));
        }, report.requestedFlags);
        assert.equal(flagsError, null, 'Failed to configure matched diagnostics');
        // Arm the upstream self-contained function before the actual sendKeys.
        await driver.executeScript(armBrowserImportTiming);
        if (config.mode === 'memory') {
            memorySampler = createProcessTreeSampler({intervalMs: 100, includePss: true});
            await memorySampler.start(browserRootPid);
        }
        await h.importDictionariesViaFileInput(driver, [fixture.path]);
        await driver.wait(async () => await driver.executeScript('return Number.isFinite(globalThis.__manabitanBrowserImportTiming?.completedAtMs);'), config.timeoutMs, 'No current import completion event', 100);
        if (memorySampler !== null) {
            const result = await memorySampler.stop();
            memoryStopped = true;
            const post = createProcessTreeSampler({intervalMs: 100, includePss: true});
            let postResult;
            try {
                const pinned = await post.start(browserRootPid);
                assert.deepEqual(pinned, result.summary.root, 'Firefox root changed after import');
                await new Promise((resolve) => setTimeout(resolve, 2000));
            } finally { postResult = await post.stop(); }
            report.memory = {window: 'before file dispatch through Selenium observing current-operation completion; polling interval 100 ms, observation lag included', result,
                postCompletion: {windowMs: 2000, result: postResult}};
        }
        const snapshot = await driver.executeScript('return {timing:globalThis.__manabitanBrowserImportTiming,debug:globalThis.__manabitanLastImportDebug,steps:globalThis.__manabitanImportStepTimingHistory??null,error:document.querySelector("#dictionary-error")?.textContent??""};');
        report.import = snapshot;
        const timing = snapshot.timing;
        assert.equal(timing.trigger, 'file-input-change');
        assert.equal(timing.errorCount, 0);
        assert(Number.isFinite(timing.startedAtMs) && Number.isFinite(timing.completedAtMs) && timing.completedAtMs >= timing.startedAtMs);
        report.visibleImportMs = timing.completedAtMs - timing.startedAtMs;
        report.route = validateRoute(snapshot.debug, fixture, config.workers3, config.expectedWorkers);
        const info = await backend(driver, 'getDictionaryInfo');
        assert.equal(info.length, 1);
        assert.equal(info[0].title, fixture.title);
        assert.equal(info[0].revision, fixture.revision);
        assert.equal(info[0].importSuccess, true);
        const counts = await backend(driver, 'getDictionaryCounts', {dictionaryNames: [fixture.title], getTotal: true});
        for (const [key, expected] of Object.entries(fixture.counts)) {
            assert.equal(counts.counts[0][key], expected, `Backend ${key} mismatch`);
            assert.equal(counts.total[key], expected, `Backend total ${key} mismatch`);
        }
        const probe = await backend(driver, 'getDictionaryTermProbe', {dictionaryTitle: fixture.title});
        assert(probe?.expression || probe?.reading, 'No stored record probe');
        const readable = await backend(driver, 'debugDictionaryLookupState', {text: probe.expression || probe.reading, dictionaryNames: [fixture.title]});
        const readableRows = findReadableRows(readable, fixture.title);
        assert(readableRows.length > 0, 'No readable glossary/content probe');
        const probeResults = [];
        assert.equal(fixture.probeTerms.length, 12);
        for (const text of fixture.probeTerms) {
            const diagnostics = await backend(driver, 'debugDictionaryLookupState', {text, dictionaryNames: [fixture.title]});
            const rows = findReadableRows(diagnostics, fixture.title);
            assert(rows.length > 0, `No readable content for source-derived probe ${text}`);
            probeResults.push({text, rows});
        }
        report.correctness = {dictionaryInfo: info, counts, recordProbe: probe, readableRows, lookupDiagnostics: readable, probeResults};
    } catch (error) {
        runError = error;
        throw error;
    } finally {
        try {
            try {
                try {
                    if (memorySampler !== null && !memoryStopped) {
                        report.memory = {window: 'interrupted memory window', result: await memorySampler.stop()};
                    }
                } finally { await cleanup(); }
            } catch (cleanupError) {
                if (runError) { throw new AggregateError([runError, cleanupError], 'Benchmark and awaited driver cleanup failed'); }
                throw cleanupError;
            }
        } finally {
            process.removeListener('SIGINT', onSignal);
            process.removeListener('SIGTERM', onSignal);
        }
    }
}

export function parseArgs(argv) {
    const flags = {};
    for (let i = 0; i < argv.length; i += 2) {
        assert(argv[i].startsWith('--') && argv[i + 1] !== undefined, 'Use --name value arguments');
        const key = argv[i].slice(2);
        assert(!Object.hasOwn(flags, key), `Repeated --${key}`);
        flags[key] = argv[i + 1];
    }
    const allowed = ['source', 'package', 'package-sha256', 'fixture', 'dataset', 'workers3', 'expected-workers', 'output', 'timeout-ms', 'preflight-only'];
    for (const key of Object.keys(flags)) { assert(allowed.includes(key), `Unknown --${key}`); }
    for (const key of ['source', 'package', 'package-sha256', 'fixture', 'dataset', 'workers3', 'expected-workers', 'output']) { assert(flags[key], `Missing --${key}`); }
    assert(['true', 'false'].includes(flags.workers3), '--workers3 must be true or false');
    assert(!flags['preflight-only'] || ['true', 'false'].includes(flags['preflight-only']));
    return {source: flags.source, package: flags.package, packageSha256: flags['package-sha256'], fixture: flags.fixture, dataset: flags.dataset, workers3: flags.workers3 === 'true', expectedWorkers: positiveInt(flags['expected-workers'], '--expected-workers'), output: path.resolve(flags.output), timeoutMs: positiveInt(flags['timeout-ms'] ?? 900_000, '--timeout-ms'), preflightOnly: flags['preflight-only'] === 'true'};
}

async function main() {
    assert.equal(Number(process.versions.node.split('.')[0]), 22);
    assert.equal(process.platform, 'linux');
    assert.equal(os.cpus().length, 4);
    const source = await realpath(process.env.MIDCORE_SOURCE_ROOT);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD:ext'], {cwd: source, encoding: 'utf8'}).trim(),
        execFileSync('git', ['rev-parse', SOURCE_COMMIT + ':ext'], {cwd: source, encoding: 'utf8'}).trim(), 'Product source differs from reviewed base');
    const output = await realpath(process.env.MIDCORE_OUTPUT);
    const dataset = process.env.MIDCORE_DICTIONARY;
    const mode = process.env.MIDCORE_MODE;
    const arm = process.env.MIDCORE_ARM;
    assert(['jmdict', 'jitendex'].includes(dataset));
    assert(['timing', 'memory'].includes(mode));
    assert(['A', 'B'].includes(arm));
    for (const key of Object.keys(process.env)) {
        if (/^MANABITAN_(?:E2E_|CHROMIUM_)/.test(key) || /^MANABITAN_FIREFOX_(?!BINARY$|HEADLESS$)/.test(key)) { delete process.env[key]; }
    }
    const lock = JSON.parse(await readFile(path.join(source, 'test/perf/dictionaries.lock.json'), 'utf8')).dictionaries[dataset];
    const config = {source, dataset, mode, workers3: arm === 'B', expectedWorkers: arm === 'B' ? 3 : 2, timeoutMs: 300000};
    const report = {status: 'failure', startedAt: new Date().toISOString(), config};
    let failure = null;
    try {
        const fixture = await fixtureOracle(source, path.join(await realpath(process.env.MIDCORE_CACHE), lock.cacheFile), dataset);
        const packagePath = await realpath(process.env.MIDCORE_PACKAGE);
        const packageIdentity = await packageOracle(source, packagePath, sha256(await readFile(packagePath)));
        const harness = await loadHarness(source);
        report.fixture = fixture;
        report.package = packageIdentity;
        report.adapter = {sha256: sha256(await readFile(fileURLToPath(import.meta.url))), ...harness.identity};
        await runBrowser(config, fixture, packageIdentity, harness, report);
        const details = report.route.details;
        const expectedExperiments = snapshotTermBankExperiments({experimentalParserWorkers3: arm === 'B'});
        let receipts = 0;
        for (const phase of report.import.debug.importerPhaseTimings) {
            for (const key of ['parserExperiments', 'fastPathParserEffectiveExperiments']) {
                if (Object.hasOwn(phase.details ?? {}, key)) { assert.deepEqual(phase.details[key], expectedExperiments); ++receipts; }
            }
        }
        assert(receipts > 0, 'Missing complete worker experiment receipts');
        assert.equal(details.dedupUniqueCount, dataset === 'jmdict' ? 360859 : 362154);
        assert.equal(details.parserFusedFallbacks, 0);
        assert.equal(details.parserFusedAttempts, report.route.groups);
        assert.equal(report.import.debug.openStorageDiagnostics?.mode, 'opfs-sahpool');
        assert.equal(report.import.debug.importerPhaseTimings.find((phase) => phase.phase === 'bulk-finalization')?.details?.published, true);
        assert(report.import.timing.sequence > report.import.timing.sequenceBefore);
        report.status = 'success';
    } catch (error) {
        failure = error;
        report.error = {message: error.message, stack: error.stack};
    } finally {
        report.finishedAt = new Date().toISOString();
        await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
        const observation = {
            schemaVersion: 1, browser: 'firefox', mode, arm, dictionary: dataset, status: report.status,
            failureReason: failure?.stack ?? '', authoritativeTiming: mode === 'timing', skippedVerification: false,
            timing: {browser: report.import?.timing ?? null, totalImportMs: report.visibleImportMs ?? null,
                workerImportMs: report.import?.debug?.localPhaseTimings?.find((phase) => phase.phase === 'worker-import-dictionary')?.elapsedMs ?? null},
            importDebug: report.import?.debug ?? null,
            validation: report.correctness ? {title: report.fixture.title, revision: report.fixture.revision, termRows: report.fixture.counts.terms,
                counts: report.correctness.counts.counts[0], contentReadable: true, probeCount: report.correctness.probeResults.length,
                probeTerms: report.fixture.probeTerms} : null,
            environment: {host: getHostEnvironment(), browser: report.runtime ?? null},
            packageIdentity: report.package ? {packageSha256: report.package.sha256, nativeSha256: report.package.verifiedAssets['lib/term-bank-parser.wasm']} : null,
            memory: report.memory ?? null, browserVersion: report.browser?.version ?? null, launchMode: 'headless',
        };
        await writeFile(path.join(output, 'observation.json'), JSON.stringify(observation, null, 2) + '\n', {flag: 'wx'});
    }
    if (failure) { throw failure; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { await main(); }
