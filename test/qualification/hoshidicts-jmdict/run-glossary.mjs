/* SPDX-License-Identifier: GPL-3.0-or-later */

import {createHash} from 'node:crypto'
import {LOOKUP_CAP, validateBrowserGlossaries, validateNativeGlossaries, verifiedGlossaryOracle} from './glossary-validation.mjs'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import {execFile} from 'node:child_process'
import {appendFileSync} from 'node:fs'
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {chromium} from 'playwright'
import {getChromiumLaunchOptions} from '../../e2e/chromium-launch-options.js'

const runProcess = promisify(execFile)
const fixtureRoot = path.dirname(fileURLToPath(import.meta.url))
const evidence = process.env.BENCH_RUN_DIR
const extensionDir = process.env.BENCH_EXTENSION_DIR
const arm = process.env.BENCH_ARM
const position = Number(process.env.BENCH_POSITION)
const runnerSha256 = process.env.BENCH_RUNNER_SHA256
if (!runnerSha256 || !evidence || !(position >= 1 && position <= 6) || !['control','candidate','hoshidicts'].includes(arm)) throw new Error('Set BENCH_RUN_DIR, BENCH_ARM and BENCH_POSITION')
if (arm !== 'hoshidicts' && (!extensionDir || !process.env.BENCH_PACKAGE_SHA256 || !process.env.BENCH_COMMIT)) throw new Error('Set BENCH_EXTENSION_DIR, BENCH_PACKAGE_SHA256 and BENCH_COMMIT for browser runs')
const hoshidictsDriver = process.env.BENCH_HOSHIDICTS_DRIVER
if (!hoshidictsDriver) throw new Error('Set BENCH_HOSHIDICTS_DRIVER')
const scratch = process.env.BENCH_SCRATCH_DIR ?? path.join(evidence, 'scratch')
await mkdir(scratch, {recursive:true})
await mkdir(path.join(evidence,'runs'), {recursive:true})
const specs = {
    jmdict: {title: 'JMdict [2026-11-22]', terms: 528299, query: '日本語', sha: '3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f', archive: process.env.BENCH_ARCHIVE},
    jitendex: {title: 'Jitendex.org [2026-10-03]', terms: 436555, query: '日本語', sha: 'e914c76596220dffc6ee0c069cd05992f03adb2988c12c3cebe817a3ac271356', archive: process.env.BENCH_ARCHIVE},
    vndb: {title: 'VNDB Characters by Bee', terms: 6648310, query: '宇野星華', sha: 'da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792', archive: process.env.BENCH_ARCHIVE},
}
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const hostSnapshot = () => ({loadavg: os.loadavg(), freeMemBytes: os.freemem(), totalMemBytes: os.totalmem(), platform: process.platform, arch: process.arch})
async function recordImportMemoryMarker(event) {
    const markerPath = process.env.MANABITAN_IMPORT_MEMORY_MARKERS
    if (!markerPath) return
    appendFileSync(markerPath, `${JSON.stringify({event, monotonicNs: process.hrtime.bigint().toString()})}\n`)
    if (event === 'end') await new Promise((resolve) => setTimeout(resolve, 200))
}
function send(page, action, params) {
    return page.evaluate(({action, params}) => new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({action, params}, (response) => {
            const error = chrome.runtime.lastError?.message ?? response?.error
            if (error) { reject(new Error(JSON.stringify(error))); return }
            resolve(response?.result ?? response)
        })
    }), {action, params})
}
function pairKey(pair) { return JSON.stringify([pair.expression, pair.reading]) }
function findNumericProperties(value, names, results = []) {
    if (Array.isArray(value)) {
        for (const item of value) findNumericProperties(item, names, results)
    } else if (value !== null && typeof value === 'object') {
        for (const [name, item] of Object.entries(value)) {
            if (names.has(name) && typeof item === 'number' && Number.isFinite(item)) results.push(item)
            findNumericProperties(item, names, results)
        }
    }
    return results
}
function sourcePairs(sourceOracle) {
    return [...new Map(sourceOracle.matchedSourceRows.map(({expression, reading}) => {
        const pair = {expression, reading}
        return [pairKey(pair), pair]
    })).values()].sort((a, b) => pairKey(a).localeCompare(pairKey(b)))
}
function coverage(pairs, expected) {
    const keys = new Set(pairs.map(pairKey))
    return {expected: expected.length, matched: expected.filter((p) => keys.has(pairKey(p))), missing: expected.filter((p) => !keys.has(pairKey(p)))}
}
function nativeGlossaryCoverage(results, glossaryOracle) {
    const actual = new Map()
    for (const result of results) {
        const key = pairKey({expression: result.expression, reading: result.reading})
        if (!actual.has(key)) actual.set(key, [])
        actual.get(key).push(...(result.glossaryRawHashes ?? []))
    }
    const groups = [...glossaryOracle.rowsByKey.entries()].map(([key, rows]) => {
        const expected = rows.map(({glossaryRawSha256}) => glossaryRawSha256).sort()
        const observed = (actual.get(key) ?? []).sort()
        return {headword: JSON.parse(key), expected, observed,
            equal: JSON.stringify(expected) === JSON.stringify(observed)}
    })
    return {equal: groups.length > 0 && groups.every(({equal}) => equal), groups}
}

