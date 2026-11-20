#!/usr/bin/env node
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
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {closeSync, openSync} from 'node:fs'
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import JSZip from 'jszip'
import {Builder, Browser, By} from 'selenium-webdriver'
import * as firefox from 'selenium-webdriver/firefox.js'
import {getHostEnvironment} from '../../dev/perf/host-environment.js'
import {snapshotTermBankExperiments} from '../../ext/js/dictionary/term-bank-experiments.js'
import {armBrowserImportTiming} from '../e2e/import-timing.js'
import {waitForExtensionBaseUrl} from '../e2e/firefox-extension-base-url.js'

/** @typedef {import('../../dev/perf/dictionary-fixtures.js').DictionaryFixture} DictionaryFixture */
/** @typedef {{bank: string, rowIndex: number, expression: string, reading: string, glossary: string[]}} SourceProbe */
/** @typedef {{phase: string, elapsedMs?: number, details?: Record<string, any>}} Phase */
/** @typedef {{name: string, message: string, stack: string, errors?: ErrorReceipt[]}} ErrorReceipt */

const helperPath = fileURLToPath(import.meta.url)
const helperRoot = fileURLToPath(new URL('../../', import.meta.url))
const extensionUuid = '6d1d0bf0-9b57-4ff8-9d93-64e13ae0f5da'
const provenance = {
    repository: 'ManabiIO/manabitan',
    sourceCommit: 'cc716cd963cab2353ed58019e6393eca0e042627',
    sourcePath: 'test/firefox/jmdict-import-ab-benchmark.js',
}
const pinnedJmdict = {
    sha256: '7681ee09f9edfef48a5e50773565da237424eb750bdb0e1e59660784ecd53e8a',
    banks: 53,
    compressedBytes: 15_574_114,
    uncompressedBytes: 171_092_992,
}

/**
 * @param {import('node:crypto').BinaryLike} bytes
 * @returns {string}
 */
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

/**
 * @param {unknown} error
 * @returns {ErrorReceipt}
 */
export function errorReceipt(error) {
    return {
        name: error instanceof Error ? error.name : 'NonErrorFailure',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack ?? '' : '',
        ...(error instanceof AggregateError ? {errors: error.errors.map(errorReceipt)} : {}),
    }
}

/**
 * Preserve a failed operation when restoring the WebDriver context also fails.
 * @template T
 * @param {() => Promise<T>} action
 * @param {() => Promise<unknown>} cleanup
 * @returns {Promise<T>}
 */
export async function withCleanup(action, cleanup) {
    /** @type {{value: T}|{error: unknown}} */
    let result
    try {
        result = {value: await action()}
    } catch (error) { result = {error} }
    try { await cleanup() } catch (error) {
        if ('error' in result) { throw new AggregateError([result.error, error], 'Operation and context restoration both failed') }
        throw error
    }
    if ('error' in result) { throw result.error }
    return result.value
}

/**
 * Validate the timed operation before any persistence or reload checks.
 * The phase records are disjoint term-file receipts; overlapping importer phase
 * durations are retained but never added together as an elapsed-time estimate.
 * @param {{timing?: Record<string, any>, debug?: Record<string, any>, error?: string}} result
 * @param {DictionaryFixture} fixture
 * @param {Record<string, boolean>} expectedExperiments
 * @returns {Record<string, any>}
 */
