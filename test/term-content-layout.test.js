/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test} from 'vitest';
import {createContentLayoutResolver, SupersededCompressedRangeError} from '../ext/js/dictionary/term-content-layout.js';

const DATA_SHA = 'a'.repeat(64);
const DICTIONARY_SHA = 'b'.repeat(64);
const DECODED_SHA = 'c'.repeat(64);

/**
 * @returns {import('core').SafeAny} Raw persisted JSON is deliberately mutated into invalid shapes below.
 */
function fixture() {
    const files = [
        {fileId: 'data', byteLength: 100, sha256: DATA_SHA},
        {fileId: 'dictionary', byteLength: 4, sha256: DICTIONARY_SHA},
    ];
    return {
        manifests: [{
            version: 1,
            regionId: 'r0',
            logicalStart: 0,
            logicalLength: 20,
            extents: [
                {logicalOffset: 0, length: 8, fileId: 'data', physicalOffset: 0},
                {logicalOffset: 14, length: 6, fileId: 'data', physicalOffset: 8},
            ],
            blocks: [frame()],
            removed: [{logicalOffset: 8, length: 6, frameLogicalOffset: 8}],
        }],
        externalFrames: [],
        files,
        physicalFiles: files.map((file) => ({...file})),
        codecs: [{codecId: 'custom', fileId: 'dictionary', formatVersion: 1, dictionaryBytes: 4, dictionarySha256: DICTIONARY_SHA}],
    };
}

function frame() {
    return {
        kind: 'block',
        logicalOffset: 8,
        recordLength: 6,
        sourceStoredLength: 6,
        originalCodecId: null,
        expectedDecodedLength: 50,
        originalEnvelope: 'none',
        fileId: 'data',
        physicalOffset: 14,
        storedLength: 4,
        codecId: 'custom',
        envelope: 'none',
        decodedLength: 50,
        decodedDigest: DECODED_SHA,
    };
}

function identity(overrides = {}) {
    return {
        kind: 'block',
        logicalOffset: 8,
        recordLength: 6,
        sourceStoredLength: 6,
        originalCodecId: null,
        expectedDecodedLength: 50,
        originalEnvelope: 'none',
        ...overrides,
    };
}

function crossRegionFixture() {
    const input = fixture();
    input.manifests[0].logicalLength = 10;
    input.manifests[0].extents.length = 1;
    input.manifests[0].removed[0].length = 2;
    input.manifests.push({
        version: 1,
        regionId: 'r1',
        logicalStart: 10,
        logicalLength: 10,
        extents: [{logicalOffset: 4, length: 6, fileId: 'data', physicalOffset: 8}],
        blocks: [],
        removed: [{logicalOffset: 0, length: 4, frameLogicalOffset: 8}],
    });
    return input;
}

