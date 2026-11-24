import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createReadStream, openAsBlob} from 'node:fs'
import {readFile, writeFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
import path from 'node:path'

const workspace = '/workspace/scratch/0a1757ac2970'
const sourceRoot = path.join(workspace, 'manabitan')
const candidateRoot = path.join(workspace, 'jmdict-sequence')
const evidenceRoot = path.join(workspace, 'sequence-evidence')
const {ZipReader, BlobReader, Uint8ArrayWriter} = await import(pathToFileURL(path.join(sourceRoot, 'node_modules/@zip.js/zip.js/index.js')))
const {createTermRecordPreinternedPlanBuilder} = await import(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/term-record-preinterned-plan.js')))
const locks = JSON.parse(await readFile(path.join(sourceRoot, 'test/perf/dictionaries.lock.json'))).dictionaries
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const moduleBytes = {
    A: await readFile(path.join(sourceRoot, 'dev/data/dictionary-wasm/term-bank-parser.wasm')),
    B: await readFile(path.join(candidateRoot, 'dev/data/dictionary-wasm/term-bank-parser.wasm')),
}
moduleBytes.C = moduleBytes.A
const modules = Object.fromEntries(await Promise.all(Object.entries(moduleBytes).map(async ([arm, bytes]) => [arm, await WebAssembly.compile(bytes)])))
const fixtures = []
const encoder = new TextEncoder()

for (const dictionary of ['jmdict', 'jitendex', 'vndb']) {
    const spec = locks[dictionary]
    const archivePath = path.join(sourceRoot, 'builds/e2e-dictionary-cache', spec.cacheFile)
    const archiveHash = createHash('sha256')
    for await (const bytes of createReadStream(archivePath)) { archiveHash.update(bytes) }
    assert.equal(archiveHash.digest('hex'), spec.sha256)
    const reader = new ZipReader(new BlobReader(await openAsBlob(archivePath)), {useWebWorkers: false})
    const rows = []
    const banks = []
    try {
        const entries = (await reader.getEntries()).filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
            .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5))).slice(0, 4)
        for (const entry of entries) {
            const bytes = await entry.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true})
            assert.equal(bytes.length, entry.uncompressedSize)
            banks.push({name: entry.filename, bytes: bytes.length, sha256: sha256(bytes)})
            for (const row of JSON.parse(new TextDecoder().decode(bytes))) { rows.push(row) }
        }
    } finally { await reader.close() }
    const builder = createTermRecordPreinternedPlanBuilder(rows.length * 2)
    const expressions = new Uint32Array(rows.length)
    const readings = new Uint32Array(rows.length)
    const equals = new Uint8Array(rows.length)
    const sequences = new Int32Array(rows.length)
    for (let row = 0; row < rows.length; ++row) {
        const value = rows[row]
        expressions[row] = builder.internStringBytes(encoder.encode(value[0]))
        equals[row] = Number(value[1] === '' || value[1] === value[0])
        readings[row] = equals[row] ? expressions[row] : builder.internStringBytes(encoder.encode(value[1]))
        const sequence = value[6] == null ? -1 : value[6]
        assert.ok(Number.isInteger(sequence) && sequence >= -0x80000000 && sequence <= 0x7fffffff)
        sequences[row] = sequence
    }
    fixtures.push({name: `${dictionary}-first-four-banks`, dictionary, archiveSha256: spec.sha256, banks,
        plan: builder.buildPlan(expressions, readings), equals, sequences})
}

const controlBase = fixtures[0]
const count = controlBase.sequences.length
fixtures.push({...controlBase, name: 'synthetic-descending-control', sequences: Int32Array.from({length: count}, (_, row) => count - row)})
const late = Int32Array.from({length: count}, (_, row) => row)
late.set([-1, 0, 0x7fffffff], count - 3)
fixtures.push({...controlBase, name: 'synthetic-late-decrease-control', sequences: late})
const shuffled = Int32Array.from({length: count}, (_, row) => row)
let seed = 20261124
for (let row = count - 1; row > 0; --row) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const other = seed % (row + 1)
    const value = shuffled[row]
    shuffled[row] = shuffled[other]
    shuffled[other] = value
}
fixtures.push({...controlBase, name: 'synthetic-shuffled-control', sequences: shuffled})

