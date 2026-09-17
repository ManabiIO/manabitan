import assert from 'node:assert/strict'
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {Worker as NodeWorker} from 'node:worker_threads'
import {pathToFileURL} from 'node:url'
import path from 'node:path'

const root = process.cwd()
const dictionary = process.argv[2] ?? 'wty-en-en'
const output = path.resolve(process.argv[3] ?? 'builds/group-corpus')
const sizes = (process.argv[4] ?? '16,32,48').split(',').map(Number)
assert.ok(sizes.length && sizes.every(n => [16, 32, 48].includes(n)))
mkdirSync(output, {recursive: true})
const fixture = JSON.parse(readFileSync('test/perf/dictionaries.lock.json', 'utf8')).dictionaries[dictionary]
assert.ok(fixture)
const archivePath = path.resolve('builds/e2e-dictionary-cache', fixture.cacheFile)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
assert.equal(sha(readFileSync(archivePath)), fixture.sha256)
const manifest = JSON.parse(execFileSync('python3', ['-c', String.raw`
import json,struct,sys,zipfile,re
from pathlib import Path
archive=Path(sys.argv[1]); out=Path(sys.argv[2]); out.mkdir(parents=True,exist_ok=True)
result=[]
with archive.open('rb') as raw,zipfile.ZipFile(archive) as z:
    banks=sorted((i for i in z.infolist() if re.fullmatch(r'term_bank_\d+\.json',i.filename)),key=lambda i:int(i.filename[10:-5]))
    assert len(banks)>=4
    for info in banks:
        raw.seek(info.header_offset); header=raw.read(30)
        assert header[:4]==b'PK\x03\x04'
        name,extra=struct.unpack_from('<HH',header,26);raw.seek(name+extra,1)
        payload=raw.read(info.compress_size)
        assert len(payload)==info.compress_size and info.compress_type in (0,8)
        target=out/(info.filename+'.raw');target.write_bytes(payload)
        result.append({'filename':info.filename,'path':str(target),'compressionMethod':info.compress_type,'compressedSize':info.compress_size,'uncompressedSize':info.file_size,'signature':info.CRC})
print(json.dumps(result))
`, archivePath, path.join(output, 'compressed-input')], {encoding: 'utf8'}))

