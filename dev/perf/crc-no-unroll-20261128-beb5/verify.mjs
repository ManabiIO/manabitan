/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {appendFileSync, writeFileSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {crc32} from 'node:zlib'
import {sha256, loadIdentity, sourceFor, createParser, verifyGroup} from './common.mjs'

const [inputDirectory, evidenceDirectory] = process.argv.slice(2)
assert.ok(inputDirectory && evidenceDirectory)
const report = {passed: false, scope: 'Untimed deterministic correctness in a process that never runs the measured cohort.',
    vectors: [], conformance: [], groups: []}
let current = {stage: 'identity'}
const journal = path.join(evidenceDirectory, 'verify.observations.jsonl')
writeFileSync(journal, '', {flag: 'wx'})
const save = observation => appendFileSync(journal, JSON.stringify(observation) + '\n')

try {
    const identity = await loadIdentity(inputDirectory, evidenceDirectory)
    const {build, manifest} = identity
    Object.assign(report, {registrationSha256: identity.registrationSha256,
        buildSha256: identity.buildSha256, captureManifestSha256: identity.captureManifestSha256,
        nodeVersion: process.version, v8Version: process.versions.v8, execArgv: process.execArgv,
        verifySha256: sha256(await readFile(new URL(import.meta.url)))})
    assert.equal(process.version, 'v22.22.0')
    const crcInstances = {}
    for (const name of ['baseline', 'candidate']) {
        const bytes = await readFile(path.join(evidenceDirectory, 'modules', name + '-test.wasm'))
        assert.equal(sha256(bytes), build.variants[name].testWasmSha256)
        const module = await WebAssembly.compile(bytes)
        assert.deepEqual(WebAssembly.Module.imports(module), [])
        crcInstances[name] = (await WebAssembly.instantiate(module)).exports
    }

    function randomBytes(length, seed) {
        const bytes = new Uint8Array(length)
        for (let index = 0; index < length; ++index) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
            bytes[index] = seed >>> 24
        }
        return bytes
    }

    function checkVector(bytes, alignment, label) {
        const expected = crc32(bytes) >>> 0
        current = {stage: 'crc-vector', label, length: bytes.length, alignment, expected, actual: {}}
        for (const name of ['baseline', 'candidate']) {
            const wasm = crcInstances[name]
            wasm.wasm_reset_heap()
            const start = wasm.wasm_alloc(bytes.length + alignment + 32)
            assert.ok(start)
            const guard = new Uint8Array(wasm.memory.buffer, start, bytes.length + alignment + 32)
            guard.fill(0xa5)
            guard.set(bytes, 16 + alignment)
            const pointer = start + 16 + alignment
            current.actual[name] = wasm.term_bank_crc32_test(pointer, bytes.length) >>> 0
            assert.equal(current.actual[name], expected, label + '/' + alignment + '/' + name)
            assert.ok(guard.subarray(0, 16 + alignment).every(value => value === 0xa5))
            assert.ok(guard.subarray(16 + alignment + bytes.length).every(value => value === 0xa5))
            assert.equal(sha256(new Uint8Array(wasm.memory.buffer, pointer, bytes.length)), sha256(bytes))
        }
        report.vectors.push(current)
        save(current)
    }

    checkVector(new TextEncoder().encode('123456789'), 0, 'published')
    assert.equal(report.vectors.at(-1).expected, 0xcbf43926)
    checkVector(new Uint8Array(), 0, 'empty')
    for (let length = 0; length <= 256; ++length) {
        checkVector(randomBytes(length, 0x4d595df4 ^ length), 0, 'short')
    }
    for (const length of [63, 64, 65, 127, 128, 129, 65535, 65536, 65537, 131071, 131072, 131073,
        262143, 262144, 262145, 262207, 262208, 262209, 1048576, 1048639]) {
        const bytes = randomBytes(length, 0x9e3779b9 ^ length)
        for (let alignment = 0; alignment < 16; ++alignment) {
            checkVector(bytes, alignment, 'boundary')
        }
    }
    for (let tail = 0; tail < 64; ++tail) {
        const bytes = randomBytes(262144 + tail, 0x25831a59 ^ tail)
        for (const alignment of [0, 1, 7, 15]) {
            checkVector(bytes, alignment, 'all-braid-tails')
        }
    }
    for (const alignment of [0, 15]) {
        checkVector(randomBytes(4 * 1024 * 1024 + 63, 0x71531ada), alignment, 'large')
    }
    assert.equal(report.vectors.length, 837)

    const parsers = {}
    for (const name of ['baseline', 'candidate']) {
        const bytes = await readFile(path.join(evidenceDirectory, 'modules', name + '.wasm'))
        assert.equal(sha256(bytes), build.variants[name].wasmSha256)
        parsers[name] = await createParser(await WebAssembly.compile(bytes), 'verify-' + name)
    }
    const conformanceBytes = await readFile(path.join(inputDirectory, 'conformance.json'))
    const conformance = JSON.parse(conformanceBytes)
    report.conformanceCaptureSha256 = sha256(conformanceBytes)
    assert.equal(conformance.nativeWasmSha256, identity.registration.baselineWasmSha256)
    for (const entry of conformance.cases) {
        const sources = await Promise.all(entry.sources.map(bank => sourceFor(inputDirectory, bank, true)))
        current = {stage: 'production-conformance', name: entry.name, expected: entry.expected, actual: {}}
        for (const name of ['baseline', 'candidate']) {
            let actual
            try {
                const result = await parsers[name].inflateCompressedTermBankSourcesWasm(sources, {experimentalTermBankSpans: true})
                const bytes = new Uint8Array(result.wasm.memory.buffer, result.jsonPtr, result.jsonLength).slice()
                actual = {accepted: true, decodedBytes: bytes.length, decodedSha256: sha256(bytes)}
            } catch (error) {
                actual = {accepted: false, error: {name: error.name, message: error.message}}
            }
            current.actual[name] = actual
            assert.deepEqual(actual, entry.expected, entry.name + '/' + name)
            for (const [index, source] of sources.entries()) {
                assert.equal(sha256(source.bytes), entry.sources[index].sha256)
            }
        }
        report.conformance.push(current)
        save(current)
    }
    assert.equal(report.conformance.length, 157)
    report.untestedStandaloneDsFormatEntries = conformance.formats.length
    for (const group of manifest.groups) {
        const sources = await Promise.all(group.banks.map(bank => sourceFor(inputDirectory, bank)))
        current = {stage: 'full-jmdict-production-inflate', groupIndex: group.groupIndex, rows: group.rows, actual: {}}
        for (const name of ['baseline', 'candidate']) {
            const result = await parsers[name].inflateCompressedTermBankSourcesWasm(sources, {}, true)
            current.actual[name] = verifyGroup(result, group)
            for (const [index, source] of sources.entries()) {
                assert.equal(sha256(source.bytes), group.banks[index].compressedSha256)
            }
        }
        assert.equal(current.actual.candidate.wasmCapacityBytes, current.actual.baseline.wasmCapacityBytes)
        report.groups.push(current)
        save(current)
    }
    assert.equal(report.groups.length, 12)
    assert.equal(report.groups.reduce((sum, group) => sum + group.rows, 0), 528299)
    report.passed = true
    console.log(JSON.stringify({passed: true, crcVectors: report.vectors.length,
        productionConformance: report.conformance.length, fullJmdictGroups: report.groups.length,
        rows: 528299, decodedBytes: manifest.decodedBytes}))
} catch (error) {
    report.failure = {current, name: error.name, message: error.message, stack: error.stack}
    save({stage: 'failure', ...report.failure})
    throw error
} finally {
    writeFileSync(path.join(evidenceDirectory, 'verify.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'})
}
