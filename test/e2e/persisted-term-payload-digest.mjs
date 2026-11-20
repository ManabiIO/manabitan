/* eslint @stylistic/semi: ["error", "never"] */

// One-off, read-only post-import diagnostic. This function is self-contained so
// an external browser driver can evaluate its source in the extension origin.
// It is deliberately outside the product and the timing cohort harness.

export async function collectPersistedTermPayloadDigest(expectedRows, suppliedRoot) {
    if (!Number.isSafeInteger(expectedRows) || expectedRows <= 0) {
        throw new TypeError('A positive exact expected term-row count is required')
    }
    const root = suppliedRoot ?? await navigator.storage.getDirectory()
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    const contentPrefix = 'manabitan-term-content'
    const recordDirectoryName = 'manabitan-term-records'
    const compare = (a, b) => {
        if (a === b) { return 0 }
        return a < b ? -1 : 1
    }
    const hex = (bytes) => [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('')
    const hash = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes))
    const requireCondition = (condition, message) => {
        if (!condition) { throw new Error(message) }
    }

    async function inventory() {
        const files = []
        const contentIndexes = []
        let recordDirectory
        for await (const [name, handle] of root.entries()) {
            if (name === recordDirectoryName) {
                requireCondition(handle.kind === 'directory', 'Term-record storage is not a directory')
                recordDirectory = handle
                continue
            }
            if (!name.startsWith(contentPrefix)) { continue }
            const match = /^manabitan-term-content(?:\^([1-9][0-9]*))?\.bin$/.exec(name)
            requireCondition(match !== null && handle.kind === 'file', `Unexpected term-content entry: ${name}`)
            const segment = match[1] === undefined ? 0 : Number(match[1])
            requireCondition(Number.isSafeInteger(segment), `Invalid content segment index: ${name}`)
            contentIndexes.push(segment)
            const file = await handle.getFile()
            files.push({path: name, kind: 'content', handle, file})
        }
        contentIndexes.sort((a, b) => a - b)
        requireCondition(contentIndexes.length > 0, 'No persisted term-content files')
        requireCondition(contentIndexes.every((value, index) => value === index), 'Content segment indexes are not contiguous from zero')
        requireCondition(recordDirectory !== undefined, 'No persisted term-record directory')
        for await (const [name, handle] of recordDirectory.entries()) {
            requireCondition(handle.kind === 'file' && /^dict-.+\.mbtr(?:\.mbti)?$/.test(name), `Unexpected term-record entry: ${name}`)
            const file = await handle.getFile()
            files.push({path: `${recordDirectoryName}/${name}`, kind: name.endsWith('.mbti') ? 'index' : 'record', handle, file})
        }
        files.sort((a, b) => compare(a.path, b.path))
        requireCondition(files.some(({kind}) => kind === 'record'), 'No persisted term-record descriptors')
        return files
    }

    const initial = await inventory()
    const byPath = new Map(initial.map((entry) => [entry.path, entry]))
    const generations = new Map()
    const pairs = []
    let rowCount = 0
    for (const entry of initial) {
        if (entry.kind === 'content') { continue }
        if (entry.kind === 'index') {
            requireCondition(byPath.get(entry.path.slice(0, -5))?.kind === 'record', `Index has no descriptor: ${entry.path}`)
            continue
        }
        const index = byPath.get(`${entry.path}.mbti`)
        requireCondition(index?.kind === 'index', `Descriptor has no index: ${entry.path}`)
        requireCondition(entry.file.size >= 26 && index.file.size >= 40, `Truncated record/index header: ${entry.path}`)
        const recordHeader = new Uint8Array(await entry.file.slice(0, 24).arrayBuffer())
        const indexHeader = new Uint8Array(await index.file.slice(0, 40).arrayBuffer())
        requireCondition(decoder.decode(recordHeader.subarray(0, 8)) === 'MBTRD16X', `Unrecognized descriptor format: ${entry.path}`)
        requireCondition(decoder.decode(indexHeader.subarray(0, 8)) === 'MBTIDX11', `Unrecognized index format: ${index.path}`)
        const recordGeneration = hex(recordHeader.subarray(8, 24))
        const indexGeneration = hex(indexHeader.subarray(24, 40))
        requireCondition(recordGeneration === indexGeneration, `Descriptor/index generation mismatch: ${entry.path}`)
        const view = new DataView(indexHeader.buffer)
        const descriptorBytes = view.getBigUint64(8, true)
        const chunkCount = view.getUint32(16, true)
        const rows = view.getUint32(20, true)
        requireCondition(descriptorBytes === BigInt(entry.file.size), `Descriptor length mismatch: ${entry.path}`)
        requireCondition(chunkCount > 0 && rows > 0, `Empty persisted index: ${index.path}`)
        requireCondition(40 + chunkCount * 40 + rows * 8 <= index.file.size, `Implausible persisted index length: ${index.path}`)
        rowCount += rows
        requireCondition(Number.isSafeInteger(rowCount), 'Persisted row count exceeds the safe integer range')
        generations.set(entry.path, recordGeneration)
        generations.set(index.path, indexGeneration)
        pairs.push({descriptor: entry.path, index: index.path, generation: recordGeneration, chunkCount, rows})
    }
    requireCondition(rowCount === expectedRows, `Persisted header rows ${rowCount} do not equal expected rows ${expectedRows}`)

    const files = []
    for (const entry of initial) {
        // Read one file at a time. No storage handle is opened for writing and
        // normalization changes only this private in-memory copy.
        const bytes = new Uint8Array(await entry.file.arrayBuffer())
        requireCondition(bytes.byteLength === entry.file.size, `Short read: ${entry.path}`)
        const rawSha256 = await hash(bytes)
        let excludedRange = null
        if (entry.kind !== 'content') {
            const start = entry.kind === 'record' ? 8 : 24
            excludedRange = {offset: start, length: 16, field: 'shardGenerationId'}
            requireCondition(hex(bytes.subarray(start, start + 16)) === generations.get(entry.path), `Generation changed during read: ${entry.path}`)
            bytes.fill(0, start, start + 16)
        }
        const normalizedSha256 = excludedRange === null ? rawSha256 : await hash(bytes)
        files.push({path: entry.path, kind: entry.kind, bytes: bytes.byteLength, rawSha256, normalizedSha256, excludedRange})
    }

    const final = await inventory()
    const snapshot = (entries) => entries.map(({path, kind, file}) => ({path, kind, bytes: file.size, lastModified: file.lastModified}))
    requireCondition(JSON.stringify(snapshot(initial)) === JSON.stringify(snapshot(final)), 'Persisted file inventory changed during digest')
    const normalizedManifest = files.map(({path, bytes, normalizedSha256}) => ({path, bytes, sha256: normalizedSha256}))
    const rawManifest = files.map(({path, bytes, rawSha256}) => ({path, bytes, sha256: rawSha256}))
    return {
        schemaVersion: 1,
        coverage: 'Every byte of all term-content segments and every term-record descriptor/index in this origin',
        normalization: 'Only paired MBTRD16X bytes [8,24) and MBTIDX11 bytes [24,40) are zeroed after generation equality is verified',
        excludedByteCount: pairs.length * 32,
        rowCount,
        fileCount: files.length,
        totalBytes: files.reduce((sum, {bytes}) => sum + bytes, 0),
        rawManifestSha256: await hash(encoder.encode(JSON.stringify(rawManifest))),
        normalizedManifestSha256: await hash(encoder.encode(JSON.stringify(normalizedManifest))),
        files,
        pairs,
        inventoryStable: true,
    }
}
