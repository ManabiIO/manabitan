/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import JSZip from 'jszip'
import {chromium, expect} from '@playwright/test'
import {ManifestUtil} from '../manifest-util.js'

const base = 'c7564f55eb0a0eead27d859beaaed1d15fc8bb1d'
const candidate = '72925bcf02192a140c6af9c960f9c3b24b1f90ef'
const modulePath = 'ext/js/dictionary/dictionary-database.js'
const workload = process.argv[2] ?? 'unique'
assert.ok(workload === 'unique' || workload === 'duplicate')
const rows = 100000
const reverse = process.env.REVERSE_ORDER === '1'
const preflight = process.env.PREFLIGHT === '1'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sources = Object.fromEntries([['A', base], ['B', candidate]].map(([arm, ref]) => [
    arm,
    execFileSync('git', ['show', `${ref}:${modulePath}`], {maxBuffer: 4 * 1024 * 1024}),
]))
const title = `Pending pair table ${workload}`
const zip = new JSZip()
const date = new Date('2026-01-01T00:00:00Z')
zip.file('index.json', JSON.stringify({title, format: 3, revision: 'pair-table-20260926', sequenced: true}), {date})
const bankSize = 10000
for (let bankStart = 0, bank = 1; bankStart < rows; bankStart += bankSize, ++bank) {
    const count = Math.min(bankSize, rows - bankStart)
    const values = Array.from({length: count}, (_, local) => {
        const i = bankStart + local
        const definitionIndex = workload === 'duplicate' ? Math.floor(i / 2) : i
        return [
            `term-${String(i).padStart(6, '0')}`,
            '',
            '',
            '',
            0,
            [`definition ${definitionIndex} 日本語 ${'x'.repeat(48)}`],
            i,
            '',
        ]
    })
    zip.file(`term_bank_${bank}.json`, JSON.stringify(values), {date})
}
const fixture = await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: {level: 6}})
const out = resolve('builds/pending-pair-completion')
await mkdir(out, {recursive: true})
const manifest = new ManifestUtil().getManifest('chrome-playwright')
await writeFile('ext/manifest.json', ManifestUtil.createManifestString(manifest).replace('$YOMITAN_VERSION', '0.0.0.0'))
const extensionId = [...hash(Buffer.from(manifest.key, 'base64')).slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
const baseUrl = `chrome-extension://${extensionId}`
const report = {
    base, candidate, workload, rows, reverse, preflight, node: process.version,
    moduleHashes: {A: hash(sources.A), B: hash(sources.B)},
    fixtureHash: hash(fixture), fixtureBytes: fixture.length,
    focusHash: hash(await readFile('ext/js/dom/document-focus-controller.js')),
    observations: [], status: 'running',
}
const save = () => writeFile(resolve(out, `${workload}${preflight ? '-preflight' : ''}.json`), JSON.stringify(report, null, 2))

async function api(page, action, params = {}) {
    return page.evaluate((message) => new Promise((yes, no) => chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError ?? response?.error
        if (error) { no(new Error(error.message ?? 'Runtime error')) } else { yes(response?.result) }
    })), {action, params})
}

async function observe(plan) {
    await writeFile(modulePath, sources[plan.arm])
    const context = await chromium.launchPersistentContext('', {
        channel: 'chromium', headless: true,
        args: [`--disable-extensions-except=${resolve('ext')}`, `--load-extension=${resolve('ext')}`],
    })
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
            document.querySelector('#dictionary-import-file-input').addEventListener('change', () => {
                globalThis.__reviewImportStart = performance.now()
            }, {once: true, capture: true})
        })
        await page.locator('#dictionary-import-file-input').setInputFiles({
            name: 'pair-table.zip', mimeType: 'application/zip', buffer: fixture,
        })
        await page.waitForFunction(() => globalThis.__manabitanLastImportCompletion?.sequence === 1, null, {timeout: 180000})
        const timing = await page.evaluate(() => ({
            start: globalThis.__reviewImportStart,
            completion: globalThis.__manabitanLastImportCompletion,
            debug: globalThis.__manabitanLastImportDebug,
        }))
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
        const counts = (await api(page, 'getDictionaryCounts', {dictionaryNames: [title], getTotal: false})).counts[0]
        assert.equal(counts.terms, rows)
        for (const key of ['termMeta', 'kanji', 'kanjiMeta', 'tagMeta', 'media']) { assert.equal(counts[key], 0, key) }
        const ids = [...new Set([0, 1, rows - 1, ...Array.from({length: 24}, (_, i) => Math.floor(i * rows / 24))])]
        const digests = []
        for (const i of ids) {
            const found = await api(page, 'termsFind', {
                text: `term-${String(i).padStart(6, '0')}`,
                details: {matchType: 'exact', deinflect: false, primaryReading: ''},
                optionsContext: {depth: 0, url: page.url()},
            })
            const text = JSON.stringify(found)
            const expectedDefinition = workload === 'duplicate' ? Math.floor(i / 2) : i
            assert.ok(text.includes(`definition ${expectedDefinition} 日本語`), `missing definition for row ${i}`)
            digests.push(hash(text))
        }
        const databaseHash = await page.evaluate(async () => [...new Uint8Array(
            await crypto.subtle.digest('SHA-256', await (await fetch('/js/dictionary/dictionary-database.js')).arrayBuffer()),
        )].map((x) => x.toString(16).padStart(2, '0')).join(''))
        assert.equal(databaseHash, report.moduleHashes[plan.arm])
        assert.deepEqual(pageErrors, [])
        return {
            ...plan, elapsedMs, counts, verifiedTerms: ids.length,
            contentDigest: hash(JSON.stringify(digests)), databaseHash,
            browser: context.browser()?.version(), pageErrors,
        }
    } finally { await context.close() }
}

const schedule = reverse ?
    [{kind: 'warmup', arm: 'B'}, {kind: 'warmup', arm: 'A'}] :
    [{kind: 'warmup', arm: 'A'}, {kind: 'warmup', arm: 'B'}]
if (!preflight) {
    schedule.push({kind: 'control', pair: 0, side: 0, arm: 'A'}, {kind: 'control', pair: 0, side: 1, arm: 'A'})
    for (let block = 0; block < 4; ++block) {
        const order = (block % 2 === 1) !== reverse ? 'BAAB' : 'ABBA'
        for (const [slot, arm] of [...order].entries()) { schedule.push({kind: 'measurement', block, slot, arm}) }
    }
    schedule.push({kind: 'control', pair: 1, side: 0, arm: 'A'}, {kind: 'control', pair: 1, side: 1, arm: 'A'})
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
