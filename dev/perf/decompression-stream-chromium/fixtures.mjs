/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {crc32, deflateRawSync, constants} from 'node:zlib'
import {inflateCompressedTermBankSourcesWasm, setTermBankWasmModule} from '../../../ext/js/dictionary/term-bank-wasm-parser.js'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const header = Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255)
const joinBytes = (...parts) => new Uint8Array(Buffer.concat(parts))
const footer = (signature, length) => {
    const bytes = new Uint8Array(8)
    const view = new DataView(bytes.buffer)
    view.setUint32(0, signature, true)
    view.setUint32(4, length >>> 0, true)
    return bytes
}
const source = (raw, options = {}, method = 8) => {
    const bytes = new Uint8Array(method === 0 ? raw : deflateRawSync(raw, options))
    return {bytes, compressionMethod: method, compressedSize: bytes.length, uncompressedSize: raw.length, signature: crc32(raw)}
}

export async function writeConformanceCases(directory, moduleBytes) {
    setTermBankWasmModule(await WebAssembly.compile(moduleBytes))
    const cases = []
    const formats = []
    let fileId = 0
    const persist = async (bytes) => {
        const filename = `conformance-${String(fileId++).padStart(4, '0')}.bin`
        await writeFile(join(directory, filename), bytes, {flag: 'wx'})
        return {filename, byteLength: bytes.length, sha256: sha256(bytes)}
    }
    const add = async (name, sources, expectedAccepted) => {
        let expected
        try {
            const result = await inflateCompressedTermBankSourcesWasm(sources, {experimentalTermBankSpans: true})
            const bytes = new Uint8Array(result.wasm.memory.buffer, result.jsonPtr, result.jsonLength)
            expected = {accepted: true, decodedBytes: bytes.length, decodedSha256: sha256(bytes)}
        } catch (error) { expected = {accepted: false, error: {name: error.name, message: error.message}} }
        assert.equal(expected.accepted, expectedAccepted, `Wrong synthetic native expectation: ${name}`)
        const inputs = []
        for (const {bytes, ...metadata} of sources) { inputs.push({...metadata, ...await persist(bytes)}) }
        cases.push({name, sources: inputs, expected})
    }
    const rows = [
        ['empty-array', Buffer.from('[]')],
        ['utf8-row', Buffer.from('[["日本語","にほんご","","",0,["Unicode 日本語 and \\\"quotes\\\""],1,""]]')],
        ['whitespace-array', Buffer.from(' \t\r\n[[]] \t\r\n')],
        ['large-repetitive', Buffer.from(JSON.stringify(Array.from({length: 2048}, (_, i) => ['語', '', '', '', 0, ['repeated '.repeat(16)], i, ''])))],
    ]
    const methods = [['default', {}], ['fixed', {strategy: constants.Z_FIXED}], ['stored-blocks', {level: 0}]]
    const mutations = [
        ['valid', (s) => s, true],
        ['wrong-crc', (s) => ({...s, signature: (s.signature + 1) >>> 0}), false],
        ['size-too-large', (s) => ({...s, uncompressedSize: s.uncompressedSize + 1}), false],
        ['size-too-small', (s) => ({...s, uncompressedSize: s.uncompressedSize - 1}), false],
        ['dishonest-tiny-size', (s) => ({...s, uncompressedSize: 1}), false],
        ['truncated-one-byte', (s) => ({...s, bytes: s.bytes.slice(0, -1), compressedSize: s.compressedSize - 1}), false],
        ['truncated-half', (s) => ({...s, bytes: s.bytes.slice(0, Math.floor(s.bytes.length / 2)), compressedSize: Math.floor(s.bytes.length / 2)}), false],
        ['trailing-zero', (s) => ({...s, bytes: joinBytes(s.bytes, Uint8Array.of(0)), compressedSize: s.compressedSize + 1}), false],
        ['trailing-garbage', (s) => ({...s, bytes: joinBytes(s.bytes, Uint8Array.of(0xde, 0xad)), compressedSize: s.compressedSize + 2}), false],
        ['concatenated-raw', (s) => ({...s, bytes: joinBytes(s.bytes, s.bytes), compressedSize: s.compressedSize * 2}), false],
        ['hidden-second-gzip-member', (s) => {
            const prefix = joinBytes(deflateRawSync(new Uint8Array()), footer(0, 0), header)
            return {...s, bytes: joinBytes(prefix, s.bytes), compressedSize: prefix.length + s.compressedSize}
        }, false],
        ['invalid-block-type', (s) => ({...s, bytes: Uint8Array.of(7), compressedSize: 1}), false],
    ]
    for (const [name, raw] of rows) {
        for (const [method, options] of methods) {
            const original = source(raw, options)
            for (const [mutation, mutate, accepted] of mutations) { await add(`${name}/${method}/${mutation}`, [mutate(original)], accepted) }
        }
    }
    const plain = source(Buffer.from('[[]]'))
    for (const [name, raw, accepted] of [
        ['object-wrapper', Buffer.from('{}'), false],
        ['BOM-wrapper', Buffer.from('\ufeff[]'), false],
        ['non-json-bracketed-inflater-only', Buffer.from('[not JSON]'), true],
    ]) { await add(name, [source(raw)], accepted) }
    const stored = source(Buffer.from('[[]]'), {}, 0)
    await add('stored-valid', [stored], true)
    await add('stored-wrong-crc', [{...stored, signature: (stored.signature ^ 1) >>> 0}], false)
    await add('stored-wrong-length', [{...stored, uncompressedSize: stored.uncompressedSize + 1}], false)
    await add('mixed-stored-deflate-valid', [stored, plain], true)
    await add('CRC-before-later-deflate-failure', [{...plain, signature: (plain.signature + 1) >>> 0}, {...plain, bytes: Uint8Array.of(7), compressedSize: 1}], false)
    await add('deflate-before-later-CRC-failure', [{...plain, bytes: Uint8Array.of(7), compressedSize: 1}, {...plain, signature: (plain.signature + 1) >>> 0}], false)
    await add('wrapper-before-later-CRC-failure', [source(Buffer.from('{}')), {...plain, signature: (plain.signature + 1) >>> 0}], false)
    await add('metadata-compressed-size', [{...plain, compressedSize: plain.compressedSize + 1}], false)
    await add('metadata-negative-size', [{...plain, uncompressedSize: -1}], false)
    await add('metadata-method', [{...plain, compressionMethod: 12}], false)

    const raw = plain.bytes
    const gzip = joinBytes(header, raw, footer(plain.signature, plain.uncompressedSize))
    const rawEmpty = deflateRawSync(new Uint8Array())
    const gzipEmpty = joinBytes(header, rawEmpty, footer(0, 0))
    for (const format of ['deflate-raw', 'gzip']) {
        const valid = format === 'gzip' ? gzip : raw
        const second = format === 'gzip' ? gzipEmpty : rawEmpty
        for (const [name, tail] of [['zero', Uint8Array.of(0)], ['garbage', Uint8Array.of(0xde, 0xad)], ['empty-member', second]]) {
            for (const chunking of ['same-chunk', 'later-chunk']) {
                const parts = chunking === 'same-chunk' ? [joinBytes(valid, tail)] : [valid, tail]
                formats.push({name: `${format}/${name}/${chunking}`, format, expectedAccepted: false,
                    parts: await Promise.all(parts.map(persist)), maxDecodedBytes: 16})
            }
        }
        formats.push({name: `${format}/valid`, format, expectedAccepted: true,
            parts: [await persist(valid)], maxDecodedBytes: 16,
            expectedSha256: sha256(Buffer.from('[[]]'))})
    }
    const manifest = {scope: 'Standalone format conformance plus exact-source native inflater acceptance and bytes. Failures are independently rerun through native code after the DS attempt to preserve and check original-source error classification.',
        nativeWasmSha256: sha256(moduleBytes), cases, formats}
    await writeFile(join(directory, 'conformance.json'), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx'})
}
