/* SPDX-License-Identifier: GPL-3.0-or-later */

import {describe, expect, test} from 'vitest';
import {canTakeOwnedTermLookupIndex} from '../ext/js/dictionary/term-lookup-index-ownership.js';
import {createImportIndexChunkFixture, getImportIndexChunkParts} from './util/import-index-chunk-fixture.js';

/**
 * Match the bounded projected row produced by copyWasmBackedColumnChunk: the
 * paths and scalar row metadata remain, key bytes reference retained storage,
 * and encoded glossary/content bytes have been removed before transfer.
 * @returns {Promise<Awaited<ReturnType<typeof createImportIndexChunkFixture>>>}
 */
async function projectedFixture() {
    const fixture = await createImportIndexChunkFixture(128, 0, false);
    const keys = fixture.chunk.termRecordPreinternedPlan.stringsBuffer;
    fixture.chunk.mediaRows.push({
        index: 0,
        imagePaths: ['images/fixture.webp'],
        row: {
            expression: '',
            reading: '',
            expressionBytes: keys.subarray(0, 9),
            readingBytes: keys.subarray(9, 15),
            readingEqualsExpression: false,
            definitionTags: '',
            rules: '',
            score: 0,
            glossaryJson: '',
            glossaryJsonBytes: void 0,
            glossaryMayContainMedia: true,
            sequence: 1,
            termTags: '',
            termEntryContentHash1: 0,
            termEntryContentHash2: 0,
            termEntryContentBytes: new Uint8Array(0),
        },
    });
    return fixture;
}

/**
 * @param {Awaited<ReturnType<typeof projectedFixture>>} fixture
 * @returns {boolean}
 */
function eligible(fixture) {
    return canTakeOwnedTermLookupIndex(fixture.prepared, fixture.prepared.bytes, fixture.encoded.recordFields, fixture.consumer);
}

