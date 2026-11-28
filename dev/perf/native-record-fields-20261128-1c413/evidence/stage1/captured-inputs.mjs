import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {gunzipSync} from 'node:zlib'

const constructors = {Uint8Array, Uint16Array, Uint32Array, Int32Array, Float64Array}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

export function readCapturedCall(directory, receipt) {
    const compressed = readFileSync(resolve(directory, receipt.file))
    assert.equal(compressed.byteLength, receipt.archiveBytes)
    assert.equal(sha256(compressed), receipt.archiveSha256)
    const bytes = gunzipSync(compressed)
    assert.equal(sha256(bytes), receipt.containerSha256)
    const headerBytes = bytes.readUInt32LE(0)
    const metadata = JSON.parse(bytes.subarray(4, 4 + headerBytes).toString())
    assert.equal(metadata.version, 1)
    assert.equal(metadata.number, receipt.number)
    assert.equal(metadata.groupIndex, receipt.groupIndex)
    assert.equal(metadata.rowCount, receipt.rowCount)
    assert.equal(metadata.contentOffsetBase, receipt.contentOffsetBase)
    assert.deepEqual(metadata.segments, receipt.segments)
    const raw = bytes.subarray(4 + headerBytes)
    const columns = {}
    let consumed = 0
    for (const segment of metadata.segments) {
        assert.equal(segment.rawOffset, consumed)
        const data = raw.subarray(segment.rawOffset, segment.rawOffset + segment.byteLength)
        assert.equal(data.byteLength, segment.byteLength)
        assert.equal(sha256(data), segment.sha256)
        assert.equal(segment.resizable, false)
        assert.deepEqual(segment.ownShadows, [])
        const backing = new ArrayBuffer(segment.backingBytes)
        const Constructor = constructors[segment.elementKind]
        assert(Constructor)
        const view = new Constructor(backing, segment.byteOffset, segment.length)
        assert.equal(view.byteLength, segment.byteLength)
        new Uint8Array(backing, segment.byteOffset, segment.byteLength).set(data)
        columns[segment.name] = view
        consumed += data.byteLength
    }
    assert.equal(consumed, raw.byteLength)
    return {metadata, columns}
}

export function reconstructPrivateCall(capture, factory) {
    const {metadata, columns} = capture
    const input = {rowCount: metadata.rowCount, scoreList: columns.scores}
    if (metadata.fixedContentOffsetBase !== null) input.fixedContentOffsetBase = metadata.fixedContentOffsetBase
    if (metadata.fixedContentLength !== null) input.fixedContentLength = metadata.fixedContentLength
    return {
        chunk: factory(input, columns.uniqueIndexes, columns.resolvedOffsets, columns.resolvedLengths),
        contentOffsets: columns.contentOffsets,
        contentLengths: columns.contentLengths,
        base: metadata.contentOffsetBase,
        expected: columns.output,
    }
}
