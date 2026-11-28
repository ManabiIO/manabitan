/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Measurement-only. Source-bound tests pass two functions exported from the
 * SAME frozen store module instance used by DictionaryDatabase:
 *   getSynchronousRecordFieldReferences
 *   getResolvedContentReferenceOriginForExperiment
 * The latter reads the existing private origin WeakMap; it creates no proof.
 */
const MEMORY_BYTES = 4 * 1024 * 1024;
const SCRATCH_START = 128 * 1024;
const MAX_ROWS = 65534;
const descriptor = Object.getOwnPropertyDescriptor;
const prototypeOf = Object.getPrototypeOf;
const hasOwn = Object.hasOwn;
const isView = ArrayBuffer.isView;
const typedArrayPrototype = prototypeOf(Uint8Array.prototype);
const typedBuffer = descriptor(typedArrayPrototype, 'buffer').get;
const typedByteOffset = descriptor(typedArrayPrototype, 'byteOffset').get;
const typedLength = descriptor(typedArrayPrototype, 'length').get;
const arrayBufferLength = descriptor(ArrayBuffer.prototype, 'byteLength').get;
const columnConstructors = [Int32Array, Uint32Array, Float64Array];
const typedArrayConstructor = prototypeOf(Int32Array);

function hasCanonicalViewAccessors() {
    if (
        descriptor(typedArrayPrototype, 'buffer')?.get !== typedBuffer ||
        descriptor(typedArrayPrototype, 'length')?.get !== typedLength ||
        hasOwn(ArrayBuffer, Symbol.hasInstance) ||
        prototypeOf(ArrayBuffer) !== Function.prototype ||
        prototypeOf(typedArrayConstructor) !== Function.prototype ||
        hasOwn(typedArrayConstructor, Symbol.hasInstance)
    ) { return false; }
    for (const constructor of columnConstructors) {
        const prototype = constructor.prototype;
        if (
            prototypeOf(constructor) !== typedArrayConstructor ||
            prototypeOf(prototype) !== typedArrayPrototype ||
            hasOwn(prototype, 'buffer') || hasOwn(prototype, 'length') ||
            hasOwn(constructor, Symbol.hasInstance)
        ) { return false; }
    }
    return true;
}

function ownData(object, name) {
    const value = descriptor(object, name);
    return value !== undefined && hasOwn(value, 'value') ? value.value : undefined;
}

function hasUnusedPlainFixedSpan(chunk) {
    const length = descriptor(chunk, 'fixedContentLength');
    if (
        length === undefined ? 'fixedContentLength' in chunk :
            !hasOwn(length, 'value') || typeof length.value === 'number'
    ) { return false; }
    const offset = descriptor(chunk, 'fixedContentOffsetBase');
    return offset === undefined ? !('fixedContentOffsetBase' in chunk) : hasOwn(offset, 'value');
}

function viewGeometry(column, expectedPrototype, scratchBuffer) {
    // Test the internal typed-array identity before prototype/instanceof work.
    // Proxies, including proxies of typed arrays, fail without running traps.
    if (
        !isView(column) || prototypeOf(column) !== expectedPrototype ||
        hasOwn(column, 'length') || hasOwn(column, 'buffer')
    ) { return null; }
    try {
        const buffer = typedBuffer.call(column);
        // The builtin getter excludes SharedArrayBuffer irrespective of its
        // prototype. A plain prototype also prevents baseline instanceof from
        // walking a caller-controlled prototype Proxy.
        arrayBufferLength.call(buffer);
        if (prototypeOf(buffer) !== ArrayBuffer.prototype || buffer === scratchBuffer) { return null; }
        return {
            buffer,
            byteOffset: typedByteOffset.call(column),
            length: typedLength.call(column),
        };
    } catch {
        // Detached, shared, or otherwise incompatible storage keeps JS behavior.
        return null;
    }
}

/**
 * Initialization is outside the component's measured invocation. The returned
 * synchronous function includes eligibility, all input copies, native work and
 * the full owned output copy. Null requires invoking the unchanged JS encoder.
 */
