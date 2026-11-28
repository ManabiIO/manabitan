import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {deserialize} from 'node:v8'
import {gunzipSync} from 'node:zlib'

const [repo, captures, root, candidate, output] = process.argv.slice(2)
assert(repo && captures && root && candidate && output, 'Expected baselineRoot captureDir buildDir candidate outputFile')
const digest = (data) => crypto.createHash('sha256').update(data).digest('hex')
const dictionary = fs.readFileSync(path.join(repo, 'dev/data/zstd-dicts/jmdict.zdict'))
const databaseSource = fs.readFileSync(path.join(repo, 'ext/js/dictionary/dictionary-database.js'), 'utf8')
const blockTargetBytes = Function(`return (${databaseSource.match(/const TERM_CONTENT_BLOCK_TARGET_BYTES = ([^;]+);/)[1]})`)()
assert.equal(blockTargetBytes, 1024 * 1024)
const plannerSource = fs.readFileSync(path.join(repo, 'ext/js/dictionary/term-content-block-store.js'), 'utf8')
function productionFunction(name) {
    const start = plannerSource.indexOf(`function ${name}(`)
    assert(start >= 0)
    const end = plannerSource.indexOf('\n/**', start)
    return Function(`${plannerSource.slice(start, end < 0 ? undefined : end)}\nreturn ${name}`)()
}
const plan = productionFunction('planContentSpansIntoSlabs')
const pack = productionFunction('packContentSpanBlock')
const report = JSON.parse(fs.readFileSync(path.join(captures, 'report.json'), 'utf8'))
assert.equal(report.complete, true)
assert.equal(report.fixture.sha256, '3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f')
const blocks = []
const inputs = []
for (let groupIndex = 1; groupIndex <= report.groups.length; ++groupIndex) {
    const name = `group-${String(groupIndex).padStart(2, '0')}.bin.gz`
    const encoded = fs.readFileSync(path.join(captures, name))
    const group = deserialize(gunzipSync(encoded))
    const {blockStartIndexes, packedChunkLengths} = plan(group.lengths, blockTargetBytes)
    for (let i = 0; i < packedChunkLengths.length; ++i) {
        const data = pack(group.source, group.offsets, group.lengths, blockStartIndexes[i], blockStartIndexes[i + 1], packedChunkLengths[i], i)
        blocks.push({group: groupIndex, index: i, data, bytes: data.length, sha256: digest(data)})
    }
    inputs.push({name, sha256: digest(encoded), rows: group.count, bytes: group.source.length})
}
const maxBytes = Math.max(4 * 1024 * 1024, ...blocks.map((x) => x.bytes))
const kinds = ['baseline', candidate]
const moduleData = {}
for (const kind of kinds) {
    const js = path.join(root, `wasm-${kind}`, 'zstd-simd-module.js')
    const wasm = fs.readFileSync(path.join(root, `wasm-${kind}`, 'zstd-simd-module.wasm'))
    moduleData[kind] = {create: (await import(pathToFileURL(js))).default, wasm, wasmSha256: digest(wasm), jsSha256: digest(fs.readFileSync(js))}
}
if (kinds[1] !== 'census') assert.deepEqual(WebAssembly.Module.exports(new WebAssembly.Module(moduleData[kinds[0]].wasm)), WebAssembly.Module.exports(new WebAssembly.Module(moduleData[kinds[1]].wasm)))
async function makeArm(label, kind) {
    const module = await moduleData[kind].create({wasmBinary: moduleData[kind].wasm})
    const cctx = module._ZSTD_createCCtx()
    const dctx = module._ZSTD_createDCtx()
    const source = module._malloc(maxBytes + 32)
    const capacity = module._ZSTD_compressBound(maxBytes) + 12
    const destination = module._malloc(capacity)
    const decoded = module._malloc(maxBytes + 32)
    const dict = module._malloc(dictionary.length)
    module.HEAPU8.set(dictionary, dict)
    for (const p of [cctx, dctx, source, destination, decoded, dict]) assert(p > 0)
    return {label, kind, module, cctx, dctx, source, destination, capacity, decoded, dict}
}
const arms = [await makeArm('A', kinds[0]), await makeArm('B', kinds[1])]
function compress(arm, data, {level = -1, useDictionary = true, alignment = 0, copy = true} = {}) {
    const {module, source, destination, dict, cctx, capacity} = arm
    if (copy) module.HEAPU8.set(data, source + alignment)
    const size = module._ZSTD_compress_usingDict(cctx, destination + 12, capacity - 12, source + alignment, data.length, useDictionary ? dict : 0, useDictionary ? dictionary.length : 0, level)
    assert.equal(module._ZSTD_isError(size), 0, `${arm.label} Zstd error: ${size}`)
    assert.equal(module._manabitan_write_block_envelope(destination, size + 12), 1)
    return module.HEAPU8.slice(destination, destination + size + 12)
}
function decode(arm, encoded, expected, useDictionary) {
    const {module, destination, capacity, decoded, dict, dctx} = arm
    assert(encoded.length <= capacity)
    module.HEAPU8.set(encoded, destination)
    const size = module._ZSTD_decompress_usingDict(dctx, decoded, maxBytes, destination + 12, encoded.length - 12, useDictionary ? dict : 0, useDictionary ? dictionary.length : 0)
    assert.equal(module._ZSTD_isError(size), 0, `${arm.label} Zstd decompress error: ${size}`)
    assert.equal(size, expected.length)
    assert.deepEqual(module.HEAPU8.subarray(decoded, decoded + size), new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength))
}
let parityCases = 0
let compressedBytes = 0
function verify(data, options = {}) {
    const a = compress(arms[0], data, options)
    const b = compress(arms[1], data, options)
    assert.deepEqual(a, b, `Compressed bytes differ at case ${parityCases}; bytes=${data.length}; options=${JSON.stringify(options)}`)
    decode(arms[0], b, data, options.useDictionary !== false)
    decode(arms[1], a, data, options.useDictionary !== false)
    ++parityCases
    return a.length
}
for (const block of blocks) compressedBytes += verify(block.data)
const matchLengthCensus = kinds[1] === 'census' ? Array.from({length: 128}, (_, i) => arms[1].module._manabitan_zstd_count_stat(i)) : undefined
const surrogateAvailable = false
const surrogateManifest = {blocks: []}
let seed = 0x718b4d2a
function random() {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return seed >>> 0
}
const lengths = [...Array.from({length: 129}, (_, i) => i), 255, 256, 257, 511, 512, 513, 1023, 1024, 1025, 4095, 4096, 4097, 65535, 65536, 65537, 131063, 131064, 131065, 131071, 131072, 131073, 262143, 262144, 262145, 1048575]
for (const length of lengths) {
    const data = new Uint8Array(length)
    for (let i = 0; i < length; ++i) data[i] = random() & 0xff
    verify(data, {alignment: length % 16, useDictionary: length % 2 === 0, level: length % 3 === 0 ? 1 : -1})
    for (let i = 0; i < length; ++i) data[i] = i % 31
    if (length > 128) data[length - 1] ^= 0xff
    verify(data, {alignment: (length + 7) % 16, useDictionary: length % 2 !== 0, level: length % 3 === 0 ? 3 : -1})
}
for (let i = 0; i < 96; ++i) {
    const sourceBlock = blocks[random() % blocks.length].data
    const length = random() % (Math.min(131100, sourceBlock.length) + 1)
    const start = random() % (sourceBlock.length - length + 1)
    const sample = sourceBlock.subarray(start, start + length)
    assert.equal(sample.byteLength, length)
    verify(sample, {alignment: i % 16, useDictionary: i % 2 === 0, level: [-5, -1, 1, 3, 9, 19][i % 6]})
}
const result = {
    scope: 'Actual WASM codec, exact production1MiB record-aligned plan over captured current-source canonical pending spans; excludes parser, worker messaging, storage and full import. Full compressed bytes plus envelope and cross-decoder equality required.',
    node: process.version,
    blockTargetBytes,
    databaseSourceSha256: digest(databaseSource),
    fixture: report.fixture,
    captureScope: report.scope,
    captureReportSha256: digest(fs.readFileSync(path.join(captures, 'report.json'))),
    plannerSourceSha256: digest(plannerSource),
    dictionarySha256: digest(dictionary),
    modules: Object.fromEntries(kinds.map((kind) => [kind, {wasmSha256: moduleData[kind].wasmSha256, wasmBytes: moduleData[kind].wasm.length, jsSha256: moduleData[kind].jsSha256}])),
    parity: {cases: parityCases, mismatches: 0, actualPlanBlocks: blocks.length, actualPlanBytes: blocks.reduce((n, b) => n + b.bytes, 0), actualPlanCompressedBytesWithEnvelopes: compressedBytes, surrogateBlocks: surrogateManifest.blocks.length, allCompressedBytesExact: true, crossDecoderRoundTrip: true},
    inputs,
    blocks: blocks.map(({data, ...entry}) => entry),
    measurements: [],
    matchLengthCensus,
    surrogateAvailable,
}
fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify({parity: result.parity, modules: result.modules}))

for (const arm of arms) {
    const {module} = arm
    module._ZSTD_freeCCtx(arm.cctx)
    module._ZSTD_freeDCtx(arm.dctx)
    for (const p of [arm.source, arm.destination, arm.decoded, arm.dict]) module._free(p)
}