// A browser-Worker API adapter, not a substitute parser: production coordinator
// and production worker modules execute unchanged over real worker_threads.
const terminations = []
class BrowserWorker {
    constructor(url) {
        this.listeners = new Map()
        this.pending = []
        this.loaded = false
        const bridge = `import {parentPort} from 'node:worker_threads'
            globalThis.self = {addEventListener: (_, fn) => parentPort.on('message', data => fn({data})),
                postMessage: (data, transfer) => parentPort.postMessage(data, transfer)}
            await import(${JSON.stringify(String(url))})
            parentPort.postMessage({bridgeLoaded: true})`
        this.worker = new NodeWorker(new URL('data:text/javascript,' + encodeURIComponent(bridge)))
        this.worker.on('message', data => {
            if (data.bridgeLoaded === true) {
                this.loaded = true
                for (const [message, transfer] of this.pending.splice(0)) this.worker.postMessage(message, transfer)
                return
            }
            for (const fn of this.listeners.get('message') ?? []) fn({data})
        })
        this.worker.on('error', error => {
            for (const fn of this.listeners.get('error') ?? []) fn({message: error.message, error})
        })
    }
    addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set())
        this.listeners.get(type).add(fn)
    }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn) }
    postMessage(message, transfer = []) {
        if (this.loaded) this.worker.postMessage(message, transfer)
        else this.pending.push([message, transfer])
    }
    terminate() { terminations.push(this.worker.terminate()) }
}
globalThis.Worker = BrowserWorker
Object.defineProperty(globalThis, 'navigator', {value: {hardwareConcurrency: 4, deviceMemory: 8}, configurable: true})
const parser = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/term-bank-wasm-parser.js')).href)
const wasm = readFileSync('ext/lib/term-bank-parser.wasm')
parser.setTermBankWasmModule(await WebAssembly.compile(wasm))
const report = {status: 'running', dictionary, fixture, sizes, wasmSha256: sha(wasm), results: []}
const persist = () => writeFileSync(path.join(output, 'parity.json'), JSON.stringify(report, null, 2) + '\n')
async function digest(flags, spans) {
    const digest = createHash('sha256')
    const header = Buffer.alloc(32)
    const length = Buffer.alloc(4)
    const addText = value => {const bytes = Buffer.from(value); length.writeUInt32LE(bytes.length); digest.update(length).update(bytes)}
    let rows = 0, contentBytes = 0, mediaRows = 0, chunks = 0
    const accepted = await parser.parseTermBankWithWasmColumnChunksParallelCompressedLazy(
        manifest.map(entry => async () => ({...entry, bytes: Uint8Array.from(readFileSync(entry.path))})),
        manifest.map(entry => entry.uncompressedSize), 3,
        async (chunk, progress) => {
            const plan = chunk.termRecordPreinternedPlan
            assert.ok(plan)
            const offsets = plan.stringOffsets ?? new Uint32Array(plan.stringLengths.length)
            if (!plan.stringOffsets) for (let i = 1; i < offsets.length; i++) offsets[i] = offsets[i - 1] + plan.stringLengths[i - 1]
            const key = index => plan.stringsBuffer.subarray(offsets[index], offsets[index] + plan.stringLengths[index])
            const mediaByRow = new Map()
            for (const media of chunk.mediaRows) {
                if (!mediaByRow.has(media.index)) mediaByRow.set(media.index, [])
                mediaByRow.get(media.index).push(media.row)
            }
            for (let i = 0; i < chunk.rowCount; i++) {
                const expression = key(plan.expressionIndexes[i]), reading = key(plan.readingIndexes[i])
                let content = chunk.contentBytesList[i], h1 = chunk.contentHash1List[i], h2 = chunk.contentHash2List[i]
                if (chunk.contentBytesBuffer && chunk.contentMetaList) {
                    const meta = chunk.contentMetaList, start = meta[i * 4] + (chunk.contentBytesBaseOffset ?? 0), size = meta[i * 4 + 1]
                    assert.ok(start >= 0 && size <= chunk.contentBytesBuffer.length - start)
                    content = chunk.contentBytesBuffer.subarray(start, start + size)
                    h1 = meta[i * 4 + 2]; h2 = meta[i * 4 + 3]
                }
                assert.ok(content instanceof Uint8Array)
                const values = [expression.length, reading.length, chunk.scoreList[i], chunk.sequenceList[i], chunk.readingEqualsExpressionList[i] ? 1 : 0, content.length, h1, h2]
                values.forEach((v, j) => header.writeUInt32LE(v >>> 0, j * 4))
                digest.update(header).update(expression).update(reading).update(content)
                contentBytes += content.length
                const media = mediaByRow.get(i) ?? []
                length.writeUInt32LE(media.length); digest.update(length)
                for (const row of media) {addText(row.expression); addText(row.reading); addText(row.glossaryJson); addText(sha(row.termEntryContentBytes)); mediaRows++}
            }
            rows += chunk.rowCount
            assert.equal(progress.processedRows, rows)
            chunks++
            // Exercise borrowing across an asynchronous sink, not just sync reads.
            const retained = chunk.contentBytesBuffer
            const before = retained ? sha(retained) : null
            await new Promise(resolve => setImmediate(resolve))
            if (retained) assert.equal(sha(retained), before)
        }, {...flags, experimentalTermBankSpans: spans, computeContentHashes: true, emitContentSlab: true, emitTokenBinaryContent: true, mediaHintFastScan: true, singleChunk: true})
    assert.equal(accepted, true)
    assert.equal(rows, fixture.termRows)
    return {rows, contentBytes, mediaRows, chunks, sha256: digest.digest('hex'), profile: parser.consumeLastTermBankWasmParseProfile()}
}
try {
    for (const spans of [false, true]) {
        const baseline = await digest({}, spans)
        for (const size of sizes) {
            const flags = {[`experimentalParserGroups${size}MiB`]: true}
            const candidate = await digest(flags, spans)
            for (const field of ['rows', 'contentBytes', 'mediaRows', 'sha256']) assert.equal(candidate[field], baseline[field], `${dictionary}/${size}/${spans}/${field}`)
            assert.notEqual(candidate.profile.parallelGroupCount, baseline.profile.parallelGroupCount, 'Grouping experiment must change actual group boundaries')
            report.results.push({spans, size, baseline, candidate})
            persist()
            console.log(`${dictionary}: ${size} MiB, spans=${spans}, ${candidate.rows} ordered rows match`)
        }
    }
    report.status = 'success'
} catch (error) {report.status = 'failed'; report.error = error.stack; throw error}
finally {
    await parser.disposeParallelTermBankParser()
    await Promise.all(terminations)
    persist()
}
