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
const candidate = '3997012b4fd04d0803f2ef39993da371ca00ee45'
const modulePaths = [
    'ext/js/dictionary/mdx/vendor/js-mdict/mdict.js',
    'ext/js/dictionary/mdx/mdx-converter.js',
]
const workload = process.argv[2] ?? 'oversized'
const specs = {
    oversized: {rows: 64, decodedBytes: 9 * 1024 * 1024, samples: 8},
    normal: {rows: 64, decodedBytes: 4 * 1024 * 1024, samples: 8},
    overcap: {rows: 8, decodedBytes: 17 * 1024 * 1024, samples: 2},
}
const spec = specs[workload]
assert.ok(spec)
const preflight = process.env.PREFLIGHT === '1'
const reverse = process.env.REVERSE_ORDER === '1'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const refs = {A: base, B: candidate}
const sources = {}
for (const [arm, ref] of Object.entries(refs)) {
    sources[arm] = {}
    for (const path of modulePaths) {
        sources[arm][path] = execFileSync('git', ['show', `${ref}:${path}`], {maxBuffer: 4 * 1024 * 1024})
    }
}
const title = `Bounded oversized cache ${workload}`
const overhead = 64
const payloadBytes = Math.max(0, Math.floor(spec.decodedBytes / spec.rows) - overhead)
const entries = Array.from({length: spec.rows}, (_, i) => ({
    key: `term-${String(i).padStart(4, '0')}`,
    value: `<div>definition ${i} 日本語 ${'x'.repeat(payloadBytes)}</div>`,
}))
const fixture = makeMdictFixture(entries, {
    title,
    compression: 'zlib',
    keysPerBlock: 64,
    recordBlockSize: 32 * 1024 * 1024,
}).bytes
const out = resolve('builds/bounded-cache-completion')
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
    base,
    candidate,
    workload,
    spec,
    reverse,
    preflight,
    node: process.version,
    moduleHashes,
    fixtureHash: hash(fixture),
    fixtureBytes: fixture.length,
    focusHash: hash(await readFile('ext/js/dom/document-focus-controller.js')),
    observations: [],
    status: 'running',
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
        channel: 'chromium',
        headless: true,
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
            name: 'bounded-cache.mdx',
            mimeType: 'application/octet-stream',
            buffer: Buffer.from(fixture),
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
        assert.equal(counts.terms, spec.rows)
        for (const key of ['termMeta', 'kanji', 'kanjiMeta', 'tagMeta', 'media']) { assert.equal(counts[key], 0, key) }
        const ids = [...new Set(Array.from({length: spec.samples}, (_, i) => Math.floor(i * spec.rows / spec.samples)).concat(spec.rows - 1))]
        const digestParts = []
        for (const i of ids) {
            const found = await api(page, 'termsFind', {
                text: entries[i].key,
                details: {matchType: 'exact', deinflect: false, primaryReading: ''},
                optionsContext: {depth: 0, url: page.url()},
            })
            const text = JSON.stringify(found)
            assert.ok(text.includes(`definition ${i} 日本語`), `missing definition ${i}`)
            assert.ok(text.includes('x'.repeat(128)), `truncated definition ${i}`)
            digestParts.push(hash(text))
        }
        const hashes = await page.evaluate(async (paths) => {
            const digest = async (path) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await (await fetch('/' + path.replace(/^ext\//, ''))).arrayBuffer()))]
                .map((x) => x.toString(16).padStart(2, '0')).join('')
            return Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await digest(path)])))
        }, modulePaths)
        for (const path of modulePaths) { assert.equal(hashes[path], report.moduleHashes[plan.arm][path], path) }
        assert.deepEqual(pageErrors, [])
        return {
            ...plan,
            elapsedMs,
            counts,
            verifiedTerms: ids.length,
            contentDigest: hash(JSON.stringify(digestParts)),
            hashes,
            browser: context.browser()?.version(),
            pageErrors,
        }
    } finally {
        await context.close()
    }
}
const schedule = reverse ?
    [{kind: 'warmup', arm: 'B'}, {kind: 'warmup', arm: 'A'}] :
    [{kind: 'warmup', arm: 'A'}, {kind: 'warmup', arm: 'B'}]
if (!preflight) {
    for (let pair = 0; pair < 1; ++pair) {
        schedule.push({kind: 'control', pair, side: 0, arm: 'A'}, {kind: 'control', pair, side: 1, arm: 'A'})
    }
    for (let block = 0; block < 4; ++block) {
        const order = (block % 2 === 1) !== reverse ? 'BAAB' : 'ABBA'
        for (const [slot, arm] of [...order].entries()) { schedule.push({kind: 'measurement', block, slot, arm}) }
    }
    for (let pair = 1; pair < 2; ++pair) {
        schedule.push({kind: 'control', pair, side: 0, arm: 'A'}, {kind: 'control', pair, side: 1, arm: 'A'})
    }
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
} finally {
    await writeArm('A')
    await save()
}