export function validateImportResult(result, fixture, expectedExperiments) {
    assert(!result.error, result.error)
    const {timing, debug} = result
    assert(timing && debug, 'Missing current-operation timing or import diagnostics')
    assert.equal(timing.trigger, 'file-input-change')
    assert(Number.isSafeInteger(timing.sequenceBefore) && timing.sequenceBefore >= 0)
    assert(Number.isSafeInteger(timing.sequence) && timing.sequence > timing.sequenceBefore)
    assert.equal(timing.errorCount, 0)
    assert(Number.isFinite(timing.startedAtMs) && Number.isFinite(timing.completedAtMs) && timing.completedAtMs > timing.startedAtMs)
    assert(debug.hasResult && debug.resultTitle === fixture.expectedTitle && debug.errorCount === 0 && debug.addSettingsErrorCount === 0)
    assert.equal(debug.usesFallbackStorage, false)
    assert.equal(debug.openStorageDiagnostics?.mode, 'opfs-sahpool')
    /** @type {Phase[]} */
    const phases = debug.importerPhaseTimings
    assert(Array.isArray(phases), 'Missing importer phase receipts')
    const experiments = phases.flatMap((phase) => Object.entries(phase.details ?? {})
        .filter(([name]) => ['parserExperiments', 'fastPathParserExperiments', 'fastPathParserEffectiveExperiments', 'compressionExperiments'].includes(name))
        .map(([, value]) => value))
    assert(experiments.length >= 2, 'Missing effective production experiment receipts')
    for (const observed of experiments) { assert.deepEqual(observed, expectedExperiments) }
    const termFiles = phases.filter((phase) => phase.phase.startsWith('term-file'))
    assert(termFiles.length > 0, 'Missing disjoint term-file work receipts')
    for (const [name, expected] of Object.entries({
        rows: fixture.termRows,
        parserSourceCompressedBytes: pinnedJmdict.compressedBytes,
        parserSourceTransferredBytes: pinnedJmdict.compressedBytes,
        parserSourceUncompressedBytes: pinnedJmdict.uncompressedBytes,
    })) {
        assert.equal(termFiles.reduce((sum, phase) => sum + (phase.details?.[name] ?? 0), 0), expected, `Unexpected executed import path: ${name}`)
    }
    for (const phase of termFiles) {
        assert.equal(phase.details?.parserFusedFallbacks, 0, 'Fused parser fell back')
        assert.equal(phase.details?.dedupNativeFallbackCount, 0, 'Native deduplication fell back')
        assert.equal(phase.details?.parserDiscardedFusedRows, 0, 'Fused parser discarded rows')
    }
    const finalization = phases.find((phase) => phase.phase === 'bulk-finalization')?.details
    assert(finalization?.ok === true && finalization.published === true, 'Import did not publish successfully')
    assert.deepEqual(finalization.housekeepingErrors, [])
    const localPhases = /** @type {Phase[]} */ (debug.localPhaseTimings ?? [])
    const workerPhases = localPhases.filter((phase) => phase.phase === 'worker-import-dictionary')
    assert.equal(workerPhases.length, 1, 'Expected one worker import operation')
    assert(Number.isFinite(workerPhases[0].elapsedMs) && Number(workerPhases[0].elapsedMs) > 0)
    return {
        totalImportMs: timing.completedAtMs - timing.startedAtMs,
        workerImportMs: workerPhases[0].elapsedMs,
        timing,
        termFileWork: termFiles.map((phase) => ({
            phase: phase.phase,
            counters: Object.fromEntries(Object.entries(phase.details ?? {}).filter(([name, value]) => typeof value === 'number' && !name.endsWith('Ms') && /(?:Count|Bytes|Rows|Fallbacks)$|^(?:rows|chunkCount)$/.test(name))),
        })),
        finalizationWork: Object.fromEntries(Object.entries(finalization).filter(([name, value]) => typeof value === 'number' && !name.endsWith('Ms'))),
        largestParserWasmHeapBytes: Math.max(...termFiles.map((phase) => Number(phase.details?.parserMaxWasmHeapBytes ?? 0))),
        effectiveExperiments: expectedExperiments,
    }
}

/**
 * @param {JSZip} archive
 * @returns {Promise<SourceProbe[]>}
 */
async function sourceProbes(archive) {
    const bankNames = Object.keys(archive.files).filter((name) => /^term_bank_\d+\.json$/.test(name))
        .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
    assert.equal(bankNames.length, pinnedJmdict.banks)
    /** @type {SourceProbe[]} */
    const probes = []
    const expressions = new Set()
    for (const bankIndex of [0, Math.floor(bankNames.length / 2), bankNames.length - 1]) {
        const bank = bankNames[bankIndex]
        const entry = archive.file(bank)
        assert(entry)
        const rows = JSON.parse(await entry.async('string'))
        assert(Array.isArray(rows) && rows.length > 0)
        for (let sample = 0; sample < 4; ++sample) {
            const start = Math.floor((rows.length - 1) * sample / 3)
            for (let offset = 0; offset < rows.length; ++offset) {
                const rowIndex = (start + offset) % rows.length
                const row = rows[rowIndex]
                const expression = row[0]
                if (typeof expression !== 'string' || expression.length === 0 || expression.length > 40 || expressions.has(expression) ||
                !Array.isArray(row[5]) || !row[5].every((entry) => typeof entry === 'string')) { continue }
                expressions.add(expression)
                probes.push({bank, rowIndex, expression, reading: row[1] || expression, glossary: row[5]})
                break
            }
        }
    }
    assert.equal(probes.length, 12, 'Could not derive twelve distinct source probes')
    return probes
}