async function prepare(module, fixture) {
    const wasm = (await WebAssembly.instantiate(module)).exports
    const put = (view) => {
        const pointer = wasm.wasm_alloc(Math.max(8, view.byteLength))
        new Uint8Array(wasm.memory.buffer, pointer, view.byteLength).set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
        return pointer
    }
    const {plan, equals, sequences} = fixture
    let slots = 1
    while (slots < sequences.length) { slots *= 2 }
    const capacity = plan.stringsBuffer.length + sequences.length * 64 + 1024
    const args = [put(plan.stringsBuffer), plan.stringsBuffer.length, put(plan.stringLengths), put(plan.stringOffsets),
        put(plan.stringHashes), plan.stringLengths.length, put(plan.expressionIndexes), put(plan.readingIndexes),
        put(equals), put(sequences), sequences.length, put(new Uint8Array(capacity)), capacity,
        put(new Int32Array(sequences.length)), put(new Uint16Array(sequences.length)), put(new Uint16Array(slots)), slots]
    const encode = () => wasm.encode_term_lookup_index(...args)
    const read = (length) => new Uint8Array(wasm.memory.buffer, args[11], length)
    return {encode, read, heapBytes: wasm.memory.buffer.byteLength}
}

const permutations = ['ABC', 'ACB', 'BAC', 'BCA', 'CAB', 'CBA']
const iterations = 24
const blockCount = 12
const result = {schemaVersion: 1, sourceHead: 'd24b4e56ceb1fe14ad96ef3853f4d397efa6fa26',
    candidateCommit: 'cc4a0a73fef29c418b1f8d894648c1e9f2c2a230', node: process.version,
    scriptSha256: sha256(await readFile(new URL(import.meta.url))),
    moduleSha256: Object.fromEntries(Object.entries(moduleBytes).map(([arm, bytes]) => [arm, sha256(bytes)])),
    scope: 'Diagnostic local native lookup encoder only, 24 resident calls per observation, 12 balanced ABC blocks. First four banks of each verified locked corpus; synthetic adversarial controls reuse JMdict keys with changed sequences. Source I/O, parsing, allocation, WASM compilation, warmups and byte verification excluded. Not full parser or complete-import timing; host contention is not controlled.',
    iterations, blockCount, fixtures: []}

for (const fixture of fixtures) {
    const arms = Object.fromEntries(await Promise.all(Object.entries(modules).map(async ([arm, module]) => [arm, await prepare(module, fixture)])))
    const expectedLength = arms.A.encode()
    assert.ok(expectedLength > 0)
    const expected = new Uint8Array(arms.A.read(expectedLength))
    for (const arm of Object.values(arms)) {
        assert.equal(arm.encode(), expectedLength)
        assert.equal(Buffer.compare(arm.read(expectedLength), expected), 0)
    }
    for (let warmup = 0; warmup < 3; ++warmup) {
        for (const label of permutations[warmup]) {
            for (let iteration = 0; iteration < iterations; ++iteration) { assert.equal(arms[label].encode(), expectedLength) }
        }
    }
    const observations = []
    for (let block = 0; block < blockCount; ++block) {
        const order = permutations[block % permutations.length]
        const times = {}
        for (const label of order) {
            const arm = arms[label]
            let totalLength = 0
            const start = performance.now()
            for (let iteration = 0; iteration < iterations; ++iteration) { totalLength += arm.encode() }
            const elapsed = performance.now() - start
            assert.equal(totalLength, expectedLength * iterations)
            assert.equal(Buffer.compare(arm.read(expectedLength), expected), 0)
            times[label] = elapsed
        }
        observations.push({block, order, times})
    }
    const median = (values) => {
        const sorted = [...values].sort((a, b) => a - b)
        return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2
    }
    const stats = Object.fromEntries([['B/A', 'B', 'A'], ['B/C', 'B', 'C'], ['C/A', 'C', 'A']].map(([name, a, b]) => [name,
        {medianPairedPercent: median(observations.map(({times}) => (times[a] / times[b] - 1) * 100)),
            equalWorkPercent: (observations.reduce((sum, {times}) => sum + times[a], 0) / observations.reduce((sum, {times}) => sum + times[b], 0) - 1) * 100}]))
    result.fixtures.push({name: fixture.name, dictionary: fixture.dictionary, archiveSha256: fixture.archiveSha256, banks: fixture.banks,
        rows: fixture.sequences.length, keys: fixture.plan.stringLengths.length, indexBytes: expectedLength,
        indexSha256: sha256(expected), heapBytes: Object.fromEntries(Object.entries(arms).map(([arm, value]) => [arm, value.heapBytes])),
        observations, stats})
    process.stdout.write(`${fixture.name}: ${JSON.stringify(stats)}\n`)
}
await writeFile(path.join(evidenceRoot, 'lookup-component.json'), `${JSON.stringify(result, null, 2)}\n`)
