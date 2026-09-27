/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {chromium, expect} from '@playwright/test'
import {ManifestUtil} from '../manifest-util.js'
import {makeFixturePng, makeMdictFixture} from '../../test/util/mdict-binary-fixture.js'

const refs = {
    A: '60695b51226f6b86978bfd5ea3f11c53fcf55f11',
    B: '02b144615e2e5f1af25fe9202a9c61d858b078a8',
    C: '97c443695cef6900af95b33292b42b5196ddd009',
}
const comparison = process.argv[2] ?? 'lazy'
const pair = comparison === 'lazy' ? ['A', 'B'] : comparison === 'css' ? ['B', 'C'] : null
assert.ok(pair)
const reverse = process.env.REVERSE_ORDER === '1'
const preflight = process.env.PREFLIGHT === '1'
const modulePath = 'ext/js/dictionary/mdx/mdx-converter.js'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sources = Object.fromEntries(Object.entries(refs).map(([arm, ref]) => [
    arm,
    execFileSync('git', ['show', `${ref}:${modulePath}`], {maxBuffer: 4 * 1024 * 1024}),
]))
const resourceCount = 50000
const referencedCount = 256
const png = makeFixturePng([12, 34, 56, 255])
const resourcePath = (i) => `assets/nested/group-${String(Math.floor(i / 1000)).padStart(3, '0')}/resource-${String(i).padStart(5, '0')}.png`
const mddEntries = Array.from({length: resourceCount}, (_, i) => ({
    key: '\\' + resourcePath(i).replaceAll('/', '\\'),
    value: png,
}))
if (comparison === 'css') {
    // Keep a small CSS population so suffix classification is exercised across
    // the same 50k-resource index without making persistence dominate timing.
    for (let i = 0; i < 200; ++i) {
        const index = resourceCount - 1 - i
        mddEntries[index] = {
            key: `\\styles\\nested\\theme-${String(i).padStart(4, '0')}.CsS`,
            value: new TextEncoder().encode('.word { color: red; }'),
        }
    }
}
const mdxEntries = Array.from({length: referencedCount}, (_, i) => ({
    key: `term-${String(i).padStart(4, '0')}`,
    value: `<div>definition ${i} 日本語 <img src="${resourcePath(i)}"></div>`,
}))
const title = `MDD index complete ${comparison}`
const mdx = makeMdictFixture(mdxEntries, {
    title,
    compression: 'zlib',
    keysPerBlock: 64,
    recordBlockSize: 65536,
}).bytes
const mdd = makeMdictFixture(mddEntries, {
    mdd: true,
    compression: 'zlib',
    keysPerBlock: 256,
    recordBlockSize: 262144,
}).bytes

