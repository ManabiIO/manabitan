/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import JSZip from 'jszip'
import {chromium, expect} from '@playwright/test'
import {ManifestUtil} from '../manifest-util.js'
import {ensureFixtureFile, loadDictionaryFixtures} from '../perf/dictionary-fixtures.js'

const base = '2d79cd1dec164caa3075884133d9d12204a4f48a'
const candidate = '6c7c690ccb3794c01941a536e7564907348cd83c'
const modulePath = 'ext/js/dictionary/dictionary-importer.js'
const workload = process.argv[2] ?? 'frequency'
assert.ok(['frequency', 'mixed', 'none'].includes(workload))
const reverse = process.env.REVERSE_ORDER === '1'
const preflight = process.env.PREFLIGHT === '1'
const hash = (value) => createHash('sha256').update(value).digest('hex')
const sources = Object.fromEntries([['A', base], ['B', candidate]].map(([arm, ref]) => [arm, execFileSync('git', ['show', `${ref}:${modulePath}`], {maxBuffer: 4 * 1024 * 1024})]))
const out = resolve('builds/meta-completion')
await mkdir(out, {recursive: true})
const lock = (await loadDictionaryFixtures()).jmdict
const originalPath = resolve(out, lock.cacheFile)
await ensureFixtureFile(lock, originalPath)
const original = await readFile(originalPath)
const zip = await JSZip.loadAsync(original)
const index = JSON.parse(await zip.file('index.json').async('string'))
assert.equal(index.title, lock.expectedTitle)
assert.equal(index.revision, lock.revision)
const title = index.title
const expected = {terms: 0, termMeta: 0, kanji: 0, kanjiMeta: 0, tagMeta: 0, media: 0}
const bankTypes = {term: 'terms', term_meta: 'termMeta', kanji: 'kanji', kanji_meta: 'kanjiMeta', tag: 'tagMeta'}
const termBankHashes = {}
const names = Object.keys(zip.files).filter((name) => /^(term|term_meta|kanji|kanji_meta|tag)_bank_\d+\.json$/.test(name)).sort((a, b) => a.localeCompare(b, 'en', {numeric: true}))
const unique = new Map()
const termSamples = []
for (const name of names) {
    const text = await zip.file(name).async('string')
    const rows = JSON.parse(text)
    const kind = /^(.*)_bank_/.exec(name)[1]
    expected[bankTypes[kind]] += rows.length
    if (kind === 'term') {
        termBankHashes[name] = hash(text)
        for (const row of rows) {
            if (unique.size < 100000 && !unique.has(row[0])) { unique.set(row[0], row[1] || row[0]) }
        }
        if (rows.length && termSamples.length < 12) { termSamples.push(rows[Math.floor(rows.length / 2)][0]) }
    }
}
assert.equal(expected.terms, lock.termRows)
assert.equal(expected.termMeta, 0)
assert.equal(expected.kanjiMeta, 0)
assert.equal(unique.size, 100000)
const keys = [...unique.keys()]
const readings = [...unique.values()]
const additions = {}
if (workload !== 'none') {
    additions['term_meta_bank_1.json'] = keys.map((key, i) => [key, 'freq', i + 1])
    expected.termMeta += keys.length
}
if (workload === 'mixed') {
    additions['term_meta_bank_2.json'] = keys.slice(0, 12000).map((key, i) => [key, 'pitch', {reading: readings[i], pitches: [{position: 0}]}])
    additions['term_meta_bank_3.json'] = keys.slice(0, 12000).map((key, i) => [key, 'ipa', {reading: readings[i], transcriptions: [{ipa: 'jo.mi'}]}])
    additions['kanji_meta_bank_1.json'] = Array.from({length: 15000}, (_, i) => [String.fromCodePoint(0x4e00 + i), 'freq', i + 1])
    expected.termMeta += 24000
    expected.kanjiMeta += 15000
}
const additionHashes = {}
for (const [name, rows] of Object.entries(additions)) {
    assert.equal(zip.file(name), null)
    const text = JSON.stringify(rows)
    additionHashes[name] = hash(text)
    zip.file(name, text, {date: new Date('2026-01-01T00:00:00Z')})
}
const fixture = workload === 'none' ? original : await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: {level: 6}})
const rebuilt = await JSZip.loadAsync(fixture)
for (const [name, digest] of Object.entries(termBankHashes)) { assert.equal(hash(await rebuilt.file(name).async('string')), digest) }
const manifest = new ManifestUtil().getManifest('chrome-playwright')
await writeFile('ext/manifest.json', ManifestUtil.createManifestString(manifest).replace('$YOMITAN_VERSION', '0.0.0.0'))
const extensionId = [...hash(Buffer.from(manifest.key, 'base64')).slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
const baseUrl = `chrome-extension://${extensionId}`
const focusHash = hash(await readFile('ext/js/dom/document-focus-controller.js'))
const reportPath = resolve(out, `${workload}${preflight ? '-preflight' : ''}.json`)
const report = {base, candidate, workload, reverse, preflight, node: process.version, lock, fixtureHash: hash(fixture), fixtureBytes: fixture.length, termBankHashes, additionHashes, expected, focusHash, moduleHashes: {A: hash(sources.A), B: hash(sources.B)}, observations: [], status: 'running'}
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2))
const controlModes = [[], ['freq'], ['ipa', 'freq', 'pitch', 'freq'], ['unknown', 'freq', 'unknown'], ['total', 'freq', 'total'], ['__proto__', 'constructor', 'freq'], Array.from({length: 100000}, (_, i) => ['freq', 'pitch', 'ipa', 'unknown'][i % 4])]
const controlResults = {}
for (const arm of ['A', 'B']) {
    await writeFile(modulePath, sources[arm])
    const {DictionaryImporter} = await import(`../../${modulePath}?control=${arm}`)
    controlResults[arm] = controlModes.map((modes) => DictionaryImporter.prototype._getMetaCounts(modes.map((mode) => ({mode}))))
}
assert.deepEqual(controlResults.A, controlResults.B)
report.helperControls = {cases: controlModes.length, digest: hash(JSON.stringify(controlResults.A))}
await writeFile(modulePath, sources.A)
async function api(page, action, params = {}) {
    return page.evaluate((message) => new Promise((yes, no) => chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError ?? response?.error
        if (error) { no(new Error(error.message ?? 'Runtime error')) } else { yes(response?.result) }
    })), {action, params})
}
async function observe(plan) {
    await writeFile(modulePath, sources[plan.arm])
    const context = await chromium.launchPersistentContext('', {channel: 'chromium', headless: true, args: [`--disable-extensions-except=${resolve('ext')}`, `--load-extension=${resolve('ext')}`]})
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    try {
        await page.goto(`${baseUrl}/settings.html`)
        await expect(page.locator('html')).toHaveAttribute('data-loaded', 'true', {timeout: 30000})
        for (const other of context.pages()) { if (other !== page && other.url().endsWith('/welcome.html')) { await other.close() } }
        await page.bringToFront()
        await page.locator('.settings-item[data-modal-action="show,dictionaries"]').click()
        await page.locator('#dictionary-import-button').click()
        await page.evaluate(() => {
            globalThis.__manabitanImportCompletionSignalEnabled = true
            document.querySelector('#dictionary-import-file-input').addEventListener('change', () => { globalThis.__reviewImportStart = performance.now() }, {once: true, capture: true})
        })
        await page.locator('#dictionary-import-file-input').setInputFiles({name: 'jmdict-with-metadata.zip', mimeType: 'application/zip', buffer: fixture})
        await page.waitForFunction(() => globalThis.__manabitanLastImportCompletion?.sequence === 1, null, {timeout: 120000})
        const timing = await page.evaluate(() => ({start: globalThis.__reviewImportStart, completion: globalThis.__manabitanLastImportCompletion, debug: globalThis.__manabitanLastImportDebug}))
        assert.equal(timing.completion.errorCount, 0)
        assert.equal(timing.completion.importRunCurrent, true)
        assert.deepEqual(timing.completion.importedTitles, [title])
        assert.equal(timing.debug.hasResult, true)
        assert.equal(timing.debug.errorCount, 0)
        assert.equal(timing.debug.addSettingsErrorCount, 0)
        assert.equal(timing.debug.usesFallbackStorage, false)
        assert.equal(timing.debug.openStorageDiagnostics?.mode, 'opfs-sahpool')
        const elapsedMs = timing.completion.completedAtMonotonicMs - timing.start
        assert.ok(Number.isFinite(elapsedMs) && elapsedMs > 0)
        await expect(page.locator('#dictionaries')).toHaveText('Dictionaries (1 installed, 1 enabled)', {timeout: 30000})
        const info = await api(page, 'getDictionaryInfo')
        assert.deepEqual(info.map((item) => [item.title, item.revision]), [[title, lock.revision]])
        const counts = (await api(page, 'getDictionaryCounts', {dictionaryNames: [title], getTotal: false})).counts[0]
        for (const [key, value] of Object.entries(expected)) { assert.equal(counts[key], value, key) }
        const ids = [...new Set([0, 1, 2047, 2048, 4095, 4096, 49999, 50000, keys.length - 1, ...Array.from({length: 24}, (_, i) => Math.floor(i * keys.length / 24))])]
        const frequencies = await api(page, 'getTermFrequencies', {termReadingList: ids.map((i) => [keys[i], null]), dictionaries: [title]})
        assert.equal(frequencies.length, workload === 'none' ? 0 : ids.length)
        if (workload !== 'none') {
            for (const i of ids) { assert.ok(frequencies.some((item) => item.term === keys[i] && item.frequency === i + 1), `wrong frequency for ${keys[i]}`) }
        }
        const lookups = []
        for (const text of termSamples) {
            const found = await api(page, 'termsFind', {text, details: {matchType: 'exact', deinflect: false, primaryReading: ''}, optionsContext: {depth: 0, url: page.url()}})
            assert.ok(JSON.stringify(found).includes(JSON.stringify(text).slice(1, -1)), `missing term ${text}`)
            lookups.push(found)
        }
        const hashes = await page.evaluate(async () => {
            const digest = async (path) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await (await fetch(path)).arrayBuffer()))].map((x) => x.toString(16).padStart(2, '0')).join('')
            return {importer: await digest('/js/dictionary/dictionary-importer.js'), focus: await digest('/js/dom/document-focus-controller.js')}
        })
        assert.equal(hashes.importer, report.moduleHashes[plan.arm])
        assert.equal(hashes.focus, focusHash)
        assert.deepEqual(pageErrors, [])
        return {...plan, elapsedMs, timing, counts, summary: info[0].counts, verifiedFrequencyRows: frequencies.length, frequencyDigest: hash(JSON.stringify(frequencies)), verifiedTermLookups: lookups.length, lookupDigest: hash(JSON.stringify(lookups)), hashes, browser: context.browser()?.version(), pageErrors}
    } finally { await context.close() }
}
const schedule = reverse ? [{kind: 'warmup', arm: 'B'}, {kind: 'warmup', arm: 'A'}] : [{kind: 'warmup', arm: 'A'}, {kind: 'warmup', arm: 'B'}]
if (!preflight) {
    for (let pair = 0; pair < 2; pair++) { schedule.push({kind: 'control', pair, side: 0, arm: 'A'}, {kind: 'control', pair, side: 1, arm: 'A'}) }
    for (let block = 0; block < 6; block++) {
        const order = (block % 2 === 1) !== reverse ? 'BAAB' : 'ABBA'
        for (const [slot, arm] of [...order].entries()) { schedule.push({kind: 'measurement', block, slot, arm}) }
    }
    for (let pair = 2; pair < 4; pair++) { schedule.push({kind: 'control', pair, side: 0, arm: 'A'}, {kind: 'control', pair, side: 1, arm: 'A'}) }
}
report.schedule = schedule
try {
    for (const [index, plan] of schedule.entries()) {
        const observation = await observe({...plan, index})
        report.observations.push(observation)
        await save()
        console.log(JSON.stringify({workload, index, kind: plan.kind, arm: plan.arm, elapsedMs: observation.elapsedMs}))
    }
    report.status = 'success'
} catch (error) {
    report.status = 'failure'
    report.failure = {index: report.observations.length, message: String(error), stack: error.stack}
    throw error
} finally {
    await writeFile(modulePath, sources.A)
    await save()
}
