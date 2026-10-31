/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2016-2022  Yomichan Authors
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

/* eslint-disable-next-line @typescript-eslint/ban-ts-comment */
// @ts-nocheck

/* eslint-disable unicorn/prefer-spread -- Typed copies preserve the production fixture and rollback oracle types. */
/* eslint-disable no-extend-native -- Fault injection tests restore each typed-array prototype in finally. */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';
import {NativeCanonicalScanner, compileCanonicalScanModule} from '../ext/js/dictionary/term-content-canonical-scan.js';
import {CANONICAL_SCAN_LAYOUT as layout} from '../ext/js/dictionary/term-content-canonical-layout.js';

const wasm = new Uint8Array(
    await fs.readFile(new URL('../ext/lib/term-content-canonical-scan-v1.wasm', import.meta.url)),
);
const module = await WebAssembly.compile(wasm);
function jsDatabase() {
    const db = new DictionaryDatabase();
    db._nativeCanonicalScanner = new NativeCanonicalScanner({
        loadModule: async () => {
            throw new Error('JS oracle');
        },
    });
    return db;
}
function useProductionScanner(db, _bytes, hooks = {}) {
    const original = db._nativeCanonicalScanner;
    const scanner = new NativeCanonicalScanner({loadModule: async () => module, hooks});
    db._nativeCanonicalScanner = scanner;
    return {
        stats: scanner.stats,
        restore() {
            db._nativeCanonicalScanner = original;
        },
    };
}