describe('projected parser media ownership', () => {
    test.each([false, true])('preserves projected row storage with consumer media removed: %s', async (removed) => {
        const fixture = await projectedFixture();
        fixture.registerOwnership();
        if (removed) { Reflect.deleteProperty(fixture.consumer, 'mediaRows'); }
        const row = fixture.chunk.mediaRows[0].row;
        const keys = new Uint8Array(fixture.chunk.termRecordPreinternedPlan.stringsBuffer);
        expect(eligible(fixture)).toBe(true);
        const pending = fixture.adopt();
        expect(pending).not.toBeInstanceOf(Uint8Array);
        expect(fixture.prepared.bytes.byteLength).toBe(0);
        expect(fixture.encoded.recordFields.byteLength).toBe(0);
        expect(row.expressionBytes).toEqual(keys.subarray(0, 9));
        expect(row.readingBytes).toEqual(keys.subarray(9, 15));
        expect(row.termEntryContentBytes).toHaveLength(0);
        expect(fixture.chunk.mediaRows[0].imagePaths).toEqual(['images/fixture.webp']);
        expect(Buffer.concat(getImportIndexChunkParts([pending]))).toEqual(Buffer.from(fixture.expected));
    });

    test.each(['initial-payload', 'late-payload', 'initial-fields', 'late-fields'])('declines retained media keys aliasing %s storage', async (kind) => {
        const fixture = await projectedFixture();
        const bytes = kind.endsWith('payload') ? fixture.prepared.bytes : fixture.encoded.recordFields;
        if (kind.startsWith('late')) { fixture.registerOwnership(); }
        fixture.chunk.mediaRows[0].row.expressionBytes = bytes.subarray(0, 3);
        if (kind.startsWith('initial')) { fixture.registerOwnership(); }
        expect(eligible(fixture)).toBe(false);
        expect(fixture.adopt()).toEqual(fixture.expected);
        expect(bytes.byteLength).toBeGreaterThan(0);
    });

    test.each(['media-list', 'entry', 'row', 'paths'])('declines a replaced %s before invoking its Proxy traps', async (kind) => {
        const fixture = await projectedFixture();
        fixture.registerOwnership();
        let traps = 0;
        const proxy = new Proxy({}, {
            get() { ++traps; throw new Error('Replacement media get'); },
            getPrototypeOf() { ++traps; throw new Error('Replacement media prototype'); },
            ownKeys() { ++traps; throw new Error('Replacement media keys'); },
            getOwnPropertyDescriptor() { ++traps; throw new Error('Replacement media descriptor'); },
        });
        const entry = fixture.chunk.mediaRows[0];
        switch (kind) {
            case 'media-list':
                Reflect.set(fixture.chunk, 'mediaRows', proxy);
                break;
            case 'entry':
                Reflect.set(fixture.chunk.mediaRows, '0', proxy);
                break;
            case 'row':
                Reflect.set(entry, 'row', proxy);
                break;
            default:
                Reflect.set(entry, 'imagePaths', proxy);
                break;
        }
        expect(eligible(fixture)).toBe(false);
        expect(fixture.adopt()).toEqual(fixture.expected);
        expect(traps).toBe(0);
    });

    test.each(['media-list', 'entry', 'row', 'paths', 'row-extension'])('declines late %s accessors without invoking them', async (kind) => {
        const fixture = await projectedFixture();
        fixture.registerOwnership();
        const entry = fixture.chunk.mediaRows[0];
        /** @type {object|undefined} */
        let target = entry.row;
        let name = 'added';
        switch (kind) {
            case 'media-list':
                target = fixture.chunk.mediaRows;
                name = '0';
                break;
            case 'entry':
                target = entry;
                name = 'row';
                break;
            case 'paths':
                target = entry.imagePaths;
                name = '0';
                break;
            case 'row':
                name = 'expressionBytes';
                break;
        }
        if (typeof target === 'undefined') { throw new Error('Missing projected media fixture'); }
        let reads = 0;
        Object.defineProperty(target, name, {
            configurable: true,
            enumerable: true,
            get() { ++reads; throw new Error('Late projected media accessor'); },
        });
        expect(eligible(fixture)).toBe(false);
        expect(fixture.adopt()).toEqual(fixture.expected);
        expect(reads).toBe(0);
    });

    test.each(['unprojected-content', 'unprojected-glossary', 'nested-row', 'empty-paths', 'sparse-paths', 'non-string-path', 'extra-entry-field'])('keeps %s rows on eager snapshots', async (kind) => {
        const fixture = await projectedFixture();
        const entry = fixture.chunk.mediaRows[0];
        if (kind === 'unprojected-content') { entry.row.termEntryContentBytes = Uint8Array.of(1); }
        if (kind === 'unprojected-glossary') { entry.row.glossaryJsonBytes = Uint8Array.of(1); }
        if (kind === 'nested-row') { Reflect.set(entry.row, 'nested', {bytes: fixture.prepared.bytes}); }
        if (kind === 'empty-paths') { entry.imagePaths = []; }
        if (kind === 'sparse-paths') { entry.imagePaths = new Array(1); }
        if (kind === 'non-string-path') { Reflect.set(entry, 'imagePaths', [fixture.prepared.bytes]); }
        if (kind === 'extra-entry-field') { Reflect.set(entry, 'retained', fixture.prepared.bytes); }
        fixture.registerOwnership();
        expect(eligible(fixture)).toBe(false);
        expect(fixture.adopt()).toEqual(fixture.expected);
        expect(fixture.prepared.bytes.byteLength).toBeGreaterThan(0);
    });

    test('rejects media key geometry shadows without invoking them', async () => {
        const fixture = await projectedFixture();
        fixture.registerOwnership();
        const keys = fixture.chunk.mediaRows[0].row.expressionBytes;
        if (!(keys instanceof Uint8Array)) { throw new Error('Missing projected keys'); }
        let reads = 0;
        Object.defineProperty(keys, 'buffer', {
            get() { ++reads; throw new Error('Projected key geometry shadow'); },
        });
        expect(eligible(fixture)).toBe(false);
        expect(reads).toBe(0);
    });
});
