// Diagnostic-only observer. It returns original promises and retains no source
// arrays after hashing their current values. No latency result is qualified.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const viewBytes = (view) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
const hashColumn = (view) => hash(viewBytes(view))

export async function installCompressionObserver(db, moduleUrl, getGroupIndex) {
    const {TermContentCompressionPool} = await import(moduleUrl('ext/js/dictionary/zstd-term-content.js'))
    const groups = []
    const pending = []
    function observe(promise) {
        pending.push(promise)
        void promise.catch(() => {})
    }
    function captureReferences(group, stored) {
        group.references = {
            count: stored.contentOffsets.length,
            offsetsSha256: hashColumn(stored.contentOffsets),
            lengthsSha256: hashColumn(stored.contentLengths),
            contentDictName: stored.contentDictName,
        }
    }
    for (const method of ['_beginAppendSharedSpans', '_tryAppendSharedSpans']) {
        const original = db._termContentBlockStore[method]
        assert.equal(typeof original, 'function')
        db._termContentBlockStore[method] = function (source, offsets, lengths, ...rest) {
            const group = {
                index: getGroupIndex(),
                method,
                sourceBytes: source.byteLength,
                originalDescriptorCount: offsets.length,
                originalColumnBytes: offsets.byteLength + lengths.byteLength,
                originalOffsetsSha256: hashColumn(offsets),
                originalLengthsSha256: hashColumn(lengths),
                originalOffsetsPrivate: offsets.buffer instanceof ArrayBuffer,
                originalLengthsPrivate: lengths.buffer instanceof ArrayBuffer,
            }
            assert.equal(groups.some(({index}) => index === group.index), false)
            groups.push(group)
            const operation = original.call(this, source, offsets, lengths, ...rest)
            if (method === '_beginAppendSharedSpans') {
                observe(operation.storage.then((stored) => captureReferences(group, stored)))
                observe(operation.completion.then((stored) => {
                    group.finalCompressedBytes = stored.compressedBytes
                    group.finalUncompressedBytes = stored.uncompressedBytes
                }))
            } else {
                observe(operation.then((stored) => {
                    assert(stored)
                    captureReferences(group, stored)
                    group.finalCompressedBytes = stored.compressedBytes
                    group.finalUncompressedBytes = stored.uncompressedBytes
                }))
            }
            return operation
        }
    }
    const begin = TermContentCompressionPool.prototype.beginCompressWrappedSpans
    TermContentCompressionPool.prototype.beginCompressWrappedSpans = function (source, offsets, lengths, starts, blockLengths, ...rest) {
        const group = groups.find(({index}) => index === getGroupIndex())
        assert(group, 'Compression dispatch must correspond to an observed append')
        assert.equal(group.transport, undefined, 'Expected one pool dispatch per group')
        group.transport = {
            descriptorCount: offsets.length,
            columnBytes: offsets.byteLength + lengths.byteLength,
            offsetsSha256: hashColumn(offsets),
            lengthsSha256: hashColumn(lengths),
            blockCount: blockLengths.length,
            blockStartIndexes: Array.from(starts),
            blockLengths: Array.from(blockLengths),
            metadataSnapshotBytes: offsets.byteLength + lengths.byteLength,
        }
        const operation = begin.call(this, source, offsets, lengths, starts, blockLengths, ...rest)
        observe(operation.completion.then((result) => {
            const aggregate = createHash('sha256')
            group.compressedFrames = result.chunks.map((bytes) => {
                aggregate.update(bytes)
                return {byteLength: bytes.byteLength, sha256: hash(bytes)}
            })
            group.compressedFramesSha256 = aggregate.digest('hex')
            group.compressedFrameBytes = result.chunks.reduce((sum, bytes) => sum + bytes.byteLength, 0)
            group.wrapped = result.wrapped
        }))
        return operation
    }
    return {
        async finish() {
            await Promise.all(pending)
            for (const group of groups) {
                assert(group.transport)
                assert(group.references)
                assert(group.compressedFrames)
                assert.equal(group.compressedFrames.length, group.transport.blockCount)
                assert.equal(group.finalCompressedBytes, group.compressedFrameBytes)
                assert.equal(group.finalUncompressedBytes, group.transport.blockLengths.reduce((sum, size) => sum + size, 0))
                assert.equal(group.references.count, group.originalDescriptorCount)
            }
            return {
                measurement: 'Untimed correctness census; callback hashing perturbs import latency',
                groups,
                totals: {
                    groups: groups.length,
                    originalDescriptorCount: groups.reduce((sum, group) => sum + group.originalDescriptorCount, 0),
                    transportDescriptorCount: groups.reduce((sum, group) => sum + group.transport.descriptorCount, 0),
                    originalColumnBytes: groups.reduce((sum, group) => sum + group.originalColumnBytes, 0),
                    transportColumnBytes: groups.reduce((sum, group) => sum + group.transport.columnBytes, 0),
                    compressedBlocks: groups.reduce((sum, group) => sum + group.transport.blockCount, 0),
                    compressedBytes: groups.reduce((sum, group) => sum + group.compressedFrameBytes, 0),
                    uncompressedBytes: groups.reduce((sum, group) => sum + group.finalUncompressedBytes, 0),
                    references: groups.reduce((sum, group) => sum + group.references.count, 0),
                },
            }
        },
    }
}