test('production canonical kernel: 63 differential, boundary, rollback and full record/index byte controls', async () => {
    const checks = [],
        totals = {
            calls: 0,
            rows: 0,
            inserted: 0,
            fallbacks: 0,
            instances: 0,
            copiedInputBytes: 0,
            copiedOutputBytes: 0,
            copiedTableBytes: 0,
            copiedGlossaryBytes: 0,
            scatterRows: 0,
            nativeMissJsScatterRows: 0,
            nativePendingRows: 0,
            exactDescriptorRows: 0,
            failedExactAppendRows: 0,
            snapshotBytes: 0,
            adoptedColumnBytes: 0,
            adoptedPlanBytes: 0,
            synchronousRollbacks: 0,
        };
    function collect(controller) {
        for (const key of Object.keys(totals)) {
            totals[key] += controller.stats[key];
        }
    }
    function fixture(n, {existing = false, collision = false, lookup = true, resolved = false, epoch = 1} = {}) {
        const db = jsDatabase(),
            bytes = new Uint8Array(n * 4),
            meta = new Uint32Array(n * 4),
            ids = Uint32Array.from({length: n}, (_, i) => i);
        for (let i = 0; i < n; i++) {
            bytes.set([i & 255, (i >>> 8) & 255, 7, 9], i * 4);
            meta.set([i * 4, 4, i + 1, (i ^ 0x9e3779b9) >>> 0], i * 4);
        }
        if (collision && n > 3) {
            meta[6] = meta[2];
            meta[7] = meta[3];
            meta[10] = meta[2];
            meta[11] = meta[3];
            bytes.set(bytes.subarray(0, 4), 8);
        }
        const plan = {
            uniqueCount: n,
            sourceRowCount: n,
            uniqueRowIndexes: ids.slice(),
            uniqueSignatures: new Uint32Array(n * 3),
            resolvedFlags: new Uint8Array(n),
            resolvedOffsets: new Float64Array(n),
            resolvedLengths: new Uint32Array(n),
            resolvedDictNames: new Array(n),
            pendingEpochs: new Uint32Array(n).fill(87),
            pendingIndexes: new Uint32Array(n).fill(91),
            nextEpoch: epoch,
            persistedLookupRequired: lookup,
        };
        db._ensureTermEntryContentMetaHashPairCapacity(1);
        const storage = new Map();
        if (existing) {
            for (let i = 0; i < n; i++) {
                if (i % 3 === 1) {
                    continue;
                }
                const m = i * 4;
                if (db._getTermEntryContentMetaByHashPair(meta[m + 2], meta[m + 3])) {
                    continue;
                }
                const value = bytes.slice(m, m + 4);
                storage.set(100 + m, value);
                db._setTermEntryContentMetaByHashPair(meta[m + 2], meta[m + 3], {
                    id: i,
                    offset: 100 + m,
                    length: 4,
                    dictName: 'raw',
                });
            }
        }
        db._readTermEntryContentBytesDetailed = async (offset) => ({status: 'ok', bytes: storage.get(offset)});
        if (resolved) {
            plan.resolvedFlags[0] = 1;
            plan.resolvedOffsets[0] = 22;
            plan.resolvedLengths[0] = 4;
            plan.resolvedDictNames[0] = 'old';
        }
        const chunk = {
            rowCount: n,
            contentRowStart: 0,
            contentBytesList: [],
            contentHash1List: new Uint32Array(),
            contentHash2List: new Uint32Array(),
            contentBytesBuffer: bytes,
            contentBytesBaseOffset: 0,
            contentMetaList: meta,
            contentUniqueIndexList: ids,
            contentDedupPlan: plan,
            contentDictNameList: null,
            uniformContentDictName: 'raw',
            useResolvedContentReferences: true,
        };
        return {db, chunk, plan, storage};
    }
    const fields = [
        'HashPairTable',
        'Hash1Table',
        'Hash2Table',
        'StateTable',
        'LengthTable',
        'SignaturePresentTable',
        'Signature1Table',
        'Signature2Table',
        'Signature3Table',
        'IdTable',
        'OffsetTable',
        'DictNameIdTable',
        'RecentSourceBatchIdTable',
        'RecentSourceOffsetTable',
    ];
    function metadata(f) {
        return Object.fromEntries(fields.map((k) => [k, [...(f.db['_termEntryContentMeta' + k] ?? [])]]));
    }
    function same(a, b, ar, br) {
        assert.deepEqual(metadata(b), metadata(a));
        for (const k of [
            '_termEntryContentMetaDenseCount',
            '_termEntryContentMetaHashPairPendingCount',
            '_termEntryContentMetaHashPairCount',
            '_termEntryContentMetaFreeIndexes',
        ]) {
            assert.deepEqual(b.db[k], a.db[k], k);
        }
        for (const k of [
            'resolvedFlags',
            'resolvedOffsets',
            'resolvedLengths',
            'resolvedDictNames',
            'resolvedUniformDictName',
            'pendingEpochs',
            'pendingIndexes',
            'nextEpoch',
        ]) {
            assert.deepEqual(b.plan[k], a.plan[k], k);
        }
        if (ar && br) {
            for (const k of [
                'contentOffsets',
                'contentLengths',
                'resolvedContentDictNames',
                'pendingContentHash1s',
                'pendingContentHash2s',
                'pendingContentCount',
                'pendingHitCount',
                'persistedHitCount',
                'exactFallbackCount',
            ]) {
                assert.deepEqual(br[k], ar[k], k);
            }
            assert.deepEqual([...br.pendingPlanUniqueIndexes], [...ar.pendingPlanUniqueIndexes]);
            assert.deepEqual(br.pendingContentSpans, ar.pendingContentSpans);
            assert.deepEqual(br.stagedContentMetadata, ar.stagedContentMetadata);
        }
    }
    for (const existing of [false, true]) {
        for (const collision of [false, true]) {
            for (const reserve of [false, true]) {
                for (const epoch of [1, 0]) {
                    const a = fixture(73, {existing, collision, epoch, resolved: true}),
                        b = fixture(73, {existing, collision, epoch, resolved: true});
                    const controller = useProductionScanner(b.db, wasm);
                    const ar = await a.db._resolveArtifactTermContentDedup(a.chunk, reserve),
                        br = await b.db._resolveArtifactTermContentDedup(b.chunk, reserve);
                    same(a, b, ar, br);
                    assert.equal(controller.stats.copiedTableBytes, 0);
                    assert.equal(controller.stats.copiedGlossaryBytes, 0);
                    assert.ok(controller.stats.calls > 0);
                    collect(controller);
                    checks.push(
                        `differential existing=${existing} collision=${collision} reserve=${reserve} epoch=${epoch}`,
                    );
                }
            }
        }
    }
    // True published collision-list byte matching: primary bytes differ, secondary equals source.
    {
        const a = fixture(4, {existing: true, collision: true}),
            b = fixture(4, {existing: true, collision: true});
        for (const f of [a, b]) {
            f.db._termEntryContentMetaCollisionsByHashPair.set('1:' + f.chunk.contentMetaList[3], [
                {id: 9, offset: 777, length: 4, dictName: 'raw'},
            ]);
            f.storage.set(777, f.chunk.contentBytesBuffer.slice(4, 8));
        }
        const controller = useProductionScanner(b.db, wasm);
        same(
            a,
            b,
            await a.db._resolveArtifactTermContentDedup(a.chunk, true),
            await b.db._resolveArtifactTermContentDedup(b.chunk, true),
        );
        assert.equal(b.plan.resolvedOffsets[1], 777);
        assert.equal(b.plan.resolvedFlags[1], 1);
        collect(controller);
        checks.push('published collision list uses existing byte matcher');
    }
    // Boundary test includes misses before, between and after exacts; invalid later row must wait.
    for (const candidates of [4095, 4096, 4097]) {
        const n = candidates + 3,
            a = fixture(n),
            b = fixture(n);
        const traces = [];
        for (const f of [a, b]) {
            const trace = [];
            traces.push(trace);
            for (let i = 0; i < n; i++) {
                if (i === 0 || i === 2001 || i === n - 1) {
                    continue;
                }
                const m = i * 4;
                f.db._setTermEntryContentMetaByHashPair(
                    f.chunk.contentMetaList[m + 2],
                    f.chunk.contentMetaList[m + 3],
                    {id: i, offset: 100 + m, length: 4, dictName: 'raw'},
                );
                f.storage.set(100 + m, f.chunk.contentBytesBuffer.slice(m, m + 4));
            }
            const exact = f.db._findMatchingPersistedTermEntryContentMetaBatch.bind(f.db);
            f.db._findMatchingPersistedTermEntryContentMetaBatch = async (descriptors) => {
                trace.push([descriptors.length, f.plan.pendingEpochs[n - 1] === 1]);
                if (descriptors.length === 4096) {
                    assert.equal(f.plan.pendingEpochs[n - 1], 87);
                }
                // Grow authoritative arena while the first wave is in flight; old views stay valid.
                if (descriptors.length === 4096) {
                    const old = f.db._termContentMetadataArena;
                    f.db._ensureTermEntryContentMetaHashPairCapacity(n * 3);
                    assert.ok(old.state.byteLength > 0);
                }
                return exact(descriptors);
            };
        }
        const controller = useProductionScanner(b.db, wasm);
        const ar = await a.db._resolveArtifactTermContentDedup(a.chunk, true),
            br = await b.db._resolveArtifactTermContentDedup(b.chunk, true);
        same(a, b, ar, br);
        assert.deepEqual(traces[1], traces[0]);
        collect(controller);
        checks.push(`${candidates} candidate await ordering, mixed misses, arena growth`);
    }
    for (const fault of ['late-source', 'late-identity', 'late-row', 'trap', 'output-copy', 'exact-read']) {
        const a = fixture(40, {existing: true}),
            b = fixture(40, {existing: true});
        const priorA = metadata(a),
            priorB = metadata(b);
        let fail = true;
        const controller = useProductionScanner(b.db, wasm, {
            get trapAfter() {
                return fault === 'trap' && fail ? 2 : 0;
            },
            beforeOutputCopy() {
                if (fault === 'output-copy' && fail) {
                    throw new Error('copy fault');
                }
            },
        });
        for (const f of [a, b]) {
            if (fault === 'late-source') {
                f.chunk.contentMetaList[39 * 4] = 0xffffffff;
            }
            if (fault === 'late-identity') {
                f.chunk.contentUniqueIndexList[39] = 1;
            }
            if (fault === 'late-row') {
                f.plan.uniqueRowIndexes[20] = 0;
            }
            if (fault === 'exact-read') {
                f.db._readTermEntryContentBytesDetailed = async () => {
                    throw new Error('read fault');
                };
            }
        }
        if (['late-source', 'late-identity', 'late-row', 'exact-read'].includes(fault)) {
            await assert.rejects(a.db._resolveArtifactTermContentDedup(a.chunk, true));
            await assert.rejects(b.db._resolveArtifactTermContentDedup(b.chunk, true));
            // Native can undo an unaccepted segment precisely, baseline rollback leaves reusable IDs.
        } else {
            await assert.rejects(b.db._resolveArtifactTermContentDedup(b.chunk, true));
        }
        assert.equal(b.db._termEntryContentMetaHashPairPendingCount, 0);
        for (const f of [a, b]) {
            assert.equal(f.db._getTermEntryContentMetaByHashPair(1, 0x9e3779b9).offset, 100);
        }
        if (fault !== 'exact-read') {
            assert.equal(b.db._termEntryContentMetaDenseCount, 27); // only the 27 earlier published entries
            assert.deepEqual(b.plan.pendingEpochs, new Uint32Array(40).fill(87));
        }
        fail = false;
        for (const f of [a, b]) {
            f.chunk.contentMetaList[39 * 4] = 39 * 4;
            f.chunk.contentUniqueIndexList[39] = 39;
            f.plan.uniqueRowIndexes[20] = 20;
            f.db._readTermEntryContentBytesDetailed = async (offset) => ({status: 'ok', bytes: f.storage.get(offset)});
        }
        const br = await b.db._resolveArtifactTermContentDedup(b.chunk, true);
        assert.equal(br.pendingContentCount, 13);
        assert.equal(br.persistedHitCount, 27);
        collect(controller);
        checks.push(`${fault} rollback preserves prior entries and retry`);
    }
    // A later malformed row cannot be inspected before the 4096 candidate verification boundary.
    {
        const f = fixture(4098);
        for (let i = 0; i < 4096; i++) {
            const m = i * 4;
            f.db._setTermEntryContentMetaByHashPair(f.chunk.contentMetaList[m + 2], f.chunk.contentMetaList[m + 3], {
                id: i,
                offset: i,
                length: 4,
                dictName: 'raw',
            });
        }
        f.chunk.contentUniqueIndexList[4097] = 0;
        let wave = 0;
        f.db._findMatchingPersistedTermEntryContentMetaBatch = async (d) => {
            ++wave;
            assert.equal(d.length, 4096);
            return d.map((x) => ({existingMeta: x.primary, exactFallback: false}));
        };
        const c = useProductionScanner(f.db, wasm);
        await assert.rejects(f.db._resolveArtifactTermContentDedup(f.chunk, true));
        assert.equal(wave, 1);
        assert.equal(f.plan.resolvedFlags[0], 1);
        assert.equal(f.plan.resolvedFlags[4095], 1);
        collect(c);
        checks.push('late invalid identity after 4096th await preserves earlier resolutions');
    }
    {
        const f = fixture(10),
            controller = useProductionScanner(f.db, wasm);
        const r = await f.db._resolveArtifactTermContentDedup(f.chunk, true);
        f.db._rollbackStagedArtifactTermContentMetadata(r.stagedContentMetadata);
        await f.db._resolveArtifactTermContentDedup(f.chunk, true);
        assert.equal(controller.stats.fallbacks, 1);
        collect(controller);
        checks.push('free-ID fallback before native mutation');
    }
    {
        const f = fixture(100001),
            controller = useProductionScanner(f.db, wasm);
        await f.db._resolveArtifactTermContentDedup(f.chunk, false);
        assert.equal(controller.stats.fallbacks, 1);
        assert.equal(controller.stats.calls, 0);
        collect(controller);
        checks.push('scratch limit fallback before native mutation');
    }

    // Same hashes AND three sampled signatures still require complete byte verification.
    {
        const a = fixture(2, {existing: true}),
            b = fixture(2, {existing: true});
        for (const f of [a, b]) {
            const bytes = Uint8Array.from({length: 40}, (_, i) => i % 20);
            bytes[26] = 99;
            f.chunk.contentBytesBuffer = bytes;
            f.chunk.contentMetaList.set([0, 20, 1, 2, 20, 20, 1, 2]);
            const sig = [
                f.db._readTermContentSignature(bytes, 0),
                f.db._readTermContentSignature(bytes, 8),
                f.db._readTermContentSignature(bytes, 16),
            ];
            f.plan.uniqueSignatures.set([...sig, ...sig]);
            f.db._setTermEntryContentMetaByHashPair(1, 2, {
                id: 9,
                offset: 777,
                length: 20,
                dictName: 'raw',
                signature1: sig[0],
                signature2: sig[1],
                signature3: sig[2],
            });
            f.storage.set(777, bytes.slice(0, 20));
        }
        const c = useProductionScanner(b.db, wasm),
            ar = await a.db._resolveArtifactTermContentDedup(a.chunk, true),
            br = await b.db._resolveArtifactTermContentDedup(b.chunk, true);
        same(a, b, ar, br);
        assert.equal(br.persistedHitCount, 1);
        assert.equal(br.pendingContentCount, 1);
        assert.deepEqual([...br.pendingPlanUniqueIndexes], [1]);
        collect(c);
        checks.push('equal hashes and signatures with unequal middle bytes require full verification');
    }
    // Trap/output failure restores every hot metadata word and exact slot coordinate.
    for (const fault of ['trap', 'copy', 'scatter']) {
        const f = fixture(40, {existing: true});
        let before, counts;
        const c = useProductionScanner(f.db, wasm, {
            trapAfter: fault === 'trap' ? 3 : 0,
            beforeNative() {
                before = metadata(f);
                counts = [f.db._termEntryContentMetaDenseCount, f.db._termEntryContentMetaHashPairPendingCount];
            },
            beforeOutputCopy() {
                if (fault === 'copy') {
                    throw new Error('copy fault');
                }
            },
            afterPlanWrite() {
                if (fault === 'scatter') {
                    throw new Error('post-plan fault');
                }
            },
        });
        await assert.rejects(f.db._resolveArtifactTermContentDedup(f.chunk, true));
        assert.deepEqual(metadata(f), before);
        assert.deepEqual(
            [f.db._termEntryContentMetaDenseCount, f.db._termEntryContentMetaHashPairPendingCount],
            counts,
        );
        collect(c);
        checks.push(`${fault} precise full-column and slot rollback without table rebuild`);
    }
    // Full publication owner: compare persisted bytes and row-record content references,
    // with repeated rows, pending hash collisions, reimport and borrowed slab release.
    {
        function owner(native) {
            const f = fixture(40);
            f.chunk.dictionary = 'synthetic';
            f.chunk.dictionaryTotalRows = 80;
            f.chunk.contentBytesBuffer[8] = 55;
            f.chunk.contentMetaList[10] = f.chunk.contentMetaList[2];
            f.chunk.contentMetaList[11] = f.chunk.contentMetaList[3];
            const old = f.chunk.contentMetaList;
            f.chunk.rowCount = 80;
            f.chunk.contentMetaList = new Uint32Array(320);
            f.chunk.contentMetaList.set(old);
            f.chunk.contentMetaList.set(old, 160);
            f.chunk.contentUniqueIndexList = Uint32Array.from({length: 80}, (_, i) => i % 40);
            for (let i = 0; i < 40; i++) {
                const bytes = f.chunk.contentBytesBuffer.subarray(i * 4, i * 4 + 4),
                    word = f.db._readTermContentSignature(bytes, 0);
                f.plan.uniqueSignatures.set([word, word, word], i * 3);
            }
            f.db._bulkImportTransactionOpen = true;
            f.db._deferTermsVirtualTableSync = true;
            f.db._termContentZstdInitialized = true;
            const content = [],
                records = [],
                encoded = [];
            const encoder = new TermRecordOpfsStore();
            let releases = 0,
                next = 0;
            f.chunk.releaseBorrowedContent = () => {
                ++releases;
            };
            f.db._termContentBlockImportSession = {
                tryBeginAppendSpans(_dict, buffer, offsets, lengths) {
                    assert.equal(f.db._termEntryContentMetaHashPairCount, 0);
                    assert.ok(f.db._termEntryContentMetaHashPairPendingCount > 0);
                    const contentOffsets = new Float64Array(offsets.length),
                        contentLengths = lengths.slice();
                    for (let i = 0; i < offsets.length; i++) {
                        contentOffsets[i] = next;
                        const bytes = buffer.slice(offsets[i], offsets[i] + lengths[i]);
                        content.push([next, bytes]);
                        f.storage.set(next, bytes);
                        next += bytes.length;
                    }
                    const stored = {contentOffsets, contentLengths, contentDictName: 'raw'};
                    return {
                        initialSelection: false,
                        storage: Promise.resolve(stored),
                        sourceConsumed: Promise.resolve(),
                        completion: Promise.resolve({
                            ...stored,
                            packMs: 0,
                            compressMs: 0,
                            envelopeMs: 0,
                            referenceMs: 0,
                            opfsAppendMs: 0,
                        }),
                    };
                },
            };
            f.chunk.expressionBytesList = Array.from({length: 80}, (_, i) => new TextEncoder().encode('語' + i));
            f.chunk.readingBytesList = Array.from({length: 80}, () => new TextEncoder().encode('ご'));
            f.chunk.readingEqualsExpressionList = new Uint8Array(80);
            f.chunk.scoreList = Int32Array.from({length: 80}, (_, i) => i - 40);
            f.chunk.sequenceList = Int32Array.from({length: 80}, (_, i) => i * 2);
            f.db._termRecordStore = {
                async appendBatchFromArtifactChunkResolvedContent(chunk) {
                    const r = chunk.resolvedContentReferences;
                    const result = await encoder._encodeArtifactChunkRecords(
                        chunk,
                        new Float64Array(),
                        new Uint32Array(),
                    );
                    encoded.push({
                        contentOffsetBase: result.contentOffsetBase,
                        recordFields: result.recordFields,
                        lookupIndexBytes: result.lookupIndexBytes,
                        recordFieldsFormat: result.recordFieldsFormat,
                    });
                    for (let row = 0; row < chunk.rowCount; row++) {
                        const u = r.uniqueIndexList[row],
                            offset = r.offsets[u],
                            length = r.lengths[u];
                        const bytes = f.storage.get(offset);
                        assert.deepEqual(bytes, f.chunk.contentBytesBuffer.slice((row % 40) * 4, (row % 40) * 4 + 4));
                        const record = new Uint8Array(16);
                        const d = new DataView(record.buffer);
                        d.setUint32(0, row, true);
                        d.setFloat64(4, offset, true);
                        d.setUint32(12, length, true);
                        records.push(record);
                    }
                    return {buildRecordsMs: 0, encodeMs: 0, appendWriteMs: 0};
                },
            };
            const controller = native ? useProductionScanner(f.db, wasm) : null;
            return {...f, controller, content, records, encoded, getReleases: () => releases};
        }
        const a = owner(false),
            b = owner(true);
        for (const f of [a, b]) {
            await f.db._bulkAddArtifactTermsChunkWithContentDedup(f.chunk);
        }
        same(a, b);
        assert.deepEqual(b.content, a.content);
        assert.deepEqual(b.records, a.records);
        assert.deepEqual(b.encoded, a.encoded);
        assert.equal(b.db.getLastBulkAddTermsMetrics().dedupNativeCallCount, 1);
        assert.equal(b.db.getLastBulkAddTermsMetrics().dedupNativeScannedRows, 40);
        assert.equal(b.db.getLastBulkAddTermsMetrics().dedupNativeBulkPendingRows, 40);
        assert.equal(b.db.getLastBulkAddTermsMetrics().dedupNativeFallbackCount, 0);
        assert.equal(b.content.length, 40);
        assert.equal(b.getReleases(), 1);
        assert.equal(b.db._termEntryContentMetaHashPairPendingCount, 0);
        assert.equal(b.db._termEntryContentMetaHashPairCount, 39);
        assert.equal(b.db._termEntryContentMetaCollisionsByHashPair.size, 1);
        const before = b.content.length;
        for (const f of [a, b]) {
            f.plan.resolvedFlags.fill(0);
            f.plan.persistedLookupRequired = true;
            await f.db._bulkAddArtifactTermsChunkWithContentDedup(f.chunk);
        }
        same(a, b);
        assert.deepEqual(b.records, a.records);
        assert.deepEqual(b.encoded, a.encoded);
        assert.equal(b.content.length, before);
        collect(b.controller);
        checks.push(
            'full content publication and 160 production-encoded row-record byte/reference parity including collision and reimport',
        );
    }

    // Failure in a later await cannot rewind dense IDs allocated before the earlier await.
    {
        const a = fixture(4099),
            b = fixture(4099);
        for (const f of [a, b]) {
            for (let i = 1; i < 4099; i++) {
                if (i === 4097) {
                    continue;
                }
                const m = i * 4;
                f.db._setTermEntryContentMetaByHashPair(
                    f.chunk.contentMetaList[m + 2],
                    f.chunk.contentMetaList[m + 3],
                    {id: i, offset: 100 + m, length: 4, dictName: 'raw'},
                );
                f.storage.set(100 + m, f.chunk.contentBytesBuffer.slice(m, m + 4));
            }
            let wave = 0;
            const original = f.db._findMatchingPersistedTermEntryContentMetaBatch.bind(f.db);
            f.db._findMatchingPersistedTermEntryContentMetaBatch = async (d) => {
                if (++wave === 2) {
                    throw new Error('later exact read rejection');
                }
                return original(d);
            };
        }
        const c = useProductionScanner(b.db, wasm);
        const dense = b.db._termEntryContentMetaDenseCount;
        await assert.rejects(a.db._resolveArtifactTermContentDedup(a.chunk, true));
        await assert.rejects(b.db._resolveArtifactTermContentDedup(b.chunk, true));
        same(a, b);
        assert.equal(b.plan.resolvedFlags[4096], 1);
        assert.equal(b.plan.resolvedFlags[4098], 0);
        assert.equal(b.db._termEntryContentMetaDenseCount, dense + 2);
        for (const f of [a, b]) {
            f.db._findMatchingPersistedTermEntryContentMetaBatch =
                DictionaryDatabase.prototype._findMatchingPersistedTermEntryContentMetaBatch.bind(f.db);
        }
        same(
            a,
            b,
            await a.db._resolveArtifactTermContentDedup(a.chunk, true),
            await b.db._resolveArtifactTermContentDedup(b.chunk, true),
        );
        assert.equal(c.stats.fallbacks, 1);
        collect(c);
        checks.push('later exact rejection preserves earlier flags/dense IDs; free-ID retry matches JS');
    }
    // Nonzero global row range AND byte base, selected unique subrange, and duplicates.
    for (const existing of [false, true]) {
        for (const reserve of [false, true]) {
            const a = fixture(40, {existing, resolved: true}),
                b = fixture(40, {existing, resolved: true});
            for (const f of [a, b]) {
                const old = f.chunk.contentMetaList,
                    bytes = new Uint8Array(19 + f.chunk.contentBytesBuffer.length);
                bytes.set(f.chunk.contentBytesBuffer, 19);
                f.chunk.contentBytesBuffer = bytes;
                f.chunk.contentBytesBaseOffset = 19;
                // Unique global rows 0,2,...78. Select rows 21..54: first unique 11,
                // last unique 28; first chunk row is a duplicate whose owner was earlier.
                f.plan.uniqueRowIndexes = Uint32Array.from({length: 40}, (_, i) => i * 2);
                f.chunk.rowCount = 34;
                f.chunk.contentRowStart = 21;
                f.chunk.contentMetaList = new Uint32Array(34 * 4);
                f.chunk.contentUniqueIndexList = new Uint32Array(34);
                for (let row = 0; row < 34; ++row) {
                    const u = Math.floor((row + 21) / 2);
                    f.chunk.contentMetaList.set(old.subarray(u * 4, u * 4 + 4), row * 4);
                    f.chunk.contentUniqueIndexList[row] = u;
                }
                f.plan.resolvedFlags[10] = 1;
                f.plan.resolvedOffsets[10] = 321;
                f.plan.resolvedLengths[10] = 4;
                f.plan.resolvedDictNames[10] = 'old';
                f.plan.resolvedFlags[12] = 1;
                f.plan.resolvedOffsets[12] = 876;
                f.plan.resolvedLengths[12] = 4;
                f.plan.resolvedDictNames[12] = 'old';
            }
            const c = useProductionScanner(b.db, wasm);
            const ar = await a.db._resolveArtifactTermContentDedup(a.chunk, reserve),
                br = await b.db._resolveArtifactTermContentDedup(b.chunk, reserve);
            same(a, b, ar, br);
            assert.ok(c.stats.calls > 0);
            assert.equal(b.plan.pendingEpochs[9], 87);
            assert.equal(b.plan.pendingEpochs[28], 87);
            for (let i = 0; i < br.pendingContentCount; i++) {
                const u = br.pendingPlanUniqueIndexes[i];
                assert.ok(u >= 11 && u < 28);
                assert.equal(b.plan.pendingIndexes[u], i);
                assert.equal(b.plan.pendingEpochs[u], 1);
                assert.equal(br.pendingContentSpans.offsets[i], 19 + u * 4);
            }
            collect(c);
            checks.push(
                `nonzero rowStart/baseOffset selected unique subrange duplicates existing=${existing} reserve=${reserve}`,
            );
        }
    }
    // Native healthy direct misses have no JS per-pending callback, scatter, exact
    // descriptor, or failed-exact append. Maximum rows prove the exact prefix bound.
    {
        const f = fixture(layout.MAX);
        const c = useProductionScanner(f.db, wasm);
        const r = await f.db._resolveArtifactTermContentDedup(f.chunk, true);
        assert.ok(r.pendingPlanUniqueIndexes instanceof Uint32Array);
        assert.equal(r.pendingContentCount, layout.MAX);
        assert.equal(c.stats.nativeMissJsScatterRows, 0);
        assert.equal(c.stats.scatterRows, 0);
        assert.equal(c.stats.exactDescriptorRows, 0);
        assert.equal(c.stats.failedExactAppendRows, 0);
        assert.equal(c.stats.inserted, layout.MAX);
        assert.equal(c.stats.copiedTableBytes, 0);
        assert.equal(c.stats.copiedGlossaryBytes, 0);
        for (let i = 0; i < layout.MAX; ++i) {
            assert.equal(r.pendingPlanUniqueIndexes[i], i);
            assert.equal(f.plan.pendingIndexes[i], i);
            assert.equal(f.plan.pendingEpochs[i], 1);
            assert.equal(r.pendingContentSpans.offsets[i], i * 4);
            assert.equal(r.stagedContentMetadata.indexes[i], i);
        }
        collect(c);
        checks.push(
            '100000 healthy fresh direct misses: native SOA/epochs/order, zero JS pending scatter, fixed scratch bound',
        );
    }
    // Actual partial typed-set failures: a prefix has already been modified when
    // the throw occurs. Test pending output, staged IDs, and each JS plan column.
    for (const fault of [
        'copy-first',
        'copy-second',
        'column-partial',
        'staged-partial',
        'epoch-partial',
        'index-partial',
        'after-plan',
        'exact-descriptor',
    ]) {
        const f = fixture(40, {existing: true});
        let before, counts;
        const epochs = f.plan.pendingEpochs.slice(),
            indexes = f.plan.pendingIndexes.slice();
        const uSet = Uint32Array.prototype.set,
            iSet = Int32Array.prototype.set,
            uSlice = Uint32Array.prototype.slice;
        let fired = false;
        const c = useProductionScanner(f.db, wasm, {
            beforeNative() {
                before = metadata(f);
                counts = [f.db._termEntryContentMetaDenseCount, f.db._termEntryContentMetaHashPairPendingCount];
            },
            beforeOutputCopy({column}) {
                if ((fault === 'copy-first' && column === 0) || (fault === 'copy-second' && column === 1)) {
                    Uint32Array.prototype.slice = function injectedSlice() {
                        Uint32Array.prototype.slice = uSlice;
                        fired = true;
                        throw new Error(fault);
                    };
                }
            },
            beforeAdopt({columns}) {
                if (fault === 'column-partial' || fault === 'epoch-partial' || fault === 'index-partial') {
                    Uint32Array.prototype.set = function injectedUint32Set(source, offset = 0) {
                        const target =
                            fault === 'column-partial' ?
                                source === columns[1] :
                                this === (fault === 'epoch-partial' ? f.plan.pendingEpochs : f.plan.pendingIndexes);
                        if (target) {
                            Uint32Array.prototype.set = uSet;
                            uSet.call(this, source.subarray(0, Math.max(1, source.length >>> 1)), offset);
                            fired = true;
                            throw new Error(fault);
                        }
                        return uSet.call(this, source, offset);
                    };
                }
                if (fault === 'staged-partial') {
                    Int32Array.prototype.set = function injectedInt32Set(source, offset = 0) {
                        Int32Array.prototype.set = iSet;
                        iSet.call(this, source.subarray(0, Math.max(1, source.length >>> 1)), offset);
                        fired = true;
                        throw new Error(fault);
                    };
                }
            },
            afterPlanWrite() {
                if (fault === 'after-plan') {
                    fired = true;
                    throw new Error(fault);
                }
            },
            afterExactDescriptor() {
                if (fault === 'exact-descriptor') {
                    fired = true;
                    throw new Error(fault);
                }
            },
        });
        try {
            await assert.rejects(f.db._resolveArtifactTermContentDedup(f.chunk, true));
        } finally {
            Uint32Array.prototype.set = uSet;
            Int32Array.prototype.set = iSet;
            Uint32Array.prototype.slice = uSlice;
        }
        assert.ok(fired, fault);
        assert.deepEqual(metadata(f), before, fault);
        assert.deepEqual(
            [f.db._termEntryContentMetaDenseCount, f.db._termEntryContentMetaHashPairPendingCount],
            counts,
        );
        assert.deepEqual(f.plan.pendingEpochs, epochs);
        assert.deepEqual(f.plan.pendingIndexes, indexes);
        assert.equal(c.stats.synchronousRollbacks, 1);
        assert.deepEqual(f.db._termEntryContentMetaFreeIndexes, []);
        // No double-cleared/freed IDs: retry can use the native route again.
        c.restore();
        const retry = useProductionScanner(f.db, wasm);
        const r = await f.db._resolveArtifactTermContentDedup(f.chunk, true);
        assert.equal(r.pendingContentCount, 13);
        assert.equal(retry.stats.fallbacks, 0);
        collect(c);
        collect(retry);
        checks.push(`${fault}: exact native columns/slots/counts and plan restoration; no double-clear; native retry`);
    }
    // A failed synchronous second segment preserves earlier accepted flags and
    // projections; only earlier accepted pending IDs reach ordinary outer rollback.
    for (const fault of [
        'late-source',
        'late-identity',
        'late-row',
        'trap',
        'copy-second',
        'after-plan',
        'exact-descriptor',
    ]) {
        const f = fixture(4101);
        let wave = 0,
            fired = false;
        for (let i = 1; i < 4101; i++) {
            if (i === 4097 || i === 4100) {
                continue;
            }
            const m = i * 4;
            f.db._setTermEntryContentMetaByHashPair(f.chunk.contentMetaList[m + 2], f.chunk.contentMetaList[m + 3], {
                id: i,
                offset: 100 + m,
                length: 4,
                dictName: 'raw',
            });
            f.storage.set(100 + m, f.chunk.contentBytesBuffer.slice(m, m + 4));
        }
        const exact = f.db._findMatchingPersistedTermEntryContentMetaBatch.bind(f.db);
        f.db._findMatchingPersistedTermEntryContentMetaBatch = async (d) => {
            ++wave;
            const r = await exact(d);
            if (wave === 1) {
                if (fault === 'late-source') {
                    f.chunk.contentMetaList[4100 * 4] = 0xffffffff;
                }
                if (fault === 'late-identity') {
                    f.chunk.contentUniqueIndexList[4100] = 0;
                }
                if (fault === 'late-row') {
                    f.plan.uniqueRowIndexes[4100] = 1;
                }
                // Trigger arena replacement so native must copy the altered later inputs.
                f.db._ensureTermEntryContentMetaHashPairCapacity(20000);
            }
            return r;
        };
        const dense = f.db._termEntryContentMetaDenseCount;
        const c = useProductionScanner(f.db, wasm, {
            get trapAfter() {
                return fault === 'trap' && wave === 1 ? 1 : 0;
            },
            beforeOutputCopy({column}) {
                if (fault === 'copy-second' && wave === 1 && column === 1) {
                    fired = true;
                    throw new Error(fault);
                }
            },
            afterPlanWrite() {
                if (fault === 'after-plan' && wave === 1) {
                    fired = true;
                    throw new Error(fault);
                }
            },
            afterExactDescriptor() {
                if (fault === 'exact-descriptor' && wave === 1) {
                    fired = true;
                    throw new Error(fault);
                }
            },
        });
        await assert.rejects(f.db._resolveArtifactTermContentDedup(f.chunk, true));
        assert.equal(wave, 1);
        assert.equal(f.plan.resolvedFlags[4096], 1);
        assert.equal(f.plan.resolvedFlags[4098], 0);
        assert.equal(f.plan.pendingEpochs[0], 1);
        assert.equal(f.plan.pendingIndexes[0], 0);
        assert.equal(f.plan.pendingEpochs[4097], 87);
        assert.equal(f.plan.pendingIndexes[4097], 91);
        assert.equal(f.db._termEntryContentMetaDenseCount, dense + 1);
        assert.equal(f.db._termEntryContentMetaHashPairPendingCount, 0);
        assert.equal(f.db._termEntryContentMetaFreeIndexes.length, 1);
        assert.equal(f.db._getTermEntryContentMetaByHashPair(2, f.chunk.contentMetaList[7]).offset, 104);
        if (['copy-second', 'after-plan', 'exact-descriptor'].includes(fault)) {
            assert.ok(fired);
        }
        collect(c);
        checks.push(
            `later ${fault}: preserve accepted segment flags/projections/dense IDs, restore current native/JS segment`,
        );
    }
    // Mixed dict names and missing/short signature/plan arrays use original JS
    // before native mutation. A no-reservation arena may be initialized by adapter.
    for (const shape of ['mixed-names', 'missing-signatures', 'short-epochs', 'short-indexes', 'no-arena']) {
        const a = fixture(10),
            b = fixture(10);
        for (const f of [a, b]) {
            if (shape === 'mixed-names') {
                f.chunk.contentDictNameList = Array.from({length: 10}, (_, i) => (i % 2 ? 'raw' : 'other'));
            }
            if (shape === 'missing-signatures') {
                f.plan.uniqueSignatures = null;
            }
            if (shape === 'short-epochs') {
                f.plan.pendingEpochs = new Uint32Array(2);
            }
            if (shape === 'short-indexes') {
                f.plan.pendingIndexes = new Uint32Array(2);
            }
            if (shape === 'no-arena') {
                f.db = jsDatabase();
            }
        }
        const c = useProductionScanner(b.db, wasm);
        const ar = await a.db._resolveArtifactTermContentDedup(a.chunk, shape !== 'no-arena'),
            br = await b.db._resolveArtifactTermContentDedup(b.chunk, shape !== 'no-arena');
        // Native no-reservation initialization adds an empty arena only; no metadata mutation.
        if (shape !== 'no-arena') {
            same(a, b, ar, br);
        } else {
            assert.deepEqual(br.pendingContentSpans, ar.pendingContentSpans);
            assert.equal(br.pendingContentCount, 10);
            assert.ok(c.stats.calls > 0);
        }
        if (shape !== 'no-arena') {
            assert.equal(c.stats.calls, 0);
            assert.equal(c.stats.fallbacks, 1);
        }
        collect(c);
        checks.push(`${shape} pre-mutation fallback or no-reservation native initialization`);
    }

    // Failed exact rows append after their wave, before direct misses in the next
    // segment. This also proves pendingBase refresh and typed failed-exact indexing.
    for (const leadingMiss of [false, true]) {
        const n = 4100,
            a = fixture(n),
            b = fixture(n);
        for (const f of [a, b]) {
            for (let i = leadingMiss ? 1 : 0; i < (leadingMiss ? 4097 : 4096); ++i) {
                const m = i * 4;
                f.db._setTermEntryContentMetaByHashPair(
                    f.chunk.contentMetaList[m + 2],
                    f.chunk.contentMetaList[m + 3],
                    {id: i, offset: 100 + m, length: 4, dictName: 'raw'},
                );
                const value = f.chunk.contentBytesBuffer.slice(m, m + 4);
                if (i === 1 || i === 2001 || i === 4095) {
                    value[2] = 88;
                }
                f.storage.set(100 + m, value);
            }
        }
        const c = useProductionScanner(b.db, wasm),
            ar = await a.db._resolveArtifactTermContentDedup(a.chunk, true),
            br = await b.db._resolveArtifactTermContentDedup(b.chunk, true);
        same(a, b, ar, br);
        assert.deepEqual(
            [...br.pendingPlanUniqueIndexes],
            leadingMiss ? [0, 1, 2001, 4095, 4097, 4098, 4099] : [1, 2001, 4095, 4096, 4097, 4098, 4099],
        );
        assert.equal(c.stats.failedExactAppendRows, 3);
        assert.equal(c.stats.nativeMissJsScatterRows, 0);
        collect(c);
        checks.push(
            `4096 wave with three failed exact rows: same pending order and refreshed base, leadingMiss=${leadingMiss}`,
        );
    }
    // Real hash values with colliding open-addressed slots exercise probe chains;
    // separate forced equal-pair controls above exercise exact byte collisions.
    {
        const a = fixture(300),
            b = fixture(300);
        const {hashTermEntryContentBytesPair} = await import('../ext/js/dictionary/term-entry-content-hash.js');
        let slotCollisions = 0;
        for (const f of [a, b]) {
            f.db._ensureTermEntryContentMetaHashPairCapacity(300);
            const slots = new Set(),
                mask = f.db._termContentMetadataArena.slots.length - 1;
            for (let i = 0; i < 300; i++) {
                const m = i * 4,
                    [h1, h2] = hashTermEntryContentBytesPair(f.chunk.contentBytesBuffer.subarray(m, m + 4));
                f.chunk.contentMetaList[m + 2] = h1;
                f.chunk.contentMetaList[m + 3] = h2;
                let h = (h1 ^ Math.imul(h2, 0x9e3779b1)) >>> 0;
                h ^= h >>> 16;
                const slot = h & mask;
                if (slots.has(slot)) {
                    ++slotCollisions;
                }
                slots.add(slot);
                if (i % 3 === 0) {
                    f.db._setTermEntryContentMetaByHashPair(h1, h2, {
                        id: i,
                        offset: 100 + m,
                        length: 4,
                        dictName: 'raw',
                    });
                    f.storage.set(100 + m, f.chunk.contentBytesBuffer.slice(m, m + 4));
                }
            }
        }
        assert.ok(slotCollisions > 0);
        const c = useProductionScanner(b.db, wasm);
        same(
            a,
            b,
            await a.db._resolveArtifactTermContentDedup(a.chunk, true),
            await b.db._resolveArtifactTermContentDedup(b.chunk, true),
        );
        collect(c);
        checks.push('real XXH32-pair values with slot probe collisions across published and pending entries');
    }
    assert.ok(layout.usedBytes <= layout.PREFIX);
    assert.equal(layout.usedBytes, 8263840);
    assert.equal(checks.length, 63);
});