/**
 * @param {import('selenium-webdriver/firefox.js').Driver} driver
 * @param {string} action
 * @param {unknown} [params]
 * @returns {Promise<any>}
 */
async function send(driver, action, params = null) {
    const response = await driver.executeAsyncScript(`
        const done = arguments[arguments.length - 1]
        window.chrome.runtime.sendMessage({action: arguments[0], params: arguments[1]}, (response) => {
            const error = window.chrome.runtime.lastError
            done(error ? {error: error.message} : response)
        })
    `, action, params)
    assert(response && typeof response === 'object' && !('error' in response), JSON.stringify(response))
    return response.result
}

/**
 * @param {import('selenium-webdriver/firefox.js').Driver} driver
 * @param {string} baseUrl
 * @returns {Promise<void>}
 */
async function openSettings(driver, baseUrl) {
    await driver.get(`${baseUrl}/settings.html?popup-preview=false`)
    await driver.wait(async () => await driver.executeScript("return document.documentElement.dataset.loaded === 'true' && !!document.querySelector('#dictionary-import-file-input')"), 30_000)
}

/**
 * @param {import('selenium-webdriver/firefox.js').Driver} driver
 * @returns {Promise<number>}
 */
async function backgroundOrigin(driver) {
    const result = await driver.executeAsyncScript(`
        const done = arguments[arguments.length - 1]
        window.browser.runtime.getBackgroundPage().then(
            (page) => done({origin: page.performance.timeOrigin}),
            (error) => done({error: String(error)}),
        )
    `)
    assert(Number.isFinite(result?.origin) && result.origin > 0, JSON.stringify(result))
    return result.origin
}

/**
 * Reload from browser chrome while a neutral tab owns the WebDriver context.
 * An extension page cannot reliably answer a WebDriver command after its own
 * runtime has unloaded. This performs exactly one reload, never an install or
 * a second import, and restores content context without hiding the first error.
 * @param {import('selenium-webdriver/firefox.js').Driver} driver
 * @param {string} addonId
 * @returns {Promise<Record<string, unknown>>}
 */
async function reloadExtension(driver, addonId) {
    await driver.setContext(firefox.Context.CHROME)
    return await withCleanup(async () => {
        const result = await driver.executeAsyncScript(`
            const done = arguments[arguments.length - 1]
            const id = arguments[0]
            ;(async () => {
                const {AddonManager} = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs')
                const addon = await AddonManager.getAddonByID(id)
                if (!addon || !addon.isActive) { throw new Error('Expected an active installed add-on') }
                await addon.reload()
                const reopened = await AddonManager.getAddonByID(id)
                if (!reopened || !reopened.isActive) { throw new Error('Add-on did not reactivate after reload') }
                return {id: reopened.id, active: reopened.isActive}
            })().then((value) => done({value}), (error) => done({error: String(error), stack: error?.stack ?? ''}))
        `, addonId)
        assert(result && !result.error, JSON.stringify(result))
        assert.equal(result.value?.id, addonId)
        assert.equal(result.value?.active, true)
        return result.value
    }, async () => await driver.setContext(firefox.Context.CONTENT))
}

/**
 * @param {import('selenium-webdriver/firefox.js').Driver} driver
 * @param {DictionaryFixture} fixture
 * @param {SourceProbe[]} probes
 * @returns {Promise<Record<string, any>>}
 */
