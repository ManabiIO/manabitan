/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import JSZip from 'jszip'
import {chromium, expect} from '@playwright/test'
import {ManifestUtil} from '../manifest-util.js'

const base = '384d1c97dae6bd17555973b77ad415e038438499'
const candidate = '67e03e925816d0b43cf321f3e89f198352cb1569'
const common = 'f2ddf271c1a55d3ce47c751383d81cfc3a1deb08'
const modulePath = 'ext/js/dictionary/dictionary-database.js'
const workload = process.argv[2] ?? 'frequency'
assert.ok(['frequency', 'mixed', 'small'].includes(workload))
const reverse = process.env.REVERSE_ORDER === '1'
const preflight = process.env.PREFLIGHT === '1'
const sha = (value) => createHash('sha256').update(value).digest('hex')
const sources = Object.fromEntries([['A', base], ['B', candidate]].map(([arm, ref]) => [arm, execFileSync('git', ['show', `${ref}:${modulePath}`])]))
const focusHash = sha(await readFile('ext/js/dom/document-focus-controller.js'))
const title = `SQL import ${workload}`
const total = workload === 'small' ? 128 : 100000
const frequencyRows = Array.from({length: total}, (_, i) => [`term-${i}`, 'freq', i + 1])
const banks = {'term_meta_bank_1.json': frequencyRows}
const expected = {terms: 0, termMeta: total, kanji: 0, kanjiMeta: 0, tagMeta: 0, media: 0}
if (workload === 'mixed') {
    banks['term_meta_bank_2.json'] = Array.from({length: 12000}, (_, i) => [`pitch-${i}`, 'pitch', {reading: 'よみ', pitches: [{position: i % 3, tags: ['standard']}]}])
    banks['term_meta_bank_3.json'] = Array.from({length: 12000}, (_, i) => [`ipa-${i}`, 'ipa', {reading: 'よみ', transcriptions: [{ipa: 'jo.mi', tags: ['standard']}]}])
    banks['kanji_bank_1.json'] = Array.from({length: 15000}, (_, i) => [String.fromCodePoint(0x4e00 + i), 'オン', 'くん', 'standard', [`meaning-${i}`], {grade: String(i % 10)}])
    banks['kanji_meta_bank_1.json'] = Array.from({length: 15000}, (_, i) => [String.fromCodePoint(0x4e00 + i), 'freq', i + 1])
    banks['tag_bank_1.json'] = Array.from({length: 20000}, (_, i) => [`tag-${i}`, 'category', i % 7, `note-${i}`, i % 5])
    expected.termMeta += 24000
    expected.kanji = 15000
    expected.kanjiMeta = 15000
    expected.tagMeta = 20000
}
const zip = new JSZip()
const date = new Date('2026-01-01T00:00:00Z')
zip.file('index.json', JSON.stringify({title, format: 3, revision: 'sql-20260926', sequenced: true}), {date})
for (const [name, rows] of Object.entries(banks)) { zip.file(name, JSON.stringify(rows), {date}) }
const fixture = await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: {level: 6}})
const manifest = new ManifestUtil().getManifest('chrome-playwright')
await writeFile('ext/manifest.json', ManifestUtil.createManifestString(manifest).replace('$YOMITAN_VERSION', '0.0.0.0'))
const extensionId = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
const baseUrl = `chrome-extension://${extensionId}`
const out = resolve('builds/sql-import')
await mkdir(out, {recursive: true})
const outputPath = resolve(out, `${workload}${preflight ? '-preflight' : ''}.json`)
const report = {base, candidate, common, focusHash, workload, reverse, preflight, node: process.version, moduleHashes: {A: sha(sources.A), B: sha(sources.B)}, fixtureHash: sha(fixture), fixtureBytes: fixture.length, expected, observations: [], status: 'running'}
const save = () => writeFile(outputPath, JSON.stringify(report, null, 2))
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
        for (const other of context.pages()) {
            if (other !== page && other.url().endsWith('/welcome.html')) { await other.close() }
        }
        await page.bringToFront()
        await page.locator('.settings-item[data-modal-action="show,dictionaries"]').click()
        await page.locator('#dictionary-import-button').click()
        await page.evaluate(() => {
            globalThis.__manabitanImportCompletionSignalEnabled = true
            document.querySelector('#dictionary-import-file-input').addEventListener('change', () => { globalThis.__reviewImportStart = performance.now() }, {once: true, capture: true})
        })
        await page.locator('#dictionary-import-file-input').setInputFiles({name: 'sql-import.zip', mimeType: 'application/zip', buffer: fixture})
        await page.waitForFunction(() => globalThis.__manabitanLastImportCompletion?.sequence === 1, null, {timeout: 90000})
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
        assert.deepEqual(info.map((item) => [item.title, item.revision]), [[title, 'sql-20260926']])
        const counts = (await api(page, 'getDictionaryCounts', {dictionaryNames: [title], getTotal: false})).counts[0]
        for (const [key, value] of Object.entries(expected)) { assert.equal(counts[key], value, key) }
        const ids = [...new Set([0, 1, 2047, 2048, 4095, 4096, 49999, 50000, total - 1, ...Array.from({length: 32}, (_, i) => Math.floor(i * total / 32))].filter((i) => i < total))]
        const frequencies = await api(page, 'getTermFrequencies', {termReadingList: ids.map((i) => [`term-${i}`, null]), dictionaries: [title]})
        assert.equal(frequencies.length, ids.length)
        for (const i of ids) {
            assert.ok(frequencies.some((item) => item.term === `term-${i}` && item.frequency === i + 1), `wrong frequency for term-${i}: ${JSON.stringify(frequencies.slice(0, 2))}`)
        }
        const hashes = await page.evaluate(async () => {
            const hash = async (path) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await (await fetch(path)).arrayBuffer()))].map((x) => x.toString(16).padStart(2, '0')).join('')
            return {database: await hash('/js/dictionary/dictionary-database.js'), focus: await hash('/js/dom/document-focus-controller.js')}
        })
        assert.equal(hashes.database, report.moduleHashes[plan.arm])
        assert.equal(hashes.focus, focusHash)
        assert.deepEqual(pageErrors, [])
        return {...plan, elapsedMs, timing, counts, verifiedFrequencyRows: ids.length, frequencyDigest: sha(JSON.stringify(frequencies)), hashes, browser: context.browser()?.version(), pageErrors}
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
