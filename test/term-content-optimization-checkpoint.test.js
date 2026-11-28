/* SPDX-License-Identifier: GPL-3.0-or-later */

import {expect, test} from 'vitest';
import {decodeOnlineContentFrameCheckpoint, encodeOnlineContentFrameCheckpoint, parseOnlineContentFrameDescriptor} from '../ext/js/dictionary/term-content-optimization-checkpoint.js';

/** @returns {import('../ext/js/dictionary/term-content-optimization-checkpoint.js').OnlineContentFrameDescriptor} */
function frame() {
    return {identity: {kind: 'legacy-entry',
        logicalOffset: 2 ** 34,
        recordLength: 512,
        sourceStoredLength: 100,
        originalCodecId: null,
        expectedDecodedLength: null,
        originalEnvelope: 'none'},
    physicalKey: 'file-a:16+60/file-b:0+40',
    storedLength: 100,
    codecId: null,
    envelope: 'none',
    decodedLength: null,
    decodedDigest: null};
}

test('generalized frames preserve decoded versus physical length and exact replay encoding', () => {
    const original = frame();
    const row = encodeOnlineContentFrameCheckpoint(original);
    const legacy = {...row, metadataJson: JSON.stringify({version: 1, frame: original})};
    expect(decodeOnlineContentFrameCheckpoint(row)).toEqual(original);
    expect(decodeOnlineContentFrameCheckpoint(legacy)).toEqual(original);
    expect(row.metadataJson.length).toBeLessThan(legacy.metadataJson.length);
    expect(row.sequence).toBe(2 ** 34);
    const reordered = Object.fromEntries(Object.entries(original).reverse());
    expect(encodeOnlineContentFrameCheckpoint(reordered)).toEqual(row);
    const owned = parseOnlineContentFrameDescriptor(original);
    original.identity.sourceStoredLength = 17;
    expect(owned.identity.sourceStoredLength).toBe(100);
});

test('encoded byte admission counts UTF-8 rather than JavaScript code units', () => {
    expect(() => encodeOnlineContentFrameCheckpoint({...frame(), physicalKey: 'あ'.repeat(7000)})).toThrow(RangeError);
});

test('checkpoint validators reject accessors without executing them', () => {
    const input = frame();
    let invoked = false;
    Object.defineProperty(input, 'physicalKey', {get() {
        invoked = true;
        return 'fake';
    },
    enumerable: true});
    expect(() => parseOnlineContentFrameDescriptor(input)).toThrow(TypeError);
    expect(invoked).toBe(false);
});

test('persisted side columns cannot silently disagree with the immutable descriptor', () => {
    const row = encodeOnlineContentFrameCheckpoint(frame());
    for (const bad of [{...row, sequence: 1}, {...row, byteLength: 99}, {...row, sha256: 'a'.repeat(64)}, {...row, metadataJson: '{"version":2,"frame":{}}'}]) {
        expect(() => decodeOnlineContentFrameCheckpoint(bad)).toThrow(TypeError);
    }
});

test('impossible physical spans, envelopes and codec selectors reject before persistence', () => {
    const original = frame();
    for (const bad of [
        {...original, identity: {...original.identity, logicalOffset: Number.MAX_SAFE_INTEGER}},
        {...original, identity: {...original.identity, kind: 'block'}},
        {...original, identity: {...original.identity, expectedDecodedLength: 700}},
        {...original, codecId: ''},
        {...original, decodedDigest: 'a'.repeat(64)},
        {...original, physicalKey: ''},
    ]) {
        expect(() => encodeOnlineContentFrameCheckpoint(bad)).toThrow(TypeError);
    }
});
