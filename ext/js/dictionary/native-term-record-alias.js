/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {assertNativeTermRecordLease, hasNativeTermRecordLease} from './native-term-record-ownership.js';
import {
    createRawTermContentCompactBlockDictName,
    isRawTermContentTokenBinary,
    RAW_TERM_CONTENT_TOKEN_DICT_NAME,
} from './raw-term-content.js';
import {createArtifactTermRecordChunkWithResolvedContent} from './term-record-opfs-store.js';

const MAX_ALIAS_ENTRIES = 64;
const MAX_ALIAS_INPUT_BYTES = 64 * 1024;

/** @typedef {import('./dictionary-database.js').ArtifactTermRecordChunk} RecordChunk */
/** @typedef {NonNullable<Awaited<ReturnType<import('./term-content-block-store.js').TermContentBlockImportSession['append']>>>} BlockStorage */
/**
 * @typedef {{sourceChunk: RecordChunk, lease: object, validateOwner: () => void}} NativeRecordAliasOwner
 */

/**
 * Keeps a privately owned native lookup segment whole when only a bounded raw
 * prefix would otherwise split its records. Canonical deduplication tables
 * stay unchanged: the extra physical references belong only to this append.
 *
 * This entry is synchronous for every ineligible chunk. The database calls it
 * only after ordinary content persistence and metadata publication settle.
 * @param {NativeRecordAliasOwner} owner
 * @param {RecordChunk} recordChunk
 * @param {string|(string|null)[]} contentDictNames
 * @param {import('./term-content-block-store.js').TermContentBlockImportSession|null} blockSession
 * @param {string|null} compressionDictName
 * @param {(offset: number, length: number, dictName: string) => Promise<Uint8Array|null>} readContent
 * @returns {Promise<{chunk: RecordChunk, contentDictName: string, blockStorage: BlockStorage, aliasCount: number, inputBytes: number}|null>|null}
 */
