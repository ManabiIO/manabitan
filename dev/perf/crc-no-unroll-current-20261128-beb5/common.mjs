/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

export const here = path.dirname(fileURLToPath(import.meta.url))
export const repo = path.resolve(here, '../../..')
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const readJson = async filename => JSON.parse(await readFile(filename, 'utf8'))

export async function loadIdentity(inputDirectory, evidenceDirectory) {
    const registrationBytes = await readFile(path.join(here, 'registration.json'))
    const registration = JSON.parse(registrationBytes)
    const buildBytes = await readFile(path.join(evidenceDirectory, 'build.json'))
    const build = JSON.parse(buildBytes)
    const manifestBytes = await readFile(path.join(inputDirectory, 'manifest.json'))
    const manifest = JSON.parse(manifestBytes)
    assert.equal(build.passed, true)
    assert.equal(build.registrationSha256, sha256(registrationBytes))
    assert.equal(manifest.baseline, registration.baselineCommit)
    assert.equal(manifest.wasmSha256, registration.baselineWasmSha256)
    assert.equal(manifest.captureSha256, registration.sourceFiles['dev/perf/crc-no-unroll-current-20261128-beb5/capture.mjs'])
    assert.equal(manifest.archiveSha256, registration.fixture.archiveSha256)
    assert.equal(manifest.archiveBytes, registration.fixture.archiveBytes)
    assert.equal(manifest.lockSha256, registration.fixture.lockSha256)
    assert.equal(manifest.totalRows, 528299)
    assert.equal(manifest.compressedBytes, 15632849)
    assert.equal(manifest.decodedBytes, 171617523)
    assert.equal(manifest.groups.length, 12)
    assert.equal(manifest.groups.reduce((sum, group) => sum + group.banks.length, 0), 53)
    assert.deepEqual(manifest.grouping, {parserWorkers: 3, groupsPerWorker: 4, targetBytes: 25165824, executionConcurrency: 1})
    for (const [index, group] of manifest.groups.entries()) {
        assert.equal(group.groupIndex, index)
        assert.equal(group.crcReuseEligible, false)
        assert.ok(group.banks.length > 1)
    }
    return {registration, build, manifest,
        registrationSha256: sha256(registrationBytes),
        buildSha256: sha256(buildBytes),
        captureManifestSha256: sha256(manifestBytes)}
}

export async function sourceFor(inputDirectory, bank, conformance = false) {
    const bytes = new Uint8Array(await readFile(path.join(inputDirectory, bank.filename)))
    assert.equal(bytes.length, conformance ? bank.byteLength : bank.compressedSize)
    assert.equal(sha256(bytes), conformance ? bank.sha256 : bank.compressedSha256)
    return {bytes, compressionMethod: bank.compressionMethod, compressedSize: bank.compressedSize,
        uncompressedSize: bank.uncompressedSize, signature: bank.signature,
        filename: bank.zipFilename ?? bank.filename}
}

export async function createParser(module, identifier) {
    const url = pathToFileURL(path.join(repo, 'ext/js/dictionary/term-bank-wasm-parser.js'))
    url.searchParams.set('crc-no-unroll-instance', identifier)
    const parser = await import(url.href)
    parser.setTermBankWasmModule(module)
    await parser.initializeTermBankWasmParser()
    return parser
}

export function verifyGroup(result, group) {
    assert.equal(result.jsonLength, group.decodedBytes)
    assert.equal(result.bankSpanCount, group.banks.length)
    assert.ok(result.bankSpansPtr)
    assert.equal(result.crcSignaturesPtr, 0, 'Immediate CRC must not be deferred')
    const spans = new Uint32Array(result.wasm.memory.buffer, result.bankSpansPtr, group.banks.length * 2)
    const owned = new Uint8Array(result.wasm.memory.buffer, result.jsonPtr, result.jsonLength).slice()
    assert.equal(sha256(owned), group.decodedSha256)
    let offset = 0
    for (const [index, bank] of group.banks.entries()) {
        assert.equal(spans[index * 2], offset)
        assert.equal(spans[index * 2 + 1], bank.uncompressedSize)
        assert.equal(sha256(owned.subarray(offset, offset + bank.uncompressedSize)), bank.decodedSha256)
        offset += bank.uncompressedSize
    }
    assert.equal(offset, owned.length)
    return {decodedSha256: group.decodedSha256, bankCount: group.banks.length,
        wasmCapacityBytes: result.wasm.memory.buffer.byteLength,
        memoryShared: result.wasm.memory.buffer instanceof SharedArrayBuffer}
}