async function runHoshidicts(dataset, pair, spec, oracle, glossaryOracle) {
    const output = process.env.BENCH_RESOURCE_HOSHI_OUTPUT ?? await mkdtemp(path.join(scratch, `cap-default-${dataset}-${pair}-hoshi-`))
    if (process.env.BENCH_RESOURCE_HOSHI_OUTPUT) await mkdir(output, {recursive: false})
    const before = hostSnapshot()
    try {
        const args = [spec.archive, output, spec.query, spec.title, String(spec.terms), `cap-${dataset}-${pair}`]
        const {stdout, stderr} = await runProcess(hoshidictsDriver, args, {maxBuffer: 8 * 1024 * 1024})
        const result = JSON.parse(stdout)
        const expectedPairs = sourcePairs(oracle)
        const sourceCoverage = coverage(result.headwordPairs, expectedPairs)
        const resultDigestMatchesOracle = validateNativeGlossaries(result.resultSha256, glossaryOracle).equal
        const glossaryValidation = nativeGlossaryCoverage(result.orderedResults, glossaryOracle)
        const errors = []
        if (result.engine !== 'hoshidicts' || result.termCount !== spec.terms || result.query !== spec.query ||
            result.title !== spec.title || result.exactHeadword !== true || result.dictionaryMatched !== true ||
            result.nonemptyGlossary !== true || result.resultCount !== result.orderedResults.length ||
            result.orderedResults.some((item) => !item.hydrated) || sourceCoverage.missing.length > 0) {
            errors.push('Hoshidicts lookup failed exact-pair or hydrated-glossary validation')
        }
        if (result.configuredMaxResults !== LOOKUP_CAP || result.configuredScanLength !== LOOKUP_CAP ||
            result.resultCount >= LOOKUP_CAP) {
            errors.push('Hoshidicts lookup did not verify an unsaturated common result cap and scan length')
        }
        if (!glossaryValidation.equal) errors.push('Hoshidicts per-headword glossary content differs from pinned source rows')
        const eligible = errors.length === 0
        return {
            engine: 'hoshidicts', dataset, pair, position, arm, runnerSha256,
            archive: path.basename(spec.archive), archiveSha256: oracle.archiveSha256,
            query: spec.query, title: spec.title, termCount: result.termCount,
            resultCount: result.resultCount, configuredMaxResults: result.configuredMaxResults,
            configuredScanLength: result.configuredScanLength,
            headwordPairCount: result.headwordPairCount, headwordPairs: result.headwordPairs,
            orderedHeadwordPairs: result.orderedResults.map(({expression, reading}) => ({expression, reading})),
            orderedResults: result.orderedResults, sourcePairCoverage: sourceCoverage,
            exactHeadword: result.exactHeadword, nonemptyGlossary: result.nonemptyGlossary,
            allResultsHydrated: result.orderedResults.every((item) => item.hydrated),
            capSaturated: result.resultCount >= result.configuredMaxResults,
            resultSha256: result.resultSha256, importMs: result.importMs,
            lookupStageMs: result.lookupStageMs, totalMs: result.totalMs,
            hostBefore: before, hostAfter: hostSnapshot(), hoshidictsRunId: result.runId,
            driverStdout: stdout.trim(), driverStderr: stderr,
            glossaryValidation, resultDigestMatchesOracle, validation: {eligible, errors}, status: eligible ? 'passed' : 'failed',
        }
    } finally {
        // The coordinator retires the task-owned scratch directory after qualification.
    }
}

