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
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {openSync, closeSync} from 'node:fs'
import {readFile, writeFile, mkdir} from 'node:fs/promises'
import {cpus, loadavg, release} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import JSZip from 'jszip'
import {Builder, Browser, By} from 'selenium-webdriver'
import * as seleniumFirefox from 'selenium-webdriver/firefox.js'
import {firefox as playwrightFirefox} from 'playwright'
import {armBrowserImportTiming} from '../e2e/import-timing.js'
import {waitForExtensionBaseUrl} from '../e2e/firefox-extension-base-url.js'
import {loadDictionaryFixtures} from '../../dev/perf/dictionary-fixtures.js'
import {snapshotTermBankExperiments} from '../../ext/js/dictionary/term-bank-experiments.js'
import {parseJson} from '../../ext/js/core/json.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const {values} = parseArgs({options: {
    'baseline-package': {type: 'string'},
    'candidate-package': {type: 'string'},
    zip: {type: 'string'},
    geckodriver: {type: 'string'},
    output: {type: 'string'},
    'firefox-binary': {type: 'string', default: playwrightFirefox.executablePath()},
    'reverse-order': {type: 'boolean', default: false},
    mode: {type: 'string', default: 'smoke'},
}})
assert(
    values['baseline-package'] && values['candidate-package'] && values.zip && values.geckodriver && values.output,
    'Required: --baseline-package ZIP --candidate-package ZIP --zip JMdict.zip --geckodriver BINARY --output DIRECTORY',
)
assert(['prepare', 'smoke', 'cohort'].includes(values.mode))
assert.equal(process.platform, 'linux', 'This qualification driver targets Linux only')
const output = path.resolve(values.output)
await mkdir(output, {recursive: true})

/**
 * @param {import('node:crypto').BinaryLike} bytes
 * @returns {string}
 */
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
/**
 * @param {string} filename
 * @returns {Promise<{filename: string, sha256: string, manifest: object, entries: Record<string, string>}>}
 */
