import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdirSync, writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {gzipSync} from 'node:zlib'

const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const getters = Object.fromEntries(['buffer', 'byteOffset', 'byteLength', 'length'].map((key) => [key, Object.getOwnPropertyDescriptor(typedPrototype, key).get]))
const tag = Object.getOwnPropertyDescriptor(typedPrototype, Symbol.toStringTag).get
const privateLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable').get
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

export function installRecordFieldCapture({store, module, outputDirectory, getGroupIndex}) {
    const directory = resolve(outputDirectory, 'captures')
    mkdirSync(directory)
    const original = store._encodeArtifactRecordFields
    const calls = []
    const save = () => writeFileSync(resolve(outputDirectory, 'record-field-calls.json'), JSON.stringify({complete: false, calls}, null, 2) + '\n')
    store._encodeArtifactRecordFields = function (chunk, contentOffsets, contentLengths, contentOffsetBase) {
        const number = calls.length
        const call = {number, groupIndex: getGroupIndex(), rowCount: chunk.rowCount, contentOffsetBase, complete: false}
        calls.push(call)
        try {
            const references = module.diagnosticRecordFieldReferences(chunk, chunk.rowCount)
            call.privateSynchronousReferences = references !== null
            call.fixedContentOffsetBase = chunk.fixedContentOffsetBase ?? null
            call.fixedContentLength = chunk.fixedContentLength ?? null
            assert(references !== null, 'Stage-1 actual JMdict calls must expose the current private direct-reference route')
            const raw = []
            const segments = []
            let rawOffset = 0
            function capture(name, values) {
                assert(ArrayBuffer.isView(values), name)
                const buffer = getters.buffer.call(values)
                const byteOffset = getters.byteOffset.call(values)
                const byteLength = getters.byteLength.call(values)
                const bytes = Buffer.from(new Uint8Array(buffer, byteOffset, byteLength))
                const descriptor = {
                    name,
                    elementKind: tag.call(values),
                    length: getters.length.call(values),
                    byteOffset,
                    byteLength,
                    backingBytes: privateLength.call(buffer),
                    resizable: resizable.call(buffer),
                    ownShadows: ['buffer', 'byteOffset', 'byteLength', 'length'].filter((key) => Object.hasOwn(values, key)),
                    rawOffset,
                    sha256: sha256(bytes),
                }
                rawOffset += bytes.byteLength
                raw.push(bytes)
                segments.push(descriptor)
            }
            capture('uniqueIndexes', references.uniqueIndexList)
            capture('scores', chunk.scoreList)
            capture('resolvedOffsets', references.offsets)
            capture('resolvedLengths', references.lengths)
            capture('contentOffsets', contentOffsets)
            capture('contentLengths', contentLengths)
            const output = original.call(this, chunk, contentOffsets, contentLengths, contentOffsetBase)
            capture('output', output)
            call.segments = segments
            call.rawBytes = rawOffset
            call.format = output.byteLength === chunk.rowCount * 16 ? 'float64' : output.byteLength === chunk.rowCount * 12 ? 'legacy' : 'compact'
            if (call.format === 'compact') call.scoreCount = new DataView(output.buffer, output.byteOffset, output.byteLength).getUint32(8, true)
            const header = Buffer.from(JSON.stringify({version: 1, number, groupIndex: call.groupIndex, rowCount: call.rowCount, contentOffsetBase, fixedContentOffsetBase: call.fixedContentOffsetBase, fixedContentLength: call.fixedContentLength, segments}))
            const prefix = Buffer.alloc(4)
            prefix.writeUInt32LE(header.byteLength)
            const complete = Buffer.concat([prefix, header, ...raw])
            const compressed = gzipSync(complete, {level: 6})
            call.file = `captures/call-${String(number).padStart(3, '0')}.bin.gz`
            call.containerSha256 = sha256(complete)
            call.archiveSha256 = sha256(compressed)
            call.archiveBytes = compressed.byteLength
            writeFileSync(resolve(outputDirectory, call.file), compressed, {flag: 'wx'})
            call.complete = true
            save()
            return output
        } catch (error) {
            call.error = String(error)
            call.stack = error?.stack
            save()
            throw error
        }
    }
    return {
        calls,
        finish() {
            assert(calls.length > 0 && calls.every((call) => call.complete))
            assert.equal(calls.reduce((sum, call) => sum + call.rowCount, 0), 528299)
            writeFileSync(resolve(outputDirectory, 'record-field-calls.json'), JSON.stringify({complete: true, stockOutputsConsumed: true, calls}, null, 2) + '\n')
            return {calls: calls.length, rows: calls.reduce((sum, call) => sum + call.rowCount, 0), sourceBytes: calls.reduce((sum, call) => sum + call.rawBytes, 0), compressedCaptureBytes: calls.reduce((sum, call) => sum + call.archiveBytes, 0)}
        },
        restore() { store._encodeArtifactRecordFields = original },
    }
}
