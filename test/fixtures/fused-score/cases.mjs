/* Copyright (C) 2026 Manabitan authors. SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
// These tests use the production parser. No decoder or codec is substituted.
import {
    parseTermBankWithWasmChunks,
    parseTermBankWithWasmColumnChunks,
    consumeLastTermBankWasmParseProfile,
} from '../../../ext/js/dictionary/term-bank-wasm-parser.js'
import {TermRecordOpfsStore} from '../../../ext/js/dictionary/term-record-opfs-store.js'
import {TermContentOpfsStore} from '../../../ext/js/dictionary/term-content-opfs-store.js'
import {splitPersistedTermLookupIndex} from '../../../ext/js/dictionary/term-lookup-index.js'
import {RAW_TERM_CONTENT_TOKEN_DICT_NAME} from '../../../ext/js/dictionary/raw-term-content.js'

const encoder = new TextEncoder()
const fusedOptions = {emitContentSlab: true, emitTokenBinaryContent: true, prepareLookupIndexes: true}
const negativeCases = [
    ['negative-first', ['-0', '0', '1', '-1']],
    ['negative-middle', ['1', '-0', '0', '-1']],
    ['negative-last', ['0', '1', '-1', '-0']],
    ['negative-all', ['-0', '-0', '-0', '-0']],
    ['negative-mixed', ['-0', '0', '-0', '2147483647', '-2147483648']],
]
const controls = [
    ['positive-zero', ['0', '0', '1', '-1'], 0],
    ['integer-extremes', ['-2147483648', '2147483647', '0', '1'], 0],
    ['negative-exponent-zero', ['1', '-0e0', '0', '-1'], 1],
    ['negative-decimal-zero', ['1', '-0.0', '0', '-1'], 1],
    ['fraction-fallback', ['1', '1.5', '-0', '-2.25'], 1],
    ['wide-number-fallback', ['1', '1099511627776.5', '-0', '0'], 1],
]
function check(value, message) {
    if (!value) { throw new Error(message) }
}
function rows(tokens) {
    return tokens.map((token, i) => `["語-${i}","","","",${token},["gloss-${i}"],${i + 1},""]`)
}
function banks(tokens) {
    const values = rows(tokens)
    const split = Math.ceil(values.length / 2)
    return [values.slice(0, split), values.slice(split)].map((x) => encoder.encode(`[${x.join(',')}]`))
}
function equalScores(actual, tokens) {
    check(actual.length === tokens.length, `score count ${actual.length} != ${tokens.length}`)
    for (let i = 0; i < tokens.length; ++i) {
        check(Object.is(actual[i], Number(tokens[i])), `score[${i}] token=${tokens[i]} actual=${String(actual[i])} negativeZero=${Object.is(actual[i], -0)}`)
    }
}
function bytesEqual(a, b) { return a.length === b.length && a.every((value, i) => value === b[i]) }

export async function runScoreCases() {
    const report = []
    for (const [name, tokens, fallbacks] of [...negativeCases.map(([name, tokens]) => [name, tokens, 1]), ...controls]) {
        try {
            const input = banks(tokens)
            const copies = input.map((x) => Uint8Array.from(x))
            const scores = []
            await parseTermBankWithWasmColumnChunks(input, 3, (chunk) => { scores.push(...chunk.scoreList) }, 64, fusedOptions)
            const profile = consumeLastTermBankWasmParseProfile()
            equalScores(scores, tokens)
            check(profile?.fusedParseAttempts === 1, 'fixture did not attempt the fused parser')
            check(profile.fusedParseFallbacks === fallbacks, `fallbacks=${profile.fusedParseFallbacks} expected=${fallbacks}`)
            check(input.every((x, i) => bytesEqual(x, copies[i])), 'parser mutated its input')
            report.push({name, passed: true, fallbacks: profile.fusedParseFallbacks})
        } catch (error) { report.push({name, passed: false, error: String(error)}) }
    }
    for (const token of ['"-0"', 'null', 'true', '[]', '{}', '1e309', '-1e309']) {
        let dispatched = false
        let rejected = false
        try {
            await parseTermBankWithWasmChunks(encoder.encode(`[${rows([token]).join(',')}]`), 3, () => { dispatched = true })
        } catch { rejected = true }
        report.push({name: `invalid-${token}`, passed: rejected && !dispatched})
    }
    const sequences = []
    const sequenceBanks = [
        encoder.encode('[["a","","","",1,["g"],-0,""]]'),
        encoder.encode('[["b","","","",2,["g"],3,""]]'),
    ]
    await parseTermBankWithWasmColumnChunks(sequenceBanks, 3, (chunk) => { sequences.push(...chunk.sequenceList) }, 64, fusedOptions)
    const sequenceProfile = consumeLastTermBankWasmParseProfile()
    report.push({name: 'sequence-contract-unchanged', passed: sequences[0] === 0 && sequences[1] === 3 && sequenceProfile?.fusedParseFallbacks === 0})
    return report
}

export async function runNativePersistence(tokens = ['1', '-0', '0', '-1'], requireNativeBrowser = true) {
    if (requireNativeBrowser) { check(globalThis.crossOriginIsolated, 'SharedArrayBuffer isolation is required') }
    check(typeof navigator.storage?.getDirectory === 'function', 'native OPFS is required')
    const store = new TermRecordOpfsStore()
    const content = new TermContentOpfsStore()
    await store.prepare()
    await content.prepare()
    await store.beginImportSession()
    await content.beginImportSession()
    const expectedContent = []
    await parseTermBankWithWasmColumnChunks(banks(tokens), 3, async (chunk) => {
        const slices = []
        for (let i = 0; i < chunk.rowCount; ++i) {
            const start = chunk.contentBytesBaseOffset + chunk.contentMetaList[i * 4]
            const length = chunk.contentMetaList[i * 4 + 1]
            slices.push(chunk.contentBytesBuffer.slice(start, start + length))
        }
        expectedContent.push(...slices.map((x) => Uint8Array.from(x)))
        const spans = await content.appendBatch(slices)
        await store.appendBatchFromArtifactChunkResolvedContent(
            {...chunk, dictionary: 'score-regression', dictionaryTotalRows: tokens.length},
            spans.map((x) => x.offset),
            spans.map((x) => x.length),
            RAW_TERM_CONTENT_TOKEN_DICT_NAME,
        )
    }, 64, fusedOptions)
    await content.endImportSession()
    await store.endImportSession()
    const ids = tokens.map((_, i) => i + 1)
    async function verify(materialize) {
        const reader = new TermRecordOpfsStore()
        const contentReader = new TermContentOpfsStore()
        await reader.prepare()
        await contentReader.prepare()
        await (materialize ? reader._loadShardFiles(true) : reader.ensureDictionariesLoaded(['score-regression']))
        check(reader.getDictionaryHealth('score-regression').status === 'available', 'reopened dictionary was not available')
        const records = await reader.getByIdsAsync(ids)
        const ordered = ids.map((id) => records.get(id))
        check(ordered.every(Boolean), 'missing reopened records')
        equalScores(ordered.map((x) => x.score), tokens)
        for (let i = 0; i < ordered.length; ++i) {
            check(ordered[i].expression === `語-${i}`, `headword changed at ${i}`)
            check(ordered[i].sequence === i + 1, `sequence changed at ${i}`)
            const bytes = await contentReader.readSlice(ordered[i].entryContentOffset, ordered[i].entryContentLength)
            check(bytesEqual(bytes, expectedContent[i]), `persisted content changed at ${i}`)
        }
        const integrity = await reader.verifyIntegrity()
        check(integrity.actualShardCount > 0, 'no persisted shard was checked')
        check(integrity.missingShardCount === 0 && integrity.orphanShardCount === 0 && integrity.invalidShardPayloadCount === 0, 'shard integrity validation failed')
        check(integrity.removedOrphanShardCount === 0 && !integrity.rewroteAllShardsFromMemory, 'verification repaired unrelated authoritative data')
    }
    await verify(false)
    await verify(true)
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle('manabitan-term-records')
    let repaired = 0
    for await (const [name, handle] of directory.entries()) {
        if (!name.endsWith('.mbti')) { continue }
        const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer())
        const view = new DataView(bytes.buffer)
        const chunkHeader = 40
        const payloadLength = view.getUint32(chunkHeader + 16, true)
        const payloadStart = chunkHeader + 40
        const payload = bytes.subarray(payloadStart, payloadStart + payloadLength)
        const {base, derived} = splitPersistedTermLookupIndex(payload)
        check(derived.length > 0, 'fixture has no derived index section')
        const protectedBase = Uint8Array.from(base)
        const protectedFields = bytes.slice(payloadStart + payloadLength)
        bytes[derived.byteOffset] ^= 1
        check(bytesEqual(base, protectedBase), 'fault injection changed authoritative base')
        check(bytesEqual(bytes.subarray(payloadStart + payloadLength), protectedFields), 'fault injection changed authoritative fields')
        const writable = await handle.createWritable()
        await writable.write(bytes)
        await writable.close()
        ++repaired
    }
    check(repaired > 0, 'no derived section found for repair control')
    await verify(false)
    return {passed: true, records: tokens.length, nativeOPFS: requireNativeBrowser, storageBoundary: requireNativeBrowser ? 'browser OPFS' : 'Node temporary-file adapter', reopenModes: 2, derivedSectionsRepaired: repaired}
}