export function tryCreateNativeTermRecordAliases(owner, recordChunk, contentDictNames, blockSession, compressionDictName, readContent) {
    const {sourceChunk, lease, validateOwner} = owner;
    if (
        !Array.isArray(contentDictNames) || blockSession === null ||
        !blockSession.isBlockStorageSelected(sourceChunk.dictionary) ||
        !hasNativeTermRecordLease(lease, sourceChunk)
    ) { return null; }
    assertNativeTermRecordLease(lease, sourceChunk);
    validateOwner();
    const plan = sourceChunk.contentDedupPlan;
    const references = recordChunk.resolvedContentReferences;
    const uniqueCount = plan?.uniqueCount;
    if (
        plan === null || typeof plan === 'undefined' ||
        references === null || typeof references === 'undefined' ||
        typeof uniqueCount !== 'number' || !Number.isSafeInteger(uniqueCount) || uniqueCount <= 0 ||
        uniqueCount > sourceChunk.rowCount ||
        references.uniqueIndexList !== sourceChunk.contentUniqueIndexList ||
        references.offsets !== plan.resolvedOffsets || references.lengths !== plan.resolvedLengths ||
        !(plan.resolvedOffsets.buffer instanceof ArrayBuffer) ||
        !(plan.resolvedLengths.buffer instanceof ArrayBuffer) ||
        plan.resolvedOffsets.length !== uniqueCount || plan.resolvedLengths.length !== uniqueCount ||
        plan.resolvedFlags.length !== uniqueCount ||
        !Array.isArray(plan.resolvedDictNames) || plan.resolvedDictNames.length !== uniqueCount ||
        recordChunk.preparedLookupIndexes !== sourceChunk.preparedLookupIndexes
    ) { return null; }

    // These arrays are filled by this ordered database append, after the
    // receiver lease was acquired. Retain their identities separately from
    // the immutable native parser columns.
    const {resolvedOffsets: offsets, resolvedLengths: lengths, resolvedFlags: flags, resolvedDictNames: names} = plan;
    const targetName = createRawTermContentCompactBlockDictName(compressionDictName);
    /** @type {Array<{offset: number, length: number, uniqueIndexes: number[]}>} */
    const rawReferences = [];
    /** @type {Map<number, Map<number, number>>} */
    const byOffset = new Map();
    let inputBytes = 0;
    let hasCompressed = false;
    for (let uniqueIndex = 0; uniqueIndex < uniqueCount; ++uniqueIndex) {
        const offset = offsets[uniqueIndex];
        const length = lengths[uniqueIndex];
        if (flags[uniqueIndex] === 0 || !Number.isSafeInteger(offset) || offset < 0 || length === 0) { return null; }
        const name = names[uniqueIndex];
        if (name === targetName) {
            hasCompressed = true;
            continue;
        }
        if (name !== RAW_TERM_CONTENT_TOKEN_DICT_NAME) { return null; }
        let byLength = byOffset.get(offset);
        const previous = byLength?.get(length);
        if (typeof previous === 'number') {
            rawReferences[previous].uniqueIndexes.push(uniqueIndex);
            continue;
        }
        inputBytes += length;
        if (rawReferences.length >= MAX_ALIAS_ENTRIES || inputBytes > MAX_ALIAS_INPUT_BYTES) { return null; }
        if (typeof byLength === 'undefined') {
            byLength = new Map();
            byOffset.set(offset, byLength);
        }
        byLength.set(length, rawReferences.length);
        rawReferences.push({offset, length, uniqueIndexes: [uniqueIndex]});
    }
    if (!hasCompressed || rawReferences.length === 0) { return null; }

    const assertOwnership = () => {
        assertNativeTermRecordLease(lease, sourceChunk);
        validateOwner();
        if (
            sourceChunk.contentDedupPlan !== plan ||
            plan.resolvedOffsets !== offsets || plan.resolvedLengths !== lengths ||
            plan.resolvedFlags !== flags || plan.resolvedDictNames !== names ||
            recordChunk.resolvedContentReferences !== references ||
            references.uniqueIndexList !== sourceChunk.contentUniqueIndexList ||
            references.offsets !== offsets || references.lengths !== lengths
        ) { throw new Error('Native term-record resolved content ownership changed'); }
    };

    return (async () => {
        /** @type {Uint8Array[]} */
        const rawBytes = [];
        for (const {offset, length} of rawReferences) {
            assertOwnership();
            const bytes = await readContent(offset, length, RAW_TERM_CONTENT_TOKEN_DICT_NAME);
            assertOwnership();
            if (bytes === null || bytes.byteLength !== length || !isRawTermContentTokenBinary(bytes)) { return null; }
            // Reads can return import-overlay subviews. This bounded copy
            // owns just the canonical inputs across compression and append.
            rawBytes.push(new Uint8Array(bytes));
        }
        assertOwnership();
        const blockStorage = await blockSession.append(sourceChunk.dictionary, rawBytes, compressionDictName);
        assertOwnership();
        if (blockStorage === null) { return null; }
        if (
            blockStorage.contentDictName !== targetName ||
            blockStorage.contentOffsets.length !== rawReferences.length ||
            blockStorage.contentLengths.length !== rawReferences.length
        ) { throw new Error('Native term-record alias storage returned invalid references'); }
        const aliasOffsets = new Float64Array(offsets);
        for (let index = 0; index < rawReferences.length; ++index) {
            const rawReference = rawReferences[index];
            const offset = blockStorage.contentOffsets[index];
            if (!Number.isSafeInteger(offset) || offset < 0 || blockStorage.contentLengths[index] !== rawReference.length) {
                throw new Error('Native term-record alias storage changed the logical content length');
            }
            for (const uniqueIndex of rawReference.uniqueIndexes) { aliasOffsets[uniqueIndex] = offset; }
        }
        return {
            chunk: createArtifactTermRecordChunkWithResolvedContent(
                recordChunk,
                references.uniqueIndexList,
                aliasOffsets,
                lengths,
                sourceChunk.preparedLookupIndexes,
            ),
            contentDictName: targetName,
            blockStorage,
            aliasCount: rawReferences.length,
            inputBytes,
        };
    })();
}
