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

import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'
import {getDictionaryWasmSourceIdentity, loadDictionaryWasm} from '../dictionary-wasm.js'
import {parseJson} from '../../ext/js/core/json.js'
import {safePerformance} from '../../ext/js/core/safe-performance.js'
import {getHostEnvironment} from './host-environment.js'

/** @typedef {import('../../ext/js/dictionary/term-bank-wasm-parser.js').TermBankColumnChunk} Chunk */
/** @typedef {NonNullable<ReturnType<typeof import('../../ext/js/dictionary/term-bank-wasm-parser.js').consumeLastTermBankWasmParseProfile>>} Profile */
/** @typedef {{elapsedMs: number, cpuMs: number, cpuUserMs: number, cpuSystemMs: number, rows: number, profile: Profile, digest: string|null}} Pass */
/** @typedef {{pair: number, arm: string, sourceRoot: string, exitCode: number|null, signal: string|null, error: string|null, stdout: string, stderr: string, result: Awaited<ReturnType<typeof measure>>|null}} Observation */

const root = fileURLToPath(new URL('../../', import.meta.url))
const runner = fileURLToPath(import.meta.url)
const lanes = ['runs', 'unique', 'shared-prefix', 'escaped-runs']
const rowCount = 20000
const bankRows = 10000
const warmupCount = 2
const measuredPassCount = 3
const sourceFiles = [
    'package-lock.json',
    'dev/data/dictionary-wasm/manifest.json',
    'ext/js/dictionary/term-bank-wasm-parser.js',
    'ext/js/dictionary/term-bank-experiments.js',
    'ext/js/dictionary/term-record-preinterned-plan.js',
    'ext/js/dictionary/term-lookup-index.js',
    'ext/js/dictionary/term-lookup-index-preparation.js',
    'ext/js/dictionary/term-lookup-scratch.js',
]
const parseOptions = {
    singleChunk: true,
    emitTermByteLists: false,
    computeContentHashes: true,
    emitContentSlab: true,
    emitTokenBinaryContent: true,
    mediaHintFastScan: true,
    validateGlossaryTypes: true,
    prepareLookupIndexes: false,
    experimentalFusedSingleBank: true,
    experimentalNativeEscapedKeys: true,
}

/**
 * @param {import('node:crypto').BinaryLike} bytes
 * @returns {string}
 */
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }

/**
 * All lanes have identical row counts, scores, sequences and glossary distribution.
 * They isolate consecutive key hits, early misses, late misses and escaped hits.
 * @param {string} lane
 * @returns {Uint8Array[]}
 * @throws {Error} If the lane is unknown.
 */
function fixture(lane) {
    const encoder = new TextEncoder()
    const sources = []
    for (let start = 0; start < rowCount; start += bankRows) {
        const rows = []
        for (let index = start; index < start + bankRows; ++index) {
            const id = index.toString(16).padStart(6, '0')
            const run = Math.floor(index / 8).toString(16).padStart(6, '0')
            let expression
            let reading
            switch (lane) {
                case 'runs':
                    expression = '漢字' + run
                    reading = 'かな' + run
                    break
                case 'unique':
                    expression = (Math.imul(index, 0x9e3779b1) >>> 0).toString(16).padStart(8, '0') + '漢字'
                    reading = (Math.imul(index, 0x85ebca77) >>> 0).toString(16).padStart(8, '0') + 'かな'
                    break
                case 'shared-prefix':
                    // Keep combined unique key bytes below the production
                    // fused arena budget while forcing late token mismatches.
                    expression = '共通接頭辞' + id
                    reading = 'おなじせっとうじ' + id
                    break
                case 'escaped-runs':
                    expression = '漢\\字' + run
                    reading = 'か\\な' + run
                    break
                default: throw new Error('Unknown fixture lane')
            }
            rows.push([expression, reading, '', '', index % 17 - 8, ['sense ' + (index % 257)], index + 1, ''])
        }
        sources.push(encoder.encode(JSON.stringify(rows)))
    }
    return sources
}

