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
const candidate = '406d396e6c8635eb8c841bbaad1b9b51b63c3647'
const modulePaths = [
    'ext/js/dictionary/mdx/vendor/js-mdict/mdict.js',
    'ext/js/dictionary/mdx/vendor/js-mdict/mdx.js',
]
const workload = process.argv[2] ?? 'large'
const rows = {large: 50000, medium: 10000, small: 64}[workload]
assert.ok(rows)
const preflight = process.env.PREFLIGHT === '1'
const reverse = process.env.REVERSE_ORDER === '1'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sources = {}
for (const [arm, ref] of Object.entries({A: base, B: candidate})) {
    sources[arm] = {}
    for (const path of modulePaths) {
        sources[arm][path] = execFileSync('git', ['show', `${ref}:${path}`], {maxBuffer: 4 * 1024 * 1024})
    }
}
const title = `Borrowed record complete ${workload}`
const body = workload === 'small' ? 128 : 512
const entries = Array.from({length: rows}, (_, i) => ({
    key: `term-${String(i).padStart(6, '0')}`,
    value: `<div>definition ${i} 日本語 ${'x'.repeat(body)}</div>`,
}))
const fixture = makeMdictFixture(entries, {
    title,
    compression: 'zlib',
    keysPerBlock: 128,
    recordBlockSize: 8 * 1024 * 1024,
}).bytes
const out = resolve('builds/borrowed-records-completion')
await mkdir(out, {recursive: true})
const manifest = new ManifestUtil().getManifest('chrome-playwright')
await writeFile('ext/manifest.json', ManifestUtil.createManifestString(manifest).replace('$YOMITAN_VERSION', '0.0.0.0'))
const extensionId = [...hash(Buffer.from(manifest.key, 'base64')).slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
const baseUrl = `chrome-extension://${extensionId}`
const moduleHashes = Object.fromEntries(Object.entries(sources).map(([arm, files]) => [
    arm,
    Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, hash(bytes)])),
]))
const report = {
    base, candidate, workload, rows, reverse, preflight, node: process.version,
    moduleHashes, fixtureHash: hash(fixture), fixtureBytes: fixture.length,
    focusHash: hash(await readFile('ext/js/dom/document-focus-controller.js')),
    observations: [], status: 'running',
}
const save = () => writeFile(resolve(out, `${workload}${preflight ? '-preflight' : ''}.json`), JSON.stringify(report, null, 2))
async function writeArm(arm) {
    for (const path of modulePaths) { await writeFile(path, sources[arm][path]) }
}
async function api(page, action, params = {}) {
    return page.evaluate((message) => new Promise((yes, no) => chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError ?? response?.error
        if (error) { no(new Error(error.message ?? 'Runtime error')) } else { yes(response?.result) }
    })), {action, params})
}
async function observe(plan) {
    await writeArm(plan.arm)
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
            name: 'borrowed-records.mdx', mimeType: 'application/octet-stream', buffer: Buffer.from(fixture),
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
        const ids = [...new Set([0, 1, rows - 1, ...Array.from({length: 16}, (_, i) => Math.floor(i * rows / 16))])]
        const digestParts = []
        for (const i of ids) {
            const found = await api(page, 'termsFind', {
                text: entries[i].key,
                details: {matchType: 'exact', deinflect: false, primaryReading: ''},
                optionsContext: {depth: 0, url: page.url()},
            })
            const text = JSON.stringify(found)
            assert.ok(text.includes(`definition ${i} 日本語`), `missing definition ${i}`)
            digestParts.push(hash(text))
        }
        const hashes = await page.evaluate(async (paths) => {
            const digest = async (path) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await (await fetch('/' + path.replace(/^ext\//, ''))).arrayBuffer()))]
                .map((x) => x.toString(16).padStart(2, '0')).join('')
            return Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await digest(path)])))
        }, modulePaths)
        for (const path of modulePaths) { assert.equal(hashes[path], report.moduleHashes[plan.arm][path]) }
        assert.deepEqual(pageErrors, [])
        return {...plan, elapsedMs, counts, contentDigest: hash(JSON.stringify(digestParts)), hashes, browser: context.browser()?.version(), pageErrors}
    } finally { await context.close() }
}
const schedule = reverse ? [{kind:'warmup',arm:'B'},{kind:'warmup',arm:'A'}] : [{kind:'warmup',arm:'A'},{kind:'warmup',arm:'B'}]
if (!preflight) {
    schedule.push({kind:'control',pair:0,side:0,arm:'A'},{kind:'control',pair:0,side:1,arm:'A'})
    for (let block=0; block<4; ++block) {
        const order=(block%2===1)!==reverse?'BAAB':'ABBA'
        for (const [slot,arm] of [...order].entries()) schedule.push({kind:'measurement',block,slot,arm})
    }
    schedule.push({kind:'control',pair:1,side:0,arm:'A'},{kind:'control',pair:1,side:1,arm:'A'})
}
report.schedule=schedule
try {
    for (const [index,plan] of schedule.entries()) {
        const result=await observe({...plan,index})
        report.observations.push(result)
        await save()
        console.log(JSON.stringify({workload,index,kind:plan.kind,arm:plan.arm,elapsedMs:result.elapsedMs}))
    }
    report.status='success'
} catch(error) {
    report.status='failure'; report.failure={index:report.observations.length,message:String(error),stack:error.stack}; throw error
} finally { await writeArm('A'); await save() }
