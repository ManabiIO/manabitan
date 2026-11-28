// Standalone experiment only. No product module imports or runtime integration.
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const typedGetters = Object.fromEntries(['buffer', 'byteOffset', 'byteLength', 'length'].map((key) => [key, Object.getOwnPropertyDescriptor(typedPrototype, key).get]))
const intrinsicTag = Object.getOwnPropertyDescriptor(typedPrototype, Symbol.toStringTag).get
const privateByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable').get
const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1
const expectedPrototypes = {Uint32Array: Uint32Array.prototype, Int32Array: Int32Array.prototype, Float64Array: Float64Array.prototype}
const widths = {Uint32Array: 4, Int32Array: 4, Float64Array: 8}

function inspectColumn(value, kind) {
    if (!ArrayBuffer.isView(value) || Object.getPrototypeOf(value) !== expectedPrototypes[kind]) return null
    for (const key of ['buffer', 'byteOffset', 'byteLength', 'length', Symbol.toStringTag]) {
        if (Object.hasOwn(value, key)) return null
    }
    if (intrinsicTag.call(value) !== kind) return null
    const buffer = typedGetters.buffer.call(value)
    let backingBytes
    try {
        backingBytes = privateByteLength.call(buffer)
        if (resizable.call(buffer)) return null
    } catch { return null }
    const length = typedGetters.length.call(value)
    const byteOffset = typedGetters.byteOffset.call(value)
    const byteLength = typedGetters.byteLength.call(value)
    if (byteLength !== length * widths[kind] || byteOffset + byteLength > backingBytes) return null
    return {buffer, byteOffset, byteLength, length}
}

function dataValue(object, key) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)
    return typeof descriptor === 'undefined' || !('value' in descriptor) ? null : {value: descriptor.value}
}

export function selectNativeRecordFields(chunk, base, privateReferences) {
    if (!littleEndian) return null
    // The production WeakMap proof runs first. It rejects external/proxied
    // chunks without reading their descriptors. Zero is not a cached value
    // witness; actual dimensions and internal element kinds are checked below.
    const references = privateReferences(chunk, 0)
    if (references === null) return null
    const rowCount = dataValue(chunk, 'rowCount')
    const scoreProperty = dataValue(chunk, 'scoreList')
    const fixedBase = Object.getOwnPropertyDescriptor(chunk, 'fixedContentOffsetBase')
    if (
        rowCount === null || scoreProperty === null ||
        !Number.isSafeInteger(rowCount.value) || rowCount.value <= 0 || rowCount.value > 0xffffffff ||
        !Number.isSafeInteger(base) || base < 0 ||
        (typeof fixedBase !== 'undefined' && (!('value' in fixedBase) || fixedBase.value !== undefined))
    ) return null
    const indexes = inspectColumn(references.uniqueIndexList, 'Uint32Array')
    const scores = inspectColumn(scoreProperty.value, 'Int32Array')
    const offsets = inspectColumn(references.offsets, 'Float64Array')
    const lengths = inspectColumn(references.lengths, 'Uint32Array')
    const count = rowCount.value
    if (
        indexes === null || scores === null || offsets === null || lengths === null ||
        indexes.length < count || scores.length < count || offsets.length !== lengths.length ||
        offsets.length === 0 || offsets.length > 0xffffffff
    ) return null
    return {count, uniqueCount: offsets.length, indexes, scores, offsets, lengths}
}

export class NativeRecordFields {
    constructor({wasmBytes, privateReferences, stockEncode, maximumPages = 1024}) {
        this.privateReferences = privateReferences
        this.stockEncode = stockEncode
        this.maximumPages = maximumPages
        this.memory = null
        this.native = null
        this.lastStats = null
        this.lastLayout = null
        this.initializationError = null
        try {
            this.module = new WebAssembly.Module(wasmBytes)
            const imports = WebAssembly.Module.imports(this.module)
            if (imports.length !== 1 || imports[0].module !== 'env' || imports[0].name !== 'memory' || imports[0].kind !== 'memory') throw new Error('Unexpected native imports')
            this.memory = new WebAssembly.Memory({initial: 2, maximum: maximumPages})
            this.instance = new WebAssembly.Instance(this.module, {env: {memory: this.memory}})
            if (typeof this.instance.exports.record_fields_abi_version !== 'function' || this.instance.exports.record_fields_abi_version() !== 1 || typeof this.instance.exports.encode_record_fields !== 'function') throw new Error('Unsupported record-field ABI')
            this.native = this.instance.exports.encode_record_fields
        } catch (error) {
            this.initializationError = String(error)
        }
    }