/**
 * @param {string} sourceRoot
 * @returns {Promise<{nativeSource: ReturnType<typeof getDictionaryWasmSourceIdentity>, hashes: Record<string, string>, gitHead: string, gitStatus: string}>}
 * @throws {Error} If source provenance cannot be recorded.
 */
async function identify(sourceRoot) {
    /** @type {Record<string, string>} */
    const hashes = {}
    for (const file of sourceFiles) { hashes[file] = sha256(await readFile(path.join(sourceRoot, file))) }
    hashes['ext/lib/term-bank-parser.wasm'] = sha256(await readFile(path.join(sourceRoot, 'ext/lib/term-bank-parser.wasm')))
    hashes.runner = sha256(await readFile(runner))
    const head = spawnSync('git', ['rev-parse', 'HEAD'], {cwd: sourceRoot, encoding: 'utf8'})
    const status = spawnSync('git', ['status', '--porcelain=1', '--untracked-files=no'], {cwd: sourceRoot, encoding: 'utf8'})
    if (head.status !== 0 || status.status !== 0) { throw new Error('Cannot identify source checkout') }
    return {nativeSource: getDictionaryWasmSourceIdentity(sourceRoot), hashes, gitHead: head.stdout.trim(), gitStatus: status.stdout}
}

/**
 * Hash borrowed views inside the parser callback, before the next call can reuse them.
 * The separate oracle includes every interned key, row column, canonical content and lookup byte.
 * @param {import('node:crypto').Hash} digest
 * @param {Chunk} chunk
 * @param {typeof import('../../ext/js/dictionary/term-lookup-index.js').encodePersistedTermLookupIndexFromPreinternedPlan} encodeLookup
 * @throws {Error} If the expected complete columns are missing.
 */
function digestChunk(digest, chunk, encodeLookup) {
    const plan = chunk.termRecordPreinternedPlan
    const {contentMetaList, contentBytesBuffer, contentBytesBaseOffset, contentUniqueIndexList} = chunk
    if (!(plan.stringOffsets instanceof Uint32Array) || !(plan.stringHashes instanceof Uint32Array) ||
    !(contentMetaList instanceof Uint32Array) || !(contentBytesBuffer instanceof Uint8Array) ||
    typeof contentBytesBaseOffset !== 'number' || !(contentUniqueIndexList instanceof Uint32Array) || chunk.mediaRows.length > 0) {
        throw new Error('Missing complete key/content columns or unexpected media rows')
    }
    const dedup = /** @type {unknown} */ (chunk.contentDedupPlan)
    if (typeof dedup !== 'object' || dedup === null || !('uniqueCount' in dedup) || !('sourceRowCount' in dedup) ||
    !('uniqueRowIndexes' in dedup) || !('uniqueSignatures' in dedup) || typeof dedup.uniqueCount !== 'number' ||
    !Number.isSafeInteger(dedup.uniqueCount) || dedup.uniqueCount <= 0 || dedup.uniqueCount > chunk.rowCount ||
    dedup.sourceRowCount !== chunk.rowCount || !(dedup.uniqueRowIndexes instanceof Uint32Array) ||
    dedup.uniqueRowIndexes.length !== dedup.uniqueCount || !(dedup.uniqueSignatures instanceof Uint32Array) ||
    dedup.uniqueSignatures.length !== dedup.uniqueCount * 3 || contentUniqueIndexList.length !== chunk.rowCount ||
    contentMetaList.length !== chunk.rowCount * 4) {
        throw new Error('Missing or malformed complete content dedup metadata')
    }
    digest.update(JSON.stringify({rowCount: chunk.rowCount, uniqueCount: dedup.uniqueCount, sourceRowCount: dedup.sourceRowCount}))
    for (const view of [plan.stringsBuffer,
        plan.stringLengths,
        plan.stringOffsets,
        plan.stringHashes,
        plan.expressionIndexes,
        plan.readingIndexes,
        chunk.readingEqualsExpressionList,
        chunk.scoreList,
        chunk.sequenceList,
        contentUniqueIndexList,
        dedup.uniqueRowIndexes,
        dedup.uniqueSignatures]) {
        digest.update(String(view.byteLength) + ':')
        digest.update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
    }
    for (let row = 0; row < chunk.rowCount; ++row) {
        const offset = contentBytesBaseOffset + contentMetaList[row * 4]
        const length = contentMetaList[row * 4 + 1]
        digest.update(String(length) + ':')
        digest.update(contentBytesBuffer.subarray(offset, offset + length))
        const hashes = contentMetaList.subarray(row * 4 + 2, row * 4 + 4)
        digest.update(new Uint8Array(hashes.buffer, hashes.byteOffset, hashes.byteLength))
    }
    digest.update(encodeLookup(plan, chunk.readingEqualsExpressionList, chunk.sequenceList, chunk.rowCount))
}