test('production typed pending IDs: storage and record failure, old-entry preservation, free-ID retry (4 controls)', async () => {
    const results = [];
    for (const fault of ['storage', 'record']) {
        for (const native of [false, true]) {
            const db = jsDatabase();
            db._bulkImportTransactionOpen = true;
            db._deferTermsVirtualTableSync = true;
            db._termContentZstdInitialized = true;
            const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
                meta = new Uint32Array(24),
                ids = Uint32Array.from([0, 1, 2, 0, 1, 2]);
            for (let r = 0; r < 6; r++) {
                const u = r % 3;
                meta.set([u * 4, 4, u + 11, u + 31], r * 4);
            }
            const plan = {
                uniqueCount: 3,
                sourceRowCount: 6,
                uniqueRowIndexes: Uint32Array.from([0, 1, 2]),
                uniqueSignatures: new Uint32Array(9),
                resolvedFlags: new Uint8Array(3),
                resolvedOffsets: new Float64Array(3),
                resolvedLengths: new Uint32Array(3),
                resolvedDictNames: new Array(3),
                pendingEpochs: new Uint32Array(3),
                pendingIndexes: new Uint32Array(3),
                nextEpoch: 1,
                persistedLookupRequired: true,
            };
            for (let u = 0; u < 3; u++) {
                const word = db._readTermContentSignature(bytes, u * 4);
                plan.uniqueSignatures.set([word, word, word], u * 3);
            }
            const chunk = {
                dictionary: 'outer-fault',
                dictionaryTotalRows: 6,
                rowCount: 6,
                contentRowStart: 0,
                contentBytesList: [],
                contentHash1List: new Uint32Array(),
                contentHash2List: new Uint32Array(),
                contentBytesBuffer: bytes,
                contentBytesBaseOffset: 0,
                contentMetaList: meta,
                contentUniqueIndexList: ids,
                contentDedupPlan: plan,
                contentDictNameList: null,
                uniformContentDictName: 'raw',
                useResolvedContentReferences: true,
            };
            const storage = new Map([[2000, Uint8Array.from([20, 21, 22, 23])]]);
            db._setTermEntryContentMetaByHashPair(9, 9, {id: 77, offset: 2000, length: 4, dictName: 'old'});
            const old = {...db._getTermEntryContentMetaByHashPair(9, 9)};
            db._readTermEntryContentBytesDetailed = async (offset) => ({status: 'ok', bytes: storage.get(offset)});
            let activeFault = true,
                releases = 0,
                appends = 0,
                typedResults = 0;
            chunk.releaseBorrowedContent = () => {
                releases++;
            };
            db._termContentBlockImportSession = {
                tryBeginAppendSpans(_name, source, offsets, lengths) {
                    const contentOffsets = new Float64Array(offsets.length),
                        contentLengths = lengths.slice();
                    let next = 0;
                    for (let i = 0; i < offsets.length; i++) {
                        contentOffsets[i] = next;
                        storage.set(next, source.slice(offsets[i], offsets[i] + lengths[i]));
                        next += lengths[i];
                    }
                    const stored = {contentOffsets, contentLengths, contentDictName: 'raw'};
                    const storagePromise =
                        activeFault && fault === 'storage' ?
                            Promise.reject(new Error('storage fault')) :
                            Promise.resolve(stored);
                    return {
                        initialSelection: false,
                        storage: storagePromise,
                        sourceConsumed: Promise.resolve(),
                        completion: storagePromise.then((value) => ({
                            ...value,
                            packMs: 0,
                            compressMs: 0,
                            envelopeMs: 0,
                            referenceMs: 0,
                            opfsAppendMs: 0,
                        })),
                    };
                },
            };
            db._termRecordStore = {
                async appendBatchFromArtifactChunkResolvedContent(recordChunk) {
                    if (activeFault && fault === 'record') {
                        throw new Error('record fault');
                    }
                    const r = recordChunk.resolvedContentReferences;
                    assert.equal(r.uniqueIndexList.length, 6);
                    for (let row = 0; row < 6; row++) {
                        const u = r.uniqueIndexList[row];
                        assert.deepEqual(storage.get(r.offsets[u]), bytes.slice((row % 3) * 4, (row % 3) * 4 + 4));
                    }
                    appends++;
                    return {buildRecordsMs: 0, encodeMs: 0, appendWriteMs: 0};
                },
            };
            const controller = native ? useProductionScanner(db, wasm) : null;
            const resolve = db._resolveArtifactTermContentDedup.bind(db);
            db._resolveArtifactTermContentDedup = async (...args) => {
                const value = await resolve(...args);
                if (value.pendingPlanUniqueIndexes instanceof Uint32Array) {
                    typedResults++;
                }
                return value;
            };
            await assert.rejects(db._bulkAddArtifactTermsChunkWithContentDedup(chunk), new RegExp(fault + ' fault'));
            assert.equal(releases, 1);
            assert.equal(appends, 0);
            assert.equal(db._termEntryContentMetaHashPairPendingCount, 0);
            assert.equal(db._termEntryContentMetaHashPairCount, 1);
            assert.deepEqual(db._getTermEntryContentMetaByHashPair(9, 9), old);
            assert.deepEqual([...plan.resolvedFlags], [0, 0, 0]);
            assert.deepEqual([...plan.resolvedOffsets], [0, 0, 0]);
            assert.deepEqual([...plan.resolvedLengths], [0, 0, 0]);
            if (native) {
                assert.equal(typedResults, 1);
                assert.equal(controller.stats.calls, 1);
                assert.equal(controller.stats.fallbacks, 0);
            }
            activeFault = false;
            await db._bulkAddArtifactTermsChunkWithContentDedup(chunk);
            assert.equal(releases, 2);
            assert.equal(appends, 1);
            assert.equal(db._termEntryContentMetaHashPairPendingCount, 0);
            assert.equal(db._termEntryContentMetaHashPairCount, 4);
            assert.deepEqual([...plan.resolvedFlags], [1, 1, 1]);
            assert.deepEqual(db._getTermEntryContentMetaByHashPair(9, 9), old);
            if (native) {
                assert.equal(controller.stats.fallbacks, 1);
            } // Exact existing free-ID fallback before mutation.
            results.push({fault, native, typedResults, releases, appends, stats: controller?.stats ?? null});
        }
    }

    assert.equal(results.length, 4);
});

