#!/usr/bin/env node
/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'
import {crc32, deflateRawSync} from 'node:zlib'
import {pathToFileURL} from 'node:url'

const [baselineRoot, candidateRoot, outputPath] = process.argv.slice(2)
assert(baselineRoot && candidateRoot && outputPath, 'Provide baseline root, candidate root and output path')
const encoder = new TextEncoder()
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const parserPath = `${baselineRoot}/ext/js/dictionary/term-bank-wasm-parser.js`
assert.equal(hash(await readFile(parserPath)), hash(await readFile(`${candidateRoot}/ext/js/dictionary/term-bank-wasm-parser.js`)), 'Parser JavaScript must match')
const {hashTermKeyBytes} = await import(pathToFileURL(`${baselineRoot}/ext/js/dictionary/term-key-hash.js`))
const modules = []
const sources = []
for (const [index, directory] of [baselineRoot, candidateRoot].entries()) {
  const wasm = await readFile(`${directory}/ext/lib/term-bank-parser.wasm`)
  const module = await import(`${pathToFileURL(parserPath).href}?independent-prefix=${index}`)
  module.setTermBankWasmModule(await WebAssembly.compile(wasm))
  modules.push(module)
  sources.push({directory, wasmSha256: hash(wasm), cSha256: hash(await readFile(`${directory}/ext/js/dictionary/wasm/term-bank-parser.c`))})
}

function bytes(value) {
  if (value === null || typeof value === 'undefined') return value
  return {type: value.constructor.name, base64: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')}
}

function normalize(value) {
  if (ArrayBuffer.isView(value)) return bytes(value)
  if (value instanceof Map) return [...value.entries()].map(([key, item]) => [key, normalize(item)])
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => !key.endsWith('Ms') && typeof item !== 'function')
    .map(([key, item]) => [key, normalize(item)]))
  return value
}

function snapshot(chunk) {
  const start = chunk.contentBytesBaseOffset ?? 0
  return normalize({
    rowCount: chunk.rowCount,
    expressionBytesList: chunk.expressionBytesList,
    readingBytesList: chunk.readingBytesList,
    readingEqualsExpressionList: chunk.readingEqualsExpressionList,
    scoreList: chunk.scoreList,
    sequenceList: chunk.sequenceList,
    contentBytesList: chunk.contentBytesList,
    contentHash1List: chunk.contentHash1List,
    contentHash2List: chunk.contentHash2List,
    contentBytes: chunk.contentBytesBuffer?.subarray(start, start + chunk.contentBytesLength),
    contentMetaList: chunk.contentMetaList,
    contentMetaByUniqueIndex: chunk.contentMetaByUniqueIndex,
    contentUniqueIndexList: chunk.contentUniqueIndexList,
    contentDedupPlan: chunk.contentDedupPlan,
    termRecordPreinternedPlan: chunk.termRecordPreinternedPlan,
    preparedLookupIndexes: chunk.preparedLookupIndexes,
    mediaRows: chunk.mediaRows,
  })
}

const standard = {
  computeContentHashes: true, emitContentSlab: true, emitTokenBinaryContent: true,
  emitTermByteLists: true, useNativeStringPlan: true, singleChunk: true,
  validateGlossaryTypes: true, mediaHintFastScan: true,
}

async function parse(module, banks, options, preload, controls) {
  module.consumeLastTermBankWasmParseProfile()
  const emitted = []
  let error = null
  let preloaded
  try {
    if (preload) preloaded = await module.inflateCompressedTermBankSourcesWasm(banks.map((source, i) => {
      const raw = encoder.encode(source)
      const method = controls.forceCompressed || i % 2 === 0 ? 8 : 0
      const compressed = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw
      const signature = controls.corruptCrc && i === banks.length - 1 ? (crc32(raw) ^ 1) >>> 0 : crc32(raw)
      return {bytes: compressed, compressionMethod: method, compressedSize: compressed.length, uncompressedSize: raw.length, signature, filename: `term_bank_${i + 1}.json`}
    }), options, true)
    if (controls.requireDeferredCrc) assert(preloaded?.crcSignaturesPtr > 0, 'fixture must exercise production deferred-CRC gate')
    await module.parseTermBankWithWasmColumnChunks(
      preloaded ? new Uint8Array(0) : banks.map(source => encoder.encode(source)), 3,
      chunk => { emitted.push(snapshot(chunk)) }, 7, {...options, ...(preloaded ? {preloadedSource: preloaded} : {})},
    )
  } catch (caught) {
    error = {name: caught.name, message: caught.message}
  }
  const profile = module.consumeLastTermBankWasmParseProfile()
  return {result: {error, emitted}, diagnostics: {
    fusedAttempts: profile?.fusedParseAttempts,
    fusedFallbacks: profile?.fusedParseFallbacks,
    glossaryReuseHits: profile?.validatedGlossaryReuseCount,
    maxWasmHeapBytes: profile?.maxWasmHeapBytes,
    crcVerified: preloaded?.crcVerified,
    crcDeferred: Boolean(preloaded?.crcSignaturesPtr),
    crcReusedGlossaryCount: preloaded?.crcReusedGlossaryCount,
  }}
}