/**
 * Compilation, fixture generation, warmups and the full oracle are excluded from measured passes.
 * This is a parser component control, not a browser import benchmark.
 * @param {string} lane
 * @param {string} sourceRoot
 * @returns {Promise<{ok: boolean, lane: string, sourceRoot: string, phase: string, fixtureSha256: string[], sourceIdentity: Awaited<ReturnType<typeof identify>>|null, warmups: Pass[], passes: Pass[], oracle: Pass|null, hostBefore: Record<string, unknown>, hostAfter: Record<string, unknown>|null, memoryAfter: ReturnType<typeof process.memoryUsage>|null, maxRssKiB: number|null, error: string|null}>}
 */
async function measure(lane, sourceRoot) {
    /** @type {Awaited<ReturnType<typeof measure>>} */
    const report = {ok: false,
        lane,
        sourceRoot,
        phase: 'identity',
        fixtureSha256: [],
        sourceIdentity: null,
        warmups: [],
        passes: [],
        oracle: null,
        hostBefore: getHostEnvironment(),
        hostAfter: null,
        memoryAfter: null,
        maxRssKiB: null,
        error: null}
    try {
        report.sourceIdentity = await identify(sourceRoot)
        const validatedWasm = loadDictionaryWasm(sourceRoot).get('term-bank-parser.wasm')
        if (!validatedWasm || sha256(validatedWasm) !== report.sourceIdentity.hashes['ext/lib/term-bank-parser.wasm']) {
            throw new Error('Built parser WASM differs from validated source manifest')
        }
        // Explicit caller-selected worktree, never a dictionary-controlled path.
        // eslint-disable-next-line no-unsanitized/method, @typescript-eslint/no-unsafe-assignment
        const parser = /** @type {typeof import('../../ext/js/dictionary/term-bank-wasm-parser.js')} */ (await import(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/term-bank-wasm-parser.js')).href))
        // eslint-disable-next-line no-unsanitized/method, @typescript-eslint/no-unsafe-assignment
        const lookup = /** @type {typeof import('../../ext/js/dictionary/term-lookup-index.js')} */ (await import(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/term-lookup-index.js')).href))
        parser.setTermBankWasmModule(await WebAssembly.compile(validatedWasm))
        const sources = fixture(lane)
        report.fixtureSha256 = sources.map(sha256)
        /**
         * @param {boolean} verify
         * @returns {Promise<Pass>}
         * @throws {Error} If row count or the fused parser contract differs.
         */
        const execute = async (verify) => {
            let rows = 0
            const digest = createHash('sha256')
            const cpuBefore = process.cpuUsage()
            const before = safePerformance.now()
            await parser.parseTermBankWithWasmColumnChunks(sources, 3, (chunk) => {
                rows += chunk.rowCount
                if (verify) { digestChunk(digest, chunk, lookup.encodePersistedTermLookupIndexFromPreinternedPlan) }
            }, 2048, parseOptions)
            const elapsedMs = safePerformance.now() - before
            const cpu = process.cpuUsage(cpuBefore)
            const cpuUserMs = cpu.user / 1000
            const cpuSystemMs = cpu.system / 1000
            const profile = parser.consumeLastTermBankWasmParseProfile()
            if (rows !== rowCount || profile?.fusedParseAttempts !== 1 || profile.fusedParseFallbacks !== 0) {
                throw new Error('Unexpected row count or fused parser fallback: ' + JSON.stringify({rows, profile}))
            }
            return {elapsedMs, cpuMs: cpuUserMs + cpuSystemMs, cpuUserMs, cpuSystemMs, rows, profile, digest: verify ? digest.digest('hex') : null}
        }
        report.phase = 'warmup'
        for (let index = 0; index < warmupCount; ++index) { report.warmups.push(await execute(false)) }
        globalThis.gc?.()
        report.phase = 'measure'
        for (let index = 0; index < measuredPassCount; ++index) { report.passes.push(await execute(false)) }
        report.phase = 'oracle'
        report.oracle = await execute(true)
        report.phase = 'source-recheck'
        if (JSON.stringify(await identify(sourceRoot)) !== JSON.stringify(report.sourceIdentity)) {
            throw new Error('Source or WASM changed during observation')
        }
        report.ok = true
        report.phase = 'complete'
    } catch (error) { report.error = error instanceof Error ? error.stack ?? error.message : String(error) }
    report.hostAfter = getHostEnvironment()
    report.memoryAfter = process.memoryUsage()
    report.maxRssKiB = process.resourceUsage().maxRSS
    return report
}

/**
 * @param {number[]} values
 * @returns {number}
 */
function median(values) {
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

const {values, positionals} = parseArgs({allowPositionals: true,
    options: {
        'child': {type: 'boolean', default: false},
        'pairs': {type: 'string', default: '8'},
        'source-root': {type: 'string', default: root},
        'baseline-root': {type: 'string'},
        'initial-order': {type: 'string', default: 'AB'},
        'out': {type: 'string'},
    }})
const lane = positionals[0]
if (positionals.length !== 1 || !lanes.includes(lane)) { throw new Error('Provide runs, unique, shared-prefix or escaped-runs') }
if (values.child) {
    const result = await measure(lane, path.resolve(values['source-root']))
    process.stdout.write(JSON.stringify(result) + '\n')
    if (!result.ok) { process.exitCode = 1 }
} else {
    const pairs = Number(values.pairs)
    if (!Number.isSafeInteger(pairs) || pairs < 2 || !values['baseline-root'] || !['AB', 'BA'].includes(values['initial-order'])) {
        throw new Error('Require --baseline-root, --pairs >= 2 and --initial-order AB or BA')
    }
    const sourceRoot = path.resolve(values['source-root'])
    const baselineRoot = path.resolve(values['baseline-root'])
    const output = path.resolve(values.out ?? path.join(root, 'builds/perf/20261119/term-key-' + lane + '.json'))
    const reverseOrder = values['initial-order'] === 'AB' ? 'BA' : 'AB'
    const order = Array.from({length: pairs}, (_, pair) => (pair % 2 === 0 ? values['initial-order'] : reverseOrder))
    /** @type {Observation[]} */
    const observations = []
    /** @type {string[]} */
    const failures = []
    const report = {schemaVersion: 1,
        startedAt: new Date().toISOString(),
        completedAt: /** @type {string|null} */ (null),
        plan: {lane,
            rowCount,
            bankRows,
            warmupCount,
            measuredPassCount,
            pairs,
            order,
            baselineRoot,
            sourceRoot,
            parseOptions,
            fixtureSha256: fixture(lane).map(sha256),
            runnerSha256: sha256(await readFile(runner)),
            scope: 'Node parser component; oracle and lookup construction excluded; no browser import claim'},
        observations,
        failures,
        summary: /** @type {{pairedMedianPercent: number, equalWorkPercent: number, cpuPairedMedianPercent: number, cpuEqualWorkPercent: number}|null} */ (null)}
    await mkdir(path.dirname(output), {recursive: true})
    /** @returns {Promise<void>} */
    const save = async () => {
        await writeFile(output + '.tmp', JSON.stringify(report, null, 2) + '\n')
        await rename(output + '.tmp', output)
    }
    await save()
    for (let pair = 0; pair < pairs; ++pair) {
        for (const arm of order[pair]) {
            const selectedRoot = arm === 'A' ? baselineRoot : sourceRoot
            const child = spawnSync(
                process.execPath,
                ['--expose-gc', runner, lane, '--child', '--source-root', selectedRoot],
                {encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024},
            )
            /** @type {Awaited<ReturnType<typeof measure>>|null} */
            let result = null
            try { result = /** @type {Awaited<ReturnType<typeof measure>>} */ (parseJson(child.stdout)) } catch { /* Preserve unparseable output below. */ }
            observations.push({pair,
                arm,
                sourceRoot: selectedRoot,
                exitCode: child.status,
                signal: child.signal,
                error: child.error?.message ?? null,
                stdout: child.stdout,
                stderr: child.stderr,
                result})
            if (child.status !== 0 || !result?.ok) { failures.push('Pair ' + pair + ' arm ' + arm + ' failed') }
            await save()
        }
    }
    /** @type {number[]} */
    const ratios = []
    /** @type {number[]} */
    const cpuRatios = []
    let baselineTotal = 0
    let candidateTotal = 0
    let baselineCpuTotal = 0
    let candidateCpuTotal = 0
    /** @type {Record<string, string>} */
    const identities = {}
    for (const observation of observations) {
        const result = observation.result
        if (!result?.ok) { continue }
        const identity = JSON.stringify(result.sourceIdentity)
        if (identities[observation.arm] && identities[observation.arm] !== identity) { failures.push('Source changed between observations: ' + observation.arm) }
        identities[observation.arm] = identity
        if (JSON.stringify(result.fixtureSha256) !== JSON.stringify(report.plan.fixtureSha256)) { failures.push('Fixture identity differs') }
    }
    for (let pair = 0; pair < pairs; ++pair) {
        const baseline = observations.find((item) => item.pair === pair && item.arm === 'A')?.result
        const candidate = observations.find((item) => item.pair === pair && item.arm === 'B')?.result
        if (!baseline?.ok || !candidate?.ok) { continue }
        for (const file of sourceFiles) {
            if (file === 'dev/data/dictionary-wasm/manifest.json') { continue }
            if (baseline.sourceIdentity?.hashes[file] !== candidate.sourceIdentity?.hashes[file]) {
                failures.push('Comparison changed JavaScript or dependency identity: ' + file)
            }
        }
        if (!baseline.oracle?.digest || baseline.oracle.digest !== candidate.oracle?.digest) { failures.push('Full output parity differs at pair ' + pair) }
        const a = baseline.passes.reduce((sum, pass) => sum + pass.elapsedMs, 0)
        const b = candidate.passes.reduce((sum, pass) => sum + pass.elapsedMs, 0)
        const aCpu = baseline.passes.reduce((sum, pass) => sum + pass.cpuMs, 0)
        const bCpu = candidate.passes.reduce((sum, pass) => sum + pass.cpuMs, 0)
        baselineTotal += a
        candidateTotal += b
        baselineCpuTotal += aCpu
        candidateCpuTotal += bCpu
        ratios.push(b / a - 1)
        cpuRatios.push(bCpu / aCpu - 1)
    }
    if (failures.length === 0) {
        report.summary = {
            pairedMedianPercent: 100 * median(ratios),
            equalWorkPercent: 100 * (candidateTotal / baselineTotal - 1),
            cpuPairedMedianPercent: 100 * median(cpuRatios),
            cpuEqualWorkPercent: 100 * (candidateCpuTotal / baselineCpuTotal - 1),
        }
    }
    report.completedAt = new Date().toISOString()
    await save()
    process.stdout.write(JSON.stringify({output, failures, summary: report.summary}) + '\n')
    if (failures.length > 0) { process.exitCode = 1 }
}