async function inspectPersistedContent(page) {
    const files = await page.evaluate(async () => {
        const files = []
        async function walk(dir, prefix) {
            for await (const [name, entry] of dir.entries()) {
                if (entry.kind === 'directory') { await walk(entry, prefix + name + '/'); continue }
                const file = await entry.getFile()
                files.push({path: prefix + name, bytes: file.size})
            }
        }
        await walk(await navigator.storage.getDirectory(), '')
        return files
    })
    const contentFile = files.find(({path}) => path === 'manabitan-term-content.bin') ?? null
    return {fileCount: files.length, totalBytes: files.reduce((sum, item) => sum + item.bytes, 0),
        contentFileBytes: contentFile?.bytes ?? null, fileSample: files.slice(0, 32)}
}

async function probeLookup(page, query, expectedDigest, title, glossaryOracle) {
    const probe = await page.evaluate(async (query) => {
        const started = performance.now()
        const response = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({action:'termsFind', params:{text:query, details:{}, optionsContext:{current:true}}}, (result) => {
                const error = chrome.runtime.lastError?.message ?? result?.error
                if (error) { reject(new Error(JSON.stringify(error))); return }
                resolve({received:performance.now(), entries:(result?.result ?? result).dictionaryEntries})
            })
        })
        return {elapsedMs:response.received-started, entries:response.entries}
    }, query)
    const digest = sha256(Buffer.from(JSON.stringify(probe.entries)))
    return {
        ms: probe.elapsedMs,
        digest,
        entries: probe.entries.length,
        equal: digest === expectedDigest,
        ...(digest === expectedDigest ? {} : {
            glossaryValidation: validateBrowserGlossaries(probe.entries, title, glossaryOracle),
            rawEntries: probe.entries,
        }),
    }
}

async function verifyPersistedMedia(page, mediaOracle) {
    const {path: mediaPath, sha256: expectedSha256, bytes: expectedBytes, dictionary} = mediaOracle
    const media = await send(page, 'getMedia', {targets: [{dictionary, path: mediaPath}]})
    if (!Array.isArray(media) || media.length !== 1 || media[0].path !== mediaPath || media[0].dictionary !== dictionary ||
        typeof media[0].content !== 'string') {
        throw new Error('Restarted dictionary did not return the pinned VNDB media target')
    }
    const bytes = Buffer.from(media[0].content, 'base64')
    const actualSha256 = sha256(bytes)
    if (bytes.length !== expectedBytes || actualSha256 !== expectedSha256) {
        throw new Error(`Restarted VNDB media mismatch for ${mediaPath}: ${bytes.length} bytes, ${actualSha256}`)
    }
    return {dictionary, path: mediaPath, bytes: bytes.length, sha256: actualSha256, matchesSourceArchive: true}
}

