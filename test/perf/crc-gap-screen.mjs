/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createReadStream, openAsBlob} from 'node:fs'
import {access, mkdir, readFile, readdir, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {crc32, inflateRawSync} from 'node:zlib'
import {getHostEnvironment} from '../../dev/perf/host-environment.js'

// This is an experiment harness, not a complete browser-import benchmark.
// Each A/B/C observation gets a fresh Node process and production WASM instance.
const harnessPath = fileURLToPath(import.meta.url)
const orders = ['ABC', 'BCA', 'CAB', 'ACB', 'BAC', 'CBA']
const parserOptions = {
    experimentalNativeEscapedKeys: true,
    singleChunk: true,
    maxPendingChunks: 1,
    emitTermByteLists: false,
    computeContentHashes: true,
    emitContentSlab: true,
    emitTokenBinaryContent: true,
    compactContentMetadata: true,
    mediaHintFastScan: true,
    validateGlossaryTypes: true,
    prepareLookupIndexes: true,
}
const identityFiles = [
    'ext/js/dictionary/wasm/term-bank-parser.c',
    'ext/js/dictionary/wasm/term-bank-inflate.c',
    'dev/data/dictionary-wasm/manifest.json',
    'dev/data/dictionary-wasm/term-bank-parser.wasm',
]
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const json = (value) => JSON.stringify(value, null, 2) + '\n'
const args = process.argv.slice(2)
function option(name) {
    const index = args.indexOf(name)
    return index < 0 ? undefined : args[index + 1]
}
async function fileHash(filename) {
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(filename)) { hash.update(bytes) }
    return hash.digest('hex')
}
async function identity(root) {
    // Include every runtime JS dependency, including generated library bundles.
    const runtimeFiles = execFileSync('git', ['-C', root, 'ls-files', 'ext/js', 'ext/lib'], {encoding: 'utf8'})
        .trim().split('\n')
        .filter((filename) => filename.endsWith('.js'))
    const libraryFiles = (await readdir(path.join(root, 'ext/lib'), {recursive: true}))
        .filter((filename) => filename.endsWith('.js'))
        .map((filename) => `ext/lib/${filename}`)
    const files = [...new Set([...identityFiles, ...runtimeFiles, ...libraryFiles])].sort()
    return {
        root,
        head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
        files: Object.fromEntries(await Promise.all(files.map(async (filename) => [filename, sha256(await readFile(path.join(root, filename)))]))),
    }
}
function hashValue(hash, value) {
    if (ArrayBuffer.isView(value)) {
        hash.update(`${value.constructor.name}:${value.byteLength}:`)
        hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
    } else if (value instanceof Map) {
        hash.update(`Map:${value.size}:`)
        for (const [key, entry] of value) {
            hashValue(hash, key)
            hashValue(hash, entry)
        }
    } else if (Array.isArray(value)) {
        hash.update(`Array:${value.length}:`)
        for (const entry of value) { hashValue(hash, entry) }
    } else if (value !== null && typeof value === 'object') {
        hash.update('Object:')
        for (const key of Object.keys(value).sort()) {
            hashValue(hash, key)
            hashValue(hash, value[key])
        }
    } else { hash.update(`${typeof value}:${String(value)}\0`) }
}
function digest(value) {
    const hash = createHash('sha256')
    hashValue(hash, value)
    return hash.digest('hex')
}
function partition(banks) {
    const totalBytes = banks.reduce((sum, bank) => sum + bank.uncompressedSize, 0)
    const groupCount = Math.min(banks.length, Math.max(9, Math.ceil(totalBytes / (24 * 1024 * 1024))))
    const groups = []
    let start = 0
    let consumedBytes = 0
    for (let index = 0; index < groupCount - 1; ++index) {
        const remainingGroups = groupCount - index
        const targetBytes = (totalBytes - consumedBytes) / remainingGroups
        let end = start + 1
        let bytes = banks[start].uncompressedSize
        const maxEnd = banks.length - (remainingGroups - 1)
        while (end < maxEnd) {
            const nextBytes = bytes + banks[end].uncompressedSize
            if (Math.abs(nextBytes - targetBytes) > Math.abs(bytes - targetBytes)) { break }
            bytes = nextBytes
            ++end
        }
        groups.push(banks.slice(start, end))
        start = end
        consumedBytes += bytes
    }
    groups.push(banks.slice(start))
    return {groups, totalBytes}
}
async function runObservation(configPath) {
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    assert.equal(await fileHash(harnessPath), config.harnessSha256)
    assert.deepEqual(await identity(config.root), config.identity)
    assert.equal(await fileHash(config.samplePath), config.sampleSha256)
    const sample = JSON.parse(await readFile(config.samplePath, 'utf8'))
    const groups = []
    for (const group of sample.groups) {
        const sources = []
        for (const entry of group.banks) {
            const bytes = new Uint8Array(await readFile(path.join(path.dirname(config.samplePath), entry.payloadFile)))
            assert.equal(bytes.length, entry.compressedSize)
            assert.equal(sha256(bytes), entry.compressedSha256)
            const decoded = entry.compressionMethod === 0 ? bytes : inflateRawSync(bytes)
            assert.equal(decoded.length, entry.uncompressedSize)
            assert.equal(crc32(decoded), entry.signature)
            sources.push({...entry, bytes})
        }
        groups.push({...group, sources})
    }
    // The explicit experiment root and every runtime source were verified above.
    // eslint-disable-next-line no-unsanitized/method
    const parser = await import(pathToFileURL(path.join(config.root, 'ext/js/dictionary/term-bank-wasm-parser.js')))
    parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(path.join(config.root, 'dev/data/dictionary-wasm/term-bank-parser.wasm'))))
    const environmentBefore = getHostEnvironment()
    let previousOutput = null
    async function runGroup(group, captureWitnesses) {
        let output
        let witnessBytes
        let witnessStats
        let verifierCalls = 0
        let restoreVerifier
        // Input reading, module compilation, and all output hashing are excluded.
        // Inflation, CRC, native parsing, lookup construction, result ownership,
        // and projected media extraction are included in parserStageMs.
        const start = performance.now()
        const source = await parser.inflateCompressedTermBankSourcesWasm(group.sources, parserOptions, true)
        assert(source.crcSignaturesPtr, 'Sample must use deferred native source CRC')
        if (captureWitnesses) {
            const original = source.wasm.verify_term_bank_source_crcs
            assert.equal(typeof original, 'function')
            source.wasm.verify_term_bank_source_crcs = (...values) => {
                ++verifierCalls
                const result = original(...values)
                assert.equal(result, 0)
                const rows = values[6]
                const witnessesPtr = values[7]
                const statsPtr = values[8]
                assert(witnessesPtr && statsPtr && rows > 0)
                witnessBytes = new Uint8Array(new Uint8Array(source.wasm.memory.buffer, witnessesPtr, rows * 4))
                witnessStats = [...new Uint32Array(source.wasm.memory.buffer, statsPtr, 3)]
                return result
            }
            restoreVerifier = () => { source.wasm.verify_term_bank_source_crcs = original }
        }
        try {
            await parser.parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, (chunk) => {
                assert.equal(source.crcVerified, true)
                assert.equal(output, undefined, 'Expected one production chunk per group')
                output = parser.copyWasmBackedColumnChunk(chunk, false, true, true, source)
            }, 2048, {...parserOptions, preloadedSource: source})
        } finally { restoreVerifier?.() }
        const parserStageMs = performance.now() - start
        assert(output)
        // This is a timing diagnostic, not encoded dictionary output.
        delete output.preparedLookupIndexEncodeMs
        const profile = parser.consumeLastTermBankWasmParseProfile()
        const crcStats = [source.crcScannedBytes, source.crcReusedBytes, source.crcReusedGlossaryCount]
        for (const count of crcStats) { assert(Number.isSafeInteger(count) && count >= 0) }
        const sourceBytes = group.sources.reduce((sum, entry) => sum + entry.uncompressedSize, 0)
        assert.equal(crcStats[0] + crcStats[1], sourceBytes)
        assert.equal(profile.fusedParseFallbacks, 0)
        assert(Number.isFinite(source.crcMs) && source.crcMs >= 0)
        const content = {
            groupIndex: group.index,
            rowCount: output.rowCount,
            sourceBytes,
            outputSha256: digest(output),
            crcStats,
            contentBytes: output.contentBytesLength,
            lookupBytes: [...output.preparedLookupIndexes.values()].reduce((sum, index) => sum + index.bytes.length, 0),
            mediaRows: output.mediaRows.length,
            maxWasmHeapBytes: profile.maxWasmHeapBytes,
        }
        if (captureWitnesses) {
            assert.equal(verifierCalls, 1)
            assert.equal(witnessBytes.length, output.rowCount * 4)
            assert.deepEqual(witnessStats, crcStats)
        }
        if (previousOutput) { assert.equal(digest(previousOutput.output), previousOutput.digest, 'Owned output mutated after native heap reuse') }
        previousOutput = {output, digest: content.outputSha256}
        for (const entry of group.sources) { assert.equal(sha256(entry.bytes), entry.compressedSha256, 'Compressed source mutated') }
        return {content, witnessesSha256: witnessBytes && sha256(witnessBytes), parserStageMs, sourceCrcMs: source.crcMs, sourceInflateMs: source.inflateMs}
    }
    // Complete CRC witness qualification is separate from the measured passes.
    const qualification = []
    for (const group of groups) {
        const value = await runGroup(group, true)
        qualification.push({content: value.content, witnessesSha256: value.witnessesSha256})
    }
    const passes = []
    for (let pass = -config.warmupPasses; pass < config.measuredPasses; ++pass) {
        if (typeof globalThis.gc === 'function') { globalThis.gc() }
        const measurements = []
        for (const [index, group] of groups.entries()) {
            const result = await runGroup(group, false)
            assert.deepEqual(result.content, qualification[index].content)
            measurements.push({groupIndex: group.index, parserStageMs: result.parserStageMs, sourceCrcMs: result.sourceCrcMs, sourceInflateMs: result.sourceInflateMs})
        }
        if (pass >= 0) {
            passes.push({
                index: pass,
                parserStageMs: measurements.reduce((sum, value) => sum + value.parserStageMs, 0),
                sourceCrcMs: measurements.reduce((sum, value) => sum + value.sourceCrcMs, 0),
                sourceInflateMs: measurements.reduce((sum, value) => sum + value.sourceInflateMs, 0),
                groups: measurements,
            })
        }
    }
    assert.deepEqual(await identity(config.root), config.identity)
    assert.equal(await fileHash(harnessPath), config.harnessSha256)
    const mean = (field) => passes.reduce((sum, value) => sum + value[field], 0) / passes.length
    await writeFile(config.outputPath, json({
        complete: true,
        arm: config.arm,
        block: config.block,
        processId: process.pid,
        environmentBefore,
        environmentAfter: getHostEnvironment(),
        identity: config.identity,
        harnessSha256: config.harnessSha256,
        sampleSha256: config.sampleSha256,
        qualification,
        passes,
        parserStageMs: mean('parserStageMs'),
        sourceCrcMs: mean('sourceCrcMs'),
        sourceInflateMs: mean('sourceInflateMs'),
    }))
}
function summarize(observations) {
    const median = (values) => {
        const sorted = [...values].sort((a, b) => a - b)
        return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2
    }
    return Object.fromEntries(['parserStageMs', 'sourceCrcMs', 'sourceInflateMs'].map((field) => {
        const byArm = Object.fromEntries(['A', 'B', 'C'].map((arm) => [arm, observations.filter((value) => value.arm === arm).map((value) => value[field])]))
        return [field, {
            medians: Object.fromEntries(Object.entries(byArm).map(([arm, values]) => [arm, median(values)])),
            pairedCandidateVsAPercent: median(byArm.B.map((value, index) => (value / byArm.A[index] - 1) * 100)),
            pairedCandidateVsCPercent: median(byArm.B.map((value, index) => (value / byArm.C[index] - 1) * 100)),
            pairedControlVsAPercent: median(byArm.C.map((value, index) => (value / byArm.A[index] - 1) * 100)),
            fasterThanA: byArm.B.filter((value, index) => value < byArm.A[index]).length,
            fasterThanC: byArm.B.filter((value, index) => value < byArm.C[index]).length,
        }]
    }))
}
async function runScreen() {
    for (const name of ['--baseline', '--candidate', '--archive', '--output']) { assert(option(name), `Required: ${name}`) }
    const baseline = path.resolve(option('--baseline'))
    const candidate = path.resolve(option('--candidate'))
    const archivePath = path.resolve(option('--archive'))
    const outputDirectory = path.resolve(option('--output'))
    const smoke = args.includes('--smoke')
    const protocol = {blocks: smoke ? 1 : 12, orders, qualificationPasses: 1, warmupPasses: smoke ? 0 : 2, measuredPasses: smoke ? 1 : 3, freshProcessPerObservation: true, sampleGroups: 5, smoke}
    await mkdir(outputDirectory, {recursive: true})
    await assert.rejects(access(path.join(outputDirectory, 'protocol.json')), 'Use a fresh output directory')
    const harnessBytes = await readFile(harnessPath)
    const harnessSha256 = sha256(harnessBytes)
    const identities = {A: await identity(baseline), B: await identity(candidate)}
    identities.C = identities.A
    const lockBytes = await readFile(path.join(baseline, 'test/perf/dictionaries.lock.json'))
    assert.deepEqual(await readFile(path.join(candidate, 'test/perf/dictionaries.lock.json')), lockBytes)
    const fixture = JSON.parse(lockBytes).dictionaries.vndb
    assert.equal(await fileHash(archivePath), fixture.sha256)
    const archive = await openAsBlob(archivePath)
    assert.equal(archive.size, fixture.sizeBytes)
    // The explicit baseline root and every runtime source were recorded above.
    // eslint-disable-next-line no-unsanitized/method
    const {readDenseZipDirectory} = await import(pathToFileURL(path.join(baseline, 'ext/js/dictionary/dense-zip-directory.js')))
    // eslint-disable-next-line no-unsanitized/method
    const {RawZipPayloadReader} = await import(pathToFileURL(path.join(baseline, 'ext/js/dictionary/term-bank-source-pipeline.js')))
    const entries = await readDenseZipDirectory(archive)
    assert(entries)
    const banks = entries.filter(({filename}) => /^term_bank_\d+\.json$/.test(filename)).sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
    const {groups, totalBytes} = partition(banks)
    assert.equal(groups.length, 170)
    assert.equal(totalBytes, 4267992967)
    const indices = Array.from({length: protocol.sampleGroups}, (_, index) => Math.round(index * (groups.length - 1) / (protocol.sampleGroups - 1)))
    const reader = new RawZipPayloadReader(archive)
    const sample = {partition: {groupCount: groups.length, totalBytes, workerCount: 3, groupsPerWorker: 3, targetGroupBytes: 24 * 1024 * 1024}, groups: []}
    for (const index of indices) {
        const sampledBanks = []
        for (const entry of groups[index]) {
            const bytes = await reader.read(entry, new AbortController().signal, true)
            const payloadFile = `${entry.filename}.deflate`
            await writeFile(path.join(outputDirectory, payloadFile), bytes)
            sampledBanks.push({filename: entry.filename, compressionMethod: entry.compressionMethod, compressedSize: entry.compressedSize, uncompressedSize: entry.uncompressedSize, signature: entry.signature, compressedSha256: sha256(bytes), payloadFile})
        }
        sample.groups.push({index, banks: sampledBanks})
    }
    const samplePath = path.join(outputDirectory, 'sample.json')
    const sampleBytes = Buffer.from(json(sample))
    await writeFile(samplePath, sampleBytes)
    const sampleSha256 = sha256(sampleBytes)
    await writeFile(path.join(outputDirectory, 'crc-gap-screen.mjs'), harnessBytes)
    for (const [arm, root] of [['A', baseline], ['B', candidate]]) {
        for (const filename of identityFiles) {
            await writeFile(path.join(outputDirectory, `${arm}-${path.basename(filename)}`), await readFile(path.join(root, filename)))
        }
    }
    const report = {
        complete: false,
        startedAtIso: new Date().toISOString(),
        protocol,
        scope: 'Node production parser stage with owned output, sampled production groups; excludes browser worker scheduling, ZIP reads, compression, storage, media unpacking and UI. Native source CRC is reported separately. This is not a complete-import speed claim.',
        excludedDiagnosticFields: ['preparedLookupIndexEncodeMs'],
        fixture: {...fixture, lockSha256: sha256(lockBytes)},
        identities,
        harnessSha256,
        sampleSha256,
        sample,
        environment: getHostEnvironment(),
        observations: [],
    }
    await writeFile(path.join(outputDirectory, 'protocol.json'), json(report))
    let expectedQualification
    for (let block = 0; block < protocol.blocks; ++block) {
        for (const arm of orders[block % orders.length]) {
            const prefix = path.join(outputDirectory, `${String(block).padStart(2, '0')}-${arm}`)
            const config = {arm, block, root: arm === 'B' ? candidate : baseline, identity: identities[arm], samplePath, sampleSha256, harnessSha256, warmupPasses: protocol.warmupPasses, measuredPasses: protocol.measuredPasses, outputPath: `${prefix}.json`}
            await writeFile(`${prefix}-config.json`, json(config))
            try {
                const stdout = execFileSync(process.execPath, ['--expose-gc', harnessPath, '--observation', `${prefix}-config.json`], {encoding: 'utf8', timeout: 300_000, maxBuffer: 4 * 1024 * 1024})
                await writeFile(`${prefix}.log`, stdout)
                const result = JSON.parse(await readFile(config.outputPath, 'utf8'))
                assert.equal(result.complete, true)
                if (expectedQualification) {
                    assert.deepEqual(result.qualification, expectedQualification)
                } else { expectedQualification = result.qualification }
                report.observations.push(result)
                await writeFile(path.join(outputDirectory, 'results.partial.json'), json(report))
            } catch (error) {
                await writeFile(`${prefix}.error.txt`, `${error.stack}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`)
                throw error
            }
        }
        console.log(`CRC production parser screen ${block + 1}/${protocol.blocks}`)
    }
    assert.deepEqual(await identity(baseline), identities.A)
    assert.deepEqual(await identity(candidate), identities.B)
    assert.equal(await fileHash(archivePath), fixture.sha256)
    assert.equal(await fileHash(harnessPath), harnessSha256)
    report.complete = true
    report.endedAtIso = new Date().toISOString()
    report.summary = smoke ? null : summarize(report.observations)
    await writeFile(path.join(outputDirectory, 'results.json'), json(report))
    console.log(json({complete: true, smoke, outputDirectory, sampleGroups: indices, summary: report.summary}))
}

await (option('--observation') ? runObservation(option('--observation')) : runScreen())
