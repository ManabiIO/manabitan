/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {chromium, expect} from '@playwright/test'
import {ManifestUtil} from '../manifest-util.js'
import {makeMdictFixture} from '../../test/util/mdict-binary-fixture.js'

const base = '9fe19a57864653d84dc5f7c41b6277ccd6d2f7f0'
const candidate = 'a9acbf52263a0fdf6f3c87ac3590186fb684699f'
const modulePath = 'ext/js/dictionary/mdx/mdx-converter.js'
const workload = process.argv[2] ?? 'large'
const rows = {large: 50000, medium: 10000, small: 64}[workload]
assert.ok(rows)
const preflight = process.env.PREFLIGHT === '1'
const reverse = process.env.REVERSE_ORDER === '1'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sources = Object.fromEntries([['A', base], ['B', candidate]].map(([arm, ref]) => [arm, execFileSync('git', ['show', `${ref}:${modulePath}`], {maxBuffer: 2 * 1024 * 1024})]))
const title = `Progress complete ${workload}`
const entries = Array.from({length: rows}, (_, i) => ({key: `term-${String(i).padStart(6, '0')}`, value: `<div>definition ${i} 日本語</div>`}))
const fixture = makeMdictFixture(entries, {title, compression: 'zlib', keysPerBlock: 128, recordBlockSize: 65536}).bytes
const out = resolve('builds/progress-completion')
await mkdir(out, {recursive: true})
const manifest = new ManifestUtil().getManifest('chrome-playwright')
await writeFile('ext/manifest.json', ManifestUtil.createManifestString(manifest).replace('$YOMITAN_VERSION', '0.0.0.0'))
const extensionId = [...hash(Buffer.from(manifest.key, 'base64')).slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
const baseUrl = `chrome-extension://${extensionId}`
const report = {base, candidate, workload, rows, reverse, preflight, node: process.version, moduleHashes: {A: hash(sources.A), B: hash(sources.B)}, fixtureHash: hash(fixture), fixtureBytes: fixture.length, focusHash: hash(await readFile('ext/js/dom/document-focus-controller.js')), outputParity: {}, observations: [], status: 'running'}
const save = () => writeFile(resolve(out, `${workload}${preflight ? '-preflight' : ''}.json`), JSON.stringify(report, null, 2))
// This independent full-converter byte comparison is outside all browser timing.
for (const arm of ['A', 'B']) {
    await writeFile(modulePath, sources[arm])
    const {createMdxImportData} = await import(`../../${modulePath}?parity=${arm}`)
    const progress = []
    const result = await createMdxImportData('progress.mdx', {}, fixture, [], (value) => progress.push(value))
    const digests = [...result.files].map(([path, bytes]) => [path, hash(bytes)]).sort(([a], [b]) => a.localeCompare(b))
    assert.equal(progress[0].completed, 0)
    assert.equal(progress.at(-1).completed, rows)
    report.outputParity[arm] = {files: digests, progressCount: progress.length}
}
assert.deepEqual(report.outputParity.A.files, report.outputParity.B.files)
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
        await page.locator('#dictionary-import-file-input').setInputFiles({name: 'progress.mdx', mimeType: 'application/octet-stream', buffer: Buffer.from(fixture)})
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
        const counts = (await api(page, 'getDictionaryCounts', {dictionaryNames: [title], getTotal: false})).counts[0]
        assert.equal(counts.terms, rows)
        for (const key of ['termMeta', 'kanji', 'kanjiMeta', 'tagMeta', 'media']) { assert.equal(counts[key], 0, key) }
        const ids = [...new Set([0, 1, rows - 1, ...Array.from({length: 24}, (_, i) => Math.floor(i * rows / 24))])]
        const content = []
        for (const i of ids) {
            const found = await api(page, 'termsFind', {text: entries[i].key, details: {matchType: 'exact', deinflect: false, primaryReading: ''}, optionsContext: {depth: 0, url: page.url()}})
            assert.ok(JSON.stringify(found).includes(`definition ${i} 日本語`), `missing definition ${i}`)
            content.push(found)
        }
        const hashes = await page.evaluate(async () => {
            const digest = async (path) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await (await fetch(path)).arrayBuffer()))].map((x) => x.toString(16).padStart(2, '0')).join('')
            return {converter: await digest('/js/dictionary/mdx/mdx-converter.js'), focus: await digest('/js/dom/document-focus-controller.js')}
        })
        assert.equal(hashes.converter, report.moduleHashes[plan.arm])
        assert.equal(hashes.focus, report.focusHash)
        assert.deepEqual(pageErrors, [])
        return {...plan, elapsedMs, timing, counts, verifiedTerms: ids.length, contentDigest: hash(JSON.stringify(content)), hashes, browser: context.browser()?.version(), pageErrors}
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
        const result = await observe({...plan, index})
        report.observations.push(result)
        await save()
        console.log(JSON.stringify({workload, index, kind: plan.kind, arm: plan.arm, elapsedMs: result.elapsedMs}))
    }
    report.status = 'success'
} catch (error) {
    report.status = 'failure'
    report.failure = {index: report.observations.length, message: String(error), stack: error.stack}
    throw error
} finally { await writeFile(modulePath, sources.A); await save() }
