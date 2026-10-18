/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
import assert from 'node:assert/strict'
import {readFile, writeFile, readdir} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'

const [source = '.', output] = process.argv.slice(2)
const root = path.resolve(source)
// eslint-disable-next-line no-unsanitized/method -- Differential tests load an explicitly selected trusted checkout.
const index = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/term-lookup-index.js')))
// eslint-disable-next-line no-unsanitized/method -- Differential tests load an explicitly selected trusted checkout.
const {createTermRecordPreinternedPlanBuilder: builder} = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/term-record-preinterned-plan.js')))
// eslint-disable-next-line no-unsanitized/method -- Differential tests load an explicitly selected trusted checkout.
const {TermRecordOpfsStore: Store} = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/term-record-opfs-store.js')))
// eslint-disable-next-line no-unsanitized/method -- Differential tests load an explicitly selected trusted checkout.
const {createNodeOpfs} = await import(pathToFileURL(path.join(root, 'test/fixtures/opfs-continuation/node-opfs-adapter.mjs')))
const encoder = new TextEncoder()
const results = []
async function check(name, run) {
    try {
        await run()
        results.push({name, passed: true})
    } catch (error) {
        results.push({name, passed: false, error: error.stack ?? String(error)})
    }
}
function planFor(expression, reading, unused = false) {
    const b = builder(4)
    if (unused) { b.internStringBytes(encoder.encode('unused')) }
    const e = b.internStringBytes(expression)
    const r = reading === null ? e : b.internStringBytes(reading)
    return b.buildPlan([e], [r])
}
function verify(bytes, expression, reading) {
    const parsed = index.parsePersistedTermLookupIndex(bytes)
    assert.deepEqual(index.getPersistedTermKeyBytes(parsed, 0, 'expression'), expression)
    assert.deepEqual(index.getPersistedTermKeyBytes(parsed, 0, 'reading'), reading)
    assert.deepEqual(index.findExactRows(parsed, expression, 'expression'), [0])
    if (reading !== null) { assert.deepEqual(index.findExactRows(parsed, reading, 'reading'), [0]) }
    assert.deepEqual(index.findSequenceRows(parsed, 123), [0])
}
for (const length of [1, 65534, 65535]) {
    for (const field of ['expression', 'reading']) {
        await check(`fallback ${field}: ${length} bytes`, () => {
            const backing = new Uint8Array(length + 4).fill(97)
            const key = backing.subarray(1, 1 + length)
            const expression = field === 'expression' ? key : encoder.encode('short')
            const reading = field === 'reading' ? key : null
            verify(index.encodePersistedTermLookupIndex([{expressionBytes: expression, readingBytes: reading, sequence: 123}]), expression, reading)
        })
    }
}
for (const length of [0, 65536]) {
    for (const field of ['expression', 'reading']) {
        await check(`fallback rejects ${field}: ${length} bytes`, () => {
            const key = new Uint8Array(length).fill(97)
            assert.throws(() => index.encodePersistedTermLookupIndex([{expressionBytes: field === 'expression' ? key : encoder.encode('short'), readingBytes: field === 'reading' ? key : null, sequence: 123}]), RangeError)
        })
    }
}
for (const text of ['a'.repeat(65535), '語'.repeat(21845)]) {
    for (const field of ['expression', 'reading']) {
        for (const unused of [false, true]) {
            await check(`base rebuild: ${text[0]} ${field}, unused key=${unused}`, () => {
                const long = encoder.encode(text)
                assert.equal(long.length, 65535)
                const expression = field === 'expression' ? long : encoder.encode('short')
                const reading = field === 'reading' ? long : null
                const plan = planFor(expression, reading, unused)
                const encoded = index.encodePersistedTermLookupIndexFromPreinternedPlan(plan, [reading === null], [123], 1)
                verify(encoded, expression, reading)
                const base = index.splitPersistedTermLookupIndex(encoded).base
                const before = new Uint8Array(base)
                const rebuilt = index.rebuildPersistedTermLookupIndexFromBase(base)
                verify(rebuilt, expression, reading)
                assert.deepEqual(base, before)
            })
        }
    }
}
for (const damage of ['none', 'derived', 'framing']) {
    await check(`store reopen and repair: ${damage}`, async () => {
        const env = await createNodeOpfs()
        const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
        Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {storage: {getDirectory: async () => env.root}, deviceMemory: 8}})
        try {
            const expression = '語'.repeat(21845)
            const expressionBytes = encoder.encode(expression)
            const row = {
                dictionary: 'Long key',
                expression,
                reading: expression,
                expressionBytes,
                readingBytes: expressionBytes,
                readingEqualsExpression: true,
                entryContentDictName: 'raw',
                entryContentOffset: 0,
                entryContentLength: 1,
                score: 7,
                sequence: 123,
            }
            const original = new Store()
            await original.prepare()
            await original.beginImportSession()
            await original.appendBatch([row], planFor(expressionBytes, null))
            await original.endImportSession()
            const directory = path.join(env.rootPath, 'manabitan-term-records')
            const files = await readdir(directory)
            const filename = path.join(directory, files.find((name) => name.endsWith('.mbti')))
            const bytes = new Uint8Array(await readFile(filename))
            if (damage !== 'none') {
                const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
                const position = damage === 'framing' ? 80 : 80 + 16 + view.getUint32(60, true) + 32
                bytes[position] ^= 1
                await writeFile(filename, bytes)
            }
            const reopened = new Store()
            await reopened.prepare()
            await reopened.ensureDictionariesLoaded(['Long key'])
            assert.equal(reopened.getDictionaryHealth('Long key').status, 'available')
            assert.deepEqual(reopened.findTermIds('Long key', expression, 'expression'), [1])
            const materialized = await reopened.getByIdsAsync([1])
            assert.equal(materialized.get(1)?.expression, expression)
            assert.equal(materialized.get(1)?.score, 7)
            assert.equal(materialized.get(1)?.entryContentLength, 1)
            const second = new Store()
            await second.prepare()
            await second.ensureDictionariesLoaded(['Long key'])
            assert.deepEqual(second.findTermIdsBySequence('Long key', 123), [1])
        } finally {
            if (previous) {
                Object.defineProperty(globalThis, 'navigator', previous)
            } else {
                delete globalThis.navigator
            }
            await env.dispose()
        }
    })
}
const result = {
    source: root,
    sourceSha256: createHash('sha256').update(await readFile(path.join(root, 'ext/js/dictionary/term-lookup-index.js'))).digest('hex'),
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    results,
}
if (output) { await writeFile(output, JSON.stringify(result, null, 2)) }
console.log(JSON.stringify(result, null, 2))
if (result.failed) { process.exitCode = 1 }
