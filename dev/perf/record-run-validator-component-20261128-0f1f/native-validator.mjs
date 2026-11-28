// Isolated component adapter. Production loading and lifetime are not changed.
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const getters = Object.fromEntries(['buffer', 'byteOffset', 'byteLength', 'length'].map((name) => [
    name, Object.getOwnPropertyDescriptor(typedArrayPrototype, name).get,
]))
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get
const arrayBufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get
const typedSet = typedArrayPrototype.set
const call = Reflect.apply
const clock = performance.now.bind(performance)
const PAGE_BYTES = 65536
const RESULT_START = 8
const INPUT_START = 32

function viewInfo(view, Type) {
    if (Object.getPrototypeOf(view) !== Type.prototype) return null
    try {
        const buffer = call(getters.buffer, view, [])
        const byteLength = call(arrayBufferByteLength, buffer, [])
        if (arrayBufferResizable && call(arrayBufferResizable, buffer, [])) return null
        return {
            buffer,
            bufferBytes: byteLength,
            byteOffset: call(getters.byteOffset, view, []),
            byteLength: call(getters.byteLength, view, []),
            length: call(getters.length, view, []),
        }
    } catch {
        return null
    }
}

export class NativeRecordRunValidator {
    constructor(moduleBytes) {
        const start = clock()
        const moduleStart = clock()
        this.module = new WebAssembly.Module(moduleBytes)
        const moduleEnd = clock()
        this.memory = new WebAssembly.Memory({initial: 1})
        this.instance = new WebAssembly.Instance(this.module, {env: {memory: this.memory}})
        const end = clock()
        this.metrics = {
            moduleCompileMs: moduleEnd - moduleStart,
            memoryAndInstantiateMs: end - moduleEnd,
            initializationMs: end - start,
            calls: 0,
            fallbackCalls: 0,
            copyInputBytes: 0,
            growMs: 0,
            copyMs: 0,
            kernelMs: 0,
            guardAndResultMs: 0,
            peakHeapBytes: this.memory.buffer.byteLength,
            peakRequiredBytes: 0,
            failureCounts: {},
        }
    }

    // Caller must already hold getSynchronousResolvedContentReferences' proof.
    // There is deliberately no asynchronous initialization inside this method.
    validate(references, runStart, runLimitEnd) {
        const start = clock()
        const ids = viewInfo(references.uniqueIndexList, Uint32Array)
        const offsets = viewInfo(references.offsets, Float64Array)
        const lengths = viewInfo(references.lengths, Uint32Array)
        const fallback = (reason, accountedMs = 0) => {
            this.metrics.fallbackCalls++
            this.metrics.failureCounts[reason] = (this.metrics.failureCounts[reason] ?? 0) + 1
            this.metrics.guardAndResultMs += clock() - start - accountedMs
            return null
        }
        if (
            ids === null || offsets === null || lengths === null ||
            !Number.isSafeInteger(runStart) || !Number.isSafeInteger(runLimitEnd) ||
            runStart < 0 || runLimitEnd < runStart || runLimitEnd > ids.length ||
            offsets.length !== lengths.length ||
            [ids, offsets, lengths].some(({buffer}) => buffer === this.memory.buffer)
        ) return fallback('shape-or-buffer')
        const rowCount = runLimitEnd - runStart
        // Copy at most one window per chunk and no more than 16 bytes per row.
        // Offset-driven splits and large unused unique tables retain the JS loop.
        if (runStart !== 0 || offsets.length > rowCount) return fallback('noninitial-or-unbounded-window')
        const idsPointer = INPUT_START
        const offsetsPointer = Math.ceil((idsPointer + rowCount * 4) / 8) * 8
        const lengthsPointer = offsetsPointer + offsets.length * 8
        const requiredBytes = lengthsPointer + lengths.length * 4
        if (!Number.isSafeInteger(requiredBytes) || requiredBytes > 0xffffffff) return fallback('address-space')
        const growStart = clock()
        try {
            const extraPages = Math.ceil(requiredBytes / PAGE_BYTES) - this.memory.buffer.byteLength / PAGE_BYTES
            if (extraPages > 0) this.memory.grow(extraPages)
        } catch {
            return fallback('memory-growth')
        }
        const growEnd = clock()
        const buffer = this.memory.buffer
        try {
            // Construct exact intrinsic views; subarray/species getters are not used.
            // Equal zero-length detached metadata views still need the JS fallback.
            const sourceIds = new Uint32Array(ids.buffer, ids.byteOffset + runStart * 4, rowCount)
            const sourceOffsets = new Float64Array(offsets.buffer, offsets.byteOffset, offsets.length)
            const sourceLengths = new Uint32Array(lengths.buffer, lengths.byteOffset, lengths.length)
            call(typedSet, new Uint32Array(buffer, idsPointer, rowCount), [sourceIds])
            call(typedSet, new Float64Array(buffer, offsetsPointer, offsets.length), [sourceOffsets])
            call(typedSet, new Uint32Array(buffer, lengthsPointer, lengths.length), [sourceLengths])
        } catch {
            const failureAt = clock()
            this.metrics.growMs += growEnd - growStart
            this.metrics.copyMs += failureAt - growEnd
            return fallback('input-copy', failureAt - growStart)
        }
        const copyEnd = clock()
        let status
        try {
            status = this.instance.exports.validate_record_run(
                idsPointer, rowCount, offsetsPointer, lengthsPointer, offsets.length, RESULT_START,
            )
        } catch {
            this.metrics.failureCounts['kernel-exception'] = (this.metrics.failureCounts['kernel-exception'] ?? 0) + 1
            this.metrics.fallbackCalls++
            this.metrics.growMs += growEnd - growStart
            this.metrics.copyMs += copyEnd - growEnd
            this.metrics.kernelMs += clock() - copyEnd
            return null
        }
        const kernelEnd = clock()
        this.metrics.calls++
        this.metrics.copyInputBytes += rowCount * 4 + offsets.length * 8 + lengths.length * 4
        this.metrics.growMs += growEnd - growStart
        this.metrics.copyMs += copyEnd - growEnd
        this.metrics.kernelMs += kernelEnd - copyEnd
        this.metrics.peakHeapBytes = Math.max(this.metrics.peakHeapBytes, buffer.byteLength)
        this.metrics.peakRequiredBytes = Math.max(this.metrics.peakRequiredBytes, requiredBytes)
        const view = new DataView(buffer, RESULT_START, 24)
        const runEnd = runStart + view.getUint32(0, true)
        const row = runStart + view.getUint32(4, true)
        const minimum = view.getFloat64(8, true)
        const maximum = view.getFloat64(16, true)
        this.metrics.guardAndResultMs += (growStart - start) + (clock() - kernelEnd)
        if (status === 1) throw new RangeError(`Invalid resolved term content reference index: ${references.uniqueIndexList[row]}`)
        if (status === 2) throw new RangeError(`Invalid term content offset: ${references.offsets[references.uniqueIndexList[row]]}`)
        if (status === 3) throw new RangeError(`Invalid term content length: ${references.lengths[references.uniqueIndexList[row]]}`)
        if (status !== 0 || runEnd < runStart || runEnd > runLimitEnd) {
            this.metrics.fallbackCalls++
            this.metrics.failureCounts['kernel-status'] = (this.metrics.failureCounts['kernel-status'] ?? 0) + 1
            return null
        }
        return {runEnd, minimum, maximum}
    }
}
