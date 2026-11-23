import fs from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import path from 'node:path'

const [root, archivePath, output] = process.argv.slice(2)
const require = createRequire(path.join(root, 'package.json'))
const {ZipReader, Uint8ArrayReader, Uint8ArrayWriter} = await import(pathToFileURL(require.resolve('@zip.js/zip.js')))
const parser = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/term-bank-wasm-parser.js')))
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const archive = await fs.readFile(archivePath)
const archiveSha256 = hash(archive)
if (archiveSha256 !== 'e914c76596220dffc6ee0c069cd05992f03adb2988c12c3cebe817a3ac271356') throw new Error('Wrong Jitendex archive')
const wasm = await fs.readFile(path.join(root, 'ext/lib/term-bank-parser.wasm'))
parser.setTermBankWasmModule(await WebAssembly.compile(wasm))
await fs.mkdir(output, {recursive: true})
const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(archive)))
const entries = (await reader.getEntries()).filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
    .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
const groups = []
const previous = new Map()
const inputDigest = createHash('sha256')
let rows = 0
let sourceJsonBytes = 0
let uniqueContents = 0
let persistedHits = 0
let sourceBytes = 0
let selectedBytes = 0
for (let start = 0; start < entries.length; start += 10) {
    const banks = []
    for (const entry of entries.slice(start, start + 10)) {
        const bytes = await entry.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true})
        sourceJsonBytes += bytes.byteLength
        banks.push(bytes)
    }
    let stable
    await parser.parseTermBankWithWasmColumnChunks(banks, 3, (chunk) => {
        stable = parser.copyWasmBackedColumnChunk(chunk, false, true)
    }, 2048, {
        singleChunk: true,
        emitTermByteLists: false,
        computeContentHashes: true,
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        mediaHintFastScan: true,
        validateGlossaryTypes: true,
        prepareLookupIndexes: true,
        projectImagePaths: true,
    })
    if (!stable || !(stable.contentBytesBuffer.buffer instanceof ArrayBuffer)) throw new Error('Missing owned content')
    const source = stable.contentBytesBuffer
    const offsets = []
    const lengths = []
    const uniqueRows = stable.contentDedupPlan.uniqueRowIndexes
    for (const row of uniqueRows) {
        const m = row * 4
        const offset = stable.contentBytesBaseOffset + stable.contentMetaList[m]
        const length = stable.contentMetaList[m + 1]
        const key = `${stable.contentMetaList[m + 2]}:${stable.contentMetaList[m + 3]}`
        const bytes = Buffer.from(source.buffer, source.byteOffset + offset, length)
        const peers = previous.get(key)
        if (peers?.some((peer) => bytes.equals(peer))) {
            persistedHits++
            continue
        }
        if (peers) peers.push(bytes)
        else previous.set(key, [bytes])
        offsets.push(offset)
        lengths.push(length)
        selectedBytes += length
    }
    const offsetBytes = new Uint8Array(Uint32Array.from(offsets).buffer)
    const lengthBytes = new Uint8Array(Uint32Array.from(lengths).buffer)
    const index = groups.length
    const files = {source: `group-${index}-source.bin`, offsets: `group-${index}-offsets.bin`, lengths: `group-${index}-lengths.bin`}
    await fs.writeFile(path.join(output, files.source), source)
    await fs.writeFile(path.join(output, files.offsets), offsetBytes)
    await fs.writeFile(path.join(output, files.lengths), lengthBytes)
    for (const bytes of [source, offsetBytes, lengthBytes]) inputDigest.update(bytes)
    groups.push({files, rows: stable.rowCount, uniqueRows: uniqueRows.length, selected: offsets.length,
        sourceBytes: source.byteLength, hashes: {source: hash(source), offsets: hash(offsetBytes), lengths: hash(lengthBytes)}})
    rows += stable.rowCount
    uniqueContents += uniqueRows.length
    sourceBytes += source.byteLength
}
await reader.close()
if (rows !== 436555 || entries.length !== 219 || groups.length !== 22) throw new Error('Incomplete Jitendex preparation')
const manifest = {archivePath, archiveSha256, archiveBytes: archive.byteLength, sourceRoot: root,
    wasmSha256: hash(wasm), node: process.version, rows, banks: entries.length, filesPerGroup: 10,
    sourceJsonBytes, sourceBytes, uniqueContents, persistedHits, selectedContents: uniqueContents - persistedHits,
    selectedBytes, inputDigest: inputDigest.digest('hex'),
    preparation: 'Production native parser plus copyWasmBackedColumnChunk(chunk,false,true); native unique representatives plus cross-group hash-pair and exact-byte equality; fixed component groups, not production planner override',
    groups}
await fs.writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(JSON.stringify({...manifest, groups: manifest.groups.length}))
