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
/* eslint-disable no-underscore-dangle -- Diagnostic preload observes production block reads without changing their result. */

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {lstat, mkdir, readFile, realpath, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {getHostEnvironment} from './host-environment.js'

/** @typedef {{blockOffset: number, blockCompressedLength: number, blockUncompressedLength: number}} BlockReference */
/** @typedef {import('../../ext/js/dictionary/term-content-block-store.js').TermContentBlockStore} BlockStore */
/** @typedef {{key: string, reference: BlockReference, bytes: Uint8Array, sha256: string, compressedSha256: string}} CapturedBlock */
/** @typedef {{label: string, level: number, context: number}} Variant */
/** @typedef {{label: string, level: number, elapsedMs: number, userCpuMs: number, systemCpuMs: number, totalCpuMs: number, minorPageFaults: number, majorPageFaults: number}} Measurement */

const sourceArgumentIndex = process.argv.indexOf('--source')
assert.ok(sourceArgumentIndex >= 0 && process.argv[sourceArgumentIndex + 1], 'Compression diagnostics require a single --source component run')
const sourceRoot = await realpath(path.resolve(process.argv[sourceArgumentIndex + 1]))
const outputOption = process.env.MANABITAN_COMPRESSION_LEVEL_OUTPUT
assert.ok(outputOption, 'MANABITAN_COMPRESSION_LEVEL_OUTPUT must name a new diagnostic report')
const outputPath = path.resolve(outputOption)
const componentOutputIndex = process.argv.indexOf('--output')
assert.ok(componentOutputIndex >= 0 && process.argv[componentOutputIndex + 1], 'The component report must have its own --output path')
assert.notEqual(outputPath, path.resolve(process.argv[componentOutputIndex + 1]), 'Component and diagnostic reports must use different paths')
try {
    await lstat(outputPath)
    throw new Error(`Output already exists: ${outputPath}`)
} catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') { throw error }
}
const rounds = Number(process.env.MANABITAN_COMPRESSION_LEVEL_ROUNDS ?? 12)
assert.ok(Number.isSafeInteger(rounds) && rounds >= 2, 'Compression rounds must be an integer >= 2')
const reverseOrder = process.env.MANABITAN_COMPRESSION_LEVEL_INITIAL_ORDER === 'reverse'
const scriptPath = fileURLToPath(import.meta.url)

/**
 * @param {Uint8Array|string} bytes
 * @returns {string}
 */
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }

/**
 * @param {number[]} values
 * @returns {number}
 */
function median(values) {
    const sorted = [...values].sort((a, b) => a - b)
    const index = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? (sorted[index - 1] + sorted[index]) / 2 : sorted[index]
}

const harnessSha256 = sha256(await readFile(scriptPath))
/** @type {Array<{path: string, bytes: number, sha256: string}>} */
const identities = []
for (const relative of [
    'ext/js/dictionary/zstd-term-content.js',
    'ext/js/dictionary/term-content-block-store.js',
    'ext/js/dictionary/term-content-block-envelope.js',
    'ext/lib/zstd-wasm.js',
    'ext/lib/zstd.wasm',
    'ext/lib/zstd-dicts/jmdict.zdict',
]) {
    const bytes = await readFile(path.join(sourceRoot, relative))
    identities.push({path: relative, bytes: bytes.byteLength, sha256: sha256(bytes)})
}
const blockStoreUrl = pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/term-content-block-store.js')).href
// eslint-disable-next-line no-unsanitized/method -- The explicitly selected local checkout supplies the production block store.
const importedBlockStore = /** @type {unknown} */ (await import(blockStoreUrl))
const {TermContentBlockStore} = /** @type {typeof import('../../ext/js/dictionary/term-content-block-store.js')} */ (importedBlockStore)
const zstdUrl = pathToFileURL(path.join(sourceRoot, 'ext/lib/zstd-wasm.js')).href
// eslint-disable-next-line no-unsanitized/method -- The same explicitly selected checkout supplies its packaged Zstd wrapper.
const importedZstd = /** @type {unknown} */ (await import(zstdUrl))
const zstd = /** @type {typeof import('../../ext/lib/zstd-wasm.js')} */ (importedZstd)
const dictionaryBytes = await readFile(path.join(sourceRoot, 'ext/lib/zstd-dicts/jmdict.zdict'))
const originalLoad = /** @type {BlockStore['_loadBlock']} */ (Reflect.get(TermContentBlockStore.prototype, '_loadBlock'))
/** @type {Map<string, CapturedBlock>} */
const captured = new Map()