test('default loader: missing asset retry, single-flight, healthy native metrics, ABI fallback before mutation', async () => {
    const oldFetch = globalThis.fetch;
    let fetches = 0;
    try {
        globalThis.fetch = vi.fn(async (url) => {
            assert.ok(String(url).endsWith('/lib/term-content-canonical-scan-v1.wasm'));
            ++fetches;
            if (fetches === 1) {
                return new Response('', {status: 404});
            }
            return new Response(wasm);
        });
        await assert.rejects(compileCanonicalScanModule());
        const [a, b] = await Promise.all([compileCanonicalScanModule(), compileCanonicalScanModule()]);
        assert.equal(a, b);
        assert.equal(fetches, 2);
        // Default database scanner uses the real packaged loader and ABI.
        const db = new DictionaryDatabase();
        const bytes = Uint8Array.from([1, 2, 3, 4]);
        const plan = {
            uniqueRowIndexes: Uint32Array.of(0),
            uniqueSignatures: new Uint32Array(3),
            resolvedFlags: new Uint8Array(1),
            resolvedOffsets: new Float64Array(1),
            resolvedLengths: new Uint32Array(1),
            resolvedDictNames: [''],
            pendingEpochs: new Uint32Array(1),
            pendingIndexes: new Uint32Array(1),
            nextEpoch: 1,
            persistedLookupRequired: true,
        };
        const chunk = {
            rowCount: 1,
            contentRowStart: 0,
            contentBytesList: [],
            contentHash1List: [],
            contentHash2List: [],
            contentBytesBuffer: bytes,
            contentBytesBaseOffset: 0,
            contentMetaList: Uint32Array.of(0, 4, 1, 2),
            contentUniqueIndexList: Uint32Array.of(0),
            contentDedupPlan: plan,
            contentDictNameList: null,
            uniformContentDictName: 'raw',
            useResolvedContentReferences: true,
        };
        const r = await db._resolveArtifactTermContentDedup(chunk, true);
        assert.ok(r.pendingPlanUniqueIndexes instanceof Uint32Array);
        assert.equal(r.nativeScanMetrics.dedupNativeCallCount, 1);
        assert.equal(r.nativeScanMetrics.dedupNativeScannedRows, 1);
        assert.equal(r.nativeScanMetrics.dedupNativeBulkPendingRows, 1);
        assert.equal(r.nativeScanMetrics.dedupNativeFallbackCount, 0);
        assert.ok(r.nativeScanMetrics.dedupNativeCopiedInputBytes > 0);
        assert.equal(db._termContentMetadataArena.memory.buffer instanceof SharedArrayBuffer, false);
        for (const mode of ['missing', 'mismatch']) {
            const f = new DictionaryDatabase();
            // Valid empty WASM module, with no ABI exports.
            f._nativeCanonicalScanner = new NativeCanonicalScanner({
                loadModule: async () => {
                    if (mode === 'missing') {
                        throw new Error('asset absent');
                    }
                    return await WebAssembly.compile(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
                },
            });
            const nextPlan = {
                ...plan,
                resolvedFlags: new Uint8Array(1),
                pendingEpochs: new Uint32Array(1),
                pendingIndexes: new Uint32Array(1),
            };
            const out = await f._resolveArtifactTermContentDedup({...chunk, contentDedupPlan: nextPlan}, true);
            assert.equal(out.nativeScanMetrics.dedupNativeCallCount, 0);
            assert.equal(out.nativeScanMetrics.dedupNativeFallbackCount, 1);
            assert.ok(Array.isArray(out.pendingPlanUniqueIndexes));
            assert.equal(f._nativeCanonicalScanner.stats.inserted, 0);
            assert.equal(out.pendingContentCount, 1);
            assert.equal(f._termEntryContentMetaHashPairPendingCount, 1);
        }
    } finally {
        globalThis.fetch = oldFetch;
    }
});

test('one helper isolates database memories and follows reset without retaining a current arena', async () => {
    function fixture() {
        const db = new DictionaryDatabase();
        const plan = {uniqueRowIndexes: Uint32Array.of(0),
            uniqueSignatures: new Uint32Array(3),
            resolvedFlags: new Uint8Array(1),
            resolvedOffsets: new Float64Array(1),
            resolvedLengths: new Uint32Array(1),
            resolvedDictNames: [''],
            pendingEpochs: new Uint32Array(1),
            pendingIndexes: new Uint32Array(1),
            nextEpoch: 1,
            persistedLookupRequired: true};
        const chunk = {rowCount: 1,
            contentRowStart: 0,
            contentBytesList: [],
            contentHash1List: [],
            contentHash2List: [],
            contentBytesBuffer: Uint8Array.of(1, 2, 3, 4),
            contentBytesBaseOffset: 0,
            contentMetaList: Uint32Array.of(0, 4, 11, 12),
            contentUniqueIndexList: Uint32Array.of(0),
            contentDedupPlan: plan,
            contentDictNameList: null,
            uniformContentDictName: 'raw',
            useResolvedContentReferences: true};
        return {db, chunk};
    }
    const a = fixture(),
        b = fixture();
    const scanner = new NativeCanonicalScanner({loadModule: async () => module});
    a.db._nativeCanonicalScanner = b.db._nativeCanonicalScanner = scanner;
    const first = await a.db._resolveArtifactTermContentDedup(a.chunk, false);
    const original = a.db._termContentMetadataArena;
    b.chunk.contentMetaList[2] = 99;
    await b.db._resolveArtifactTermContentDedup(b.chunk, false);
    assert.notEqual(b.db._termContentMetadataArena.memory, original.memory);
    assert.deepEqual(first.pendingContentHash1s, Uint32Array.of(11));
    await a.db._resolveArtifactTermContentDedup(a.chunk, false);
    assert.equal(scanner.stats.instances, 2);
    a.db._clearTermEntryContentMetaCaches();
    assert.equal(a.db._termContentMetadataArena, null);
    const next = await a.db._resolveArtifactTermContentDedup(a.chunk, false);
    assert.notEqual(a.db._termContentMetadataArena.memory, original.memory);
    assert.equal(scanner.stats.instances, 3);
    assert.equal(scanner.stats.fallbacks, 0);
    assert.deepEqual(next.pendingContentHash1s, Uint32Array.of(11));
    assert.deepEqual(first.pendingContentHash1s, Uint32Array.of(11));
});

/* eslint-enable no-extend-native */
/* eslint-enable unicorn/prefer-spread */
