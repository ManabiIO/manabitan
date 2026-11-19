/*
 * Copyright (C) 2026  Manabitan authors
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
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {test} from 'vitest'
import {createSchedule, verifyCanonicalRows, verifyEquivalentResults} from '../dev/perf/canonical-scan-benchmark.js'

test('canonical screen counterbalances adjacent pairs and rejects invalid schedules', () => {
    assert.equal(createSchedule(2, 'ABBA').map((row) => row.arm).join(''), 'ABBABAAB')
    assert.equal(createSchedule(2, 'BAAB').map((row) => row.arm).join(''), 'BAABABBA')
    for (const brackets of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(() => createSchedule(brackets, 'ABBA'))
    }
    assert.throws(() => createSchedule(1, 'AAAA'))
})

/** @returns {Parameters<typeof verifyCanonicalRows>[0]} */
function makeChunk() {
    const first = new Uint8Array(80).fill(7)
    const second = new Uint8Array(80).fill(7)
    second[20] = 8
    const bytes = new Uint8Array(160)
    bytes.set(first)
    bytes.set(second, 80)
    return /** @type {Parameters<typeof verifyCanonicalRows>[0]} */ ({
        rowCount: 3,
        uniformContentDictName: 'raw-v6',
        contentBytesBuffer: bytes,
        contentBytesBaseOffset: 0,
        contentMetaList: new Uint32Array([0, 80, 1, 2, 80, 80, 1, 2, 0, 80, 1, 2]),
        contentUniqueIndexList: new Uint32Array([0, 1, 0]),
        contentDedupPlan: {
            resolvedFlags: new Uint8Array([1, 1]),
            resolvedOffsets: new Float64Array([1, 81]),
            resolvedLengths: new Uint32Array([80, 80]),
            resolvedDictNames: null,
            resolvedUniformDictName: 'raw-v6',
            pendingEpochs: new Uint32Array(2),
            pendingIndexes: new Uint32Array(2),
            nextEpoch: 2,
        },
    })
}

test('canonical screen verifies every alias with full bytes, not matching sampled signatures', () => {
    const chunk = makeChunk()
    const storage = new Map([
        [1, new Uint8Array(chunk.contentBytesBuffer.subarray(0, 80))],
        [81, new Uint8Array(chunk.contentBytesBuffer.subarray(80, 160))],
    ])
    const input = createHash('sha256')
    const output = createHash('sha256')
    const references = createHash('sha256')
    assert.equal(verifyCanonicalRows(chunk, storage, input, output, references), 240)
    assert.equal(input.digest('hex'), output.digest('hex'))
    // Both payloads have identical first/middle/last signatures and lengths.
    // The byte at position 20 must still reject a false persisted-content hit.
    storage.set(81, new Uint8Array(chunk.contentBytesBuffer.subarray(0, 80)))
    assert.throws(() => verifyCanonicalRows(chunk, storage, createHash('sha256'), createHash('sha256'), createHash('sha256')), /Canonical bytes differ at row 1/)
    storage.set(81, new Uint8Array(chunk.contentBytesBuffer.subarray(80, 160)))
    // A wrong alias must fail even when both unique definitions are correct.
    chunk.contentMetaList[8] = 80
    assert.throws(() => verifyCanonicalRows(chunk, storage, createHash('sha256'), createHash('sha256'), createHash('sha256')), /Canonical bytes differ at row 2/)
    chunk.contentMetaList[8] = 0
    storage.delete(1)
    assert.throws(() => verifyCanonicalRows(chunk, storage, createHash('sha256'), createHash('sha256'), createHash('sha256')), /Missing content/)
})

test('canonical screen rejects missing publication and wrong representations', () => {
    const chunk = makeChunk()
    const storage = new Map([[1, new Uint8Array(80).fill(7)]])
    chunk.contentDedupPlan.resolvedFlags[0] = 0
    assert.throws(() => verifyCanonicalRows(chunk, storage, createHash('sha256'), createHash('sha256'), createHash('sha256')), /Unpublished row 0/)
    chunk.contentDedupPlan.resolvedFlags[0] = 1
    chunk.contentDedupPlan.resolvedUniformDictName = 'raw'
    assert.throws(() => verifyCanonicalRows(chunk, storage, createHash('sha256'), createHash('sha256'), createHash('sha256')), /Wrong content representation/)
})

/** @returns {Parameters<typeof verifyEquivalentResults>[0]} */
function makeResult() {
    return {
        resolveMs: 1,
        publicationMs: 1,
        rows: 3,
        groups: 1,
        contentBytes: 240,
        storedUniqueContents: 2,
        storedBytes: 160,
        pendingHits: 1,
        persistedHits: 0,
        exactFallbacks: 0,
        recentSourceHits: 0,
        metadataArenaBytes: 100,
        scannerStats: {calls: 1, snapshotBytes: 10},
        sourceContentSha256: 'content',
        resolvedContentSha256: 'content',
        referencesSha256: 'references',
        metadataSha256: 'metadata',
        storageSha256: 'storage',
    }
}

test('canonical comparison requires complete output equality while allowing instrumentation savings', () => {
    const a = makeResult()
    const b = {...a, resolveMs: 0.5, scannerStats: {calls: 1, snapshotBytes: 0}}
    verifyEquivalentResults(a, b)
    for (const field of ['sourceContentSha256', 'resolvedContentSha256', 'referencesSha256', 'metadataSha256', 'storageSha256']) {
        assert.throws(() => verifyEquivalentResults(a, {...b, [field]: 'corrupt'}), /output mismatch/)
        assert.throws(() => verifyEquivalentResults({...a, [field]: null}, {...b, [field]: null}), /Missing/)
    }
    assert.throws(() => verifyEquivalentResults(a, {...b, rows: 2}), /output mismatch/)
})