/**
 * @this {BlockStore}
 * @param {string} cacheKey
 * @param {BlockReference} reference
 * @param {string|null} compressionDictName
 * @param {{contentOffset: number, contentLength: number, contentDictName: string}} context
 * @returns {Promise<Uint8Array>}
 */
async function captureLoadedBlock(cacheKey, reference, compressionDictName, context) {
    const bytes = await originalLoad.call(this, cacheKey, reference, compressionDictName, context)
    assert.equal(compressionDictName, 'jmdict', 'This diagnostic requires the production JMdict compression dictionary')
    assert.ok(bytes instanceof Uint8Array, 'Production block decoding failed')
    const key = `${compressionDictName}:${reference.blockOffset}:${reference.blockCompressedLength}`
    const previous = captured.get(key)
    if (previous) {
        assert.equal(sha256(bytes), previous.sha256, 'A previously observed content block changed')
    } else {
        const stored = await this._contentStore.readSlice(reference.blockOffset, reference.blockCompressedLength)
        assert.ok(stored instanceof Uint8Array)
        captured.set(key, {key, reference: {...reference}, bytes, sha256: sha256(bytes), compressedSha256: sha256(stored)})
    }
    return bytes
}
TermContentBlockStore.prototype._loadBlock = captureLoadedBlock

/**
 * @param {Variant} variant
 * @param {CapturedBlock[]} blocks
 * @returns {Uint8Array[]}
 */
function compressAll(variant, blocks) {
    return blocks.map(({bytes}) => {
        const output = /** @type {unknown} */ (zstd.compressUsingDictWithPrefix(variant.context, bytes, dictionaryBytes, 12, variant.level, true))
        assert.ok(output instanceof Uint8Array)
        return output
    })
}

/**
 * @param {Variant} variant
 * @param {CapturedBlock[]} blocks
 * @param {string[]} expectedHashes
 * @returns {Measurement}
 */
function measure(variant, blocks, expectedHashes) {
    const resourcesBefore = process.resourceUsage()
    const cpuBefore = process.cpuUsage()
    const start = process.hrtime.bigint()
    const outputs = compressAll(variant, blocks)
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6
    const cpu = process.cpuUsage(cpuBefore)
    const resourcesAfter = process.resourceUsage()
    for (let i = 0; i < outputs.length; ++i) {
        assert.equal(sha256(outputs[i]), expectedHashes[i], `Compressed output changed for ${variant.label}, block ${i}`)
    }
    return {
        label: variant.label,
        level: variant.level,
        elapsedMs,
        userCpuMs: cpu.user / 1000,
        systemCpuMs: cpu.system / 1000,
        totalCpuMs: (cpu.user + cpu.system) / 1000,
        minorPageFaults: resourcesAfter.minorPageFault - resourcesBefore.minorPageFault,
        majorPageFaults: resourcesAfter.majorPageFault - resourcesBefore.majorPageFault,
    }
}

/**
 * Called after the ordinary component run and exhaustive reopened-row proof.
 * Compression measurements use the exact decoded production blocks, including
 * their original boundaries and dictionary-wide content deduplication.
 * @param {Record<string, unknown>} componentReport
 * @returns {Promise<Record<string, unknown>>}
 */
