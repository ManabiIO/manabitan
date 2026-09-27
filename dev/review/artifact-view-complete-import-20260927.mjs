/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import JSZip from 'jszip'
import {chromium, expect} from '@playwright/test'
import {ManifestUtil} from '../manifest-util.js'
import {encodeRawTermContentBinary} from '../../ext/js/dictionary/raw-term-content.js'
import {hashTermEntryContentBytesPair} from '../../ext/js/dictionary/term-entry-content-hash.js'

const base = '3df9e379038b60aca21db1d00e522ab20e6fd959'
const candidate = '05f960fceebc66202bc611b8638a52f6d8a8f885'
const runtimePaths = [
    'ext/js/dictionary/dictionary-importer.js',
    'ext/js/dictionary/term-lookup-index-preparation.js',
    'ext/js/dictionary/term-record-opfs-store.js',
]
const workload = process.argv[2] ?? 'segmented'
const rowCount = workload === 'segmented' ? 300000 : (workload === 'control' ? 20000 : 0)
assert.ok(rowCount > 0)
const preflight = process.env.PREFLIGHT === '1'
const reverse = process.env.REVERSE_ORDER === '1'
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sources = {}
for (const [arm, ref] of Object.entries({A: base, B: candidate})) {
    sources[arm] = {}
    for (const path of runtimePaths) {
        sources[arm][path] = execFileSync('git', ['show', `${ref}:${path}`], {maxBuffer: 8 * 1024 * 1024})
    }
}
const moduleHashes = Object.fromEntries(Object.entries(sources).map(([arm, files]) => [
    arm,
    Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, sha(bytes)])),
]))

const encoder = new TextEncoder()
const contentBytes = encodeRawTermContentBinary('', '', '', encoder.encode('["definition"]'), encoder)
const [hash1, hash2] = hashTermEntryContentBytesPair(contentBytes)
const expressionBytes = 11
const stringCount = rowCount
const headerBytes = 8 + 4 + 4 + 4
const stringLengthsBytes = stringCount * 2
const stringsBufferBytes = stringCount * expressionBytes
const indexesStart = headerBytes + stringLengthsBytes + stringsBufferBytes
const indexPaddingBytes = (-indexesStart) & 3
const indexesBytes = rowCount * 4 * 2
const rowBytes = 20 + contentBytes.byteLength
const artifact = new Uint8Array(indexesStart + indexPaddingBytes + indexesBytes + rowCount * rowBytes)
const view = new DataView(artifact.buffer)
artifact.set(encoder.encode('MBTB0005'), 0)
let cursor = 8
view.setUint32(cursor, rowCount, true); cursor += 4
view.setUint32(cursor, stringCount, true); cursor += 4
view.setUint32(cursor, stringsBufferBytes, true); cursor += 4
for (let i = 0; i < stringCount; ++i) { view.setUint16(cursor + i * 2, expressionBytes, true) }
cursor += stringLengthsBytes
for (let i = 0; i < rowCount; ++i) {
    const term = `term-${String(i).padStart(6, '0')}`
    artifact.set(encoder.encode(term), cursor + i * expressionBytes)
}
cursor += stringsBufferBytes
cursor += indexPaddingBytes
for (let i = 0; i < rowCount; ++i) { view.setUint32(cursor + i * 4, i, true) }
cursor += rowCount * 4
for (let i = 0; i < rowCount; ++i) { view.setUint32(cursor + i * 4, i, true) }
cursor += rowCount * 4
for (let i = 0; i < rowCount; ++i) {
    view.setInt32(cursor, i % 101, true); cursor += 4
    view.setInt32(cursor, i + 1, true); cursor += 4
    view.setUint32(cursor, hash1, true); cursor += 4
    view.setUint32(cursor, hash2, true); cursor += 4
    view.setUint32(cursor, contentBytes.byteLength, true); cursor += 4
    artifact.set(contentBytes, cursor); cursor += contentBytes.byteLength
}
assert.equal(cursor, artifact.length)

