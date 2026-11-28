// SPDX-License-Identifier: GPL-3.0-or-later
// EXPERIMENT ONLY. Inputs must come from the immutable, source-bound capture.
// This does not establish a private production ownership capability.
export const ALIAS_LIMITS = Object.freeze({maximumUniqueEntries: 64, maximumInputBytes: 64 * 1024});

export async function promoteRawReferencesForComponent(group, context) {
    const {
        blockStore, blockSession, hasCompletePreparedTermLookupIndexes,
        getRawTermContentBlockCompressionDictName, createRawTermContentCompactBlockDictName,
        createArtifactTermRecordChunkWithResolvedContent, rawTokenName,
    } = context;
    const {chunk, contentOffsets, contentLengths, contentDictNames} = group;
    const unchanged = {chunk, contentOffsets, contentLengths, contentDictNames, aliases: [], rawRows: 0, promoted: false};
    if (
        !Array.isArray(contentDictNames) ||
        !hasCompletePreparedTermLookupIndexes(chunk.preparedLookupIndexes, chunk.rowCount) ||
        !chunk.preparedLookupIndexes.has('0:' + chunk.rowCount) ||
        !blockSession._blockEnabledDictionaries.has(chunk.dictionary)
    ) { return unchanged; }
    const refs = chunk.resolvedContentReferences;
    if (
        !refs || !(refs.uniqueIndexList instanceof Uint32Array) ||
        !(refs.offsets instanceof Float64Array) || !(refs.lengths instanceof Uint32Array) ||
        refs.uniqueIndexList.length < chunk.rowCount || refs.offsets.length !== refs.lengths.length
    ) { return unchanged; }
    const compressedNames = new Set();
    const aliases = new Map();
    let rawRows = 0;
    let inputBytes = 0;
    for (let row = 0; row < chunk.rowCount; ++row) {
        const name = contentDictNames[row];
        const compressionDictionary = getRawTermContentBlockCompressionDictName(name);
        if (compressionDictionary !== undefined) {
            compressedNames.add(name);
            if (compressedNames.size > 1) { return unchanged; }
            continue;
        }
        if (name !== rawTokenName) { return unchanged; }
        const uniqueIndex = refs.uniqueIndexList[row];
        if (uniqueIndex >= refs.offsets.length) { throw new RangeError('Captured raw reference index is invalid'); }
        const offset = refs.offsets[uniqueIndex], length = refs.lengths[uniqueIndex];
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(length) || length <= 0) {
            return unchanged;
        }
        ++rawRows;
        const key = name + ':' + offset + ':' + length;
        let item = aliases.get(key);
        if (!item) {
            item = {name, offset, length, indexes: new Set(), rowCount: 0};
            aliases.set(key, item);
            inputBytes += length;
            if (aliases.size > ALIAS_LIMITS.maximumUniqueEntries || inputBytes > ALIAS_LIMITS.maximumInputBytes) {
                return unchanged;
            }
        }
        item.indexes.add(uniqueIndex);
        ++item.rowCount;
    }
    if (aliases.size === 0 || compressedNames.size !== 1) { return unchanged; }
    const targetName = [...compressedNames][0];
    const dictionaryName = getRawTermContentBlockCompressionDictName(targetName);
    if (targetName !== createRawTermContentCompactBlockDictName(dictionaryName)) { return unchanged; }
    const items = [...aliases.values()];
    const contents = [];
    for (const item of items) {
        // This is the real canonical read path; do not preload these bytes.
        const bytes = await blockStore.read(item.offset, item.length, item.name);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== item.length) {
            // No alias write has started, so ordinary record routing is safe.
            return unchanged;
        }
        contents.push(bytes);
    }
    // Use the existing per-dictionary selection latch and unchanged codec settings.
    // Errors after append begins belong to the operation; they are not swallowed.
    const result = await blockSession.append(chunk.dictionary, contents, dictionaryName);
    if (result === null) { return unchanged; }
    if (result.contentDictName !== targetName || result.contentOffsets.length !== items.length) {
        throw new Error('Alias append returned an incompatible physical reference');
    }
    const offsets = new Float64Array(refs.offsets);
    const receipts = [];
    for (let index = 0; index < items.length; ++index) {
        const item = items[index];
        if (result.contentLengths[index] !== item.length) { throw new Error('Alias logical content length changed'); }
        for (const uniqueIndex of item.indexes) { offsets[uniqueIndex] = result.contentOffsets[index]; }
        receipts.push({
            canonicalOffset: item.offset, canonicalLength: item.length, canonicalName: item.name,
            aliasOffset: result.contentOffsets[index], aliasLength: result.contentLengths[index],
            aliasName: result.contentDictName, uniqueIndexes: [...item.indexes], rows: item.rowCount,
        });
    }
    const overlay = createArtifactTermRecordChunkWithResolvedContent(
        chunk, refs.uniqueIndexList, offsets, refs.lengths, chunk.preparedLookupIndexes,
    );
    // Ordinary record-store validation and its 4 GiB delta split remain untouched.
    return {
        chunk: overlay, contentOffsets, contentLengths, contentDictNames: targetName,
        aliases: receipts, rawRows, promoted: true, inputBytes,
        blockProfile: {
            compressedBytes: result.compressedBytes, uncompressedBytes: result.uncompressedBytes,
            packMs: result.packMs, compressMs: result.compressMs, envelopeMs: result.envelopeMs,
            referenceMs: result.referenceMs, opfsAppendMs: result.opfsAppendMs,
        },
    };
}
