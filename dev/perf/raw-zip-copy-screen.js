#!/usr/bin/env node
/*
 * Copyright (C) 2026  Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFile, mkdir, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {cpus, loadavg, release} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import {ZipReader, Uint8ArrayReader} from '@zip.js/zip.js'
import {chromium, firefox} from 'playwright'
import {loadDictionaryFixtures} from './dictionary-fixtures.js'

/** @typedef {{filename: string, offset: number, rawFilename: number[], compressionMethod: number, compressedSize: number, uncompressedSize: number, signature: number, payloadOffset: number, sha256: string}} Bank */
/** @typedef {Omit<Bank, 'rawFilename'> & {rawFilename: Uint8Array}} BrowserBank */
/** @typedef {{archive: Uint8Array<ArrayBuffer>, banks: BrowserBank[], groups: number[][]}} BrowserState */
/** @typedef {{arm: string, input: string, method: string, warmup: boolean, block: number, order: string, kind: string, wallMs: number, verifiedCopies: number, declinedBatches: number, rangeReadCount: number, rangeReadBytes: number, payloadDigests: string[], hostLoad: number[]}} Observation */
/**
 * @param {import('node:crypto').BinaryLike} bytes
 * @returns {string}
 */
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const root = fileURLToPath(new URL('../../', import.meta.url))
const {values} = parseArgs({options: {
    'baseline': {type: 'string'},
    'candidate': {type: 'string', default: root},
    'zip': {type: 'string'},
    'browser': {type: 'string', default: 'chromium'},
    'output': {type: 'string'},
    'prepare-only': {type: 'boolean'},
}})
assert(values.baseline && values.zip && values.output, 'Required: --baseline CHECKOUT --zip JMdict.zip --output RESULT.json')
assert(['chromium', 'firefox'].includes(values.browser), '--browser must be chromium or firefox')
const roots = {baseline: path.resolve(values.baseline), candidate: path.resolve(values.candidate)}
const output = path.resolve(values.output)
const fixture = (await loadDictionaryFixtures()).jmdict
const archive = await readFile(values.zip)
assert.equal(archive.byteLength, fixture.sizeBytes)
assert.equal(hash(archive), fixture.sha256, 'Pinned JMdict archive differs')
const zip = new ZipReader(new Uint8ArrayReader(new Uint8Array(archive)))
/** @type {Bank[]} */
const banks = []
try {
    const entries = (await zip.getEntries()).filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename)).sort((a, b) => a.offset - b.offset)
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
    for (const entry of entries) {
        assert.equal(view.getUint32(entry.offset, true), 0x04034b50)
        const payloadOffset = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true)
        assert(payloadOffset > 0 && payloadOffset + entry.compressedSize <= archive.byteLength)
        banks.push({filename: entry.filename,
            offset: entry.offset,
            rawFilename: [...entry.rawFilename],
            compressionMethod: entry.compressionMethod,
            compressedSize: entry.compressedSize,
            uncompressedSize: entry.uncompressedSize,
            signature: entry.signature,
            payloadOffset,
            sha256: hash(archive.subarray(payloadOffset, payloadOffset + entry.compressedSize))})
    }
} finally { await zip.close() }
assert.equal(banks.length, 53)
assert.equal(banks.reduce((sum, bank) => sum + bank.compressedSize, 0), 15574114)
/** @type {number[][]} */
const groups = []
let group = [],
    compressed = 0,
    uncompressed = 0