describe('bounded immutable content layout', () => {
    test('resolves retained bytes and replacement bytes in separate domains', () => {
        const resolver = createContentLayoutResolver(fixture());
        expect(resolver.resolveLogical(2, 4)).toStrictEqual([{fileId: 'data', physicalOffset: 2, length: 4}]);
        expect(resolver.resolveLogical(14, 6)).toStrictEqual([{fileId: 'data', physicalOffset: 8, length: 6}]);
        expect(resolver.resolveFrame(identity())).toStrictEqual({
            identity: identity(),
            sourceStoredLength: 6,
            spans: [{fileId: 'data', physicalOffset: 14, length: 4}],
            storedLength: 4,
            codecId: 'custom',
            envelope: 'none',
            decodedLength: 50,
            decodedDigest: DECODED_SHA,
        });
    });

    test.each([[8, 1], [7, 2], [0, 20], [13, 2]])('reports superseded bytes without calling healthy holes corruption (%s,%s)', (offset, length) => {
        const resolver = createContentLayoutResolver(fixture());
        expect(() => resolver.resolveLogical(offset, length)).toThrow(SupersededCompressedRangeError);
        try {
            resolver.resolveLogical(offset, length);
            throw new Error('Expected a superseded range');
        } catch (error) {
            if (!(error instanceof SupersededCompressedRangeError)) { throw error; }
            expect(error).toMatchObject({name: 'SupersededCompressedRangeError', code: 'supersededCompressedRange'});
            expect(error.name).not.toBe('TermContentIntegrityError');
        }
    });

    test('allows a healthy identity region with no overrides', () => {
        const input = fixture();
        input.manifests[0].blocks = [];
        input.manifests[0].removed = [];
        input.manifests[0].extents = [{logicalOffset: 0, length: 20, fileId: 'data', physicalOffset: 0}];
        const resolver = createContentLayoutResolver(input);
        const original = identity({logicalOffset: 2, originalCodecId: 'jmdict'});
        expect(resolver.resolveFrame(original)).toMatchObject({
            identity: original,
            sourceStoredLength: 6,
            spans: [{fileId: 'data', physicalOffset: 2, length: 6}],
            storedLength: 6,
            codecId: 'jmdict',
            envelope: 'none',
            decodedLength: 50,
            decodedDigest: null,
        });
    });

    test('publishes an override before reclaiming its source interval', () => {
        const input = fixture();
        input.manifests[0].removed = [];
        input.manifests[0].blocks[0].physicalOffset = 30;
        input.manifests[0].extents = [{logicalOffset: 0, length: 20, fileId: 'data', physicalOffset: 0}];
        const resolver = createContentLayoutResolver(input);
        expect(resolver.resolveLogical(8, 6)).toEqual([{fileId: 'data', physicalOffset: 8, length: 6}]);
        expect(resolver.resolveFrame(identity()).storedLength).toBe(4);
    });

    test('validates one original frame crossing two regions without duplicate replacement descriptors', () => {
        const resolver = createContentLayoutResolver(crossRegionFixture());
        expect(resolver.resolveFrame(identity()).sourceStoredLength).toBe(6);
        expect(resolver.resolveLogical(14, 6)).toEqual([{fileId: 'data', physicalOffset: 8, length: 6}]);
        expect(() => resolver.resolveLogical(9, 2)).toThrow(SupersededCompressedRangeError);
        expect(() => resolver.resolveLogical(10, 1)).toThrow(SupersededCompressedRangeError);
    });

    test('splits retained reads at extent and region boundaries', () => {
        const input = crossRegionFixture();
        input.manifests[0].blocks = [];
        input.manifests[0].removed = [];
        input.manifests[0].extents = [
            {logicalOffset: 0, length: 5, fileId: 'data', physicalOffset: 20},
            {logicalOffset: 5, length: 5, fileId: 'data', physicalOffset: 0},
        ];
        input.manifests[1].removed = [];
        input.manifests[1].extents = [{logicalOffset: 0, length: 10, fileId: 'data', physicalOffset: 40}];
        expect(createContentLayoutResolver(input).resolveLogical(3, 10)).toEqual([
            {fileId: 'data', physicalOffset: 23, length: 2},
            {fileId: 'data', physicalOffset: 0, length: 5},
            {fileId: 'data', physicalOffset: 40, length: 3},
        ]);
    });

    test('reclaims only a suffix region using an explicit external frame owner', () => {
        const input = crossRegionFixture();
        input.externalFrames = [input.manifests[0].blocks[0]];
        input.manifests.shift();
        const resolver = createContentLayoutResolver(input);
        expect(resolver.logicalStart).toBe(10);
        expect(resolver.resolveFrame(identity()).codecId).toBe('custom');
        expect(() => resolver.resolveLogical(10, 4)).toThrow(SupersededCompressedRangeError);
    });

    test('supports a huge monolithic shared glossary override without loading all source regions', () => {
        const input = fixture();
        Object.assign(input.manifests[0].blocks[0], {
            kind: 'shared-glossary',
            recordLength: 1000000000,
            sourceStoredLength: 1000000000,
            originalEnvelope: 'none',
            expectedDecodedLength: 2000000000,
            decodedLength: 2000000000,
        });
        input.manifests[0].removed = [];
        input.manifests[0].blocks[0].physicalOffset = 30;
        input.manifests[0].extents = [{logicalOffset: 0, length: 20, fileId: 'data', physicalOffset: 0}];
        const resolver = createContentLayoutResolver(input);
        expect(resolver.resolveFrame(identity({
            kind: 'shared-glossary',
            recordLength: 1000000000,
            sourceStoredLength: 1000000000,
            originalEnvelope: 'none',
            expectedDecodedLength: 2000000000,
        })).storedLength).toBe(4);
    });

    test('legacy identity record length does not remove trailing media or other original bytes', () => {
        const input = fixture();
        Object.assign(input.manifests[0].blocks[0], {kind: 'legacy-entry', recordLength: 50, originalEnvelope: 'none'});
        const resolver = createContentLayoutResolver(input);
        expect(resolver.resolveFrame(identity({kind: 'legacy-entry', recordLength: 50, originalEnvelope: 'none'}))).toMatchObject({sourceStoredLength: 6, storedLength: 4});
        expect(resolver.resolveLogical(14, 6)).toEqual([{fileId: 'data', physicalOffset: 8, length: 6}]);
    });

    test('preserves the legacy empty-string codec name as exact identity', () => {
        const input = fixture();
        Object.assign(input.manifests[0].blocks[0], {kind: 'legacy-entry', recordLength: 50, originalCodecId: '', originalEnvelope: 'none'});
        const resolver = createContentLayoutResolver(input);
        const original = identity({kind: 'legacy-entry', recordLength: 50, originalCodecId: '', originalEnvelope: 'none'});
        expect(resolver.resolveFrame(original).identity.originalCodecId).toBe('');
        expect(() => resolver.resolveFrame({...original, originalCodecId: null})).toThrow(/identity differs/);
    });

    test('preserves unresolved original decoded length for boundary discovery above this module', () => {
        const input = fixture();
        input.manifests[0].blocks = [];
        input.manifests[0].removed = [];
        input.manifests[0].extents = [{logicalOffset: 0, length: 20, fileId: 'data', physicalOffset: 0}];
        const original = identity({kind: 'legacy-entry', recordLength: 1000, expectedDecodedLength: null, originalEnvelope: 'none'});
        expect(createContentLayoutResolver(input).resolveFrame(original)).toMatchObject({identity: original, decodedLength: null, sourceStoredLength: 6});
    });

    test('accepts data files without a whole-file digest while requiring dictionary integrity', () => {
        const input = fixture();
        input.files[0].sha256 = null;
        input.physicalFiles[0].sha256 = null;
        expect(createContentLayoutResolver(input).resolveLogical(0, 1)).toEqual([
            {fileId: 'data', physicalOffset: 0, length: 1},
        ]);
        input.files[1].sha256 = null;
        input.physicalFiles[1].sha256 = null;
        expect(() => createContentLayoutResolver(input)).toThrow(/dictionary file identity/);
    });

    test('keeps logical and physical offsets above 2^32 without narrowing', () => {
        const input = fixture();
        const base = 2 ** 32 + 57;
        input.manifests[0].logicalStart = base;
        input.manifests[0].removed[0].frameLogicalOffset += base;
        input.manifests[0].extents[0].physicalOffset = base;
        input.files[0].byteLength = base + 8;
        input.physicalFiles[0].byteLength = base + 8;
        const resolver = createContentLayoutResolver(input);
        expect(resolver.resolveLogical(base + 1, 3)).toEqual([{fileId: 'data', physicalOffset: base + 1, length: 3}]);
        expect(resolver.resolveFrame(identity({logicalOffset: base + 8})).identity.logicalOffset).toBe(base + 8);
    });

    test('preserves zero length semantics at valid offsets including holes and the end', () => {
        const resolver = createContentLayoutResolver(fixture());
        for (const offset of [0, 8, 10, 20]) { expect(resolver.resolveLogical(offset, 0)).toEqual([]); }
        expect(() => resolver.resolveLogical(21, 0)).toThrow(RangeError);
        expect(() => resolver.resolveLogical(-1, 0)).toThrow(RangeError);
    });

    test.each([
        {kind: 'legacy-entry'},
        {recordLength: 7},
        {sourceStoredLength: 5, recordLength: 5},
        {originalCodecId: 'another'},
        {expectedDecodedLength: 51},
        {originalEnvelope: 'mbc2', sourceStoredLength: 13, recordLength: 13},
    ])('rejects same-offset descriptor mismatch %o', (difference) => {
        const resolver = createContentLayoutResolver(fixture());
        expect(() => resolver.resolveFrame(identity(difference))).toThrow(/identity differs|Exact source length differs/);
    });

    test.each([{logicalOffset: 7}, {logicalOffset: 9}, {logicalOffset: 13}])('rejects a descriptor overlapping another override %o even before holes exist', (difference) => {
        const input = fixture();
        input.manifests[0].removed = [];
        input.manifests[0].blocks[0].physicalOffset = 30;
        input.manifests[0].extents = [{logicalOffset: 0, length: 20, fileId: 'data', physicalOffset: 0}];
        expect(() => createContentLayoutResolver(input).resolveFrame(identity(difference))).toThrow(/overlaps another replacement/);
    });

    test.each([
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[0].extents[0].length = 7; },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[0].extents[1].length = 5; },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[0].extents.reverse(); },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[0].extents[1].logicalOffset = 13; },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[0].extents[1].length = 7; },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[0].removed[0].length = 5; },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[0].removed[0].frameLogicalOffset = 7; },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[0].blocks = []; },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[0].blocks.push({...frame(), logicalOffset: 9}); },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[0].blocks.push({...frame()}); },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[0].blocks.unshift({...frame(), logicalOffset: 15}); },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[0].blocks[0].logicalOffset = 20; },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[0].version = 2; },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[0].blocks[0].envelope = 'future'; },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[0].blocks[0].kind = 'unknown'; },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[0].blocks[0].decodedLength = 49; },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[0].blocks[0].recordLength = 50; },
    ])('rejects truncated, unsorted, overlapping or malformed representation %#', (mutate) => {
        const input = fixture();
        mutate(input);
        expect(() => createContentLayoutResolver(input)).toThrow();
    });

    test.each([
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[1].logicalStart = 11; },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[1].logicalStart = 9; },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[1].regionId = 'r0'; },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests.reverse(); },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[1].removed[0].length = 3; },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[1].removed[0].frameLogicalOffset = 10; },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[1].blocks.push({...frame(), logicalOffset: 0}); },
    ])('requires exact explicit cross-region coverage %#', (mutate) => {
        const input = crossRegionFixture();
        mutate(input);
        expect(() => createContentLayoutResolver(input)).toThrow();
    });

    test('rejects duplicate or misplaced external frame descriptions', () => {
        const input = fixture();
        input.externalFrames = [frame()];
        expect(() => createContentLayoutResolver(input)).toThrow(/outside the region window/);
        input.externalFrames = [{...frame(), logicalOffset: 100}, {...frame(), logicalOffset: 100}];
        expect(() => createContentLayoutResolver(input)).toThrow(/sorted/);
    });

    test.each([
        (/** @type {import('core').SafeAny} */ input) => { input.codecs = []; },
        (/** @type {import('core').SafeAny} */ input) => { input.codecs[0].fileId = 'missing'; },
        (/** @type {import('core').SafeAny} */ input) => { input.codecs[0].dictionaryBytes = 5; },
        (/** @type {import('core').SafeAny} */ input) => { input.codecs[0].dictionarySha256 = DATA_SHA; },
        (/** @type {import('core').SafeAny} */ input) => { input.codecs[0].formatVersion = 2; },
        (/** @type {import('core').SafeAny} */ input) => { input.codecs.push({...input.codecs[0]}); },
        (/** @type {import('core').SafeAny} */ input) => { input.files.push({...input.files[0]}); },
        (/** @type {import('core').SafeAny} */ input) => { input.physicalFiles.push({...input.physicalFiles[0]}); },
        (/** @type {import('core').SafeAny} */ input) => { input.physicalFiles.pop(); },
        (/** @type {import('core').SafeAny} */ input) => { input.physicalFiles[0].byteLength = 99; },
        (/** @type {import('core').SafeAny} */ input) => { input.physicalFiles[0].sha256 = DICTIONARY_SHA; },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[0].extents[0].fileId = 'missing'; },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[0].blocks[0].fileId = 'missing'; },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[0].extents[0].physicalOffset = 95; },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[0].blocks[0].physicalOffset = 97; },
        (/** @type {import('core').SafeAny} */ input) => { input.files[0].sha256 = 'not-a-digest'; },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[0].blocks[0].decodedDigest = 'not-a-digest'; },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[0].extents[0].fileId = '../data'; },
    ])('requires immutable physical file and codec closure %#', (mutate) => {
        const input = fixture();
        mutate(input);
        expect(() => createContentLayoutResolver(input)).toThrow();
    });

    test('permits a physical span ending exactly at the observed file bound', () => {
        const input = fixture();
        input.manifests[0].blocks[0].physicalOffset = 96;
        expect(createContentLayoutResolver(input).resolveFrame(identity()).spans[0]).toEqual({fileId: 'data', physicalOffset: 96, length: 4});
    });

    test.each([-1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe coordinates without 32-bit coercion (%s)', (value) => {
        const input = fixture();
        input.manifests[0].extents[0].physicalOffset = value;
        expect(() => createContentLayoutResolver(input)).toThrow(RangeError);
        const resolver = createContentLayoutResolver(fixture());
        expect(() => resolver.resolveLogical(value, 1)).toThrow(RangeError);
        expect(() => resolver.resolveLogical(0, value)).toThrow(RangeError);
        expect(() => resolver.resolveFrame(identity({logicalOffset: value}))).toThrow(RangeError);
    });

    test('rejects safe operands whose range addition would overflow', () => {
        const input = fixture();
        input.manifests[0].logicalStart = Number.MAX_SAFE_INTEGER - 10;
        expect(() => createContentLayoutResolver(input)).toThrow(RangeError);
        input.manifests[0].logicalStart = 0;
        input.manifests[0].blocks[0].physicalOffset = Number.MAX_SAFE_INTEGER - 1;
        expect(() => createContentLayoutResolver(input)).toThrow(RangeError);
        expect(() => createContentLayoutResolver(fixture()).resolveLogical(Number.MAX_SAFE_INTEGER, 2)).toThrow(RangeError);
    });

    test('rejects malicious prototypes, unknown and hidden keys, symbols and accessors without invoking getters', () => {
        const inherited = fixture();
        Object.setPrototypeOf(inherited.manifests[0].extents[0], {malicious: true});
        expect(() => createContentLayoutResolver(inherited)).toThrow(/plain/);
        for (const key of ['constructor', '__proto__', 'redirectLayoutId']) {
            const input = fixture();
            Object.defineProperty(input.manifests[0].blocks[0], key, {value: 'evil', enumerable: true});
            expect(() => createContentLayoutResolver(input)).toThrow(/unknown keys/);
        }
        const symbolInput = fixture();
        symbolInput.manifests[0][Symbol('evil')] = true;
        expect(() => createContentLayoutResolver(symbolInput)).toThrow(/unknown keys/);
        const hidden = fixture();
        Object.defineProperty(hidden.manifests[0], 'version', {value: 1, enumerable: false});
        expect(() => createContentLayoutResolver(hidden)).toThrow(/hidden/);
        let reads = 0;
        const getter = fixture();
        Object.defineProperty(getter.manifests[0], 'extents', {
            get() {
                ++reads;
                throw new Error('Unexpected getter');
            },
            enumerable: true,
        });
        expect(() => createContentLayoutResolver(getter)).toThrow(/accessors/);
        expect(reads).toBe(0);
        const arrayGetter = fixture();
        Object.defineProperty(arrayGetter.manifests[0].extents, '0', {
            get() {
                ++reads;
                throw new Error('Unexpected array getter');
            },
            enumerable: true,
        });
        expect(() => createContentLayoutResolver(arrayGetter)).toThrow(/accessors/);
        expect(reads).toBe(0);
    });

    test('accepts null-prototype parsed-data records, rejecting sparse or extended arrays', () => {
        const input = fixture();
        Object.setPrototypeOf(input.manifests[0], null);
        expect(createContentLayoutResolver(input).logicalEnd).toBe(20);
        const sparse = fixture();
        delete sparse.manifests[0].extents[0];
        expect(() => createContentLayoutResolver(sparse)).toThrow(/holes/);
        const extended = fixture();
        extended.manifests.extra = true;
        expect(() => createContentLayoutResolver(extended)).toThrow(/extra keys/);
    });

    test('rejects oversized row tables before inspecting their entries', () => {
        const input = fixture();
        input.manifests[0].extents = new Array(16385);
        expect(() => createContentLayoutResolver(input)).toThrow(/table admission/);
        const regions = fixture();
        regions.manifests.push(regions.manifests[0], regions.manifests[0]);
        expect(() => createContentLayoutResolver(regions)).toThrow(/table admission/);
    });

    test('bounds UTF-8 manifest bytes independently of row count', () => {
        const input = fixture();
        input.manifests[0].extents = Array.from({length: 10000}, (_, index) => ({
            logicalOffset: index, length: 1, fileId: 'd'.repeat(128), physicalOffset: index,
        }));
        expect(() => createContentLayoutResolver(input)).toThrow(/manifest byte admission/);
    });

    test('bounds total closure metadata bytes independently of individual manifest bytes', () => {
        const input = fixture();
        input.files = Array.from({length: 10000}, (_, index) => ({fileId: 'd'.repeat(110) + index, byteLength: 1, sha256: DATA_SHA}));
        input.physicalFiles = input.files.map((/** @type {import('../ext/js/dictionary/term-content-layout.js').PhysicalFile} */ row) => ({...row}));
        expect(() => createContentLayoutResolver(input)).toThrow(/metadata byte admission/);
    });

    test('bounds aggregate rows even across individually bounded tables', () => {
        const input = fixture();
        input.files = new Array(16384).fill(input.files[0]);
        input.physicalFiles = new Array(16384).fill(input.physicalFiles[0]);
        expect(() => createContentLayoutResolver(input)).toThrow(/row admission/);
    });

    test('owns input metadata and exposes only deeply immutable results', () => {
        const input = fixture();
        const resolver = createContentLayoutResolver(input);
        const result = resolver.resolveFrame(identity());
        const spans = resolver.resolveLogical(0, 8);
        input.manifests[0].blocks[0].storedLength = 90;
        input.manifests[0].blocks[0].codecId = 'evil';
        input.manifests[0].extents[0].physicalOffset = 90;
        input.manifests[0].removed.length = 0;
        input.files[0].byteLength = 1;
        input.codecs[0].codecId = 'evil';
        expect(resolver.resolveFrame(identity())).toEqual(result);
        expect(resolver.resolveLogical(0, 8)).toEqual(spans);
        expect(() => resolver.resolveLogical(8, 1)).toThrow(SupersededCompressedRangeError);
        for (const value of [resolver, result, result.identity, result.spans, result.spans[0], spans, spans[0]]) {
            expect(Object.isFrozen(value)).toBe(true);
        }
        expect(() => { Object.defineProperty(result.identity, 'recordLength', {value: 999}); }).toThrow(TypeError);
        expect(() => { Object.defineProperty(result.spans[0], 'physicalOffset', {value: 99}); }).toThrow(TypeError);
        expect(() => { Reflect.apply(Array.prototype.push, spans, [{fileId: 'evil', physicalOffset: 0, length: 1}]); }).toThrow(TypeError);
        expect(resolver.resolveFrame(identity()).identity.recordLength).toBe(6);
    });

    test('frame identity input accessors and redirect fields cannot bypass exact matching', () => {
        const resolver = createContentLayoutResolver(fixture());
        const withRedirect = {...identity(), redirectLayoutId: 'another'};
        expect(() => resolver.resolveFrame(withRedirect)).toThrow(/unknown keys/);
        const withGetter = identity();
        Object.defineProperty(withGetter, 'recordLength', {get() { throw new Error('Unexpected getter'); }, enumerable: true});
        expect(() => resolver.resolveFrame(withGetter)).toThrow(/accessors/);
    });
});