const row = (key, glossary, index = 0) => [key, '', index % 2 ? 'noun' : '', index % 3 ? '' : 'v1', index - 2, glossary, index, index % 2 ? '' : 'common']
const bank = rows => JSON.stringify(rows)
const rawRow = (key, glossary) => `[${JSON.stringify(key)},"","","",0,${glossary},1,""]`
const routingSlot = glossary => hashTermKeyBytes(encoder.encode(JSON.stringify(glossary)).subarray(0, 64)) & 255
const noncollidingGap = (glossary, count = 11) => {
  const target = routingSlot(glossary)
  const rows = []
  for (let i = 0; rows.length < count; ++i) {
    const gap = [`independent-gap-${i}-${'q'.repeat(90)}`]
    if (routingSlot(gap) !== target) rows.push(row(`gap-${i}`, gap, i))
  }
  return rows
}
const cases = []
const add = (name, banks, extras = {}) => cases.push({name, banks, ...extras})
for (const length of [0, 1, 15, 59, 60, 61, 62, 63, 64, 65, 127, 508, 509, 511, 512, 513, 4097]) {
  const glossary = ['x'.repeat(length)]
  const rows = [row('first', glossary)]
  for (let i = 0; i < 11; ++i) rows.push(row(`gap-${i}`, [`gap${i}:${'y'.repeat(80)}`], i))
  rows.push(row('last', glossary, 13), row('adjacent', glossary, 14))
  add(`raw-glossary-length-${length + 4}`, [bank(rows.slice(0, 6)), ' \n[]\t', bank(rows.slice(6))])
}

const shared = 'same-prefix-'.repeat(12)
const forms = [
  [`${shared} plain`],
  [{type: 'text', text: `${shared}\n  normalized  `}],
  [{type: 'structured-content', content: [{tag: 'span', content: shared}, {tag: 'img', path: 'a.png'}]}],
  [{type: 'structured-content', content: [{tag: 'span', content: shared}, {tag: 'span', content: 'no image'}]}],
  [{type: 'image', path: `${shared}.png`, title: '日本語𠮷'}],
  [{type: 'structured-content', content: [{tag: 'div', content: `  ${shared}  `}]}],
]
add('media-and-normalization-hints', [bank(forms.flatMap((g, i) => [row(`a${i}`, g, i), ...noncollidingGap(g), row(`b${i}`, g, i)])), '[]'])
add('common-prefix-unique-negative-control', [bank(Array.from({length: 520}, (_, i) => row(`key-${i}`, [`${shared}${i}`], i))), '[]'])
add('all-unique-negative-control', [bank(Array.from({length: 520}, (_, i) => row(`key-${i}`, [`unique-${i}-${String(i * 65537)} ${'x'.repeat(80)}`], i))), '[]'])
const distant = Array.from({length: 300}, (_, i) => row(`key-${i}`, [`${i % 13}${shared}${i % 17}`], i))
add('bounded-slot-overwrite-and-repeats', [bank(distant), bank([...distant].reverse())])
add('generic-object-glossary', [bank([row('one', {note: shared}), row('two', {note: shared})]), '[]'], {options: {validateGlossaryTypes: false}})
add('same-raw-different-metadata', [bank(Array.from({length: 80}, (_, i) => row(`key-${i}`, [shared], i))), '[]'])
add('nonlocal-identical-content-witness', [bank([row('first', [shared]), ...noncollidingGap([shared]), row('distant', [shared]), row('adjacent', [shared])]), '[]'])
add('common-prefix-and-tail-distinct-middle', [bank(Array.from({length: 200}, (_, i) => row(`key-${i}`, [`${shared}different-${i}-same-final-sixteen`], i))), '[]'])
const targetGlossary = [`witness-target-${shared}`]
let collidingGlossary
for (let i = 0; ; ++i) {
  const glossary = [`hash-collision-${i}-${shared}`]
  if (routingSlot(glossary) === routingSlot(targetGlossary)) {
    collidingGlossary = glossary
    break
  }
}
add('distinct-prefix-hash-collision', [bank([row('target', targetGlossary), row('collision', collidingGlossary), row('target-again', targetGlossary), row('target-reused', targetGlossary)]), '[]'])
const longToken = JSON.stringify([shared])
for (const [index, bad] of [
  `${longToken.slice(0, -2)}]`, `${longToken.slice(0, -1)},]`, `${longToken} true`,
  `["${shared}\\u00xz"]`, `["${shared}",true]`, `["${shared}",{"type":"unknown"}]`,
].entries()) add(`malformed-tail-${cases.length}`, [`[${rawRow('valid', longToken)},${rawRow('bad', bad)}]`, '[]'], {mustReject: index < 4})
for (const tail of ['[', '["', '["short', '[{"type":"image"', '["' + shared.slice(0, 57)]) {
  add(`truncated-bank-${cases.length}`, [`[${rawRow('valid', longToken)}]`, `[${rawRow('bad', tail).slice(0, -7)}`], {mustReject: true})
}
add('invalid-row-delimiter-after-reuse', [`[${rawRow('valid', longToken)},${rawRow('bad', longToken).replace(',1,""]', ':1,""]')}]`, '[]'], {mustReject: true})
add('escaped-equivalent-raw-different', [`[${rawRow('a', JSON.stringify([`${shared}日本語`]))},${rawRow('b', JSON.stringify([`${shared}日本語`]).replaceAll('日', '\\u65e5'))}]`, '[]'])
add('deep-valid-structured-content', [bank([row('a', [{type: 'structured-content', content: Array.from({length: 1}, () => ({tag: 'span', content: shared}))}])]), bank([row('b', ['x'.repeat(60)])])])