async function runManabitan(dataset, pair, spec, oracle, glossaryOracle) {
    const runDirectory = path.join(evidence, 'runs', `${dataset}-${pair}-${arm}`)
    await mkdir(runDirectory, {recursive: false})
    const profile = await mkdtemp(path.join(scratch, `cap-default-${dataset}-${pair}-${arm}-`))
    let context
    let record
    const hostBefore = hostSnapshot()
    try {
        context = await chromium.launchPersistentContext(profile, getChromiumLaunchOptions({
            channel: 'chromium', headless: true,
            args: [
                `--disable-extensions-except=${extensionDir}`,
                `--load-extension=${extensionDir}`,
                ],
        }))
        const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', {timeout: 30000})
        const extensionId = new URL(worker.url()).host
        const page = context.pages()[0] ?? await context.newPage()
        await page.goto(`chrome-extension://${extensionId}/settings.html?popup-preview=false`)
        await page.waitForSelector('#dictionary-import-file-input', {state: 'attached', timeout: 30000})
        await page.waitForFunction(() => document.documentElement?.dataset?.loaded === 'true', undefined, {timeout: 30000})
        if (process.env.MANABITAN_IMPORT_MEMORY_MARKERS) {
            await page.exposeFunction('__manabitanRecordImportMemoryMarker', recordImportMemoryMarker)
        }
        const optionsContext = {current: true}
        const modifications = await send(page, 'modifySettings', {
            targets: [{scope: 'profile', optionsContext, action: 'set', path: 'general.maxResults', value: LOOKUP_CAP}],
            source: 'three-way-glossary-benchmark',
        })
        const optionsBeforeImport = await send(page, 'optionsGet', {optionsContext})
        if (modifications?.[0]?.error || optionsBeforeImport.general.maxResults !== LOOKUP_CAP) {
            throw new Error('Could not set the browser profile to the common result cap')
        }
        await page.evaluate(({query, title}) => {
            const input = document.querySelector('#dictionary-import-file-input')
            if (!(input instanceof HTMLInputElement)) throw new Error('Dictionary import input not found')
            let startedAt = null
            input.addEventListener('change', () => {
                startedAt = performance.now()
                if (typeof globalThis.__manabitanRecordImportMemoryMarker === 'function') {
                    void globalThis.__manabitanRecordImportMemoryMarker('start')
                }
            }, {capture: true, once: true})
            globalThis.__manabitanImportCompletionSignalEnabled = true
            globalThis.__capSensitivityProbe = new Promise((resolve, reject) => {
                globalThis.addEventListener('manabitan:dictionary-import-complete', ({detail}) => {
                    const importCompletedAt = detail.completedAtMonotonicMs ?? performance.now()
                    if (startedAt === null || detail.errorCount !== 0 || detail.importRunCurrent !== true ||
                        !detail.importedTitles?.includes(title)) {
                        reject(new Error(`Pinned import did not complete successfully: ${JSON.stringify(detail)}`))
                        return
                    }
                    const lookupDispatchedAt = performance.now()
                    chrome.runtime.sendMessage({action: 'termsFind', params: {
                        text: query, details: {}, optionsContext: {current: true},
                    }}, (response) => {
                        const responseReceivedAt = performance.now()
                        const error = chrome.runtime.lastError?.message ?? response?.error
                        if (error) { reject(new Error(JSON.stringify(error))); return }
                        const result = response?.result ?? response
                        const entries = result?.dictionaryEntries
                        if (!Array.isArray(entries)) {
                            reject(new Error('Malformed termsFind entry list: ' + JSON.stringify(result)))
                            return
                        }
                        const groups = entries.map((entry) => (entry.headwords ?? []).map((headword) => ({
                            expression: String(headword.term ?? ''), reading: String(headword.reading ?? ''),
                        })))
                        const matchingDefinitions = entries.map((entry) => (entry.definitions ?? []).filter((definition) =>
                            definition.dictionary === title && Array.isArray(definition.entries) && definition.entries.length > 0))
                        const allHydrated = matchingDefinitions.every((items) => items.length > 0)
                        const exactHeadword = entries.some((entry) => (entry.headwords ?? []).some((headword) =>
                            headword.term === query || headword.reading === query))
                        const finish = () => resolve({startedAt, importCompletedAt, lookupDispatchedAt, responseReceivedAt,
                            entries, groups, allHydrated, exactHeadword,
                            hydratedDefinitionCount: matchingDefinitions.reduce((sum, items) => sum + items.length, 0)})
                        if (typeof globalThis.__manabitanRecordImportMemoryMarker === 'function') {
                            void globalThis.__manabitanRecordImportMemoryMarker('end').then(finish, reject)
                        } else {
                            finish()
                        }
                    })
                }, {once: true})
            })
        }, {query: spec.query, title: spec.title})
        await page.locator('#dictionary-import-file-input').setInputFiles(spec.archive)
        const result = await page.evaluate(() => Promise.race([
            globalThis.__capSensitivityProbe,
            new Promise((_, reject) => setTimeout(() => reject(new Error('First hydrated termsFind timed out')), 180000)),
        ]))
        if (result.responseReceivedAt < result.startedAt || result.responseReceivedAt < result.importCompletedAt) {
            throw new Error('Non-monotonic Manabitan benchmark clock')
        }
        const compressionWorkerDebugState = process.env.BENCH_EXPECTED_ZSTD_WORKERS ?
            await send(page, 'debugDictionaryStorageState', undefined) : null
        const info = await send(page, 'getDictionaryInfo', undefined)
        const counts = await send(page, 'getDictionaryCounts', {dictionaryNames: info.map(({title}) => title), getTotal: false})
        const dictionaryCounts = counts.counts?.find(({name, title}) => name === spec.title || title === spec.title) ?? counts.counts?.[0] ?? null
        const optionsAfterImport = await send(page, 'optionsGet', {optionsContext})
        const resultLimit = optionsAfterImport.general.maxResults
        const glossaryValidation = validateBrowserGlossaries(result.entries, spec.title, glossaryOracle)
        const errors = []
        if (!info.some(({title}) => title === spec.title) || dictionaryCounts?.terms !== spec.terms) {
            errors.push({reason: 'Imported dictionary/count validation failed', info, counts: counts.counts})
        }
        if (resultLimit !== LOOKUP_CAP || result.entries.length >= LOOKUP_CAP) {
            errors.push('Manabitan lookup did not verify an unsaturated common result cap')
        }
        const flattened = result.groups.flat().filter(({expression}) => expression.length > 0)
        const pairMap = new Map(flattened.map((pair) => [pairKey(pair), pair]))
        const headwordPairs = [...pairMap.values()].sort((a, b) => pairKey(a).localeCompare(pairKey(b)))
        const orderedHeadwordPairs = [...new Map(flattened.map((pair) => [pairKey(pair), pair])).values()]
        const expectedPairs = sourcePairs(oracle)
        const sourceCoverage = coverage(headwordPairs, expectedPairs)
        const entriesJson = JSON.stringify(result.entries)
        record = {
            engine: 'manabitan', dataset, pair, position, arm, runnerSha256,
            archive: path.basename(spec.archive), archiveSha256: oracle.archiveSha256,
            query: spec.query, title: spec.title, termCount: dictionaryCounts?.terms ?? null,
            resultCount: result.entries.length, resultLimit, capSaturated: result.entries.length >= LOOKUP_CAP,
            resultOutputMode: optionsAfterImport.general.resultOutputMode,
            glossaryValidation,
            groups: result.groups, headwordPairCount: headwordPairs.length, headwordPairs, orderedHeadwordPairs,
            sourcePairCoverage: sourceCoverage, exactHeadword: result.exactHeadword,
            allResultsHydrated: result.allHydrated, hydratedDefinitionCount: result.hydratedDefinitionCount,
            resultSha256: sha256(Buffer.from(entriesJson)),
            completionMs: result.importCompletedAt - result.startedAt,
            lookupStageMs: result.responseReceivedAt - result.importCompletedAt,
            totalMs: result.responseReceivedAt - result.startedAt,
            dispatchToResponseMs: result.responseReceivedAt - result.lookupDispatchedAt,
            importCompletedAtMonotonicMs: result.importCompletedAt,
            responseReceivedAtMonotonicMs: result.responseReceivedAt,
            hostBefore: hostBefore, hostAfter: hostSnapshot(),
            chromiumVersion: context.browser()?.version() ?? null, extensionId,
            hardwareConcurrency: await page.evaluate(() => navigator.hardwareConcurrency ?? null),
            timingBoundary: 'settings file-input change through first correct ordinary hydrated termsFind response; callback timestamp taken before validation/hash/count reads',
        }
        if (process.env.MANABITAN_IMPORT_MEMORY_MARKERS) {
            record.storageEstimateAtFirstLookup = await page.evaluate(async () => navigator.storage.estimate())
            record.storageAtFirstLookup = await inspectPersistedContent(page)
        }
        if (process.env.BENCH_CAPTURE_IMPORT_PHASES === '1') {
            record.importDebugSnapshot = await page.evaluate(() => globalThis.__manabitanLastImportDebug ?? null)
            if (!record.importDebugSnapshot || record.importDebugSnapshot.resultTitle !== spec.title ||
                record.importDebugSnapshot.hasResult !== true || record.importDebugSnapshot.errorCount !== 0) {
                errors.push('Importer phase snapshot was missing or belonged to a different dictionary')
            }
        }
        if (process.env.BENCH_EXPECTED_ZSTD_WORKERS) {
            const actualCreatedCount = compressionWorkerDebugState?.offscreenQualificationZstdWorkersCreated ?? null
            const actualReadyCount = compressionWorkerDebugState?.offscreenQualificationZstdWorkersReady ?? null
            record.compressionWorkerAttestation = {
                expected: Number(process.env.BENCH_EXPECTED_ZSTD_WORKERS),
                actualCreatedCount,
                actualReadyCount,
                source: 'debugDictionaryStorageState.offscreen worker response',
            }
            const foundParserWorkerCounts = [...new Set(findNumericProperties(
                record.importDebugSnapshot ?? {},
                new Set(['parserParallelWorkerCount', 'fastPathParserParallelWorkerCount']),
            ))]
            record.parserWorkerCounts = foundParserWorkerCounts
            if (actualCreatedCount !== record.compressionWorkerAttestation.expected ||
                actualReadyCount !== record.compressionWorkerAttestation.expected) {
                errors.push(`Observed ${record.compressionWorkerAttestation.actualCreatedCount} created and ${record.compressionWorkerAttestation.actualReadyCount} ready Zstd compression workers; expected ${record.compressionWorkerAttestation.expected}`)
            }
            if (record.hardwareConcurrency === null || foundParserWorkerCounts.length === 0) {
                errors.push('Missing hardware concurrency or parser worker configuration attestation')
            }
        }
        if (!record.exactHeadword || !record.allResultsHydrated || sourceCoverage.missing.length > 0) {
            errors.push('Manabitan lookup failed exact-pair or hydrated-glossary validation')
        }
        if (!glossaryValidation.equal) errors.push('Manabitan glossary multiset or headword associations differ from the pinned source')
        record.commit = process.env.BENCH_COMMIT
        record.packageSha256 = process.env.BENCH_PACKAGE_SHA256
        if (errors.length === 0) {
            try {
                record.warm = await probeLookup(page, spec.query, record.resultSha256, spec.title, glossaryOracle)
                if (!record.warm.equal) errors.push('Warm lookup differs from the first lookup')
                if (pair === 1) {
                    await context.close()
                    context = null
                    context = await chromium.launchPersistentContext(profile, getChromiumLaunchOptions({
                        channel: 'chromium', headless: true,
                        args: [
                            `--disable-extensions-except=${extensionDir}`,
                            `--load-extension=${extensionDir}`,
                                        ],
                    }))
                    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', {timeout: 30000})
                    const extensionId = new URL(worker.url()).host
                    const restartedPage = context.pages()[0] ?? await context.newPage()
                    await restartedPage.goto(`chrome-extension://${extensionId}/settings.html?popup-preview=false`)
                    await restartedPage.waitForSelector('#dictionary-import-file-input', {state: 'attached', timeout: 30000})
                    await restartedPage.waitForFunction(() => document.documentElement?.dataset?.loaded === 'true', undefined, {timeout: 30000})
                    const restartOptions = await send(restartedPage, 'optionsGet', {optionsContext})
                    if (restartOptions.general.maxResults !== LOOKUP_CAP) errors.push('Browser result cap changed on restart')
                    record.afterRestart = await probeLookup(restartedPage, spec.query, record.resultSha256, spec.title, glossaryOracle)
                    if (!record.afterRestart.equal) errors.push('Restart lookup differs from the first lookup')
                    record.storage = await inspectPersistedContent(restartedPage)
                    if (['jitendex', 'vndb'].includes(dataset) && arm === 'candidate') {
                        const mediaOracleName = dataset === 'jitendex' ? 'jitendex-media-oracle.json' : 'vndb-media-oracle.json'
                        const mediaOracle = JSON.parse(await readFile(path.join(fixtureRoot, 'fixtures', mediaOracleName), 'utf8'))
                        if (mediaOracle.archiveSha256 !== spec.sha || mediaOracle.dictionary !== spec.title ||
                            !Number.isSafeInteger(mediaOracle.bytes) || !/^[0-9a-f]{64}$/.test(mediaOracle.sha256)) {
                            throw new Error('Pinned VNDB media oracle identity does not match the dataset')
                        }
                        record.persistedMedia = await verifyPersistedMedia(restartedPage, mediaOracle)
                    }
                }
            } catch (error) {
                errors.push({reason: 'Warm/restart/storage check did not complete', error: String(error)})
            }
        }
        const eligible = errors.length === 0
        record.validation = {eligible, errors}
        record.status = eligible ? 'passed' : 'failed'
    } finally {
        await context?.close()
        // Retain the owned profile for cleanup and failure diagnosis.
    }
    await writeFile(path.join(runDirectory, 'receipt.json'), `${JSON.stringify(record, null, 2)}\n`, {flag: 'wx'})
    return record
}