async function verifyPersisted(driver, fixture, probes) {
    const dictionaryInfo = await send(driver, 'getDictionaryInfo')
    assert.equal(dictionaryInfo.length, 1)
    assert.equal(dictionaryInfo[0].title, fixture.expectedTitle)
    assert.equal(dictionaryInfo[0].revision, fixture.revision)
    const counts = await send(driver, 'getDictionaryCounts', {dictionaryNames: [fixture.expectedTitle], getTotal: false})
    assert.equal(counts.counts.length, 1)
    assert.equal(counts.counts[0].terms, fixture.termRows)
    const storage = await send(driver, 'debugDictionaryStorageState')
    assert.equal(storage.usesFallbackStorage, false)
    assert.equal(storage.openStorageDiagnostics?.mode, 'opfs-sahpool')
    const samples = []
    const semantics = []
    for (const probe of probes) {
        const diagnostics = await send(driver, 'debugDictionaryLookupState', {text: probe.expression, dictionaryNames: [fixture.expectedTitle]})
        const state = diagnostics.offscreenState ?? diagnostics.workerState ?? diagnostics.localState ?? diagnostics
        const totalLength = (state.termContentStoreDebugState ?? state.termContentDiagnostics?.opfsStore)?.totalLength
        assert(Number.isSafeInteger(totalLength) && totalLength > 0)
        assert(Array.isArray(state.rowSample) && state.rowSample.length > 0)
        for (const row of state.rowSample) {
            assert(Number.isSafeInteger(row.rawEntryContentOffset) && row.rawEntryContentOffset >= 0)
            assert(Number.isSafeInteger(row.rawEntryContentLength) && row.rawEntryContentLength > 0)
            assert(row.rawEntryContentOffset + row.rawEntryContentLength <= totalLength)
            assert(row.glossaryLength > 0 && row.rawContentPreview && !['<read-null>', '<read-failed>'].includes(row.rawContentPreview))
        }
        const lookup = await send(driver, 'termsFind', {text: probe.expression, details: {matchType: 'exact', deinflect: false}, optionsContext: {index: 0}})
        let semantic = null
        for (const entry of lookup.dictionaryEntries) {
            for (const definition of entry.definitions) {
                if (definition.dictionary !== fixture.expectedTitle || JSON.stringify(definition.entries) !== JSON.stringify(probe.glossary)) { continue }
                for (const index of definition.headwordIndices) {
                    const headword = entry.headwords[index]
                    if (headword?.term === probe.expression && headword.reading === probe.reading) {
                        semantic = {expression: headword.term, reading: headword.reading, glossary: definition.entries}
                    }
                }
            }
        }
        assert(semantic, `Source expression/reading/glossary missing: ${probe.expression}/${probe.reading}`)
        semantics.push(semantic)
        samples.push({expression: probe.expression,
            totalLength,
            rows: state.rowSample.map((/** @type {Record<string, any>} */ row) => ({expression: row.expression,
                reading: row.reading,
                offset: row.rawEntryContentOffset,
                length: row.rawEntryContentLength,
                glossaryLength: row.glossaryLength,
                rawContentPreview: row.rawContentPreview}))})
    }
    return {dictionaryInfo,
        counts,
        storage,
        probeCount: probes.length,
        semantics,
        samples,
        semanticDigest: hash(JSON.stringify(semantics)),
        storageSampleDigest: hash(JSON.stringify(samples))}
}

/**
 * One untimed process-tree snapshot. Shared pages can be counted more than once;
 * this is neither peak import memory nor a private-memory measurement.
 * @param {number} browserPid
 * @returns {Record<string, unknown>}
 */
function memorySnapshot(browserPid) {
    const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,comm='], {encoding: 'utf8'}).trim().split('\n')
        .map((line) => {
            const [pid, parentPid, rssKiB, ...name] = line.trim().split(/\s+/)
            return {pid: Number(pid), parentPid: Number(parentPid), rssBytes: Number(rssKiB) * 1024, name: name.join(' ')}
        })
    const included = new Set([browserPid])
    let priorSize = 0
    while (priorSize !== included.size) {
        priorSize = included.size
        for (const row of rows) {
            if (included.has(row.parentPid)) { included.add(row.pid) }
        }
    }
    const processes = rows.filter((row) => included.has(row.pid))
    assert(processes.some((row) => row.pid === browserPid), 'Firefox process disappeared before memory snapshot')
    return {capturedAt: new Date().toISOString(),
        measurement: 'untimed process-tree RSS snapshot; shared pages may be counted repeatedly; not peak memory',
        totalRssBytes: processes.reduce((sum, row) => sum + row.rssBytes, 0),
        processes,
        helperMemory: process.memoryUsage(),
        helperResourceUsage: process.resourceUsage()}
}

/**
 * @param {string} name
 * @returns {string}
 */