    encode(chunk, contentOffsets, contentLengths, base) {
        const stats = {native: false, fallback: null, inputCopiedBytes: 0, inputCopyCalls: 0, outputCopiedBytes: 0, tableZeroedBytes: 0, scratchBytes: 0, memoryGrowthBytes: 0}
        this.lastStats = stats
        const fallback = (reason) => {
            stats.fallback = reason
            return this.stockEncode(chunk, contentOffsets, contentLengths, base)
        }
        if (this.native === null || this.memory === null) return fallback('initialization')
        let input
        try { input = selectNativeRecordFields(chunk, base, this.privateReferences) } catch { return fallback('guard-exception') }
        if (input === null) return fallback('eligibility')
        const {count, uniqueCount} = input
        const scoreCapacity = Math.min(count, 65535)
        let slotCount = 2
        while (slotCount < scoreCapacity * 2) slotCount *= 2
        let cursor = 131072
        function allocate(bytes, alignment) {
            cursor = Math.ceil(cursor / alignment) * alignment
            const start = cursor
            cursor += bytes
            return start
        }
        const layout = {
            rows: allocate(count * 4, 4),
            scores: allocate(count * 4, 4),
            offsets: allocate(uniqueCount * 8, 8),
            lengths: allocate(uniqueCount * 4, 4),
            slots: allocate(slotCount * 4, 4),
            dictionary: allocate(scoreCapacity * 4, 4),
            keys: allocate(count * 2, 2),
            output: allocate(count * 12, 4),
            outputCapacity: count * 12,
            slotCount,
            scoreCapacity,
            end: cursor,
        }
        this.lastLayout = layout
        if (!Number.isSafeInteger(cursor) || cursor > this.maximumPages * 65536) return fallback('memory-bound')
        stats.rows = count
        stats.uniqueRows = uniqueCount
        stats.slotCount = slotCount
        stats.scratchBytes = slotCount * 4 + scoreCapacity * 4 + count * 2
        stats.outputCapacityBytes = layout.outputCapacity
        stats.layoutEndBytes = cursor
        stats.memoryBytesBefore = this.memory.buffer.byteLength
        const requiredPages = Math.ceil(cursor / 65536)
        const currentPages = this.memory.buffer.byteLength / 65536
        try {
            if (requiredPages > currentPages) this.memory.grow(requiredPages - currentPages)
        } catch { return fallback('memory-growth') }
        stats.memoryBytesAfter = this.memory.buffer.byteLength
        stats.memoryGrowthBytes = stats.memoryBytesAfter - stats.memoryBytesBefore
        const bytes = new Uint8Array(this.memory.buffer)
        const copy = (column, size, target) => {
            bytes.set(new Uint8Array(column.buffer, column.byteOffset, size), target)
            stats.inputCopiedBytes += size
            ++stats.inputCopyCalls
        }
        copy(input.indexes, count * 4, layout.rows)
        copy(input.scores, count * 4, layout.scores)
        copy(input.offsets, uniqueCount * 8, layout.offsets)
        copy(input.lengths, uniqueCount * 4, layout.lengths)
        stats.tableZeroedBytes = slotCount * 4
        const args = [count, uniqueCount, layout.rows, layout.scores, layout.offsets, layout.lengths, base, layout.slots, slotCount, layout.dictionary, layout.keys, layout.output, layout.outputCapacity]
        this.lastArguments = args
        let result
        try { result = this.native(...args) } catch { return fallback('native-trap') }
        stats.nativeReturn = result
        if (!Number.isInteger(result) || result <= 0 || result > layout.outputCapacity || result >= count * 12 || result < 20) return fallback(result === 0 ? 'unsupported-compact' : 'native-return')
        const header = new Uint32Array(this.memory.buffer, layout.output, 4)
        const scoreCount = header[2]
        if (header[0] !== 0x3246524d || header[1] !== count || header[3] !== 2 || scoreCount === 0 || scoreCount >= 65535 || scoreCount > scoreCapacity || result !== 16 + scoreCount * 4 + count * 8) return fallback('native-header')
        const output = new Uint8Array(result)
        output.set(new Uint8Array(this.memory.buffer, layout.output, result))
        stats.native = true
        stats.scoreCount = scoreCount
        stats.outputCopiedBytes = result
        stats.nativeDictionaryCopiedBytes = scoreCount * 4
        stats.nativeKeysCopiedBytes = count * 2
        return output
    }
}
