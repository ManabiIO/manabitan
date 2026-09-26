/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {chromium, expect} from '@playwright/test'
import {ManifestUtil} from '../manifest-util.js'
import {makeMdictFixture} from '../../test/util/mdict-binary-fixture.js'

const base = '2d79cd1dec164caa3075884133d9d12204a4f48a'
const modulePaths = ['ext/js/dictionary/mdx/vendor/js-mdict/mdict.js', 'ext/js/dictionary/mdx/vendor/js-mdict/mdx.js']
const expectedBlobs = ['00a19a0e0219b9968fd7ac2028430cd874539da3', '418aa52d68d416ea02a1adfcbdf6f86cd0db5114']
const workload = process.argv[2] ?? 'short'
const [rows, size] = {short: [20000, 128], long: [10000, 2048], small: [64, 128]}[workload] ?? []
assert.ok(rows)
const preflight = process.env.PREFLIGHT === '1'
const reverse = process.env.REVERSE_ORDER === '1'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sources = {A: [], B: []}
for (const [i, path] of modulePaths.entries()) {
    assert.equal(execFileSync('git', ['hash-object', path], {encoding: 'utf8'}).trim(), expectedBlobs[i])
    sources.A.push(execFileSync('git', ['show', `${base}:${path}`]))
    sources.B.push(await readFile(path))
}
async function select(arm) { for (const [i, path] of modulePaths.entries()) { await writeFile(path, sources[arm][i]) } }
const title = `Borrow complete ${workload}`
const entries = Array.from({length: rows}, (_, i) => ({key: `entry-${String(i).padStart(6, '0')}`, value: `<p>definition-${i} ${'Japanese vocabulary '.repeat(Math.ceil(size / 20))}</p>`}))
const fixture = makeMdictFixture(entries, {title, compression: 'zlib', keysPerBlock: 512, recordBlockSize: 65536}).bytes
const out = resolve('builds/borrow-completion')
await mkdir(out, {recursive: true})
await writeFile(`${out}/fixture.mdx`, fixture)
const manifest = new ManifestUtil().getManifest('chrome-playwright')
await writeFile('ext/manifest.json', ManifestUtil.createManifestString(manifest).replace('$YOMITAN_VERSION', '0.0.0.0'))
const id = [...hash(Buffer.from(manifest.key, 'base64')).slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
const url = `chrome-extension://${id}`
const commonPaths = ['ext/js/dictionary/mdx/mdx-converter.js', 'ext/js/dictionary/mdx/vendor/pako.js', 'ext/js/dom/document-focus-controller.js', 'ext/js/dictionary/mdx/vendor/js-mdict/scanner.js', 'package-lock.json']
const commonHashes = Object.fromEntries(await Promise.all(commonPaths.map(async (path) => [path, hash(await readFile(path))])))
const report = {base, workload, rows, size, reverse, preflight, node: process.version, modulePaths, moduleHashes: {A: sources.A.map(hash), B: sources.B.map(hash)}, commonHashes, fixtureHash: hash(fixture), fixtureBytes: fixture.length, outputParity: {}, observations: [], status: 'running'}
const save = () => writeFile(`${out}/${workload}${preflight ? '-preflight' : ''}.json`, JSON.stringify(report, null, 2))
// A fresh process per arm prevents Node from reusing downstream module imports.
try {
    for (const arm of ['A', 'B']) {
        await select(arm)
        execFileSync(process.execPath, ['--input-type=module', '-e', `
            import {readFileSync,writeFileSync} from 'node:fs'
            import {createHash} from 'node:crypto'
            import {createMdxImportData} from './ext/js/dictionary/mdx/mdx-converter.js'
            const result=await createMdxImportData('borrow.mdx', {}, new Uint8Array(readFileSync('builds/borrow-completion/fixture.mdx')), [])
            const files=[...result.files].map(([name,bytes])=>[name,createHash('sha256').update(bytes).digest('hex')]).sort(([a],[b])=>a.localeCompare(b))
            writeFileSync('builds/borrow-completion/parity.json',JSON.stringify(files))
        `], {maxBuffer: 8 * 1024 * 1024})
        report.outputParity[arm] = JSON.parse(await readFile(`${out}/parity.json`, 'utf8'))
    }
    assert.deepEqual(report.outputParity.A, report.outputParity.B)
} finally { await select('B') }
async function api(page, action, params = {}) {
    return page.evaluate((message) => new Promise((yes, no) => chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError ?? response?.error
        if (error) { no(new Error(error.message ?? 'Runtime error')) } else { yes(response?.result) }
    })), {action, params})
}
async function observe(plan) {
    await select(plan.arm)
    const context = await chromium.launchPersistentContext('', {channel: 'chromium', headless: true, args: [`--disable-extensions-except=${resolve('ext')}`, `--load-extension=${resolve('ext')}`]})
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    try {
        await page.goto(`${url}/settings.html`)
        await expect(page.locator('html')).toHaveAttribute('data-loaded', 'true', {timeout: 30000})
        for (const other of context.pages()) { if (other !== page && other.url().endsWith('/welcome.html')) { await other.close() } }
        await page.bringToFront()
        await page.locator('.settings-item[data-modal-action="show,dictionaries"]').click()
        await page.locator('#dictionary-import-button').click()
        await page.evaluate(() => {
            globalThis.__manabitanImportCompletionSignalEnabled = true
            document.querySelector('#dictionary-import-file-input').addEventListener('change', () => { globalThis.__reviewImportStart = performance.now() }, {once: true, capture: true})
        })
        await page.locator('#dictionary-import-file-input').setInputFiles({name: 'borrow.mdx', mimeType: 'application/octet-stream', buffer: Buffer.from(fixture)})
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
            assert.ok(JSON.stringify(found).includes(`definition-${i} Japanese vocabulary`), `missing definition ${i}`)
            content.push(found)
        }
        const served = await page.evaluate(async (paths) => Promise.all(paths.map(async (path) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await (await fetch(path)).arrayBuffer()))].map((x) => x.toString(16).padStart(2, '0')).join(''))), modulePaths.map((path) => path.slice(3)))
        assert.deepEqual(served, report.moduleHashes[plan.arm])
        for (const [path, expected] of Object.entries(commonHashes)) { assert.equal(hash(await readFile(path)), expected) }
        assert.deepEqual(pageErrors, [])
        return {...plan, elapsedMs, timing, counts, verifiedTerms: ids.length, contentDigest: hash(JSON.stringify(content)), served, browser: context.browser()?.version(), pageErrors}
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
} finally { await select('B'); await save() }