export async function createCompactRecordFieldEncoder(wasmBytes, selectReferences, getReferenceOrigin) {
    if (typeof selectReferences !== 'function' || typeof getReferenceOrigin !== 'function') {
        throw new TypeError('The exact store selector and private origin lookup are required');
    }
    const initializationStart = performance.now();
    const compilationStart = performance.now();
    const module = await WebAssembly.compile(wasmBytes);
    const compilationMs = performance.now() - compilationStart;
    const imports = WebAssembly.Module.imports(module);
    if (
        imports.length !== 1 || imports[0].module !== 'env' ||
        imports[0].name !== 'memory' || imports[0].kind !== 'memory'
    ) { throw new Error('Unexpected native record-field imports'); }
    const memory = new WebAssembly.Memory({initial: MEMORY_BYTES / 65536, maximum: MEMORY_BYTES / 65536});
    const instantiationStart = performance.now();
    const instance = await WebAssembly.instantiate(module, {env: {memory}});
    const instantiationMs = performance.now() - instantiationStart;
    const {record_field_abi_version: version, encode_compact_record_fields: encode} = instance.exports;
    if (typeof version !== 'function' || version() !== 1 || typeof encode !== 'function') {
        throw new Error('Unexpected native record-field ABI');
    }
    const heap = new Uint8Array(memory.buffer);
    const stats = {
        calls: 0,
        successes: 0,
        fallbacks: 0,
        inputCopyBytes: 0,
        outputCopyBytes: 0,
        peakLayoutBytes: 0,
        memoryBytes: memory.buffer.byteLength,
        initializationMs: performance.now() - initializationStart,
        compilationMs,
        instantiationMs,
    };
    function fallback() {
        ++stats.fallbacks;
        return null;
    }
    function tryEncodeCompactRecordFields(chunk, contentOffsetBase) {
        ++stats.calls;
        // This WeakMap lookup is the first inspection of chunk. In particular,
        // a foreign Proxy cannot trigger descriptor or property traps here.
        const origin = getReferenceOrigin(chunk);
        if (origin === null || origin === undefined) { return fallback(); }
        if (
            prototypeOf(chunk) !== Object.prototype ||
            ownData(chunk, 'resolvedContentReferences') !== origin ||
            prototypeOf(origin) !== Object.prototype || !hasUnusedPlainFixedSpan(chunk) ||
            !hasCanonicalViewAccessors()
        ) { return fallback(); }
        const rows = ownData(chunk, 'rowCount');
        if (
            !Number.isSafeInteger(rows) || rows <= 0 || rows > MAX_ROWS ||
            !Number.isSafeInteger(contentOffsetBase) || contentOffsetBase < 0
        ) { return fallback(); }
        const scores = ownData(chunk, 'scoreList');
        const uniqueIds = ownData(origin, 'uniqueIndexList');
        const offsets = ownData(origin, 'offsets');
        const lengths = ownData(origin, 'lengths');
        const scoreGeometry = viewGeometry(scores, Int32Array.prototype, heap.buffer);
        const idGeometry = viewGeometry(uniqueIds, Uint32Array.prototype, heap.buffer);
        const offsetGeometry = viewGeometry(offsets, Float64Array.prototype, heap.buffer);
        const lengthGeometry = viewGeometry(lengths, Uint32Array.prototype, heap.buffer);
        if (
            scoreGeometry === null || idGeometry === null ||
            offsetGeometry === null || lengthGeometry === null ||
            scoreGeometry.length < rows || idGeometry.length < rows ||
            offsetGeometry.length !== lengthGeometry.length || offsetGeometry.length === 0
        ) { return fallback(); }
        // The callback is the unchanged selector, after non-observable guards
        // ruled out all accessor/proxy/shared cases in its indexed columns.
        const selected = selectReferences(chunk, rows);
        if (
            selected === null || selected.uniqueIndexList !== uniqueIds ||
            selected.offsets !== offsets || selected.lengths !== lengths
        ) { return fallback(); }
        const uniqueCount = offsetGeometry.length;
        let slotCount = 1;
        while (slotCount < rows * 2) { slotCount *= 2; }

        // Copy only N row values, but the complete bounded U reference columns:
        // IDs may select any U entry, including inherited split-run capacity.
        let cursor = SCRATCH_START;
        function allocate(bytes) {
            cursor = Math.ceil(cursor / 8) * 8;
            const pointer = cursor;
            cursor += bytes;
            return pointer;
        }
        const scorePointer = allocate(rows * 4);
        const idPointer = allocate(rows * 4);
        const offsetPointer = allocate(uniqueCount * 8);
        const lengthPointer = allocate(uniqueCount * 4);
        const slotPointer = allocate(slotCount * 4);
        const palettePointer = allocate(rows * 4);
        const keyPointer = allocate(rows * 2);
        const outputCapacity = rows * 12;
        const outputPointer = allocate(outputCapacity);
        if (cursor > MEMORY_BYTES) { return fallback(); }
        stats.peakLayoutBytes = Math.max(stats.peakLayoutBytes, cursor);
        heap.set(new Uint8Array(scoreGeometry.buffer, scoreGeometry.byteOffset, rows * 4), scorePointer);
        heap.set(new Uint8Array(idGeometry.buffer, idGeometry.byteOffset, rows * 4), idPointer);
        heap.set(new Uint8Array(offsetGeometry.buffer, offsetGeometry.byteOffset, uniqueCount * 8), offsetPointer);
        heap.set(new Uint8Array(lengthGeometry.buffer, lengthGeometry.byteOffset, uniqueCount * 4), lengthPointer);
        stats.inputCopyBytes += rows * 8 + uniqueCount * 12;
        const outputBytes = encode(
            rows, uniqueCount, contentOffsetBase,
            scorePointer, idPointer, offsetPointer, lengthPointer,
            slotPointer, slotCount, palettePointer, keyPointer,
            outputPointer, outputCapacity,
        );
        if (outputBytes === 0) { return fallback(); }
        if (
            !Number.isInteger(outputBytes) || outputBytes < 16 ||
            outputBytes >= outputCapacity || outputPointer + outputBytes > cursor
        ) { throw new Error('Native record-field encoder returned invalid output bounds'); }
        const output = new Uint8Array(outputBytes);
        output.set(new Uint8Array(heap.buffer, outputPointer, outputBytes));
        stats.outputCopyBytes += outputBytes;
        ++stats.successes;
        return output;
    }
    return {tryEncodeCompactRecordFields, stats};
}
