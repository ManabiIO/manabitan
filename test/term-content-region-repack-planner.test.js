/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test} from 'vitest';
import {createContentLayoutResolver} from '../ext/js/dictionary/term-content-layout.js';
import {iterateContentRepackCopyChunks, planContentRegionRepack} from '../ext/js/dictionary/term-content-region-repack-planner.js';

/** @typedef {import('../ext/js/dictionary/term-content-layout.js').Frame} Frame */
/** @typedef {import('../ext/js/dictionary/term-content-layout.js').FrameIdentity} FrameIdentity */
/** @typedef {import('../ext/js/dictionary/term-content-layout.js').PhysicalFile} PhysicalFile */
/** @typedef {import('../ext/js/dictionary/term-content-region-repack-planner.js').ContentRepackWindow} ContentRepackWindow */
/** @typedef {import('../ext/js/dictionary/term-content-region-repack-planner.js').ContentRegionRepackPlan} ContentRegionRepackPlan */

const DIGEST = 'a'.repeat(64);
const DICT_DIGEST = 'b'.repeat(64);

/** @param {number} logicalOffset @param {number} [sourceStoredLength] @param {Partial<Frame>} [fields] @returns {Frame} */
function frame(logicalOffset, sourceStoredLength = 20, fields = {}) {
    return {
        kind: 'block', logicalOffset, recordLength: sourceStoredLength, sourceStoredLength,
        originalCodecId: null, expectedDecodedLength: 40, originalEnvelope: 'none',
        fileId: 'staged', physicalOffset: 0, storedLength: 16, codecId: 'custom',
        envelope: 'none', decodedLength: 40, decodedDigest: DIGEST, ...fields,
    };
}

/** @param {FrameIdentity} value @returns {FrameIdentity} */
function identity(value) {
    const {kind, logicalOffset, recordLength, sourceStoredLength, originalCodecId, expectedDecodedLength, originalEnvelope} = value;
    return {kind, logicalOffset, recordLength, sourceStoredLength, originalCodecId, expectedDecodedLength, originalEnvelope};
}

/** @param {number} [start] @param {number} [length] @param {number} [count] @returns {ContentRepackWindow} */
function source(start = 0, length = 100, count = 2) {
    /** @type {PhysicalFile[]} */
    const files = [
        {fileId: 'old', byteLength: length * count, sha256: null},
        {fileId: 'staged', byteLength: 128, sha256: null},
        {fileId: 'dictionary', byteLength: 8, sha256: DICT_DIGEST},
    ];
    return {
        manifests: Array.from({length: count}, (_, i) => ({
            version: 1, regionId: 'region' + i,
            logicalStart: start + i * length, logicalLength: length,
            extents: [{logicalOffset: 0, length, fileId: 'old', physicalOffset: i * length}], blocks: [], removed: [],
        })),
        externalFrames: [], files, physicalFiles: structuredClone(files),
        codecs: [{codecId: 'custom', fileId: 'dictionary', formatVersion: 1, dictionaryBytes: 8, dictionarySha256: DICT_DIGEST}],
    };
}

/** @param {Map<string, Uint8Array>} bytes @param {string} fileId @returns {Uint8Array} */
function requireFileBytes(bytes, fileId) {
    const value = bytes.get(fileId);
    if (typeof value === 'undefined') { throw new Error('Missing fixture bytes: ' + fileId); }
    return value;
}

/** @param {ContentRegionRepackPlan} plan @param {Map<string, Uint8Array>} bytes @returns {Map<string, Uint8Array>} */
function executeSmallCopies(plan, bytes) {
    const result = new Map(bytes);
    for (const write of plan.writes) { result.set(write.fileId, new Uint8Array(write.byteLength)); }
    for (const copy of iterateContentRepackCopyChunks(plan, 7)) {
        requireFileBytes(result, copy.targetFileId).set(
            requireFileBytes(result, copy.sourceFileId).subarray(copy.sourceOffset, copy.sourceOffset + copy.length), copy.targetOffset,
        );
    }
    return result;
}

