import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import os from 'node:os'

const [wasmArgument, inputArgument, outputArgument, mode = 'cold'] = process.argv.slice(2)
assert(wasmArgument && inputArgument && outputArgument)
assert(mode === 'cold' || mode === 'warm')
assert.equal(typeof globalThis.gc, 'function')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const wasmPath = resolve(wasmArgument)
const inputPath = resolve(inputArgument)
const wasmBytes = await readFile(wasmPath)
const inputBytes = await readFile(inputPath)
const input = JSON.parse(inputBytes)
assert.equal(input.dictionary, 'jmdict')
assert.equal(input.fixture.sha256, '3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f')
assert.equal(input.entries.length, 53)
assert.equal(input.groups.length, 12)
const archive = await readFile(input.archivePath)
assert.equal(hash(archive), input.fixture.sha256)
const entries = new Map(input.entries.map((entry) => [entry.name, entry]))
const seen = new Set()
const groups = input.groups.map((group) => {
    const files = group.files.map((name) => {
        assert(!seen.has(name))
        seen.add(name)
        const entry = entries.get(name)
        assert(entry)
        return entry
    })
    const compressedBytes = files.reduce((sum, entry) => sum + entry.compressedBytes, 0)
    const uncompressedBytes = files.reduce((sum, entry) => sum + entry.uncompressedBytes, 0)
    // Every actual JMdict group uses immediate source CRC validation.
    assert(compressedBytes > Math.floor(uncompressedBytes / 32))
    assert.deepEqual(files.map((entry) => entry.compressedBytes), group.bytes)
    let cursor = 0
    return {
        files,
        compressedBytes,
        uncompressedBytes,
        compressed: Buffer.concat(files.map((entry) => archive.subarray(entry.offset, entry.offset + entry.compressedBytes))),
        columns: [
            Uint32Array.from(files, (entry) => { const start = cursor; cursor += entry.compressedBytes; return start }),
            Uint32Array.from(files, (entry) => entry.compressedBytes),
            Uint32Array.from(files, (entry) => entry.uncompressedBytes),
            new Uint32Array(files.length).fill(8),
            Uint32Array.from(files, (entry) => entry.crc32),
        ],
    }
})
assert.equal(seen.size, 53)
assert.equal(groups.reduce((sum, group) => sum + group.uncompressedBytes, 0), 171617523)
const module = await WebAssembly.compile(wasmBytes)
assert.deepEqual(WebAssembly.Module.imports(module), [])
const wasm = (await WebAssembly.instantiate(module)).exports
const expectedOutputDigest = '343a73cf768e5feaa5a1e557de40b3742a3de404524d164884c4787c668c6be8'

function execute() {
    const digest = createHash('sha256')
    const observations = []
    let elapsedMs = 0
    for (const group of groups) {
        // This follows the production allocator/column ordering. Allocation,
        // input copies and column preparation are outside the native endpoint.
        wasm.wasm_reset_heap()
        const inputPtr = wasm.wasm_alloc(group.compressedBytes)
        const pointers = group.columns.map((column) => wasm.wasm_alloc(column.byteLength))
        const spansPtr = wasm.wasm_alloc(group.files.length * 8)
        const outputCapacity = group.uncompressedBytes + 2
        const outputPtr = wasm.wasm_alloc(outputCapacity)
        const heap = new Uint8Array(wasm.memory.buffer)
        heap.set(group.compressed, inputPtr)
        for (let i = 0; i < pointers.length; ++i) {
            new Uint32Array(wasm.memory.buffer, pointers[i], group.files.length).set(group.columns[i])
        }
        const start = performance.now()
        const length = wasm.inflate_and_join_term_banks(
            inputPtr, group.compressedBytes, ...pointers, group.files.length,
            outputPtr, outputCapacity, spansPtr, 0,
        )
        const end = performance.now()
        assert.equal(length, group.uncompressedBytes)
        const spans = new Uint32Array(wasm.memory.buffer, spansPtr, group.files.length * 2)
        let offset = 0
        for (let i = 0; i < group.files.length; ++i) {
            assert.equal(spans[i * 2], offset)
            assert.equal(spans[i * 2 + 1], group.files[i].uncompressedBytes)
            offset += group.files[i].uncompressedBytes
        }
        digest.update(new Uint8Array(wasm.memory.buffer, outputPtr, length))
        elapsedMs += end - start
        observations.push({elapsedMs: end - start, bankCount: group.files.length, compressedBytes: group.compressedBytes, uncompressedBytes: group.uncompressedBytes, inputPtr, outputPtr, memoryBytes: wasm.memory.buffer.byteLength})
    }
    const outputDigest = digest.digest('hex')
    assert.equal(outputDigest, expectedOutputDigest)
    return {elapsedMs, groups: observations, outputDigest}
}

const warmups = []
const observations = []
const hostBefore = {load: os.loadavg(), cpuModel: os.cpus()[0]?.model, parallelism: os.availableParallelism(), processMemory: process.memoryUsage(), freeMemory: os.freemem()}
if (mode === 'warm') { for (let i = 0; i < 4; ++i) { warmups.push(execute()) } }
globalThis.gc()
for (let i = 0; i < (mode === 'cold' ? 1 : 10); ++i) { observations.push(execute()) }
const result = {
    complete: true,
    scope: 'Sequential native inflation and immediate CRC checks for the exact12production JMdict source groups in one fresh WASM instance. Production source packing, allocator order and output geometry. Allocation/copies and per-group verification excluded. No parser, worker concurrency, compression, storage or browser endpoint. Cold has zero warmups; warm has4excluded and10measured corpus passes.',
    node: process.version, v8: process.versions.v8, mode,
    wasmPath, wasmSha256: hash(wasmBytes), inputSha256: hash(inputBytes), fixtureSha256: input.fixture.sha256,
    sourceGroupEvidence: input.sourceGroupEvidence,
    scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    groupCount: groups.length, bankCount: input.entries.length,
    warmups, observations,
    meanMs: observations.reduce((sum, observation) => sum + observation.elapsedMs, 0) / observations.length,
    outputDigest: expectedOutputDigest,
    hostBefore,
    hostAfter: {load: os.loadavg(), processMemory: process.memoryUsage(), freeMemory: os.freemem()},
}
await writeFile(resolve(outputArgument), JSON.stringify(result, null, 2) + '\n', {flag: 'wx'})
console.log(JSON.stringify({complete: true, mode, meanMs: result.meanMs, wasmSha256: result.wasmSha256, outputDigest: result.outputDigest}))
