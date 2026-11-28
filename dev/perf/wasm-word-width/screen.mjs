import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {deserialize} from 'node:v8'
import {gunzipSync} from 'node:zlib'

const [repo, captures, root, output, candidate, order, mode, parityFile] = process.argv.slice(2)
assert(repo && captures && root && output && candidate && ['AB', 'BA'].includes(order) && ['warm', 'cold', 'parity'].includes(mode))
const digest = (data) => crypto.createHash('sha256').update(data).digest('hex')
const reportBytes = fs.readFileSync(path.join(captures, 'report.json'))
const report = JSON.parse(reportBytes)
assert.equal(report.complete, true)
const dictionary = report.dictionary === 'jmdict' ? fs.readFileSync(path.join(repo, 'dev/data/zstd-dicts/jmdict.zdict')) : new Uint8Array()
const level = report.dictionary === 'jmdict' ? -1 : 1
const databaseSource = fs.readFileSync(path.join(repo, 'ext/js/dictionary/dictionary-database.js'), 'utf8')
const blockTargetBytes = Function(`return (${databaseSource.match(/const TERM_CONTENT_BLOCK_TARGET_BYTES = ([^;]+);/)[1]})`)()
const plannerSource = fs.readFileSync(path.join(repo, 'ext/js/dictionary/term-content-block-store.js'), 'utf8')
const plannerStart = plannerSource.indexOf('function planContentSpansIntoSlabs(')
const plannerEnd = plannerSource.indexOf('\n/**', plannerStart)
const plan = Function(`${plannerSource.slice(plannerStart, plannerEnd)}\nreturn planContentSpansIntoSlabs`)()
const blocks = []
const captureInputs = []
for (let groupIndex = 1; groupIndex <= report.groups.length; ++groupIndex) {
    const name = `group-${String(groupIndex).padStart(2, '0')}.bin.gz`
    const encoded = fs.readFileSync(path.join(captures, name))
    const group = deserialize(gunzipSync(encoded))
    assert.equal(group.sourceLength, group.sourceBufferLength, 'Capture must encode original slab offset before restoring nonzero offsets')
    const source = new Uint8Array(group.shared ? new SharedArrayBuffer(group.sourceLength) : new ArrayBuffer(group.sourceLength))
    source.set(group.source)
    const {blockStartIndexes, packedChunkLengths} = plan(group.lengths, blockTargetBytes)
    for (let i = 0; i < packedChunkLengths.length; ++i) {
        blocks.push({
            group: groupIndex,
            block: i,
            source,
            sourceOffsets: group.offsets.slice(blockStartIndexes[i], blockStartIndexes[i + 1]),
            sourceLengths: group.lengths.slice(blockStartIndexes[i], blockStartIndexes[i + 1]),
            contentBytes: packedChunkLengths[i],
        })
    }
    captureInputs.push({name, sha256: digest(encoded), sourceBytes: source.byteLength, shared: group.shared, spans: group.count})
}
const wrapperBytes = fs.readFileSync(path.join(repo, 'dev/lib/zstd-wasm.js'))
for (const kind of ['baseline', candidate]) assert.equal(digest(fs.readFileSync(path.join(root, `wasm-${kind}`, 'zstd-wasm.js'))), digest(wrapperBytes))
const arms = []
const armKinds = mode === 'cold' ? [['K', candidate]] : mode === 'parity' ? [['A', 'baseline'], ['B', candidate]] : [['A', 'baseline'], ['B', candidate], ['C', 'baseline'], ['D', candidate]]
for (const [label, kind] of armKinds) {
    const initStart = performance.now()
    const modulePath = path.join(root, `wasm-${kind}`, 'zstd-wasm.js')
    assert.equal(digest(fs.readFileSync(modulePath)), digest(wrapperBytes))
    const wrapper = await import(`${pathToFileURL(modulePath)}?arm=${label}`)
    const wasm = fs.readFileSync(path.join(root, `wasm-${kind}`, 'zstd-simd-module.wasm'))
    await wrapper.init(`data:application/wasm;base64,${wasm.toString('base64')}`)
    const context = wrapper.createCCtx()
    arms.push({label, kind, wrapper, context, initializationMs: performance.now() - initStart, wasmSha256: digest(wasm), buffers: null})
}
function prepare(arm, block) {
    const p = arm.wrapper.prepareSpanCompression(arm.context, block.source, block.sourceOffsets, block.sourceLengths, block.contentBytes, dictionary, 12, level, true)
    arm.buffers = p.buffers
    return p
}
const blockDigests = []
let compressedBytes = 0
if (mode === 'parity') {
    for (const block of blocks) {
        const a = arms[0].wrapper.finishPreparedSpanCompression(prepare(arms[0], block))
        const b = arms[1].wrapper.finishPreparedSpanCompression(prepare(arms[1], block))
        assert.deepEqual(a, b)
        compressedBytes += a.length
        blockDigests.push({group: block.group, block: block.block, inputBytes: block.contentBytes, compressedBytes: a.length, wrappedSha256: digest(a)})
    }
} else {
    const parity = JSON.parse(fs.readFileSync(parityFile, 'utf8'))
    assert.equal(parity.captureReportSha256, digest(reportBytes))
    assert.equal(parity.parity.blocks, blocks.length)
    compressedBytes = parity.parity.compressedBytes
}
const result = {
    scope: 'Unmodified current production JS prepareSpanCompression/finishPreparedSpanCompression with actual1MiB block target, exact captured canonical pending spans and restored source SharedArrayBuffer ownership. Excludes parser, worker scheduling/messages, storage and full import.',
    node: process.version,
    candidate,
    order,
    mode,
    initialization: arms.map(({label, kind, initializationMs}) => ({label, kind, initializationMs})),
    captureScope: report.scope,
    fixture: report.fixture,
    captureReportSha256: digest(reportBytes),
    wrapperSha256: digest(wrapperBytes),
    databaseSourceSha256: digest(databaseSource),
    plannerSourceSha256: digest(plannerSource),
    blockTargetBytes,
    level,
    dictionarySha256: digest(dictionary),
    captureInputs,
    parity: {blocks: blocks.length, inputBytes: blocks.reduce((n, b) => n + b.contentBytes, 0), compressedBytes, wrappedBytesExact: mode === 'parity' ? true : 'verified-in-separate-process', blockDigests},
    measurements: [],
}
fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify({scope: result.scope, parity: {...result.parity, blockDigests: undefined}}))
if (mode !== 'parity') {
    function run(arm, round) {
        let gatherMs = 0
        let finishMs = 0
        let bytes = 0
        const start = performance.now()
        for (const block of blocks) {
            const gatherStart = performance.now()
            const p = prepare(arm, block)
            const finishStart = performance.now()
            const output = arm.wrapper.finishPreparedSpanCompression(p)
            const end = performance.now()
            gatherMs += finishStart - gatherStart
            finishMs += end - finishStart
            bytes += output.length
        }
        const wallMs = performance.now() - start
        assert.equal(bytes, compressedBytes)
        return {arm: arm.label, kind: arm.kind, round, gatherMs, finishMs, wallMs, bytes}
    }
    if (mode === 'cold') {
        result.measurements.push(run(arms[0], 0))
    } else {
        const warmArms = order === 'BA' ? [...arms].reverse() : arms
        for (let round = 0; round < 2; ++round) for (const arm of warmArms) run(arm, round)
        const schedules = [[0, 1, 3, 2], [1, 2, 0, 3], [2, 3, 1, 0], [3, 0, 2, 1]]
        for (let round = 0; round < 8; ++round) {
            global.gc?.()
            const schedule = schedules[round % schedules.length]
            for (const i of order === 'BA' ? schedule.map((index) => index ^ 1) : schedule) result.measurements.push(run(arms[i], round))
        }
    }
    const median = (v) => { const a = [...v].sort((x, y) => x - y); return (a[(a.length - 1) >> 1] + a[a.length >> 1]) / 2 }
    result.summary = Object.fromEntries(arms.map((arm) => {
        const rows = result.measurements.filter((r) => r.arm === arm.label)
        return [arm.label, {kind: arm.kind, medianGatherMs: median(rows.map((r) => r.gatherMs)), medianFinishMs: median(rows.map((r) => r.finishMs)), medianWallMs: median(rows.map((r) => r.wallMs))}]
    }))
    result.retainedBufferCapacities = Object.fromEntries(arms.map((arm) => [arm.label, {
        source: arm.buffers.sourceCapacity,
        destination: arm.buffers.destinationCapacity,
        dictionary: arm.buffers.dictionaryCapacity,
    }]))
    fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)
    console.log(JSON.stringify({summary: result.summary, retainedBufferCapacities: result.retainedBufferCapacities}))
}
for (const arm of arms) arm.wrapper.freeCCtx(arm.context)
