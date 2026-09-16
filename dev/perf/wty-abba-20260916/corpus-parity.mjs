import assert from 'node:assert/strict'
import {readFile, writeFile, mkdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import path from 'node:path'
import {parseTermBankWithWasmColumnChunks, setTermBankWasmModule, consumeLastTermBankWasmParseProfile} from '../../ext/js/dictionary/term-bank-wasm-parser.js'

const execFileAsync = promisify(execFile)
const flags = JSON.parse(process.argv[2] ?? '{"experimentalLargerFusedCapacity":true,"experimentalFusedSingleBank":true}')
const output = process.argv[3] ?? 'builds/wty-parity'
await mkdir(output, {recursive: true})
const fixture = JSON.parse(await readFile('test/perf/dictionaries.lock.json', 'utf8')).dictionaries['wty-en-en']
const archivePath = path.join('builds/e2e-dictionary-cache', fixture.cacheFile)
const archive = await readFile(archivePath)
assert.equal(archive.length, fixture.sizeBytes)
assert.equal(createHash('sha256').update(archive).digest('hex'), fixture.sha256)
const wasm = await readFile('ext/lib/term-bank-parser.wasm')
setTermBankWasmModule(await WebAssembly.compile(wasm))
const report = {fixture, flags, wasmSha256: createHash('sha256').update(wasm).digest('hex'), rows: 0, banks: [], status: 'running'}
async function save() { await writeFile(path.join(output, 'parity.json'), JSON.stringify(report, null, 2) + '\n') }
async function digestBank(bytes, options) {
    const digest = createHash('sha256')
    let rows = 0
    const header = Buffer.alloc(32)
    await parseTermBankWithWasmColumnChunks([bytes], 3, chunk => {
        const plan = chunk.termRecordPreinternedPlan
        const offsets = plan.stringOffsets ?? new Uint32Array(plan.stringLengths.length)
        if (!(plan.stringOffsets instanceof Uint32Array)) {
            for (let i = 1; i < offsets.length; ++i) { offsets[i] = offsets[i - 1] + plan.stringLengths[i - 1] }
        }
        const key = index => plan.stringsBuffer.subarray(offsets[index], offsets[index] + plan.stringLengths[index])
        for (let i = 0; i < chunk.rowCount; ++i) {
            const expression = key(plan.expressionIndexes[i])
            const reading = key(plan.readingIndexes[i])
            let content = chunk.contentBytesList[i]
            let h1 = chunk.contentHash1List[i]
            let h2 = chunk.contentHash2List[i]
            if (chunk.contentBytesBuffer && chunk.contentMetaList) {
                const meta = chunk.contentMetaList
                const offset = meta[i * 4] + (chunk.contentBytesBaseOffset ?? 0)
                const length = meta[i * 4 + 1]
                assert(offset >= 0 && length <= chunk.contentBytesBuffer.length - offset)
                content = chunk.contentBytesBuffer.subarray(offset, offset + length)
                h1 = meta[i * 4 + 2]
                h2 = meta[i * 4 + 3]
            }
            const values = [expression.length, reading.length, chunk.scoreList[i], chunk.sequenceList[i], chunk.readingEqualsExpressionList[i] ? 1 : 0, content.length, h1, h2]
            values.forEach((value, field) => header.writeUInt32LE(value >>> 0, field * 4))
            digest.update(header).update(expression).update(reading).update(content)
        }
        rows += chunk.rowCount
    }, 8192, {...options, computeContentHashes: true, emitContentSlab: true, emitTokenBinaryContent: true, mediaHintFastScan: true, singleChunk: true, prepareLookupIndexes: false})
    return {rows, sha256: digest.digest('hex'), profile: consumeLastTermBankWasmParseProfile()}
}
try {
    const {stdout: listing} = await execFileAsync('unzip', ['-Z1', archivePath], {encoding: 'utf8', maxBuffer: 4 * 1024 * 1024})
    const entries = listing.split(/\r?\n/).filter(name => /^term_bank_\d+\.json$/.test(name)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    assert.equal(entries.length, 67)
    for (const filename of entries) {
        const {stdout} = await execFileAsync('unzip', ['-p', archivePath, filename], {encoding: 'buffer', maxBuffer: 256 * 1024 * 1024})
        const bytes = new Uint8Array(stdout.buffer, stdout.byteOffset, stdout.byteLength)
        assert(bytes.byteLength < 200 * 1024 * 1024)
        const baseline = await digestBank(bytes, {})
        const candidate = await digestBank(bytes, flags)
        assert.equal(candidate.rows, baseline.rows, filename)
        assert.equal(candidate.sha256, baseline.sha256, filename)
        report.rows += baseline.rows
        report.banks.push({filename, size: bytes.length, baseline, candidate})
        await save()
        console.log(`${filename}: ${baseline.rows} rows, exact key/content/hash equality`)
    }
    assert.equal(report.rows, fixture.termRows)
    report.status = 'success'
} catch (error) {
    report.status = 'failed'
    report.error = error.stack
    throw error
} finally {
    await save()
}