// One bounded source exceeds the existing production deferred-CRC admission
// gate, without changing a threshold or adding diagnostic runtime flags.
const crcGlossaries = []
const crcSlots = new Set()
for (let i = 0; crcGlossaries.length < 17; ++i) {
  const glossary = [`crc-key-${i}-${'repeated glossary '.repeat(10)}`]
  const slot = routingSlot(glossary)
  if (!crcSlots.has(slot)) {
    crcSlots.add(slot)
    crcGlossaries.push(glossary)
  }
}
const crcBanks = Array.from({length: 4}, (_, bankIndex) => bank(Array.from({length: 6000}, (_, i) => row(`crc-${bankIndex}-${i}`, crcGlossaries[i % crcGlossaries.length]))))
add('actual-deferred-crc-nonlocal-witnesses', crcBanks, {forceCompressed: true, requireDeferredCrc: true, onlyVariants: ['preload-crc']})
add('actual-deferred-crc-invalid-signature', crcBanks, {forceCompressed: true, requireDeferredCrc: true, corruptCrc: true, mustReject: true, onlyVariants: ['preload-crc']})

const variants = [
  {name: 'default', options: {}, preload: false},
  {name: 'preload-crc', options: {}, preload: true},
  {name: 'reuse-disabled', options: {experimentalValidatedGlossaryReuse: false}, preload: false},
  {name: 'global-raw-reuse', options: {experimentalGlobalExactContentReuse: true}, preload: false},
  {name: 'media-hints-off', options: {mediaHintFastScan: false}, preload: false},
  {name: 'split-chunks', options: {singleChunk: false, prepareLookupIndexes: true}, preload: false},
]

const observations = []
for (const entry of cases) {
  for (const variant of variants) {
    if (entry.onlyVariants && !entry.onlyVariants.includes(variant.name)) continue
    const options = {...standard, ...entry.options, ...variant.options}
    const a = await parse(modules[0], entry.banks, options, variant.preload, entry)
    const b = await parse(modules[1], entry.banks, options, variant.preload, entry)
    assert.deepEqual(b.result, a.result, `${entry.name}/${variant.name}`)
    if (entry.mustReject) assert(a.result.error, `expected rejection: ${entry.name}/${variant.name}`)
    if (entry.requireDeferredCrc) {
      assert(a.diagnostics.crcDeferred && b.diagnostics.crcDeferred, 'both modules must enter deferred CRC')
      if (!entry.corruptCrc) assert(a.diagnostics.crcVerified && b.diagnostics.crcVerified, 'both modules must finish CRC verification before emitting')
    }
    observations.push({case: entry.name, variant: variant.name, rows: a.result.emitted.reduce((sum, c) => sum + c.rowCount, 0),
      error: a.result.error, digest: hash(JSON.stringify(a.result)), baseline: a.diagnostics, candidate: b.diagnostics})
  }
}

const report = {
  complete: true, node: process.version, sources,
  parserJavascriptPath: parserPath, parserJavascriptSha256: hash(await readFile(parserPath)),
  cases: cases.length, comparisons: observations.length,
  passedSuccesses: observations.filter(x => x.error === null).length,
  passedErrors: observations.filter(x => x.error !== null).length,
  observations,
  notes: 'Independent correctness only. Both frozen native modules use byte-identical baseline production JS. Full exposed columns, canonical bytes, hashes, keys, lookup bytes, dedup plans, media and exact errors/emitted prefixes are compared. Sequential parses reuse each instance to check call-local cache lifetime. No timing or full-browser claim.'
}
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({complete: true, cases: report.cases, comparisons: report.comparisons, passedSuccesses: report.passedSuccesses, passedErrors: report.passedErrors, sources})}\n`)