/**
 * @param {ReturnType<typeof createContentLayoutResolver>} resolver
 * @param {Map<string, Uint8Array>} bytes
 * @param {number} offset
 * @param {number} length
 * @returns {Uint8Array}
 */
function logicalBytes(resolver, bytes, offset, length) {
    const output = new Uint8Array(length);
    let cursor = 0;
    for (const span of resolver.resolveLogical(offset, length)) {
        output.set(requireFileBytes(bytes, span.fileId).subarray(span.physicalOffset, span.physicalOffset + span.length), cursor);
        cursor += span.length;
    }
    return output;
}

describe('bounded content region repack planning', () => {
    test('owns a crossing frame once and resolves unrelated bytes in its continuation window', () => {
        const replacement = frame(90);
        const plan = planContentRegionRepack({source: source(), replacements: [replacement],
            packFiles: [{regionId: 'region0', fileId: 'pack0'}, {regionId: 'region1', fileId: 'pack1'}]});
        expect(plan.next.manifests[0].removed).toEqual([{logicalOffset: 90, length: 10, frameLogicalOffset: 90}]);
        expect(plan.next.manifests[1].removed).toEqual([{logicalOffset: 0, length: 10, frameLogicalOffset: 90}]);
        expect(plan.next.manifests[0].blocks).toEqual([replacement]);
        expect(plan.next.manifests[1].blocks).toEqual([]);
        const continuation = createContentLayoutResolver({...plan.next, manifests: [plan.next.manifests[1]], externalFrames: [replacement]});
        expect(continuation.resolveLogical(120, 5)).toEqual([{fileId: 'pack1', physicalOffset: 10, length: 5}]);
        expect(() => continuation.resolveLogical(100, 1)).toThrow(/superseded/i);
        expect(plan.next.files.map((f) => f.fileId).sort()).toEqual(['dictionary', 'pack0', 'pack1', 'staged']);
        expect(plan.readFiles.map((f) => f.fileId)).toEqual(['old']);
    });

    test('copies every retained media/reference/header byte exactly, without interpreting byte roles', () => {
        const old = Uint8Array.from({length: 200}, (_, i) => (i * 13) % 256);
        const input = source();
        const before = structuredClone(input);
        const plan = planContentRegionRepack({source: input, replacements: [frame(90)],
            packFiles: [{regionId: 'region0', fileId: 'pack0'}, {regionId: 'region1', fileId: 'pack1'}]});
        const bytes = executeSmallCopies(plan, new Map([['old', old], ['staged', new Uint8Array(128)], ['dictionary', new Uint8Array(8)]]));
        const resolver = createContentLayoutResolver(plan.next);
        for (const [offset, length] of [[0, 90], [110, 90], [20, 24], [150, 20], [180, 10]]) {
            expect(logicalBytes(resolver, bytes, offset, length)).toEqual(old.slice(offset, offset + length));
        }
        expect(input).toEqual(before);
        expect(Object.isFrozen(plan.next.manifests[0].extents[0])).toBe(true);
    });

    test('flattens an existing override and relocates its actual stored bytes, with no redirect', () => {
        const first = planContentRegionRepack({source: source(), replacements: [frame(20)]});
        const second = planContentRegionRepack({source: first.next,
            packFiles: [{regionId: 'region0', fileId: 'packed'}], relocateFrames: true});
        const block = second.next.manifests[0].blocks[0];
        expect(block).toEqual({...frame(20), fileId: 'packed', physicalOffset: 80});
        expect(second.writes[0].byteLength).toBe(96);
        expect(second.writes[0].operations.at(-1)).toMatchObject({sourceFileId: 'staged', sourceOffset: 0, targetOffset: 80, length: 16, role: 'frame'});
        expect(createContentLayoutResolver(second.next).resolveFrame(identity(block))).toMatchObject({storedLength: 16});
    });

    test('replaces an existing override using its original identity, never the old replacement span', () => {
        const first = planContentRegionRepack({source: source(), replacements: [frame(20)]});
        const replacement = frame(20, 20, {physicalOffset: 32, storedLength: 12});
        const second = planContentRegionRepack({source: first.next, replacements: [replacement]});
        expect(second.next.manifests[0].blocks).toEqual([replacement]);
        expect(second.next.manifests[0].removed).toEqual([{logicalOffset: 20, length: 20, frameLogicalOffset: 20}]);
        expect(() => planContentRegionRepack({source: first.next, replacements: [frame(20, 21)]})).toThrow(/conflicts/);
        expect(() => planContentRegionRepack({source: first.next, replacements: [frame(20, 20, {decodedDigest: 'c'.repeat(64)})]})).toThrow(/digest/);
    });

    test('rejects overlap, duplicate identities, incomplete windows and reused output files before writes exist', () => {
        expect(() => planContentRegionRepack({source: source(), replacements: [frame(80, 30), frame(100)]})).toThrow(/overlap/);
        expect(() => planContentRegionRepack({source: source(), replacements: [frame(80), frame(80)]})).toThrow(/Duplicate/);
        expect(() => planContentRegionRepack({source: source(), replacements: [frame(190)]})).toThrow(/complete affected/);
        expect(() => planContentRegionRepack({source: source(), replacements: [frame(0, 201)]})).toThrow(/complete affected/);
        expect(() => planContentRegionRepack({source: source(), packFiles: [{regionId: 'region0', fileId: 'old'}]})).toThrow(/fresh/);
    });

    test('rejects physical aliases and accessors before returning a relocation plan', () => {
        expect(() => planContentRegionRepack({source: source(), replacements: [frame(10, 20, {fileId: 'old', physicalOffset: 50})],
            packFiles: [{regionId: 'region0', fileId: 'packed'}], relocateFrames: true})).toThrow(/physical spans overlap/i);
        let accessorCalls = 0;
        const replacement = frame(10);
        Object.defineProperty(replacement, 'storedLength', {enumerable: true, get() { ++accessorCalls; return 16; }});
        expect(() => planContentRegionRepack({source: source(), replacements: [replacement]})).toThrow(/own-data/);
        expect(accessorCalls).toBe(0);
        const targets = [{regionId: 'region0', fileId: 'packed'}];
        Object.defineProperty(targets[0], 'fileId', {enumerable: true, get() { ++accessorCalls; return 'packed'; }});
        expect(() => planContentRegionRepack({source: source(), packFiles: targets})).toThrow(/own-data/);
        expect(accessorCalls).toBe(0);
    });

    test('uses exact legacy compressed source length rather than decoded recordLength', () => {
        const legacy = frame(80, 12, {kind: 'legacy-entry', recordLength: 1000, expectedDecodedLength: 1000, decodedLength: 1000});
        const plan = planContentRegionRepack({source: source(), replacements: [legacy]});
        expect(plan.next.manifests[0].removed).toEqual([{logicalOffset: 80, length: 12, frameLogicalOffset: 80}]);
        expect(plan.next.manifests[1].removed).toEqual([]);
        expect(createContentLayoutResolver(plan.next).resolveLogical(92, 8)).toEqual([{fileId: 'old', physicalOffset: 92, length: 8}]);
    });

    test('preserves logical and physical offsets above 2^32 without bitwise truncation', () => {
        const high = 2 ** 32 + 33;
        const input = source(high, 100, 1);
        input.files[0].byteLength = high + 100;
        input.physicalFiles[0].byteLength = high + 100;
        input.manifests[0].extents[0].physicalOffset = high;
        const plan = planContentRegionRepack({source: input, replacements: [frame(high + 30)], packFiles: [{regionId: 'region0', fileId: 'highpack'}]});
        expect(plan.writes[0].operations[0].sourceOffset).toBe(high);
        expect(plan.writes[0].operations[1].sourceOffset).toBe(high + 50);
        expect(plan.next.manifests[0].removed[0].frameLogicalOffset).toBe(high + 30);
        expect(createContentLayoutResolver(plan.next).resolveLogical(high + 60, 5)[0].physicalOffset).toBe(40);
    });

    test('permits a physical pack larger than its logical region and emits bounded chunks without large arrays', () => {
        const regionBytes = 128 * 1024 * 1024;
        const storedBytes = 512 * 1024;
        const input = source(0, regionBytes);
        input.files[1].byteLength = storedBytes;
        input.physicalFiles[1].byteLength = storedBytes;
        const replacement = frame(regionBytes - 64 * 1024, 1024 * 1024, {storedLength: storedBytes, expectedDecodedLength: 2 * 1024 * 1024, decodedLength: 2 * 1024 * 1024});
        const plan = planContentRegionRepack({source: input, replacements: [replacement],
            packFiles: [{regionId: 'region0', fileId: 'largepack'}], relocateFrames: true});
        expect(plan.writes[0].byteLength).toBe(regionBytes + 448 * 1024);
        let sum = 0;
        let count = 0;
        for (const copy of iterateContentRepackCopyChunks(plan)) {
            expect(copy.length).toBeLessThanOrEqual(4 * 1024 * 1024);
            if (copy.role === 'frame') { expect(copy.logicalOffset).toBe(replacement.logicalOffset); }
            sum += copy.length;
            ++count;
        }
        expect(sum).toBe(plan.writes[0].byteLength);
        expect(count).toBeLessThan(40);
    });

    test('retains an external owner when repacking only its continuation region', () => {
        const first = planContentRegionRepack({source: source(), replacements: [frame(90)]});
        const continuation = {...first.next, manifests: [first.next.manifests[1]], externalFrames: [frame(90)]};
        const plan = planContentRegionRepack({source: continuation, packFiles: [{regionId: 'region1', fileId: 'tailpack'}], relocateFrames: true});
        expect(plan.next.externalFrames).toEqual([frame(90)]);
        expect(plan.next.manifests[0].blocks).toEqual([]);
        expect(plan.writes[0].byteLength).toBe(90);
        expect(createContentLayoutResolver(plan.next).resolveLogical(110, 1)[0].fileId).toBe('tailpack');
    });

    test('rejects unsafe arithmetic, missing codec/file closure, descriptor bounds and resource admission', () => {
        expect(() => planContentRegionRepack({source: source(), replacements: [frame(Number.MAX_SAFE_INTEGER, 1)]})).toThrow(/Unsafe/);
        expect(() => planContentRegionRepack({source: source(), replacements: [frame(10, 20, {codecId: 'missing'})]})).toThrow(/codec closure/);
        expect(() => planContentRegionRepack({source: source(), replacements: [frame(10, 20, {fileId: 'missing'})]})).toThrow(/Physical span|file closure/);
        expect(() => planContentRegionRepack({source: source(), replacements: [frame(10, 20, {physicalOffset: 120})]})).toThrow(/Physical span/);
        expect(() => planContentRegionRepack({source: source(), replacements: Array(16385).fill(frame(10))})).toThrow(/admission/);
        expect(() => [...iterateContentRepackCopyChunks({writes: []}, 4 * 1024 * 1024 + 1)]).toThrow(/chunk bound/);
        expect(() => planContentRegionRepack({source: source(), replacements: [frame(10, 20, {physicalOffset: 120})],
            packFiles: [{regionId: 'region0', fileId: 'packed'}], relocateFrames: true})).toThrow(/source physical span/);
        expect(() => planContentRegionRepack({source: source(), replacements: [frame(10, 20, {physicalOffset: -1})],
            packFiles: [{regionId: 'region0', fileId: 'packed'}], relocateFrames: true})).toThrow(/Unsafe/);
    });
});
