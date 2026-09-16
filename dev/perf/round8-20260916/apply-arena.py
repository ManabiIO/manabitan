from pathlib import Path
import hashlib, json
p = Path('ext/js/dictionary/term-bank-wasm-parser.js')
s = p.read_text()
a = s.index('        tStart = Date.now();', s.index('    if (useFusedParse) {'))
b = s.index('        allocationMs +=', a)
new = '''        tStart = Date.now();
        let contentHashTableSize = 1;
        while (contentHashTableSize < initialMetaCapacity * 2) { contentHashTableSize *= 2; }
        let stringHashTableSize = 1;
        while (stringHashTableSize < initialMetaCapacity * 4) { stringHashTableSize *= 2; }
        const stringsCapacity = Math.max(1024 * 1024, Math.min(jsonLength, initialMetaCapacity * 64));
        const normalizedInitialContentBytesPerRow = Number.isFinite(initialContentBytesPerRow) ? Math.max(16, Math.min(512, Math.trunc(initialContentBytesPerRow))) : 48;
        const contentOutCapacity = Math.min(
            0x7fffffff,
            Math.max(1024 * 1024, initialMetaCapacity * Math.max(192, normalizedInitialContentBytesPerRow)),
        );
        const experimentMask = getTermBankExperimentMask(experiments);
        // Retain the native allocator's exact eight-byte layout. A single bump
        // grows memory once instead of once per column. Content is still last,
        // so native content growth can extend it in place without relocation.
        const [outPtr, contentMetaPtr, contentHashTablePtr, rawContentHashTablePtr,
            rawContentHashesPtr, contentUniqueIndexesPtr, contentUniqueCountPtr,
            contentUniqueSignaturesPtr, rowCountPtr, stringsPtr, stringLengthsPtr,
            stringOffsetsPtr, stringHashesPtr, expressionIndexesPtr, readingIndexesPtr,
            stringHashTablePtr, stringUniqueCountPtr, stringBytesCountPtr, readingEqualsPtr,
            scoresPtr, sequencesPtr, recentContentHitsPtr, experimentStatsPtr, contentOutPtr] = allocateFusedWasmArena(wasm, [
            initialMetaCapacity * META_U32_FIELDS * 4,
            initialMetaCapacity * CONTENT_META_U32_FIELDS * 4,
            contentHashTableSize * 4,
            experiments.experimentalGlobalExactContentReuse ? contentHashTableSize * 4 : 0,
            experiments.experimentalGlobalExactContentReuse ? initialMetaCapacity * 4 : 0,
            initialMetaCapacity * 4, 4,
            initialMetaCapacity * CONTENT_SIGNATURE_U32_FIELDS * 4, 4,
            stringsCapacity, initialMetaCapacity * 4, initialMetaCapacity * 8,
            initialMetaCapacity * 8, initialMetaCapacity * 4, initialMetaCapacity * 4,
            stringHashTableSize * 4, 4, 4, initialMetaCapacity,
            initialMetaCapacity * 4, initialMetaCapacity * 4, 4,
            experimentMask !== 0 ? 20 : 0,
            contentOutCapacity,
        ]);
'''
s = s[:a] + new + s[b:]
helper = '''/**
 * Allocate disjoint arenas in precisely the layout of consecutive wasm_alloc
 * calls. Zero-sized entries denote disabled optional buffers, not allocations.
 * @param {TermBankWasmExports} wasm
 * @param {number[]} sizes
 * @returns {number[]}
 */
function allocateFusedWasmArena(wasm, sizes) {
    let total = 0;
    for (const size of sizes) {
        if (!Number.isSafeInteger(size) || size < 0 || size > 0xfffffff8) {
            throw new TermBankWasmResourceError('Invalid fused parser arena size');
        }
        total += Math.ceil(size / 8) * 8;
    }
    if (total > 0xfffffff8) {
        throw new TermBankWasmResourceError('Fused parser arena exceeds wasm32');
    }
    const base = wasm.wasm_alloc(total);
    if (base === 0) {
        throw new TermBankWasmResourceError('Failed to allocate fused term-bank parser buffers');
    }
    let offset = 0;
    return sizes.map((size) => {
        if (size === 0) { return 0; }
        const pointer = base + offset;
        offset += Math.ceil(size / 8) * 8;
        return pointer;
    });
}

'''
idx = s.rfind('/**', 0, s.index('function allocateWasmBuffer('))
s = s[:idx] + helper + s[idx:]
p.write_text(s)
print(json.dumps({'source': str(p), 'sha256': hashlib.sha256(s.encode()).hexdigest()}))
