import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {appendFileSync, createReadStream, mkdirSync, openAsBlob, readFileSync, writeFileSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {performance} from 'node:perf_hooks'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {gzipSync} from 'node:zlib'
import {hostSnapshot} from './crc-powers-host-snapshot.mjs'

const baseline = path.resolve(process.env.MANABITAN_CRC_BASELINE_ROOT ?? 'baseline')
const candidate = path.resolve(process.env.MANABITAN_CRC_CANDIDATE_ROOT ?? 'candidate')
const fixtures = path.resolve(process.env.MANABITAN_CRC_FIXTURE_ROOT ?? 'fixtures')
const output = path.resolve(process.env.CRC_POWERS_VERIFIER_OUTPUT ?? 'crc-powers-evidence')
mkdirSync(output, {recursive: true})
const orders = ['ABC', 'BCA', 'CAB', 'CBA', 'BAC', 'ACB']
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const hashFile = async (path) => {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}
const expected = {
  baseline: '8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee',
  candidate: '742efd71c5a0635a71e444ffc385f9c99c6c31b4a28d939277ce3b99eb11105c',
}
const expectedTotals = {rows: 6648310, jsonBytes: 4267992967, scannedBytes: 568284368,
  reusedBytes: 3699708599, reusedGlossaries: 6490145}

function sumRows(rows, name) {
  return rows.reduce((sum, row) => sum + row[name], 0)
}

function host() {
  const state = hostSnapshot()
  // Preserve a host observation around every timed native call while avoiding
  // unrelated runtime inventory repeated thousands of times in the raw result.
  return {capturedAtIso: state.capturedAtIso, loadAverage: state.loadAverage,
    freeMemoryBytes: state.freeMemoryBytes, memoryUsage: state.memoryUsage,
    cpuPressure: state.cpuPressure, memoryPressure: state.memoryPressure,
    procLoadAverage: state.procLoadAverage, visibleProcesses: state.visibleProcesses,
    processVisibility: state.processVisibility}
}

if (process.argv[2] === '--child') {
  const pass = Number(process.argv[3])
  const smoke = process.argv[4] === '--smoke'
  assert(Number.isInteger(pass) && pass >= 0 && pass < orders.length)
  const name = smoke ? 'crc-powers-verifier-smoke' : `crc-powers-verifier-pass-${pass}`
  const checkpointPath = output + '/' + name + '-checkpoints.jsonl.gz'
  const checkpoint = (value) => appendFileSync(checkpointPath, gzipSync(JSON.stringify(value) + '\n'))
  writeFileSync(checkpointPath, new Uint8Array(0), {flag: 'wx'})
  const report = {pass, smoke, node: process.version, groups: [], complete: false,
    orderRule: 'orders[(groupIndex + pass) % 6], where orders = ABC BCA CAB CBA BAC ACB',
    sourceModuleOrder: pass % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'],
    controls: {}, moduleBytes: {}, sourceIdentities: {}, peakLogicalHeapBytes: 0, peakDeclaredSnapshotBytes: 0}
  const save = () => {
    const bytes = gzipSync(JSON.stringify(report))
    writeFileSync(output + '/' + name + '.json.gz', bytes)
    return {file: name + '.json.gz', bytes: bytes.byteLength, sha256: sha256(bytes)}
  }
  const nativeInstantiate = WebAssembly.instantiate
  let zip
  try {
    const fixture = JSON.parse(await readFile(baseline + '/test/perf/dictionaries.lock.json')).dictionaries.vndb
    const archivePath = path.join(fixtures, fixture.cacheFile)
    assert.equal(await hashFile(archivePath), fixture.sha256)
    report.fixture = fixture
    report.host = hostSnapshot()
    const modules = {}
    for (const variant of report.sourceModuleOrder) {
      const root = variant === 'baseline' ? baseline : candidate
      const bytes = await readFile(root + '/ext/lib/term-bank-parser.wasm')
      assert.equal(sha256(bytes), expected[variant])
      report.moduleBytes[variant] = bytes.byteLength
      report.sourceIdentities[variant] = {wasmSha256: expected[variant],
        cSha256: await hashFile(root + '/ext/js/dictionary/wasm/term-bank-parser.c')}
      const before = performance.now()
      modules[variant] = await WebAssembly.compile(bytes)
      report.controls[variant] = {compileMs: performance.now() - before}
      assert.deepEqual(WebAssembly.Module.imports(modules[variant]), [])
    }
    checkpoint({kind: 'preparedModules', pass, sourceIdentities: report.sourceIdentities, moduleBytes: report.moduleBytes})
    const clones = {}
    for (const arm of orders[pass]) {
      const variant = arm === 'B' ? 'candidate' : 'baseline'
      const before = performance.now()
      const instance = await nativeInstantiate(modules[variant])
      const instantiateMs = performance.now() - before
      const wasm = instance.exports
      wasm.wasm_reset_heap()
      const heapBase = wasm.wasm_alloc(0)
      assert(heapBase > 0)
      clones[arm] = {wasm, heapBase}
      report.controls[arm] = {instantiateMs, heapBase, initialHeapBytes: wasm.memory.buffer.byteLength}
    }
    const maximumHeapBase = Math.max(...Object.values(clones).map((clone) => clone.heapBase))
    const {readDenseZipDirectory} = await import(pathToFileURL(baseline + '/ext/js/dictionary/dense-zip-directory.js'))
    const {BlobReader, ZipReader} = await import(pathToFileURL(baseline + '/node_modules/@zip.js/zip.js/index.js'))
    const {RawZipPayloadReader} = await import(pathToFileURL(baseline + '/ext/js/dictionary/term-bank-source-pipeline.js'))
    const parser = await import(pathToFileURL(baseline + '/ext/js/dictionary/term-bank-wasm-parser.js'))
    const archive = await openAsBlob(archivePath)
    const dense = await readDenseZipDirectory(archive)
    zip = dense === null ? new ZipReader(new BlobReader(archive), {useWebWorkers: false}) : null
    const entries = (dense ?? await zip.getEntries()).filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
      .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
    const source = new RawZipPayloadReader(archive)
    const totalBytes = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0)
    const hasMedia = fixture.mediaFiles > 0
    const projectImagePaths = hasMedia && totalBytes >= 1024 * 1024 * 1024
    const largeProjectedImport = projectImagePaths && totalBytes >= 512 * 1024 * 1024
    assert(largeProjectedImport)
    report.options = {singleChunk: true, maxPendingChunks: 1, emitTermByteLists: false,
      computeContentHashes: true, emitContentSlab: true, emitTokenBinaryContent: true,
      mediaHintFastScan: hasMedia, projectImagePaths, validateGlossaryTypes: true,
      ownContentBytes: largeProjectedImport, experimentalNativeEscapedKeys: largeProjectedImport,
      prepareLookupIndexes: true, prepareLookupRoute: true, compactContentMetadata: true}
    const count = Math.min(entries.length, Math.max(3 * (hasMedia ? 3 : 4), Math.ceil(totalBytes / (24 * 1024 * 1024))))
    const groups = []
    let start = 0
    let consumed = 0
    for (let index = 0; index < count - 1; ++index) {
      const target = (totalBytes - consumed) / (count - index)
      let end = start + 1
      let size = entries[start].uncompressedSize
      const maxEnd = entries.length - (count - index - 1)
      while (end < maxEnd) {
        const next = size + entries[end].uncompressedSize
        if (Math.abs(next - target) > Math.abs(size - target)) break
        size = next
        ++end
      }
      groups.push(entries.slice(start, end))
      start = end
      consumed += size
    }
    groups.push(entries.slice(start))
    assert.equal(groups.length, 170)
    parser.setTermBankWasmModule(modules.baseline)
    let activeGroup = -1
    let activeCalls = 0
    WebAssembly.instantiate = async (...arguments_) => {
      const instance = await nativeInstantiate(...arguments_)
      if (arguments_[0] !== modules.baseline) return instance
      assert(instance instanceof WebAssembly.Instance)
      const wasm = instance.exports
      return {exports: {...wasm, verify_term_bank_source_crcs: (...args) => {
        ++activeCalls
        assert.equal(args.length, 9)
        const rows = args[6]
        assert(rows > 0, 'Unexpected fallback without row witnesses')
        // Snapshot only the five declared immutable inputs and witness IDs.
        // Never copy globals, constants, stack, allocator state or unused heap.
        const regions = [
          {name: 'source', argument: 0, length: args[1]},
          {name: 'bankSpans', argument: 2, length: args[3] * 8},
          {name: 'signatures', argument: 4, length: args[3] * 4},
          {name: 'metas', argument: 5, length: rows * 17 * 4},
          {name: 'witnesses', argument: 7, length: rows * 4},
        ].map((region) => ({...region, pointer: args[region.argument],
          bytes: new Uint8Array(new Uint8Array(wasm.memory.buffer, args[region.argument], region.length))}))
        for (const region of regions) assert(region.pointer > 0)
        assert(args[8] > 0)
        const minimumPointer = Math.min(args[8], ...regions.map((region) => region.pointer))
        // A common page-multiple translation keeps all relative distances and
        // alignments but also places every input above both modules' heap base.
        const translation = Math.max(4096, Math.ceil((maximumHeapBase - minimumPointer + 16) / 4096) * 4096)
        const translatedArgs = [...args]
        for (const index of [0, 2, 4, 5, 7, 8]) translatedArgs[index] += translation
        const sorted = [...regions.map(({pointer, length}) => ({pointer: pointer + translation, length})),
          {pointer: translatedArgs[8], length: 12}].sort((a, b) => a.pointer - b.pointer)
        assert(sorted[0].pointer >= maximumHeapBase)
        for (let index = 1; index < sorted.length; ++index) {
          assert(sorted[index - 1].pointer + sorted[index - 1].length <= sorted[index].pointer,
            'Unexpected overlapping verifier input/output regions')
        }
        const end = Math.max(...sorted.map((region) => region.pointer + region.length))
        const requiredPages = Math.ceil(end / 65536)
        const inputHash = createHash('sha256')
        for (const region of regions) inputHash.update(region.bytes)
        const row = {index: activeGroup, rows, jsonBytes: args[1], bankCount: args[3],
          inputSha256: inputHash.digest('hex'), translation,
          declaredSnapshotBytes: regions.reduce((sum, region) => sum + region.length, 0),
          order: orders[(activeGroup + pass) % orders.length], arms: {}}
        let referenceWitnesses
        let referenceStats
        for (const arm of row.order) {
          const clone = clones[arm].wasm
          const currentPages = clone.memory.buffer.byteLength / 65536
          if (requiredPages > currentPages) clone.memory.grow(requiredPages - currentPages)
          for (const region of regions) new Uint8Array(clone.memory.buffer, region.pointer + translation, region.length).set(region.bytes)
          new Uint32Array(clone.memory.buffer, translatedArgs[8], 3).fill(0xa55a12ef)
          const beforeHeap = clone.memory.buffer.byteLength
          const hostBefore = host()
          const processBefore = process.cpuUsage()
          const threadBefore = process.threadCpuUsage()
          const before = performance.now()
          const status = clone.verify_term_bank_source_crcs(...translatedArgs)
          const wallMs = performance.now() - before
          const thread = process.threadCpuUsage(threadBefore)
          const processCpu = process.cpuUsage(processBefore)
          const hostAfter = host()
          const measured = {wallMs, threadCpuMs: (thread.user + thread.system) / 1000,
            processCpuMs: (processCpu.user + processCpu.system) / 1000,
            heapBytes: beforeHeap, status, hostBefore, hostAfter}
          // Persist each observation before validation so a later failure or
          // process kill cannot erase already measured first calls.
          checkpoint({kind: 'measurement', pass, group: activeGroup, arm, measured})
          assert.equal(status, 0)
          assert.equal(clone.memory.buffer.byteLength, beforeHeap)
          const witnesses = new Uint8Array(new Uint8Array(clone.memory.buffer, translatedArgs[7], rows * 4))
          const stats = [...new Uint32Array(clone.memory.buffer, translatedArgs[8], 3)]
          for (const region of regions) {
            if (region.name === 'witnesses') continue
            assert.equal(Buffer.compare(region.bytes, new Uint8Array(clone.memory.buffer, region.pointer + translation, region.length)), 0,
              'Verifier changed immutable ' + region.name)
          }
          if (referenceWitnesses === undefined) { referenceWitnesses = witnesses; referenceStats = stats }
          else { assert.equal(Buffer.compare(referenceWitnesses, witnesses), 0); assert.deepEqual(stats, referenceStats) }
          row.arms[arm] = {...measured, witnessesSha256: sha256(witnesses), stats}
        }
        assert(referenceWitnesses && referenceStats)
        new Uint8Array(wasm.memory.buffer, args[7], rows * 4).set(referenceWitnesses)
        new Uint32Array(wasm.memory.buffer, args[8], 3).set(referenceStats)
        row.scannedBytes = referenceStats[0]
        row.reusedBytes = referenceStats[1]
        row.reusedGlossaries = referenceStats[2]
        row.logicalHeapBytes = wasm.memory.buffer.byteLength + Object.values(clones).reduce((sum, {wasm: clone}) => sum + clone.memory.buffer.byteLength, 0)
        report.peakLogicalHeapBytes = Math.max(report.peakLogicalHeapBytes, row.logicalHeapBytes)
        report.peakDeclaredSnapshotBytes = Math.max(report.peakDeclaredSnapshotBytes, row.declaredSnapshotBytes)
        report.groups.push(row)
        checkpoint({kind: 'validatedGroup', pass, group: activeGroup, rows: row.rows, inputSha256: row.inputSha256,
          witnessesSha256: row.arms.A.witnessesSha256, stats: referenceStats,
          logicalHeapBytes: row.logicalHeapBytes, declaredSnapshotBytes: row.declaredSnapshotBytes})
        return 0
      }}}
    }
    for (const [index, group] of groups.entries()) {
      activeGroup = index
      activeCalls = 0
      const inputs = []
      for (const entry of group) {
        const bytes = await source.read(entry, new AbortController().signal)
        assert(bytes instanceof Uint8Array)
        inputs.push({bytes, compressionMethod: entry.compressionMethod, compressedSize: entry.compressedSize,
          uncompressedSize: entry.uncompressedSize, signature: entry.signature, filename: entry.filename})
      }
      const preloadedSource = await parser.inflateCompressedTermBankSourcesWasm(inputs, {}, true)
      let rows = 0
      await parser.parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, (chunk) => { rows += chunk.rowCount }, 2048,
        {...report.options, preloadedSource})
      const profile = parser.consumeLastTermBankWasmParseProfile()
      assert(profile !== null && rows === profile.rowCount)
      assert.equal(activeCalls, 1)
      assert.equal(report.groups[index].rows, rows)
      assert.equal(preloadedSource.crcScannedBytes, report.groups[index].scannedBytes)
      assert.equal(preloadedSource.crcReusedBytes, report.groups[index].reusedBytes)
      assert.equal(preloadedSource.crcReusedGlossaryCount, report.groups[index].reusedGlossaries)
      assert.equal(profile.fusedParseFallbacks, 0)
      globalThis.gc?.()
      if (index % 10 === 0 || index + 1 === groups.length) process.stderr.write(`pass${pass}: ${index + 1}/${groups.length} groups\n`)
      if (smoke) break
    }
    report.totals = Object.fromEntries(Object.keys(expectedTotals).map((name) => [name, sumRows(report.groups, name)]))
    if (!smoke) assert.deepEqual(report.totals, expectedTotals)
    report.timings = Object.fromEntries([...'ABC'].map((arm) => [arm,
      Object.fromEntries(['wallMs', 'threadCpuMs', 'processCpuMs'].map((metric) => [metric,
        report.groups.reduce((sum, row) => sum + row.arms[arm][metric], 0)]))]))
    report.coldFirstGroup = report.groups[0]
    report.oracleDigest = sha256(report.groups.map((row) => row.inputSha256 + row.arms.A.witnessesSha256).join('\n'))
    assert.equal(await hashFile(archivePath), fixture.sha256)
    for (const [variant, root] of [['baseline', baseline], ['candidate', candidate]]) {
      assert.equal(await hashFile(root + '/ext/lib/term-bank-parser.wasm'), expected[variant])
      assert.equal(await hashFile(root + '/ext/js/dictionary/wasm/term-bank-parser.c'), report.sourceIdentities[variant].cSha256)
    }
    report.complete = true
    const raw = save()
    console.log(JSON.stringify({pass, smoke, raw, groups: report.groups.length, totals: report.totals,
      timings: report.timings, oracleDigest: report.oracleDigest, controls: report.controls,
      moduleBytes: report.moduleBytes, sourceIdentities: report.sourceIdentities,
      peakLogicalHeapBytes: report.peakLogicalHeapBytes, peakDeclaredSnapshotBytes: report.peakDeclaredSnapshotBytes}))
  } catch (error) {
    report.failure = error.stack ?? String(error)
    save()
    throw error
  } finally {
    WebAssembly.instantiate = nativeInstantiate
    await zip?.close()
  }
} else {
  const smoke = process.argv[2] === '--smoke'
  const report = {createdAt: new Date().toISOString(), complete: false, smoke,
    runnerSha256: sha256(readFileSync(fileURLToPath(import.meta.url))), orders, observations: [],
    scope: 'Full native source CRC verifier only, on every actual VNDB group. The unmodified baseline production inflate/parser emits each invocation input once. Only declared input regions are copied into exact baseline/candidate modules, shifted by one common page multiple above all static data and stack; output witness CRCs and stats are compared byte-for-byte and returned to the parser. Three verifier instances and one parser instance are retained with explicit peak accounting. Allocation/copying/oracles/host snapshots/ZIP/parser/transport/storage/compression are outside verifier timing.',
    controls: 'Six fresh processes, all170groups each; every group uses one of six balanced A/B/C orders rotated by process and group. A/C have identical module bytes. Each verifier uses its first-call initialization naturally and persists for the pass; no warmups, retries or outlier rejection. Module compile/init timing is separate. Fresh process and existing production parser module code sharing mean this is not a browser import benchmark.',
  }
  const save = () => writeFileSync(output + '/crc-powers-verifier-' + (smoke ? 'smoke-summary' : 'screen') + '.json', JSON.stringify(report, null, 2))
  for (let pass = 0; pass < (smoke ? 1 : 6); ++pass) {
    const arguments_ = ['--expose-gc', fileURLToPath(import.meta.url), '--child', String(pass)]
    if (smoke) arguments_.push('--smoke')
    const result = spawnSync(process.execPath, arguments_, {encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 300000})
    writeFileSync(output + '/crc-powers-verifier-' + (smoke ? 'smoke' : 'pass-' + pass) + '-child.log', result.stderr ?? '')
    if (result.status !== 0) {
      report.failure = {pass, status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr}
      save()
      throw new Error(JSON.stringify(report.failure))
    }
    const observation = JSON.parse(result.stdout)
    if (report.observations.length > 0) assert.equal(observation.oracleDigest, report.observations[0].oracleDigest)
    report.observations.push(observation)
    save()
    console.log(JSON.stringify(observation))
  }
  assert.equal(sha256(readFileSync(fileURLToPath(import.meta.url))), report.runnerSha256, 'Runner changed during acquisition')
  report.complete = true
  save()
}
