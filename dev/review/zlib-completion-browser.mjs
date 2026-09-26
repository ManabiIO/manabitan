/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {deflateSync, gzipSync, inflateSync as nativeInflate} from 'node:zlib'
import {chromium, expect} from '@playwright/test'
import {ManifestUtil} from '../manifest-util.js'
import {makeMdictFixture} from '../../test/util/mdict-binary-fixture.js'

const base = '2d79cd1dec164caa3075884133d9d12204a4f48a'
const candidate = 'c74d604d328f491a4924a0dbd375acfcac603edc'
const modulePath = 'ext/js/dictionary/mdx/vendor/pako.js'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sources = Object.fromEntries([['A', base], ['B', candidate]].map(([arm, ref]) => [arm, execFileSync('git', ['show', `${ref}:${modulePath}`])]))
const out = resolve('builds/zlib-completion')
await mkdir(out, {recursive: true})
const report = {base, candidate, node: process.version, hashes: {A: hash(sources.A), B: hash(sources.B)}, arms: {}, status: 'running'}
const save = () => writeFile(join(out, 'browser.json'), JSON.stringify(report, null, 2))
function adler(bytes) {
    let a = 1
    let b = 0
    for (const byte of bytes) { a = (a + byte) % 65521; b = (b + a) % 65521 }
    return ((b << 16) | a) >>> 0
}
function truncateKeyInfo(bytes, cut) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const h = v.getUint32(0) + 8
    const start = h + 44
    const length = Number(v.getBigUint64(h + 24))
    assert.throws(() => nativeInflate(bytes.subarray(start + 8, start + length - cut)))
    const result = new Uint8Array(Buffer.concat([bytes.subarray(0, start + length - cut), bytes.subarray(start + length)]))
    const w = new DataView(result.buffer)
    w.setBigUint64(h + 24, BigInt(length - cut))
    w.setUint32(h + 40, adler(result.subarray(h, h + 40)))
    return result
}
const title = 'Zlib completion recovery'
const fixture = makeMdictFixture([{key: 'first', value: '<p>first 日本語</p>'}, {key: 'last', value: '<p>last 日本語</p>'}], {title, compression: 'zlib', version: '2.0', keysPerBlock: 10, recordBlockSize: 4096}).bytes
const damaged = truncateKeyInfo(fixture, 4)
const cases = []
for (const [codec, compress] of [['zlib', deflateSync], ['gzip', gzipSync]]) {
    for (const size of [0, 1, 20, 16384, 16385]) {
        const plain = new Uint8Array(size).fill(97)
        const packed = new Uint8Array(compress(plain))
        cases.push({codec, size, kind: 'valid', bytes: [...packed]})
        for (const cut of [1, 2, 3, 4]) { cases.push({codec, size, kind: 'truncated', cut, bytes: [...packed.subarray(0, -cut)]}) }
        cases.push({codec, size, kind: 'trailing', bytes: [...packed, 0]})
    }
}
report.fixtureHashes = {valid: hash(fixture), truncated: hash(damaged)}
const manifest = new ManifestUtil().getManifest('chrome-playwright')
await writeFile('ext/manifest.json', ManifestUtil.createManifestString(manifest).replace('$YOMITAN_VERSION', '0.0.0.0'))
const id = [...hash(Buffer.from(manifest.key, 'base64')).slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
const url = `chrome-extension://${id}`
const launch = (profile) => chromium.launchPersistentContext(profile, {channel: 'chromium', headless: true, args: [`--disable-extensions-except=${resolve('ext')}`, `--load-extension=${resolve('ext')}`]})
async function api(page, action, params = {}) {
    return page.evaluate((message) => new Promise((yes, no) => chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError ?? response?.error
        if (error) { no(new Error(error.message ?? 'Runtime error')) } else { yes(response?.result) }
    })), {action, params})
}
async function setup(context) {
    const page = await context.newPage()
    await page.goto(`${url}/settings.html`)
    await expect(page.locator('html')).toHaveAttribute('data-loaded', 'true', {timeout: 30000})
    for (const other of context.pages()) { if (other !== page && other.url().endsWith('/welcome.html')) { await other.close() } }
    await page.bringToFront()
    await page.locator('.settings-item[data-modal-action="show,dictionaries"]').click()
    return page
}
async function importFile(page, bytes, sequence) {
    await page.locator('#dictionary-import-button').click()
    await page.evaluate(() => { globalThis.__manabitanImportCompletionSignalEnabled = true })
    await page.locator('#dictionary-import-file-input').setInputFiles({name: 'completion.mdx', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes)})
    await page.waitForFunction((n) => globalThis.__manabitanLastImportCompletion?.sequence === n, sequence, {timeout: 60000})
    return page.evaluate(() => ({completion: globalThis.__manabitanLastImportCompletion, debug: globalThis.__manabitanLastImportDebug}))
}
async function verifyInstalled(page) {
    const info = await api(page, 'getDictionaryInfo')
    assert.deepEqual(info.map((x) => x.title), [title])
    const counts = (await api(page, 'getDictionaryCounts', {dictionaryNames: [title], getTotal: false})).counts[0]
    assert.equal(counts.terms, 2)
    const readback = []
    for (const text of ['first', 'last']) {
        const found = await api(page, 'termsFind', {text, details: {matchType: 'exact', deinflect: false, primaryReading: ''}, optionsContext: {depth: 0, url: page.url()}})
        assert.ok(JSON.stringify(found).includes(`${text} 日本語`))
        readback.push(found)
    }
    return {info, counts, readback}
}
try {
    for (const arm of ['A', 'B']) {
        await writeFile(modulePath, sources[arm])
        const profile = await mkdtemp(join(tmpdir(), 'mdict-zlib-'))
        let context = await launch(profile)
        const state = report.arms[arm] = {browser: context.browser()?.version(), cases: [], pageErrors: []}
        try {
            const page = await setup(context)
            page.on('pageerror', (error) => state.pageErrors.push(String(error)))
            const servedHash = await page.evaluate(async () => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await (await fetch('/js/dictionary/mdx/vendor/pako.js')).arrayBuffer()))].map((v) => v.toString(16).padStart(2, '0')).join(''))
            assert.equal(servedHash, report.hashes[arm])
            state.servedHash = servedHash
            state.cases = await page.evaluate(async (inputs) => {
                const {inflateSync} = await import('/js/dictionary/mdx/vendor/pako.js')
                return inputs.map(({bytes, ...details}) => {
                    try {
                        const decoded = inflateSync(Uint8Array.from(bytes), details.size)
                        return {...details, accepted: true, exact: decoded.length === details.size && decoded.every((x) => x === 97)}
                    } catch (error) { return {...details, accepted: false, error: String(error)} }
                })
            }, cases)
            for (const result of state.cases) {
                const accepted = result.kind === 'valid' || (arm === 'A' && result.kind === 'truncated')
                assert.equal(result.accepted, accepted, JSON.stringify(result))
                if (accepted) { assert.equal(result.exact, true) }
            }
            state.malformedImport = await importFile(page, damaged, 1)
            if (arm === 'A') {
                assert.equal(state.malformedImport.completion.errorCount, 0)
                state.incorrectInstallation = await verifyInstalled(page)
            } else {
                assert.equal(state.malformedImport.completion.errorCount, 1)
                assert.deepEqual(await api(page, 'getDictionaryInfo'), [])
                state.recoveryImport = await importFile(page, fixture, 2)
                assert.equal(state.recoveryImport.completion.errorCount, 0)
                assert.equal(state.recoveryImport.debug.usesFallbackStorage, false)
                assert.equal(state.recoveryImport.debug.openStorageDiagnostics.mode, 'opfs-sahpool')
                state.recovery = await verifyInstalled(page)
                await context.close()
                context = await launch(profile)
                state.reopened = await verifyInstalled(await setup(context))
                assert.deepEqual(state.reopened.counts, state.recovery.counts)
            }
            assert.deepEqual(state.pageErrors, [])
            await save()
        } finally { await context.close() }
    }
    report.status = 'success'
} catch (error) {
    report.status = 'failure'
    report.error = {message: String(error), stack: error.stack}
    throw error
} finally { await writeFile(modulePath, sources.B); await save() }