describe('physical representation safeguards', () => {
    test.each([
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[0].extents[1].physicalOffset = 4; },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[0].blocks[0].physicalOffset = 10; },
        (/** @type {import('core').SafeAny} */ input) => { input.manifests[0].extents[0].fileId = 'dictionary'; input.manifests[0].extents[0].length = 4; },
    ])('rejects physical aliasing between distinct retained/frame/dictionary spans %#', (mutate) => {
        const input = fixture(); mutate(input);
        expect(() => createContentLayoutResolver(input)).toThrow();
    });

    test('rejects an empty MBC2 source envelope', () => {
        const input = fixture();
        Object.assign(input.manifests[0].blocks[0], {originalEnvelope: 'mbc2', sourceStoredLength: 12, recordLength: 12});
        expect(() => createContentLayoutResolver(input)).toThrow(/envelope/);
    });

    test('rejects an empty MBC2 replacement and accepts frame bytes after its envelope', () => {
        const input = fixture();
        Object.assign(input.manifests[0].blocks[0], {envelope: 'mbc2', storedLength: 12});
        expect(() => createContentLayoutResolver(input)).toThrow(/envelope/);
        input.manifests[0].blocks[0].storedLength = 13;
        expect(createContentLayoutResolver(input).resolveFrame(identity()).storedLength).toBe(13);
    });

    test('bounds codec dictionaries independently of an observed valid file size', () => {
        const input = fixture();
        input.codecs[0].dictionaryBytes = 112641;
        input.files[1].byteLength = 112641;
        input.physicalFiles[1].byteLength = 112641;
        expect(() => createContentLayoutResolver(input)).toThrow(/dictionary byte admission/);
        input.codecs[0].dictionaryBytes = 112640;
        input.files[1].byteLength = 112640;
        input.physicalFiles[1].byteLength = 112640;
        expect(createContentLayoutResolver(input).logicalEnd).toBe(20);
    });

    test('bounds region size independently of a multi-region frame range', () => {
        const input = fixture(); input.manifests[0].logicalLength = 134217729;
        expect(() => createContentLayoutResolver(input)).toThrow(/region byte admission/);
    });
});
