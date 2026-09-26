/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile, writeFile, mkdir, mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {resolve, join} from 'node:path'
import JSZip from 'jszip'
import {chromium, expect} from '@playwright/test'
import {ManifestUtil} from '../manifest-util.js'
import {hashTermEntryContentBytesPair} from '../../ext/js/dictionary/term-entry-content-hash.js'

const baseline = process.env.EXPECT_BASELINE === '1'
const out = resolve('builds/artifact-consumption')
await mkdir(out, {recursive: true})
const source = await readFile('test/dictionary-importer-artifact-consumption.test.js', 'utf8')
const begin = source.indexOf('function artifact(version, terms) {')
const end = source.indexOf('\n/**\n * @param {Uint8Array} bytes', begin)
assert.ok(begin >= 0 && end > begin)
const fixtureWriter = new Function('encoder', 'hashTermEntryContentBytesPair', 'expect', `${source.slice(begin, end)}; return artifact`)(new TextEncoder(), hashTermEntryContentBytesPair, (value) => ({toBe: (expected) => assert.equal(value, expected)}))
const manifest = new ManifestUtil().getManifest('chrome-playwright')
await writeFile('ext/manifest.json', ManifestUtil.createManifestString(manifest).replace('$YOMITAN_VERSION', '0.0.0.0'))
const extensionId = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
const url = `chrome-extension://${extensionId}/settings.html`
const report = {baseline, sourceSha256: createHash('sha256').update(await readFile('ext/js/dictionary/dictionary-importer.js')).digest('hex'), cases: [], status: 'running'}
const save = () => writeFile(join(out, baseline ? 'browser-baseline.json' : 'browser-fixed.json'), JSON.stringify(report, null, 2))
async function api(page, action, params = {}) {
    return page.evaluate((message) => new Promise((yes, no) => chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError ?? response?.error
        if (error) { no(new Error(error.message ?? 'Runtime error')) } else { yes(response?.result) }
    })), {action, params})
}
async function open(profile) {
    const context = await chromium.launchPersistentContext(profile, {channel: 'chromium', headless: true, args: [`--disable-extensions-except=${resolve('ext')}`, `--load-extension=${resolve('ext')}`]})
    const page = await context.newPage()
    await page.goto(url)
    await expect(page.locator('html')).toHaveAttribute('data-loaded', 'true', {timeout: 30000})
    for (const other of context.pages()) {
        if (other !== page && other.url().endsWith('/welcome.html')) { await other.close() }
    }
    return {context, page}
}
async function zip(title, bytes) {
    const z = new JSZip()
    z.file('index.json', JSON.stringify({title, revision: '1', format: 3}))
    z.file('term_bank_1.mbtb', bytes)
    return z.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'})
}
async function importBytes(page, buffer, sequence) {
    await page.locator('#dictionary-import-file-input').setInputFiles({name: 'artifact.zip', mimeType: 'application/zip', buffer})
    await page.waitForFunction((expected) => globalThis.__manabitanLastImportCompletion?.sequence === expected, sequence, {timeout: 90000})
    return page.evaluate(() => ({completion: globalThis.__manabitanLastImportCompletion, debug: globalThis.__manabitanLastImportDebug}))
}
async function verify(page, title, count) {
    assert.deepEqual((await api(page, 'getDictionaryInfo')).map((item) => item.title), [title])
    const counts = await api(page, 'getDictionaryCounts', {dictionaryNames: [title], getTotal: false})
    assert.equal(counts.counts[0].terms, count)
    for (const i of [0, count - 1]) {
        const result = await api(page, 'termsFind', {text: `term-${i}`, details: {matchType: 'exact', deinflect: false, primaryReading: ''}, optionsContext: {depth: 0, url: page.url()}})
        assert.ok(JSON.stringify(result).includes(`definition term-${i}`))
    }
    return counts.counts[0]
}
try {
    for (const [version, count] of [[1, 75001], [5, 2]]) {
        const profile = await mkdtemp(join(tmpdir(), 'manabitan-artifact-'))
        const title = `Artifact consumption v${version}`
        const payload = fixtureWriter(version, Array.from({length: count}, (_, i) => `term-${i}`))
        const malformed = new Uint8Array(payload.length + 1)
        malformed.set(payload)
        malformed[payload.length] = 0x7f
        let context
        const record = {version, count}
        try {
            const opened = await open(profile)
            context = opened.context
            const page = opened.page
            const pageErrors = []
            page.on('pageerror', (error) => pageErrors.push(String(error)))
            await page.locator('.settings-item[data-modal-action="show,dictionaries"]').click()
            await page.locator('#dictionary-import-button').click()
            await page.evaluate(() => { globalThis.__manabitanImportCompletionSignalEnabled = true })
            record.malformed = await importBytes(page, await zip(title, malformed), 1)
            if (baseline) {
                assert.equal(record.malformed.completion.errorCount, 0)
                record.wronglyPublishedCounts = await verify(page, title, count)
            } else {
                assert.equal(record.malformed.completion.errorCount, 1)
                assert.deepEqual(record.malformed.completion.importedTitles, [])
                assert.deepEqual(await api(page, 'getDictionaryInfo'), [])
                const totals = await api(page, 'getDictionaryCounts', {dictionaryNames: [], getTotal: true})
                assert.equal(totals.total.terms, 0)
                record.afterRollback = totals.total
                record.recovery = await importBytes(page, await zip(title, payload), 2)
                assert.equal(record.recovery.completion.errorCount, 0)
                assert.equal(record.recovery.debug.usesFallbackStorage, false)
                assert.equal(record.recovery.debug.openStorageDiagnostics.mode, 'opfs-sahpool')
                record.recoveredCounts = await verify(page, title, count)
                await context.close()
                context = null
                const reopened = await open(profile)
                context = reopened.context
                record.reopenedCounts = await verify(reopened.page, title, count)
            }
            assert.deepEqual(pageErrors, [])
            record.browser = context.browser()?.version()
            report.cases.push(record)
            await save()
        } finally {
            await context?.close()
            await rm(profile, {recursive: true, force: true})
        }
    }
    report.status = 'success'
} catch (error) {
    report.status = 'failure'
    report.failure = {message: String(error), stack: error.stack}
    throw error
} finally { await save() }