async function runCompressionExperiment(componentReport) {
    assert.ok(Number(componentReport.harnessSemanticsVersion) >= 3, 'Requires component harness semantics version 3 or later')
    assert.ok(componentReport.verification, 'Compression diagnostics require exhaustive reopened-row verification')
    const policy = /** @type {{limitBanks: number}} */ (componentReport.policy)
    const fixture = /** @type {{termRows: number}} */ (componentReport.fixture)
    assert.equal(policy.limitBanks, 0, 'Compression diagnostics require the complete pinned fixture')
    assert.equal(componentReport.rows, fixture.termRows, 'Compression diagnostics require every pinned dictionary row')
    assert.ok(captured.size > 0, 'No compressed content blocks were observed')
    TermContentBlockStore.prototype._loadBlock = originalLoad
    const blocks = [...captured.values()].sort((a, b) => a.reference.blockOffset - b.reference.blockOffset)
    for (const block of blocks) {
        assert.equal(sha256(block.bytes), block.sha256, 'Captured source bytes changed before measurement')
    }
    /** @type {Variant[]} */
    const variants = [
        {label: 'baseline-a', level: -1, context: 0},
        {label: 'level-minus-2', level: -2, context: 0},
        {label: 'baseline-b', level: -1, context: 0},
        {label: 'level-minus-3', level: -3, context: 0},
        {label: 'level-minus-5', level: -5, context: 0},
        {label: 'level-plus-1', level: 1, context: 0},
    ]
    const initial = reverseOrder ? [...variants].reverse() : variants
    let decoder = 0
    /** @type {Record<string, {hashes: string[], compressedBytes: number}>} */
    const expected = {}
    /** @type {Array<{round: number, order: string[], measurements: Measurement[]}>} */
    const samples = []
    try {
        const decoderValue = /** @type {unknown} */ (zstd.createDCtx())
        assert.ok(typeof decoderValue === 'number' && Number.isSafeInteger(decoderValue) && decoderValue > 0, 'Could not allocate a Zstd decompression context')
        decoder = decoderValue
        for (const variant of initial) {
            const context = /** @type {unknown} */ (zstd.createCCtx())
            assert.ok(typeof context === 'number' && Number.isSafeInteger(context) && context > 0, 'Could not allocate a Zstd compression context')
            variant.context = context
            const outputs = compressAll(variant, blocks)
            for (let i = 0; i < outputs.length; ++i) {
                const compressed = outputs[i]
                if (variant.level === -1) {
                    assert.equal(sha256(compressed), blocks[i].compressedSha256, 'Baseline recompression must reproduce the exact stored envelope and frame')
                }
                const decoded = /** @type {unknown} */ (zstd.decompressUsingDict(decoder, compressed.subarray(12), dictionaryBytes, {
                    defaultHeapSize: blocks[i].bytes.byteLength,
                    maxOutputSize: blocks[i].bytes.byteLength,
                }))
                assert.ok(decoded instanceof Uint8Array)
                assert.equal(Buffer.compare(decoded, blocks[i].bytes), 0, `Decoded bytes differ for ${variant.label}, block ${i}`)
            }
            expected[variant.label] = {hashes: outputs.map(sha256), compressedBytes: outputs.reduce((sum, bytes) => sum + bytes.byteLength, 0)}
        }
        // Every variant gets one complete unmeasured pass after decoder parity.
        for (const variant of initial) { measure(variant, blocks, expected[variant.label].hashes) }
        for (let round = 0; round < rounds; ++round) {
            const rotation = round % initial.length
            let order = [...initial.slice(rotation), ...initial.slice(0, rotation)]
            if (Math.floor(round / initial.length) % 2 === 1) { order = order.reverse() }
            const measurements = order.map((variant) => measure(variant, blocks, expected[variant.label].hashes))
            samples.push({round: round + 1, order: order.map(({label}) => label), measurements})
        }
        const baselineBytes = expected['baseline-a'].compressedBytes
        const summaries = variants.map((variant) => {
            const measurements = samples.map(({measurements: values}) => values.find(({label}) => label === variant.label))
            const baselineMeasurements = samples.map(({measurements: values}) => values.find(({label}) => label === 'baseline-a'))
            assert.ok(measurements.every(Boolean) && baselineMeasurements.every(Boolean))
            const values = /** @type {Measurement[]} */ (measurements)
            const baseline = /** @type {Measurement[]} */ (baselineMeasurements)
            return {
                label: variant.label,
                level: variant.level,
                compressedBytes: expected[variant.label].compressedBytes,
                storedSizeChangePercent: (expected[variant.label].compressedBytes - baselineBytes) / baselineBytes * 100,
                medianElapsedMs: median(values.map(({elapsedMs}) => elapsedMs)),
                medianUserCpuMs: median(values.map(({userCpuMs}) => userCpuMs)),
                medianSystemCpuMs: median(values.map(({systemCpuMs}) => systemCpuMs)),
                medianTotalCpuMs: median(values.map(({totalCpuMs}) => totalCpuMs)),
                medianRoundWallImprovementPercent: median(values.map((value, i) => (baseline[i].elapsedMs - value.elapsedMs) / baseline[i].elapsedMs * 100)),
                medianRoundCpuImprovementPercent: median(values.map((value, i) => (baseline[i].totalCpuMs - value.totalCpuMs) / baseline[i].totalCpuMs * 100)),
            }
        })
        const report = {
            schemaVersion: 1,
            kind: 'jmdict-production-block-compression-level-experiment',
            boundary: 'Sequential compression of exact persisted production blocks with the packaged Zstd wrapper, dictionary and 12-byte integrity envelope; input/output copies included; packing, worker scheduling, storage, verification and UI excluded',
            warning: 'Not a whole-import speed comparison. Levels can change stored size and decompression cost. No product default changes. Baseline-b is an identical-level control; small or unstable differences are inconclusive.',
            temperature: 'One complete parity/compression pass plus one unmeasured pass per variant; retained context buffers; natural GC; output hashes outside timer; CPU includes all process threads',
            order: 'Rotating positions with a reversed second cycle; one sample per variant per round',
            rounds,
            reverseOrder,
            sourceRoot,
            completeFixture: true,
            rows: componentReport.rows,
            identities,
            harnessSha256,
            componentHarnessSha256: componentReport.harnessSha256,
            componentSource: componentReport.source,
            fixture: componentReport.fixture,
            policy: componentReport.policy,
            semanticVerification: componentReport.verification,
            runtime: {node: process.version, v8: process.versions.v8, memory: process.memoryUsage()},
            hostEnvironment: getHostEnvironment(),
            blockCount: blocks.length,
            uncompressedBytes: blocks.reduce((sum, {bytes}) => sum + bytes.byteLength, 0),
            baselineStoredBlockBytes: baselineBytes,
            exactBaselineStoredFrameParity: true,
            exactRoundTripParityAllLevels: true,
            blocks: blocks.map(({bytes, ...metadata}) => ({...metadata, uncompressedBytes: bytes.byteLength})),
            summaries,
            samples,
        }
        assert.equal(sha256(await readFile(scriptPath)), harnessSha256, 'Diagnostic source changed during the run')
        for (const identity of identities) {
            assert.equal(sha256(await readFile(path.join(sourceRoot, identity.path))), identity.sha256, `Source changed during the run: ${identity.path}`)
        }
        await mkdir(path.dirname(outputPath), {recursive: true})
        await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx'})
        return {kind: report.kind, output: outputPath, blockCount: blocks.length, exactRoundTripParityAllLevels: true}
    } finally {
        if (decoder > 0) { zstd.freeDCtx(decoder) }
        for (const variant of variants) {
            if (variant.context > 0) { zstd.freeCCtx(variant.context) }
        }
    }
}

// Installed by an explicit --import invocation; never loaded by extension code.
const instrumentationSymbol = Symbol.for('manabitan.perf.instrumentation')
const finalizeSymbol = Symbol.for('manabitan.perf.finalize')
assert.equal(Reflect.get(globalThis, instrumentationSymbol), void 0, 'Run one diagnostic preload at a time')
assert.equal(Reflect.get(globalThis, finalizeSymbol), void 0, 'Run one diagnostic preload at a time')
Reflect.set(globalThis, instrumentationSymbol, {
    kind: 'jmdict-production-block-compression-level-experiment',
    diagnosticOnly: true,
    output: outputPath,
    source: scriptPath,
    sha256: harnessSha256,
})
Reflect.set(globalThis, finalizeSymbol, runCompressionExperiment)

/* eslint-enable no-underscore-dangle */