function requiredEnv(name) {
    const value = process.env[name]
    assert(typeof value === 'string' && value.length > 0, `Missing ${name}`)
    return value
}

/** @returns {Promise<void>} */
async function main() {
    assert.equal(process.platform, 'linux', 'This qualification helper targets Linux')
    const output = path.resolve(requiredEnv('MANABITAN_STUDY_OUTPUT_DIR'))
    await mkdir(output, {recursive: true})
    /** @type {Record<string, any>} */
    const report = {schemaVersion: 1,
        completed: false,
        authoritativeTiming: false,
        skippedVerification: false,
        startedAt: new Date().toISOString(),
        phase: 'validate-inputs',
        error: null,
        cleanupErrors: [],
        diagnosticErrors: [],
        provenance,
        hostBefore: getHostEnvironment(),
        boundary: 'Fresh helper process and Firefox profile; file-input change to the existing post-UI completion signal. Setup, RSS snapshots, source probes and one AddonManager extension reload are outside timing. Reload is not a browser-process restart.',
        memoryBoundary: 'Untimed RSS snapshots plus reported parser WASM heap maxima; no import peak-memory claim and no sampler during timing.'}
    const summaryPath = path.join(output, 'summary.json')
    await writeFile(summaryPath, `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx'})
    /** @returns {Promise<void>} */
    const save = async () => {
        await writeFile(`${summaryPath}.tmp`, `${JSON.stringify(report, null, 2)}\n`)
        await rename(`${summaryPath}.tmp`, summaryPath)
    }
    /** @param {string} phase @returns {Promise<void>} */
    const checkpoint = async (phase) => {
        report.phase = phase
        await save()
        console.log(JSON.stringify({event: 'phase', phase}))
    }
    /** @type {import('selenium-webdriver/firefox.js').Driver|null} */
    let driver = null
    /** @type {number|null} */
    let logFd = null
    let passed = false
    try {
        const sourceRoot = path.resolve(requiredEnv('MANABITAN_STUDY_SOURCE_ROOT'))
        const sourceSha = requiredEnv('MANABITAN_STUDY_SOURCE_SHA')
        assert(/^[a-f0-9]{40}$/.test(sourceSha))
        const git = (/** @type {string[]} */ args) => execFileSync('git', ['-C', sourceRoot, ...args], {encoding: 'utf8'}).trim()
        const [actualSha, sourceTree] = git(['rev-parse', 'HEAD', 'HEAD^{tree}']).split('\n')
        assert.equal(actualSha, sourceSha, 'Prepared source checkout changed')
        const legalSha256 = requiredEnv('MANABITAN_STUDY_LEGAL_SHA256')
        assert(/^[a-f0-9]{64}$/.test(legalSha256))
        const legalPath = path.join(sourceRoot, 'ext/legal-npm.html')
        assert.equal(hash(await readFile(legalPath)), legalSha256, 'Common generated legal overlay changed')
        const status = git(['status', '--porcelain', '--untracked-files=no'])
        const changedFiles = git(['diff', '--name-only', 'HEAD', '--']).split('\n').filter(Boolean)
        assert(changedFiles.every((file) => file === 'ext/legal-npm.html'), 'Unexpected tracked product changes')
        const sourceLockPath = path.join(sourceRoot, 'package-lock.json')
        assert.equal(hash(await readFile(sourceLockPath)), hash(await readFile(path.join(helperRoot, 'package-lock.json'))), 'Helper and product dependency locks differ')
        report.source = {root: sourceRoot,
            commit: actualSha,
            tree: sourceTree,
            trackedDirty: status.length > 0,
            commonGeneratedOverlay: {'ext/legal-npm.html': legalSha256},
            packageLockSha256: hash(await readFile(sourceLockPath))}
        const dictionary = requiredEnv('MANABITAN_STUDY_DICTIONARY')
        assert.equal(dictionary, 'jmdict', 'Only the pinned JMdict workload is qualified by this helper')
        const fixtureLockPath = path.join(sourceRoot, 'test/perf/dictionaries.lock.json')
        const fixtureLockBytes = await readFile(fixtureLockPath)
        const fixtureLock = JSON.parse(fixtureLockBytes.toString('utf8'))
        assert.equal(fixtureLock.schemaVersion, 1)
        const fixture = /** @type {DictionaryFixture} */ (fixtureLock.dictionaries[dictionary])
        assert.equal(fixture.sha256, pinnedJmdict.sha256, 'Unexpected JMdict source revision')
        const fixturePath = path.join(path.resolve(requiredEnv('MANABITAN_STUDY_CACHE_DIR')), fixture.cacheFile)
        const fixtureBytes = await readFile(fixturePath)
        assert.equal(fixtureBytes.length, fixture.sizeBytes)
        assert.equal(hash(fixtureBytes), fixture.sha256)
        const probes = await sourceProbes(await JSZip.loadAsync(fixtureBytes))
        report.fixture = {...fixture, path: fixturePath, lockSha256: hash(fixtureLockBytes), probes}
        const packagePath = path.resolve(requiredEnv('MANABITAN_STUDY_PACKAGE'))
        const packageSha256 = requiredEnv('MANABITAN_STUDY_PACKAGE_SHA256')
        assert(/^[a-f0-9]{64}$/.test(packageSha256))
        const packageBytes = await readFile(packagePath)
        assert.equal(hash(packageBytes), packageSha256, 'Prepared Firefox package changed')
        const packageArchive = await JSZip.loadAsync(packageBytes)
        const manifestFile = packageArchive.file('manifest.json')
        assert(manifestFile)
        const manifest = JSON.parse(await manifestFile.async('string'))
        assert.equal(manifest.background?.page, 'background.html', 'Expected the Firefox background-page package')
        const addonId = manifest.browser_specific_settings?.gecko?.id
        assert(['{1e12d533-8e72-4ec5-9edc-cd50e26d7d43}', '{accbebce-862b-48a9-bb9a-1da9ad1f8702}'].includes(addonId), 'Unexpected extension identity')
        const experimentsPath = path.join(sourceRoot, 'ext/js/dictionary/term-bank-experiments.js')
        const experimentsEntry = packageArchive.file('js/dictionary/term-bank-experiments.js')
        assert(experimentsEntry)
        assert.equal(hash(await experimentsEntry.async('nodebuffer')), hash(await readFile(experimentsPath)))
        assert.equal(hash(await readFile(experimentsPath)), hash(await readFile(path.join(helperRoot, 'ext/js/dictionary/term-bank-experiments.js'))), 'Helper and product experiment defaults differ')
        const expectedExperiments = snapshotTermBankExperiments()
        report.package = {path: packagePath, sha256: packageSha256, sizeBytes: packageBytes.length, manifest}
        const binaryPath = path.resolve(requiredEnv('MANABITAN_STUDY_FIREFOX_BINARY'))
        const driverPath = path.resolve(requiredEnv('MANABITAN_STUDY_GECKODRIVER'))
        const headlessValue = process.env.MANABITAN_STUDY_FIREFOX_HEADLESS ?? '0'
        assert(['0', '1'].includes(headlessValue), 'Invalid Firefox headless setting')
        const headless = headlessValue === '1'
        if (!headless) { assert(process.env.DISPLAY, 'Headed Firefox requires the workflow Xvfb display') }
        const runtime = {node: process.version,
            headless,
            binaryPath,
            binarySha256: hash(await readFile(binaryPath)),
            binaryVersion: execFileSync(binaryPath, ['--version'], {encoding: 'utf8'}).trim(),
            geckodriverPath: driverPath,
            geckodriverSha256: hash(await readFile(driverPath)),
            geckodriverVersion: execFileSync(driverPath, ['--version'], {encoding: 'utf8'}).trim()}
        assert(runtime.geckodriverVersion.startsWith('geckodriver 0.37.1'))
        report.runtime = runtime
        const timingSource = armBrowserImportTiming.toString()
        const timingPath = path.join(helperRoot, 'test/e2e/import-timing.js')
        report.tooling = {helperSha256: hash(await readFile(helperPath)),
            timingFileSha256: hash(await readFile(timingPath)),
            timingFunctionSha256: hash(timingSource)}
        const crashPath = path.join(output, 'crash-dumps')
        await mkdir(crashPath)
        logFd = openSync(path.join(output, 'geckodriver.log'), 'wx')
        const options = new firefox.Options().setBinary(binaryPath)
        if (headless) { options.addArguments('-headless') }
        for (const [name, value] of Object.entries({
            'xpinstall.signatures.required': false,
            'extensions.manifestV3.enabled': true,
            'extensions.backgroundServiceWorker.enabled': true,
            'javascript.options.shared_memory': true,
            'dom.postMessage.sharedArrayBuffer.withCOOP_COEP': true,
            'dom.postMessage.sharedArrayBuffer.bypassCOOP_COEP.insecure.enabled': true,
            'extensions.webextensions.uuids': JSON.stringify({[addonId]: extensionUuid}),
        })) { options.setPreference(name, value) }
        const service = new firefox.ServiceBuilder(driverPath).addArguments('--allow-system-access')
        service.setEnvironment({...process.env,
            MINIDUMP_SAVE_PATH: crashPath,
            MOZ_CRASHREPORTER: '1',
            MOZ_CRASHREPORTER_SHUTDOWN: '1',
            MOZ_CRASHREPORTER_NO_REPORT: '1'})
        service.setStdio(['ignore', logFd, logFd])
        await checkpoint('launch-browser')
        driver = /** @type {import('selenium-webdriver/firefox.js').Driver} */ (await new Builder()
            .forBrowser(Browser.FIREFOX).setFirefoxOptions(options)
            .setFirefoxService(service)
            .build())
        await driver.manage().setTimeouts({implicit: 0, pageLoad: 30_000, script: 180_000})
        const capabilities = await driver.getCapabilities()
        const profile = capabilities.get('moz:profile')
        const browserPid = Number(capabilities.get('moz:processID'))
        assert(typeof profile === 'string' && profile.length > 0)
        assert(Number.isSafeInteger(browserPid) && browserPid > 0)
        report.browser = {version: capabilities.get('browserVersion'),
            profile,
            pid: browserPid,
            freshProfile: true,
            suppliedProfile: false}
        await driver.get('about:blank')
        await checkpoint('install-extension')
        assert.equal(await driver.installAddon(packagePath, true), addonId)
        const baseUrl = await waitForExtensionBaseUrl(driver, addonId)
        assert.equal(baseUrl, `moz-extension://${extensionUuid}`)
        await openSettings(driver, baseUrl)
        assert.deepEqual(await send(driver, 'getDictionaryInfo'), [])
        const storageBefore = await send(driver, 'debugDictionaryStorageState')
        assert.equal(storageBefore.usesFallbackStorage, false)
        assert.equal(storageBefore.openStorageDiagnostics?.mode, 'opfs-sahpool')
        const environment = await driver.executeScript(`return {
            flags: window.manabitanImportPerformanceFlags ?? null,
            profiling: window.manabitanPerformanceInstrumentationEnabled === true,
            useSession: window.manabitanImportUseSession ?? null,
            disableIntegrityCounts: window.manabitanDisableIntegrityCounts ?? null,
            deviceMemory: window.navigator.deviceMemory ?? null,
            hardwareConcurrency: window.navigator.hardwareConcurrency,
            userAgent: window.navigator.userAgent,
            crossOriginIsolated: window.crossOriginIsolated,
            sharedArrayBuffer: typeof window.SharedArrayBuffer === 'function',
        }`)
        assert.equal(environment.flags, null)
        assert.equal(environment.profiling, false)
        assert.notEqual(environment.useSession, false)
        assert.notEqual(environment.disableIntegrityCounts, true)
        assert.equal(environment.sharedArrayBuffer, true)
        report.productionEnvironment = environment
        report.storageBefore = storageBefore
        report.memoryBefore = memorySnapshot(browserPid)
        await checkpoint('import')
        await driver.executeScript(`const globalThis = window; (${timingSource})()`)
        const input = await driver.findElement(By.css('#dictionary-import-file-input'))
        await input.sendKeys(fixturePath)
        const result = await driver.executeAsyncScript(`
            const done = arguments[arguments.length - 1]
            const finish = () => {
                const timing = window.__manabitanBrowserImportTiming
                if (timing?.completedAtMs == null) { return }
                clearTimeout(timeout)
                window.removeEventListener('manabitan:dictionary-import-complete', complete)
                done({timing, debug: window.__manabitanLastImportDebug})
            }
            const complete = () => queueMicrotask(finish)
            const timeout = setTimeout(() => {
                window.removeEventListener('manabitan:dictionary-import-complete', complete)
                done({error: 'No current-operation completion within 150 seconds', debug: window.__manabitanLastImportDebug})
            }, 150000)
            window.addEventListener('manabitan:dictionary-import-complete', complete)
            finish()
        `)
        report.importResult = result
        Object.assign(report, validateImportResult(result, fixture, expectedExperiments))
        report.memoryAfterImport = memorySnapshot(browserPid)
        await checkpoint('verify-persisted')
        const beforeReload = await verifyPersisted(driver, fixture, probes)
        report.beforeReload = beforeReload
        const priorOrigin = await backgroundOrigin(driver)
        await checkpoint('reload-extension')
        await driver.switchTo().newWindow('tab')
        await driver.get('about:blank')
        const neutralHandle = await driver.getWindowHandle()
        assert.equal(await driver.getCurrentUrl(), 'about:blank')
        report.reloadCommand = await reloadExtension(driver, addonId)
        await driver.switchTo().window(neutralHandle)
        await driver.switchTo().newWindow('tab')
        await openSettings(driver, baseUrl)
        const nextOrigin = await backgroundOrigin(driver)
        assert.notEqual(nextOrigin, priorOrigin, 'Extension background realm did not reload')
        report.reload = {kind: 'addon-manager-reload-from-browser-chrome', priorOrigin, nextOrigin, reimported: false, browserRestarted: false}
        await checkpoint('verify-after-reload')
        const afterReload = await verifyPersisted(driver, fixture, probes)
        report.afterReload = afterReload
        assert.deepEqual(afterReload.counts, beforeReload.counts)
        assert.equal(afterReload.semanticDigest, beforeReload.semanticDigest)
        assert.equal(afterReload.storageSampleDigest, beforeReload.storageSampleDigest)
        report.validation = {title: fixture.expectedTitle,
            revision: fixture.revision,
            termRows: fixture.termRows,
            contentReadable: true,
            probeCount: probes.length,
            semanticDigest: beforeReload.semanticDigest,
            storageSampleDigest: beforeReload.storageSampleDigest,
            extensionReloadVerified: true}
        report.memoryAfterReload = memorySnapshot(browserPid)
        await checkpoint('verify-identities')
        assert.equal(git(['rev-parse', 'HEAD']), sourceSha)
        assert.equal(git(['rev-parse', 'HEAD^{tree}']), sourceTree)
        assert.equal(git(['status', '--porcelain', '--untracked-files=no']), status)
        assert.equal(hash(await readFile(legalPath)), legalSha256)
        assert.equal(hash(await readFile(packagePath)), packageSha256)
        assert.equal(hash(await readFile(fixturePath)), fixture.sha256)
        assert.equal(hash(await readFile(fixtureLockPath)), report.fixture.lockSha256)
        assert.equal(hash(await readFile(sourceLockPath)), report.source.packageLockSha256)
        assert.equal(hash(await readFile(binaryPath)), runtime.binarySha256)
        assert.equal(hash(await readFile(driverPath)), runtime.geckodriverSha256)
        assert.equal(hash(await readFile(helperPath)), report.tooling.helperSha256)
        assert.equal(hash(await readFile(timingPath)), report.tooling.timingFileSha256)
        passed = true
    } catch (error) {
        report.error = errorReceipt(error)
        report.failurePhase = report.phase
        console.error(JSON.stringify({event: 'failure', phase: report.phase, error: report.error}))
    } finally {
        await checkpoint('cleanup')
        try {
            await driver?.quit()
        } catch (error) { report.cleanupErrors.push(errorReceipt(error)) }
        if (logFd !== null) {
            try {
                closeSync(logFd)
            } catch (error) { report.cleanupErrors.push(errorReceipt(error)) }
        }
        report.completed = passed && report.cleanupErrors.length === 0
        report.authoritativeTiming = report.completed
        report.finishedAt = new Date().toISOString()
        report.hostAfter = getHostEnvironment()
        report.phase = report.completed ? 'complete' : 'failed'
        await save()
    }
    console.log(JSON.stringify({event: 'observation', completed: report.completed, totalImportMs: report.totalImportMs ?? null, output: summaryPath}))
    if (!report.completed) { process.exitCode = 1 }
}

if (process.argv[1] && path.resolve(process.argv[1]) === helperPath) {
    main().catch((error) => {
        console.error(JSON.stringify({event: 'fatal-helper-error', error: errorReceipt(error)}))
        process.exitCode = 1
    })
}