const out = resolve('builds/mdd-index-completion')
await mkdir(out, {recursive: true})
const manifest = new ManifestUtil().getManifest('chrome-playwright')
await writeFile('ext/manifest.json', ManifestUtil.createManifestString(manifest).replace('$YOMITAN_VERSION', '0.0.0.0'))
const extensionId = [...hash(Buffer.from(manifest.key, 'base64')).slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
const baseUrl = `chrome-extension://${extensionId}`
const report = {
    refs,
    pair,
    comparison,
    reverse,
    preflight,
    node: process.version,
    moduleHashes: Object.fromEntries(Object.entries(sources).map(([arm, bytes]) => [arm, hash(bytes)])),
    fixtureHashes: {mdx: hash(mdx), mdd: hash(mdd)},
    fixtureBytes: {mdx: mdx.length, mdd: mdd.length},
    observations: [],
    status: 'running',
}
const save = () => writeFile(resolve(out, `${comparison}${preflight ? '-preflight' : ''}.json`), JSON.stringify(report, null, 2))

async function api(page, action, params = {}) {
    return page.evaluate((message) => new Promise((yes, no) => chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError ?? response?.error
        if (error) { no(new Error(error.message ?? 'Runtime error')) } else { yes(response?.result) }
    })), {action, params})
}
async function observe(plan) {
    await writeFile(modulePath, sources[plan.arm])
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
        await page.locator('#dictionary-import-file-input').setInputFiles([
            {name: 'Book.mdx', mimeType: 'application/octet-stream', buffer: Buffer.from(mdx)},
            {name: 'Book.mdd', mimeType: 'application/octet-stream', buffer: Buffer.from(mdd)},
        ])
        await page.waitForFunction(() => globalThis.__manabitanLastImportCompletion?.sequence === 1, null, {timeout: 180000})
        const timing = await page.evaluate(() => ({
            start: globalThis.__reviewImportStart,
            completion: globalThis.__manabitanLastImportCompletion,
            debug: globalThis.__manabitanLastImportDebug,
        }))
        assert.equal(timing.completion.errorCount, 0)
        assert.deepEqual(timing.completion.importedTitles, [title])
        assert.equal(timing.debug.usesFallbackStorage, false)
        assert.equal(timing.debug.openStorageDiagnostics?.mode, 'opfs-sahpool')
        const elapsedMs = timing.completion.completedAtMonotonicMs - timing.start
        assert.ok(Number.isFinite(elapsedMs) && elapsedMs > 0)
        const counts = (await api(page, 'getDictionaryCounts', {dictionaryNames: [title], getTotal: false})).counts[0]
        assert.equal(counts.terms, referencedCount)
        assert.equal(counts.media, referencedCount)
        const ids = [0, 1, 63, 127, 191, 255]
        const digest = []
        for (const i of ids) {
            const found = await api(page, 'termsFind', {
                text: mdxEntries[i].key,
                details: {matchType: 'exact', deinflect: false, primaryReading: ''},
                optionsContext: {depth: 0, url: page.url()},
            })
            const json = JSON.stringify(found)
            assert.ok(json.includes(`definition ${i} 日本語`))
            digest.push(hash(json))
        }
        const converterHash = await page.evaluate(async () => [...new Uint8Array(await crypto.subtle.digest(
            'SHA-256',
            await (await fetch('/js/dictionary/mdx/mdx-converter.js')).arrayBuffer(),
        ))].map((x) => x.toString(16).padStart(2, '0')).join(''))
        assert.equal(converterHash, report.moduleHashes[plan.arm])
        assert.deepEqual(pageErrors, [])
        return {
            ...plan,
            elapsedMs,
            counts,
            digest: hash(JSON.stringify(digest)),
            converterHash,
            browser: context.browser()?.version(),
            pageErrors,
        }
    } finally {
        await context.close()
    }
}
const [left, right] = pair
const schedule = reverse ? [{kind:'warmup',arm:right},{kind:'warmup',arm:left}] : [{kind:'warmup',arm:left},{kind:'warmup',arm:right}]
if (!preflight) {
    schedule.push({kind:'control',pair:0,side:0,arm:left},{kind:'control',pair:0,side:1,arm:left})
    for (let block=0; block<4; ++block) {
        const abba = (block % 2 === 0) !== reverse ? [left,right,right,left] : [right,left,left,right]
        for (const [slot,arm] of abba.entries()) { schedule.push({kind:'measurement',block,slot,arm}) }
    }
    schedule.push({kind:'control',pair:1,side:0,arm:left},{kind:'control',pair:1,side:1,arm:left})
}
report.schedule=schedule
try {
    for (const [index, plan] of schedule.entries()) {
        const result=await observe({...plan,index})
        report.observations.push(result)
        await save()
        console.log(JSON.stringify({comparison,index,kind:plan.kind,arm:plan.arm,elapsedMs:result.elapsedMs}))
    }
    report.status='success'
} catch (error) {
    report.status='failure'
    report.failure={index:report.observations.length,message:String(error),stack:error.stack}
    throw error
} finally {
    await writeFile(modulePath,sources[left])
    await save()
}