for (let i = 0; i < banks.length; ++i) {
    const bank = banks[i]
    if (group.length > 0 && (compressed + bank.compressedSize > 4 * 1024 * 1024 || uncompressed + bank.uncompressedSize > 4 * 1024 * 1024)) {
        groups.push(group)
        group = []
        compressed = 0; uncompressed = 0
    }
    group.push(i)
    compressed += bank.compressedSize; uncompressed += bank.uncompressedSize
}
if (group.length > 0) { groups.push(group) }
const modulePath = 'ext/js/dictionary/term-bank-source-pipeline.js'
const sources = await Promise.all(Object.entries(roots).map(async ([arm, checkout]) => {
    assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {cwd: checkout, encoding: 'utf8'}), '', `Dirty checkout: ${checkout}`)
    return {arm, commit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: checkout, encoding: 'utf8'}).trim(), moduleSha256: hash(await readFile(path.join(checkout, modulePath)))}
}))
assert.equal(hash(await readFile(path.join(roots.baseline, 'package-lock.json'))), hash(await readFile(path.join(roots.candidate, 'package-lock.json'))))
const schedule = [['AA', 'ABBA'], ['AB', 'BAAB'], ['AB', 'ABBA'], ['AA', 'BAAB'], ['AB', 'ABBA'], ['AB', 'BAAB']]
/** @type {Observation[]} */
const observations = []
/** @type {Record<string, string>} */
const servedSources = {}
const report = {schemaVersion: 1,
    startedAt: new Date().toISOString(),
    fixture,
    banks,
    groups,
    sources,
    servedSources,
    observations,
    boundary: 'Direct RawZipPayloadReader API calls over all 53 compressed JMdict term banks; not automatic importer dispatch. Four complete reads per observation; fresh reader each time; all outputs retained until verification (unlike production streaming). Blob is memory-backed and includes initial Blob.arrayBuffer inside timing. readBatch falls back to read for banks beyond its unchanged 4 MiB budget. Input creation, module loading, byte/digest/ownership checks and transfer probes are outside timing. Component only, no inflate, parser, storage or full import.',
    schedule,
    warmupsPerArmPerMode: 2,
    repetitions: 4,
    plannedObservations: 120,
    completed: false,
    node: process.version,
    nodeV8: process.versions.v8,
    cpu: cpus()[0].model,
    os: release(),
    fixtureLockSha256: hash(await readFile(path.join(root, 'test/perf/dictionaries.lock.json'))),
    driverSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    browser: values.browser,
    playwrightManifestSha256: hash(await readFile(path.join(root, 'node_modules/playwright-core/browsers.json'))),
    browserVersion: '',
    browserExecutableSha256: '',
    userAgent: '',
    error: ''}
