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

import {describe, expect, test} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';

function fixture(offsets = [100, 120, 140], lengths = [1, 2, 1]) {
    const pendingOffsets = Float64Array.from(offsets);
    const pendingLengths = Uint32Array.from(lengths);
    const sourceOffsets = new Uint32Array(lengths.length);
    let byteLength = 0;
    for (let i = 0; i < lengths.length; ++i) {
        sourceOffsets[i] = byteLength;
        byteLength += lengths[i];
    }
    return {
        pendingOffsets,
        pendingLengths,
        pendingResolvedDictNames: 'jmdict',
        pendingContentBytes: [],
        pendingContentSpans: {
            buffer: new Uint8Array(byteLength),
            offsets: sourceOffsets,
            lengths: pendingLengths,
        },
    };
}

/**
 * @param {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} database
 * @param {ReturnType<typeof fixture>} value
 * @param {{offsets: Float64Array, lengths: Uint32Array, spans: {buffer: Uint8Array, offsets: Uint32Array, lengths: Uint32Array}, dictName: string}|null} [witness]
 * @returns {() => void}
 */
function register(database, value, witness = null) {
    return Reflect.get(database, '_registerInFlightTermContentSources').call(
        database,
        value.pendingOffsets,
        value.pendingLengths,
        value.pendingResolvedDictNames,
        value.pendingContentBytes,
        value.pendingContentSpans,
        witness,
    );
}

describe('DictionaryDatabase in-flight term-content producer witness', () => {
    test('uses an identity-matched witness on the uncontended single-reference slab', () => {
        const database = new DictionaryDatabase();
        const value = fixture();
        const spans = value.pendingContentSpans;
        const unregister = register(database, value, {
            offsets: value.pendingOffsets,
            lengths: value.pendingLengths,
            spans,
            dictName: 'jmdict',
        });
        const [batch] = Reflect.get(database, '_inFlightTermContentSourceBatches');
        expect(batch.minimumOffset).toBe(100);
        expect(batch.maximumOffset).toBe(140);
        expect(batch.sortedOffsets).toBe(true);
        expect(Reflect.get(database, '_findInFlightTermContentSource').call(database, 120, 2, 'jmdict')).toEqual({
            buffer: spans.buffer,
            offset: 1,
            length: 2,
        });
        unregister();
        expect(Reflect.get(database, '_inFlightTermContentSourceBatches').size).toBe(0);
    });

    test('falls back for overlapping batches and a mismatched producer identity', () => {
        const database = new DictionaryDatabase();
        const first = fixture([100], [1]);
        const unregisterFirst = register(database, first);
        const second = fixture([120, 140], [1, 1]);
        const unregisterSecond = register(database, second, {
            offsets: second.pendingOffsets,
            lengths: second.pendingLengths,
            spans: second.pendingContentSpans,
            dictName: 'jmdict',
        });
        const [batch] = [...Reflect.get(database, '_inFlightTermContentSourceBatches')].slice(1);
        expect(batch.minimumOffset).toBe(120);
        unregisterSecond();
        unregisterFirst();

        const third = fixture();
        const unregisterThird = register(database, third, {
            offsets: Float64Array.from(third.pendingOffsets),
            lengths: third.pendingLengths,
            spans: third.pendingContentSpans,
            dictName: 'jmdict',
        });
        expect(Reflect.get(database, '_inFlightTermContentSourceBatches').size).toBe(1);
        unregisterThird();
    });

    test.each([
        ['single fixed metadata slab', true, false],
        ['multiple reference slabs', false, false],
        ['shared mutable source offsets', true, true],
    ])('producer witness eligibility: %s', async (_name, singleReferenceSlab, sharedOffsets) => {
        const database = new DictionaryDatabase();
        const lengths = Uint32Array.of(1, 2, 1);
        const offsets = sharedOffsets ? new Uint32Array(new SharedArrayBuffer(lengths.byteLength)) : Uint32Array.of(0, 1, 3);
        if (sharedOffsets) { offsets.set([0, 1, 3]); }
        const spans = {
            buffer: new Uint8Array(new SharedArrayBuffer(4)),
            offsets,
            lengths,
        };
        Reflect.set(database, '_termContentZstdInitialized', true);
        Reflect.set(database, '_termContentBlockImportSession', {
            tryBeginAppendSpans: () => ({
                storage: Promise.resolve({
                    contentOffsets: Float64Array.of(100, 120, 140),
                    contentLengths: lengths,
                    contentDictName: 'raw-block-v2:jmdict',
                    singleReferenceSlab,
                }),
                completion: Promise.resolve({
                    packMs: 0,
                    compressMs: 0,
                    envelopeMs: 0,
                    referenceMs: 0,
                    opfsAppendMs: 0,
                    initialSelectionSavingsMiss: false,
                }),
                initialSelection: false,
            }),
        });
        const begin = Reflect.get(database, '_tryBeginPersistArtifactTermContent');
        const persistence = begin.call(database, 'jmdict', spans);
        if (persistence === null) { throw new Error('Expected persistence operation'); }
        const result = await persistence.storage;
        const witnessSymbol = Object.getOwnPropertySymbols(result).find(
            (symbol) => symbol.description === 'inFlightTermContentSourceWitness',
        );
        if (typeof witnessSymbol !== 'symbol') { throw new Error('Expected private producer witness slot'); }
        if (singleReferenceSlab && !sharedOffsets) {
            expect(Reflect.get(result, witnessSymbol)).toMatchObject({
                offsets: result.pendingOffsets,
                lengths,
                spans,
                dictName: 'raw-block-v2:jmdict',
            });
        } else {
            expect(Reflect.get(result, witnessSymbol)).toBeNull();
        }
    });
});