const title = `Artifact views ${workload}`
const zip = new JSZip()
const date = new Date('2026-01-01T00:00:00Z')
zip.file('index.json', JSON.stringify({title, format: 3, revision: 'artifact-view-20260927', sequenced: true}), {date})
zip.file('term_bank_1.mbtb', artifact, {date, compression: 'STORE'})
const fixture = await zip.generateAsync({type: 'nodebuffer', compression: 'STORE'})
const fixtureHash = sha(fixture)

const out = resolve('builds/artifact-view-completion')
await mkdir(out, {recursive: true})
const manifest = new ManifestUtil().getManifest('chrome-playwright')
await writeFile('ext/manifest.json', ManifestUtil.createManifestString(manifest).replace('$YOMITAN_VERSION', '0.0.0.0'))
const extensionId = [...sha(Buffer.from(manifest.key, 'base64')).slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
const baseUrl = `chrome-extension://${extensionId}`
const report = {
    base,
    candidate,
    workload,
    rowCount,
    reverse,
    preflight,
    node: process.version,
    moduleHashes,
    fixtureHash,
    fixtureBytes: fixture.length,
    artifactBytes: artifact.length,
    observations: [],
    status: 'running',
}
const outputPath = resolve(out, `${workload}${preflight ? '-preflight' : ''}.json`)
const save = () => writeFile(outputPath, JSON.stringify(report, null, 2))

async function writeArm(arm) {
    for (const path of runtimePaths) { await writeFile(path, sources[arm][path]) }
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
                globalThis.__artifactViewStart = performance.now()
            }, {once: true, capture: true})
        })
        await page.locator('#dictionary-import-file-input').setInputFiles({
            name: 'artifact-view.zip',
            mimeType: 'application/zip',
            buffer: fixture,
        })
        await page.waitForFunction(() => globalThis.__manabitanLastImportCompletion?.sequence === 1, null, {timeout: 180000})
        const timing = await page.evaluate(() => ({
            start: globalThis.__artifactViewStart,
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
        assert.equal(counts.terms, rowCount)
        for (const key of ['termMeta', 'kanji', 'kanjiMeta', 'tagMeta', 'media']) { assert.equal(counts[key], 0, key) }

        const ids = [...new Set([0, 1, rowCount - 1, ...Array.from({length: 12}, (_, i) => Math.floor(i * rowCount / 12))])]
        const readback = []
        for (const i of ids) {
            const term = `term-${String(i).padStart(6, '0')}`
            const found = await api(page, 'termsFind', {
                text: term,
                details: {matchType: 'exact', deinflect: false, primaryReading: ''},
                optionsContext: {depth: 0, url: page.url()},
            })
            const json = JSON.stringify(found)
            assert.ok(json.includes(term), `missing term ${term}`)
            assert.ok(json.includes('definition'), `missing definition for ${term}`)
            readback.push(sha(json))
        }
        const hashes = await page.evaluate(async (paths) => {
            const digest = async (path) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await (await fetch('/' + path.replace(/^ext\\//, ''))).arrayBuffer()))]
                .map((x) => x.toString(16).padStart(2, '0')).join('')
            return Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await digest(path)])))
        }, runtimePaths)
        for (const path of runtimePaths) { assert.equal(hashes[path], report.moduleHashes[plan.arm][path], path) }
        assert.deepEqual(pageErrors, [])
        return {
            ...plan,
            elapsedMs,
            counts,
            readbackDigest: sha(JSON.stringify(readback)),
            hashes,
            browser: context.browser()?.version(),
            phaseTimings: timing.debug.phaseTimings ?? null,
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
    for (let pair = 0; pair < 2; ++pair) {
        schedule.push({kind: 'control', pair, side: 0, arm: 'A'}, {kind: 'control', pair, side: 1, arm: 'A'})
    }
    for (let block = 0; block < 4; ++block) {
        const order = (block % 2 === 1) !== reverse ? 'BAAB' : 'ABBA'
        for (const [slot, arm] of [...order].entries()) { schedule.push({kind: 'measurement', block, slot, arm}) }
    }
    for (let pair = 2; pair < 4; ++pair) {
        schedule.push({kind: 'control', pair, side: 0, arm: 'A'}, {kind: 'control', pair, side: 1, arm: 'A'})
    }
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
    await writeArm('A')
    await save()
}
