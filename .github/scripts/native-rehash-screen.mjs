import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {performance} from 'node:perf_hooks'
import {pathToFileURL} from 'node:url'

const [baseline, candidate, capturePath, arm, destination] = process.argv.slice(2)
assert(baseline && candidate && capturePath && ['A', 'B', 'C'].includes(arm) && destination)
const root = arm === 'B' ? candidate : baseline
const capture = JSON.parse(await readFile(capturePath, 'utf8'))
assert(capture.complete && capture.snapshots.length > 0)
const importFrom = (file) => import(pathToFileURL(path.join(root, file)))
const {DictionaryDatabase} = await importFrom('ext/js/dictionary/dictionary-database.js')
const {NativeCanonicalScanner} = await importFrom('ext/js/dictionary/term-content-canonical-scan.js')
const {TermContentMetadataArena} = await importFrom('ext/js/dictionary/term-content-metadata-arena.js')
const wasm = await readFile(path.join(root, 'dev/data/dictionary-wasm/term-content-canonical-scan-v1.wasm'))
const module = await WebAssembly.compile(wasm)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const names = {
    slots: '_termEntryContentMetaHashPairTable', hash1: '_termEntryContentMetaHash1Table', hash2: '_termEntryContentMetaHash2Table',
    state: '_termEntryContentMetaStateTable', length: '_termEntryContentMetaLengthTable', signaturePresent: '_termEntryContentMetaSignaturePresentTable',
    signature1: '_termEntryContentMetaSignature1Table', signature2: '_termEntryContentMetaSignature2Table', signature3: '_termEntryContentMetaSignature3Table',
}
const rows = []
const output = createHash('sha256')
for (const snapshot of capture.snapshots) {
    assert(snapshot.nativeModuleAlreadyLoaded)
    const data = await readFile(path.join(path.dirname(capturePath), snapshot.file))
    assert.equal(sha256(data), snapshot.sha256)
    const db = new DictionaryDatabase()
    const previous = new TermContentMetadataArena(snapshot.oldDenseCapacity, snapshot.oldSlotCapacity)
    db._termContentMetadataArena = previous
    for (const column of snapshot.columns) {
        const view = column.kind === 'arena' ? previous[column.name] : new globalThis[column.type](column.length)
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
        bytes.set(data.subarray(column.offset, column.offset + column.byteLength))
        db[column.kind === 'arena' ? names[column.name] : column.name] = view
    }
    db._termEntryContentMetaDenseCount = snapshot.denseCount
    db._termEntryContentMetaHashPairCount = snapshot.publishedCount
    db._termEntryContentMetaHashPairPendingCount = snapshot.pendingCount
    db._termEntryContentMetaHashPairMask = snapshot.oldSlotCapacity - 1
    const scanner = new NativeCanonicalScanner({loadModule: async () => module})
    // The captured production-sequence replay has already made ordinary scans
    // before this resize. Module compilation is already paid in both arms; the
    // replacement memory's first native instance is included below.
    Reflect.set(scanner, '_module', module)
    db._nativeCanonicalScanner = scanner
    let nativeAttempts = 0
    let nativeSuccesses = 0
    if (arm === 'B') {
        const rehash = scanner.rehash.bind(scanner)
        scanner.rehash = (...args) => {
            ++nativeAttempts
            const result = rehash(...args)
            if (result) { ++nativeSuccesses }
            return result
        }
    }
    assert.equal(typeof globalThis.gc, 'function')
    globalThis.gc()
    globalThis.gc()
    const cpuBefore = process.cpuUsage()
    const resourcesBefore = process.resourceUsage()
    const started = performance.now()
    db._resizeTermContentMetadataArena(snapshot.requiredCount, snapshot.slotCapacity, snapshot.forceRehash)
    const totalMs = performance.now() - started
    const cpu = process.cpuUsage(cpuBefore)
    const resourcesAfter = process.resourceUsage()
    const current = db._termContentMetadataArena
    assert.notEqual(current, previous)
    for (const column of snapshot.columns) {
        const previousView = column.kind === 'arena' ? previous[column.name] : null
        if (previousView !== null) {
            assert(Buffer.from(previousView.buffer, previousView.byteOffset, previousView.byteLength).equals(data.subarray(column.offset, column.offset + column.byteLength)))
        }
        const nextView = db[column.kind === 'arena' ? names[column.name] : column.name]
        output.update(column.name)
        output.update(new Uint8Array(nextView.buffer, nextView.byteOffset, nextView.byteLength))
    }
    if (arm === 'B') { assert.equal(nativeSuccesses, 1) }
    rows.push({groupIndex: snapshot.groupIndex, denseCount: snapshot.denseCount,
        previousDenseCapacity: snapshot.oldDenseCapacity, previousSlotCapacity: snapshot.oldSlotCapacity,
        denseCapacity: current.state.length, slotCapacity: current.slots.length,
        totalMs, cpuMs: (cpu.user + cpu.system) / 1000,
        voluntaryContextSwitches: resourcesAfter.voluntaryContextSwitches - resourcesBefore.voluntaryContextSwitches,
        involuntaryContextSwitches: resourcesAfter.involuntaryContextSwitches - resourcesBefore.involuntaryContextSwitches,
        minorPageFaults: resourcesAfter.minorPageFault - resourcesBefore.minorPageFault,
        majorPageFaults: resourcesAfter.majorPageFault - resourcesBefore.majorPageFault,
        nativeAttempts, nativeSuccesses, nativeInstances: scanner.stats.instances})
}
const sourceFiles = [
    'ext/js/dictionary/dictionary-database.js', 'ext/js/dictionary/term-content-canonical-scan.js',
    'ext/js/dictionary/term-content-metadata-arena.js', 'ext/js/dictionary/wasm/term-content-canonical-scan-v1.c',
    'dev/data/dictionary-wasm/manifest.json',
]
const result = {arm, pid: process.pid, node: process.version, dictionary: capture.dictionary,
    scope: 'Fresh Node process and cold replacement arena. Complete production resize includes arena allocation, all live-column copies, side-column growth, rehash, new native instance and publication. Already-loaded immutable module availability matches captured prior scans. Input snapshot construction and fixed pre-measurement GC are outside the interval. B includes a one-call activation witness wrapper.',
    wasmSha256: sha256(wasm), captureSha256: sha256(await readFile(capturePath)), harnessSha256: sha256(await readFile(new URL(import.meta.url))),
    sources: Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, sha256(await readFile(path.join(root, file)))]))),
    rows, totalMs: rows.reduce((sum, row) => sum + row.totalMs, 0), cpuMs: rows.reduce((sum, row) => sum + row.cpuMs, 0),
    outputDigest: output.digest('hex')}
await writeFile(destination, `${JSON.stringify(result, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({arm, dictionary: result.dictionary, totalMs: result.totalMs, cpuMs: result.cpuMs, outputDigest: result.outputDigest})}\n`)