await mkdir(path.dirname(output), {recursive: true})
/** @returns {Promise<void>} */
const save = async () => { await writeFile(output, `${JSON.stringify(report, null, 2)}\n`) }
if (values['prepare-only']) {
    await save()
    process.exit(0)
}
const server = createServer((request, response) => {
    void (async () => {
        const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
        if (pathname === '/') {
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><title>Raw ZIP component screen</title>')
            return
        }
        if (pathname === '/fixture') {
            response.end(archive)
            return
        }
        const match = /^\/(baseline|candidate|control)\/(ext\/js\/.+\.js)$/.exec(pathname)
        if (match === null) {
            response.writeHead(404).end()
            return
        }
        const checkout = match[1] === 'candidate' ? roots.candidate : roots.baseline
        const filename = path.resolve(checkout, match[2])
        assert(filename.startsWith(path.join(checkout, 'ext/js') + path.sep))
        const bytes = await readFile(filename)
        const digest = hash(bytes)
        assert(!servedSources[pathname] || servedSources[pathname] === digest, 'Served source changed during run')
        servedSources[pathname] = digest
        response.setHeader('Content-Type', 'text/javascript'); response.end(bytes)
    })().catch((error) => {
        report.error = String(error)
        response.writeHead(500).end()
    })
})
await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(void 0))
})
const address = server.address()
assert(address !== null && typeof address !== 'string')
const browserType = values.browser === 'firefox' ? firefox : chromium
const executablePath = browserType.executablePath()
/** @type {import('playwright').Browser|undefined} */
let browser
try {
    report.browserExecutableSha256 = hash(await readFile(executablePath))
    browser = await browserType.launch({headless: true, executablePath})
    report.browserVersion = browser.version()
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${address.port}/`)
    report.userAgent = await page.evaluate(async ({entries, batches}) => {
        const bytes = new Uint8Array(await (await fetch('/fixture')).arrayBuffer())
        Reflect.set(globalThis, 'rawZipScreen', {archive: bytes, banks: entries.map((bank) => ({...bank, rawFilename: new Uint8Array(bank.rawFilename)})), groups: batches})
        return navigator.userAgent
    }, {entries: banks, batches: groups})
    /**
     * @param {string} arm
     * @param {string} input
     * @param {string} method
     * @returns {Promise<Pick<Observation, 'wallMs'|'verifiedCopies'|'declinedBatches'|'rangeReadCount'|'rangeReadBytes'|'payloadDigests'>>}
     */
    const measure = async (arm, input, method) => await page.evaluate(async ({arm: variant, input: inputKind, method: operation, sourcePath}) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- The preceding page setup installs this typed fixture before any observation.
        const state = /** @type {BrowserState} */ (/** @type {unknown} */ (Reflect.get(globalThis, 'rawZipScreen')))
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, no-unsanitized/method -- The host selects only actual source roots through the fixed localhost routes.
        const module = /** @type {typeof import('../../ext/js/dictionary/term-bank-source-pipeline.js')} */ (await import(`/${variant}/${sourcePath}`))
        const source = inputKind === 'blob' ? new Blob([state.archive]) : state.archive.buffer
        const signal = new AbortController().signal
        const readers = [],
            outputs = [],
            batchResults = []
        let declinedBatches = 0
        // eslint-disable-next-line no-restricted-syntax -- This browser component records its explicit monotonic timing boundary.
        const started = performance.now()
        for (let repeat = 0; repeat < 4; ++repeat) {
            const reader = new module.RawZipPayloadReader(source)
            const payloads = []
            if (operation === 'read') {
                for (const bank of state.banks) { payloads.push({filename: bank.filename, bytes: await reader.read(bank, signal)}) }
            } else {
                for (const indexes of state.groups) {
                    const batch = await reader.readBatch(indexes.map((index) => state.banks[index]), signal)
                    if (batch === null) {
                        ++declinedBatches
                        for (const index of indexes) {
                            const bank = state.banks[index]
                            payloads.push({filename: bank.filename, bytes: await reader.read(bank, signal)})
                        }
                    } else { payloads.push(...batch.sources); batchResults.push({batch, indexes}) }
                }
            }
            readers.push(reader); outputs.push(payloads)
        }
        // eslint-disable-next-line no-restricted-syntax -- End timing before byte, metadata and ownership verification.
        const wallMs = performance.now() - started
        const owned = new Set(),
            payloadDigests = []
        let rangeReadCount = 0,
            rangeReadBytes = 0
        for (const {batch, indexes} of batchResults) {
            rangeReadCount += batch.rangeReadCount; rangeReadBytes += batch.rangeReadBytes
            if (batch.sources.length !== indexes.length) { throw new Error('Batch source count differs') }
            for (let i = 0; i < indexes.length; ++i) {
                const actual = batch.sources[i],
                    expected = state.banks[indexes[i]]
                if (actual.file !== expected || ['filename', 'compressionMethod', 'compressedSize', 'uncompressedSize', 'signature'].some((key) => Reflect.get(actual, key) !== Reflect.get(expected, key))) { throw new Error('Batch metadata differs') }
            }
        }
        for (let repeat = 0; repeat < outputs.length; ++repeat) {
            const payloads = outputs[repeat]
            const cached = /** @type {Uint8Array} */ (await Reflect.get(readers[repeat], '_archiveBytesPromise'))
            if (payloads.length !== state.banks.length) { throw new Error('Missing payload') }
            for (let i = 0; i < payloads.length; ++i) {
                const {bytes, filename} = payloads[i],
                    bank = state.banks[i]
                if (filename !== bank.filename || bytes.byteLength !== bank.compressedSize || bytes.byteOffset !== 0 ||
                !(bytes.buffer instanceof ArrayBuffer) || bytes.buffer.byteLength !== bank.compressedSize || owned.has(bytes.buffer) || bytes.buffer === cached.buffer) { throw new Error('Payload does not own an exact, independent allocation') }
                owned.add(bytes.buffer)
                for (let j = 0; j < bytes.length; ++j) {
                    if (bytes[j] !== state.archive[bank.payloadOffset + j]) { throw new Error(`Payload bytes differ: ${filename}/${j}`) }
                }
                if (repeat === 0) {
                    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((n) => n.toString(16).padStart(2, '0')).join('')
                    if (digest !== bank.sha256) { throw new Error(`Payload digest differs: ${filename}`) }
                    payloadDigests.push(digest)
                }
                const first = cached[bank.payloadOffset]
                try {
                    cached[bank.payloadOffset] ^= 0xff
                    if (bytes[0] !== first) { throw new Error('Payload aliases source') }
                } finally { cached[bank.payloadOffset] = first }
                const moved = structuredClone(bytes, {transfer: [bytes.buffer]})
                if (bytes.byteLength !== 0 || moved.byteLength !== bank.compressedSize || cached.byteLength !== state.archive.byteLength) { throw new Error('Transfer detached source or another payload') }
            }
        }
        return {wallMs, verifiedCopies: owned.size, declinedBatches, rangeReadCount, rangeReadBytes, payloadDigests}
    }, {arm, input, method, sourcePath: modulePath})
    for (const input of ['array-buffer', 'blob']) {
        for (const method of ['read', 'readBatch']) {
            for (const arm of ['baseline', 'candidate', 'control']) {
                for (let warmup = 0; warmup < 2; ++warmup) {
                    observations.push({arm, input, method, warmup: true, block: warmup, order: '', kind: 'warmup', hostLoad: loadavg(), ...await measure(arm, input, method)})
                }
            }
            for (let block = 0; block < schedule.length; ++block) {
                const [kind, order] = schedule[block]
                for (const label of order) {
                    const arm = label === 'A' ? 'baseline' : (kind === 'AA' ? 'control' : 'candidate')
                    observations.push({arm, input, method, warmup: false, block, order, kind, hostLoad: loadavg(), ...await measure(arm, input, method)})
                }
                await save()
            }
        }
    }
    /**
     * @param {string} prefix
     * @returns {Record<string, string>}
     */
    const prefixSources = (prefix) => Object.fromEntries(Object.entries(servedSources).filter(([url]) => url.startsWith(`/${prefix}/`)).map(([url, digest]) => [url.slice(prefix.length + 2), digest]))
    const baselineSources = prefixSources('baseline'),
        candidateSources = prefixSources('candidate')
    assert.deepEqual(prefixSources('control'), baselineSources)
    assert.deepEqual(Object.keys(candidateSources).sort(), Object.keys(baselineSources).sort())
    for (const [url, digest] of Object.entries(servedSources)) {
        const [, arm, ...relative] = url.split('/')
        assert.equal(hash(await readFile(path.join(arm === 'candidate' ? roots.candidate : roots.baseline, ...relative))), digest, 'Source changed after loading')
    }
    for (const source of sources) {
        const checkout = source.arm === 'candidate' ? roots.candidate : roots.baseline
        assert.equal(servedSources[`/${source.arm}/${modulePath}`], source.moduleSha256)
        assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {cwd: checkout, encoding: 'utf8'}).trim(), source.commit)
        assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {cwd: checkout, encoding: 'utf8'}), '')
    }
    assert(Object.keys(baselineSources).every((filename) => filename === modulePath || baselineSources[filename] === candidateSources[filename]))
    assert.equal(observations.length, report.plannedObservations)
    assert(observations.every(({wallMs, verifiedCopies, payloadDigests}) => Number.isFinite(wallMs) && wallMs > 0 && verifiedCopies === 212 && payloadDigests.length === 53))
    for (const observation of observations) {
        const reference = observations.find(({input, method}) => input === observation.input && method === observation.method)
        assert(reference)
        for (const key of ['declinedBatches', 'rangeReadCount', 'rangeReadBytes']) { assert.equal(Reflect.get(observation, key), Reflect.get(reference, key)) }
    }
    assert.equal(report.error, '')
    report.completed = true
} catch (error) { report.error = String(error); throw error } finally {
    try { await browser?.close() } finally {
        await new Promise((resolve) => { server.close(() => resolve(void 0)) })
        await save()
    }
}