async function packageReceipt(filename) {
    const bytes = await readFile(filename)
    const archive = await JSZip.loadAsync(bytes)
    const manifest = parseJson(await archive.file('manifest.json').async('string'))
    assert.equal(manifest.background?.page, 'background.html', 'Expected a Firefox release package')
    assert.equal(manifest.browser_specific_settings?.gecko?.id, '{1e12d533-8e72-4ec5-9edc-cd50e26d7d43}', 'Development packages are not qualification inputs')
    const entries = {}
    for (const name of Object.keys(archive.files).sort()) {
        if (!archive.files[name].dir) { entries[name] = hash(await archive.files[name].async('nodebuffer')) }
    }
    return {filename: path.resolve(filename), sha256: hash(bytes), manifest, entries}
}
const baseline = await packageReceipt(values['baseline-package'])
const candidate = await packageReceipt(values['candidate-package'])
assert.deepEqual(Object.keys(baseline.entries), Object.keys(candidate.entries))
const packageDifferences = Object.keys(baseline.entries).filter((name) => baseline.entries[name] !== candidate.entries[name])
assert.deepEqual(packageDifferences, ['js/dictionary/term-bank-source-pipeline.js'], 'Unexpected product differences')
assert.deepEqual(baseline.manifest, candidate.manifest)
const fixture = (await loadDictionaryFixtures()).jmdict
const dictionaryBytes = await readFile(values.zip)
assert.equal(dictionaryBytes.byteLength, fixture.sizeBytes)
assert.equal(hash(dictionaryBytes), fixture.sha256)
const archive = await JSZip.loadAsync(dictionaryBytes)
const bankNames = Object.keys(archive.files).filter((name) => /^term_bank_\d+\.json$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
assert.equal(bankNames.length, 53)
const probes = []
const expressions = new Set()
for (const bankIndex of [0, Math.floor(bankNames.length / 2), bankNames.length - 1]) {
    const bank = bankNames[bankIndex]
    const rows = parseJson(await archive.file(bank).async('string'))
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
assert.equal(probes.length, 12, 'Could not derive twelve distinct string-glossary source probes')
const binaryPath = path.resolve(values['firefox-binary'])
const driverPath = path.resolve(values.geckodriver)
const firefoxManifest = parseJson(await readFile(path.join(root, 'node_modules/playwright-core/browsers.json'), 'utf8')).browsers.find((entry) => entry.name === 'firefox')
assert.equal(firefoxManifest.browserVersion, '155.0')
const expectedExperiments = snapshotTermBankExperiments()
const sharedArmSource = armBrowserImportTiming.toString()
const schedule = values.mode === 'cohort' ?
[
    {kind: 'warmup', order: 'ABBA'},
    ...['AA', 'AB', 'AB', 'AA', 'AB', 'AB', 'AA', 'AB', 'AB'].map((kind, block) => ({kind, order: block % 2 === 0 ? 'ABBA' : 'BAAB'})),
] :
[{kind: values.mode, order: 'B'}]
if (values['reverse-order'] && values.mode === 'cohort') {
    for (const block of schedule) { block.order = block.order.replace(/[AB]/g, (label) => (label === 'A' ? 'B' : 'A')) }
}
const report = {
    schemaVersion: 1,
    mode: values.mode,
    completed: false,
    error: '',
    startedAt: new Date().toISOString(),
    boundary: 'Current settings-page file-input change to the existing post-UI import-completion signal. Fresh Selenium profile for every observation. Extension setup, post-import counts/storage/source probes, extension reload and repeated persisted probes are outside timing. No screenshots, process samplers or traces. Extension reload is not browser-process restart.',
    baseline,
    candidate,
    packageDifferences,
    fixture,
    probes,
    expectedExperiments,
    schedule,
    reverseOrder: values['reverse-order'],
    plannedObservations: values.mode === 'cohort' ? 40 : 1,
    observations: [],
    runtime: {node: process.version,
        cpu: cpus()[0].model,
        os: release(),
        firefoxManifest,
        firefoxBinarySha256: '',
        geckodriverSha256: '',
        geckodriverVersion: ''},
    driverSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    sharedTimingSha256: hash(sharedArmSource),
    sharedTimingFileSha256: hash(await readFile(path.join(root, 'test/e2e/import-timing.js'))),
    fixtureLockSha256: hash(await readFile(path.join(root, 'test/perf/dictionaries.lock.json'))),
}
/** @returns {Promise<void>} */
const save = async () => { await writeFile(path.join(output, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`) }
await save()
if (values.mode === 'prepare') { process.exit(0) }
report.runtime.firefoxBinarySha256 = hash(await readFile(binaryPath))
report.runtime.geckodriverSha256 = hash(await readFile(driverPath))
report.runtime.geckodriverVersion = execFileSync(driverPath, ['--version'], {encoding: 'utf8'}).trim()
assert(report.runtime.geckodriverVersion.startsWith('geckodriver 0.37.1'))
const profiles = new Set()

/**
 * @param {import('selenium-webdriver/firefox.js').Driver} driver
 * @param {string} action
 * @param {unknown} [params]
 * @returns {Promise<unknown>}
 */
async function send(driver, action, params = null) {
    const response = await driver.executeAsyncScript(`
        const done = arguments[arguments.length - 1];
        const api = window.chrome;
        api.runtime.sendMessage({action: arguments[0], params: arguments[1]}, (response) => {
            const error = api.runtime.lastError;
            done(error ? {error: error.message} : response);
        });
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
    await driver.wait(async () => await driver.executeScript('return document.documentElement.dataset.loaded === \'true\' && !!document.querySelector(\'#dictionary-import-file-input\');'), 30_000)
}

/**
 * @param {import('selenium-webdriver/firefox.js').Driver} driver
 * @returns {Promise<object>}
 */
async function verifyPersisted(driver) {
    const dictionaryInfo = await send(driver, 'getDictionaryInfo')
    assert.equal(dictionaryInfo.length, 1)
    assert.equal(dictionaryInfo[0].title, fixture.expectedTitle)
    assert.equal(dictionaryInfo[0].revision, fixture.revision)
    const counts = await send(driver, 'getDictionaryCounts', {dictionaryNames: [fixture.expectedTitle], getTotal: false})
    assert.equal(counts.counts[0].terms, fixture.termRows)
    const storage = await send(driver, 'debugDictionaryStorageState')
    assert.equal(storage.usesFallbackStorage, false)
    assert.equal(storage.openStorageDiagnostics?.mode, 'opfs-sahpool')
    const samples = []
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
        const matching = lookup.dictionaryEntries.some((entry) => entry.definitions.some((definition) => definition.dictionary === fixture.expectedTitle && JSON.stringify(definition.entries) === JSON.stringify(probe.glossary) &&
        definition.headwordIndices.some((index) => entry.headwords[index]?.term === probe.expression && entry.headwords[index]?.reading === probe.reading)))
        assert(matching, `Source expression/reading/glossary missing: ${probe.expression}/${probe.reading}`)
        samples.push({expression: probe.expression,
            totalLength,
            rows: state.rowSample.map((row) => ({
                expression: row.expression,
                reading: row.reading,
                offset: row.rawEntryContentOffset,
                length: row.rawEntryContentLength,
                glossaryLength: row.glossaryLength,
                rawContentPreview: row.rawContentPreview,
            }))})
    }
    return {dictionaryInfo, counts, storage, samples, digest: hash(JSON.stringify(samples))}
}

/**
 * @param {string} arm
 * @param {number} index
 * @returns {Promise<object>}
 */
async function observe(arm, index) {
    const product = arm === 'B' ? candidate : baseline
    const observationDir = path.join(output, `observation-${String(index).padStart(2, '0')}`)
    await mkdir(observationDir, {recursive: true})
    const logFd = openSync(path.join(observationDir, 'geckodriver.log'), 'a')
    const options = new seleniumFirefox.Options().addArguments('-headless').setBinary(binaryPath)
    for (const [key, value] of Object.entries({
        'xpinstall.signatures.required': false,
        'extensions.manifestV3.enabled': true,
        'extensions.backgroundServiceWorker.enabled': true,
        'javascript.options.shared_memory': true,
        'dom.postMessage.sharedArrayBuffer.withCOOP_COEP': true,
        'dom.postMessage.sharedArrayBuffer.bypassCOOP_COEP.insecure.enabled': true,
        'extensions.webextensions.uuids': JSON.stringify({[product.manifest.browser_specific_settings.gecko.id]: '6d1d0bf0-9b57-4ff8-9d93-64e13ae0f5da'}),
    })) { options.setPreference(key, value) }
    const service = new seleniumFirefox.ServiceBuilder(driverPath).addArguments('--allow-system-access')
    service.setStdio(['ignore', logFd, logFd])
    const record = {arm, packageSha256: product.sha256, completed: false, error: '', hostLoad: loadavg(), profile: '', browserVersion: '', wallMs: null}
    let driver = null
    let operationFailed = false
    /** @type {unknown} */
    let operationError
    try {
        driver = await new Builder().forBrowser(Browser.FIREFOX).setFirefoxOptions(options)
            .setFirefoxService(service)
            .build()
        await driver.manage().setTimeouts({implicit: 0, pageLoad: 30_000, script: 180_000})
        const capabilities = await driver.getCapabilities()
        record.profile = String(capabilities.get('moz:profile'))
        record.browserVersion = String(capabilities.get('browserVersion'))
        assert(record.profile.length > 0 && record.profile !== 'undefined' && !profiles.has(record.profile), 'Profile was reused')
        profiles.add(record.profile)
        assert.equal(record.browserVersion, firefoxManifest.browserVersion)
        const addonId = await driver.installAddon(product.filename, true)
        assert.equal(addonId, product.manifest.browser_specific_settings.gecko.id)
        const baseUrl = await waitForExtensionBaseUrl(driver, addonId)
        await openSettings(driver, baseUrl)
        assert.deepEqual(await send(driver, 'getDictionaryInfo'), [])
        const configured = await driver.executeScript('return {flags: window.manabitanImportPerformanceFlags ?? null, profiling: window.manabitanPerformanceInstrumentationEnabled === true};')
        assert.deepEqual(configured, {flags: null, profiling: false})
        // Gecko may use a separate script sandbox: bind the unchanged shared observer to the actual page window.
        await driver.executeScript(`const globalThis = window; (${sharedArmSource})();`)
        await driver.findElement(By.css('#dictionary-import-file-input')).sendKeys(path.resolve(values.zip))
        const result = await driver.executeAsyncScript(`
            const done = arguments[arguments.length - 1];
            const finish = () => {
                const timing = window.__manabitanBrowserImportTiming;
                if (timing?.completedAtMs == null) { return; }
                clearTimeout(timeout);
                window.removeEventListener('manabitan:dictionary-import-complete', complete);
                done({timing, debug: window.__manabitanLastImportDebug});
            };
            const complete = () => queueMicrotask(finish);
            const timeout = setTimeout(() => { window.removeEventListener('manabitan:dictionary-import-complete', complete); done({error: 'No current-operation completion within 150 seconds', debug: window.__manabitanLastImportDebug}); }, 150000);
            window.addEventListener('manabitan:dictionary-import-complete', complete);
            finish();
        `)
        assert(!result.error, JSON.stringify(result))
        const {timing, debug} = result
        assert.equal(timing.trigger, 'file-input-change')
        assert(Number.isSafeInteger(timing.sequence) && timing.sequence > timing.sequenceBefore)
        assert.equal(timing.errorCount, 0)
        assert(Number.isFinite(timing.startedAtMs) && Number.isFinite(timing.completedAtMs) && timing.completedAtMs > timing.startedAtMs)
        record.wallMs = timing.completedAtMs - timing.startedAtMs
        record.timing = timing
        record.importDebug = debug
        assert(debug.hasResult && debug.resultTitle === fixture.expectedTitle && debug.errorCount === 0 && debug.addSettingsErrorCount === 0)
        assert.equal(debug.usesFallbackStorage, false)
        assert.equal(debug.openStorageDiagnostics?.mode, 'opfs-sahpool')
        const experiments = debug.importerPhaseTimings.flatMap((phase) => Object.entries(phase.details ?? {}).filter(([name]) => ['parserExperiments', 'fastPathParserExperiments', 'fastPathParserEffectiveExperiments', 'compressionExperiments'].includes(name)).map(([, value]) => value))
        assert(experiments.length >= 2, 'Missing effective production experiment receipts')
        for (const observed of experiments) { assert.deepEqual(observed, expectedExperiments) }
        const termFiles = debug.importerPhaseTimings.filter((phase) => phase.phase.startsWith('term-file'))
        assert(termFiles.length > 0, 'Missing disjoint term-file work receipts')
        record.termFileWork = termFiles.map((phase) => ({
            phase: phase.phase,
            counters: Object.fromEntries(Object.entries(phase.details).filter(([name, value]) => typeof value === 'number' && !name.endsWith('Ms') && /(?:Count|Bytes|Rows|Fallbacks)$|^(?:rows|chunkCount)$/.test(name))),
        }))
        for (const [name, expected] of Object.entries({rows: fixture.termRows, parserSourceCompressedBytes: 15_574_114, parserSourceTransferredBytes: 15_574_114})) {
            assert.equal(termFiles.reduce((sum, phase) => sum + (phase.details[name] ?? 0), 0), expected, `Changed raw compressed source path did not execute: ${name}`)
        }
        for (const phase of termFiles) {
            assert.equal(phase.details.parserFusedFallbacks, 0)
            assert.equal(phase.details.dedupNativeFallbackCount, 0)
        }
        const finalization = debug.importerPhaseTimings.find((phase) => phase.phase === 'bulk-finalization')?.details
        assert(finalization?.ok === true && finalization.published === true)
        assert.deepEqual(finalization.housekeepingErrors, [])
        record.finalizationWork = Object.fromEntries(Object.entries(finalization).filter(([name, value]) => typeof value === 'number' && !name.endsWith('Ms') && name !== 'termRecordLookupIndexMaxQueuedBytes'))
        record.beforeReload = await verifyPersisted(driver)
        const priorOrigin = await driver.executeAsyncScript('const done = arguments[arguments.length - 1]; window.browser.runtime.getBackgroundPage().then((page) => done(page.performance.timeOrigin), (error) => done({error:String(error)}));')
        assert(Number.isFinite(priorOrigin))
        const settingsHandle = await driver.getWindowHandle()
        await driver.switchTo().newWindow('tab')
        await driver.get('about:blank')
        const reloadHandle = await driver.getWindowHandle()
        await driver.switchTo().window(settingsHandle)
        try {
            await driver.executeScript('setTimeout(() => window.browser.runtime.reload(), 0);')
        } catch (error) {
            if (error?.name !== 'NoSuchWindowError' && !String(error).includes('Browsing context has been discarded')) { throw error }
        }
        await driver.switchTo().window(reloadHandle)
        await driver.sleep(500)
        await openSettings(driver, baseUrl)
        const nextOrigin = await driver.executeAsyncScript('const done = arguments[arguments.length - 1]; window.browser.runtime.getBackgroundPage().then((page) => done(page.performance.timeOrigin), (error) => done({error:String(error)}));')
        assert(Number.isFinite(nextOrigin) && nextOrigin !== priorOrigin, 'Extension backend did not reload')
        record.afterReload = await verifyPersisted(driver)
        assert.equal(record.afterReload.digest, record.beforeReload.digest)
        record.reload = {priorOrigin, nextOrigin, kind: 'extension-runtime-reload'}
        record.completed = true
    } catch (error) {
        operationFailed = true
        operationError = error
        record.error = String(error)
    } finally {
        try { await driver?.quit() } catch (error) {
            record.cleanupError = String(error)
            if (!operationFailed) {
                operationFailed = true
                operationError = error
                record.completed = false
                record.error = record.cleanupError
            }
        } finally {
            closeSync(logFd)
            await writeFile(path.join(observationDir, 'result.json'), `${JSON.stringify(record, null, 2)}\n`)
        }
    }
    if (operationFailed) { throw operationError }
    return record
}

try {
    let index = 0
    for (const [block, {kind, order}] of schedule.entries()) {
        for (const label of order) {
            const arm = kind === 'AA' ? 'A' : label
            const observation = {block, kind, order, label, warmup: kind === 'warmup', ...await observe(arm, index++)}
            const first = report.observations[0]
            if (first) {
                assert.equal(observation.beforeReload.digest, first.beforeReload.digest, 'Persisted source probes differ across observations')
                assert.deepEqual(observation.termFileWork, first.termFileWork, 'Disjoint term-file work differs across observations')
                assert.deepEqual(observation.finalizationWork, first.finalizationWork, 'Final storage work differs across observations')
                assert.deepEqual(observation.beforeReload.counts, first.beforeReload.counts, 'Persisted dictionary counts differ across observations')
            }
            report.observations.push(observation)
            await save()
            console.log(JSON.stringify({index, kind, label, wallMs: observation.wallMs, completed: observation.completed}))
        }
    }
    assert.equal(report.observations.length, report.plannedObservations)
    assert.equal(hash(await readFile(baseline.filename)), baseline.sha256)
    assert.equal(hash(await readFile(candidate.filename)), candidate.sha256)
    assert.equal(hash(await readFile(binaryPath)), report.runtime.firefoxBinarySha256)
    assert.equal(hash(await readFile(driverPath)), report.runtime.geckodriverSha256)
    assert.equal(hash(await readFile(fileURLToPath(import.meta.url))), report.driverSha256)
    assert.equal(hash(await readFile(path.join(root, 'test/e2e/import-timing.js'))), report.sharedTimingFileSha256)
    assert.equal(hash(await readFile(path.join(root, 'test/perf/dictionaries.lock.json'))), report.fixtureLockSha256)
    const finalDictionaryBytes = await readFile(values.zip)
    assert.equal(finalDictionaryBytes.byteLength, fixture.sizeBytes)
    assert.equal(hash(finalDictionaryBytes), fixture.sha256)
    report.completed = true
} catch (error) {
    report.error = String(error)
    throw error
} finally { await save() }