const [engine, dataset, pairText, oraclePath] = process.argv.slice(2)
const pair = Number(pairText)
if (!['hoshidicts', 'manabitan'].includes(engine) || !(dataset in specs) || !Number.isInteger(pair) || pair < 1 || pair > 6) {
    throw new Error('usage: run-glossary.mjs hoshidicts|manabitan jmdict|jitendex|vndb 1..6 source-oracle.json')
}
const spec = specs[dataset]
const oracle = JSON.parse(await readFile(oraclePath, 'utf8'))
if (oracle.query !== spec.query || oracle.archiveSha256 !== spec.sha || oracle.termCount !== spec.terms || oracle.dictionaryTitle !== spec.title) {
    throw new Error('Frozen source oracle does not match requested archive, title, query, and count')
}
if ((engine === 'hoshidicts') !== (arm === 'hoshidicts')) throw Error('Engine/arm mismatch')
if (sha256(await readFile(spec.archive)) !== spec.sha) throw Error('Pinned archive mismatch')
const [expectedGlossaries, glossaryAttestations] = await Promise.all([
    readFile(path.join(fixtureRoot, 'expected-glossaries.json'), 'utf8').then(JSON.parse),
    readFile(path.join(fixtureRoot, 'glossary-attestations.json'), 'utf8').then(JSON.parse),
])
const glossaryOracle = verifiedGlossaryOracle(dataset, spec, expectedGlossaries[dataset], glossaryAttestations[dataset])
const result = engine === 'hoshidicts' ?
    await runHoshidicts(dataset, pair, spec, oracle, glossaryOracle) :
    await runManabitan(dataset, pair, spec, oracle, glossaryOracle)
const runDirectory = path.join(evidence, 'runs', `${dataset}-${pair}-${engine}`)
if (engine === 'hoshidicts') {
    await mkdir(runDirectory, {recursive: false})
    await writeFile(path.join(runDirectory, 'receipt.json'), `${JSON.stringify(result, null, 2)}\n`, {flag: 'wx'})
}
console.log(JSON.stringify({engine, dataset, pair, totalMs: result.totalMs, lookupStageMs: result.lookupStageMs,
    resultCount: result.resultCount, headwordPairCount: result.headwordPairCount,
    resultSha256: result.resultSha256, status: result.status, eligible: result.validation.eligible, validationErrors: result.validation.errors}))
if (!result.validation.eligible) {
    throw new Error('Lookup qualification failed. See the saved receipt for details.')
}
