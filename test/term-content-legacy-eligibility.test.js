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

import {expect, test} from 'vitest';
import {probeLegacyTermContentFrame, skipLegacyEligibilitySelector} from '../ext/js/dictionary/term-content-legacy-eligibility.js';

/**
 * @param {Uint8Array} bytes
 * @returns {{logicalHighWater: number, assertCurrent: () => void, readSlice: (offset: number, length: number) => Promise<Uint8Array>}}
 */
function source(bytes) {
    return {logicalHighWater: bytes.byteLength,
        assertCurrent: () => {},
        readSlice: async (/** @type {number} */ offset, /** @type {number} */ length) => bytes.slice(offset, offset + length)};
}

const generic = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x20, 3, 25, 0, 0, 97, 98, 99]);
const withDictionaryId = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x21, 9, 3, 25, 0, 0, 97, 98, 99]);
const legacy = {kind: /** @type {const} */ ('reference'),
    reference: {recordId: 1, entryContentOffset: 0, entryContentLength: 3, entryContentDictName: ''}};

test('proves the stored codec from the frame header before activation', async () => {
    const signal = new AbortController().signal;
    await expect(probeLegacyTermContentFrame(source(generic), legacy, signal)).resolves.toEqual({kind: 'eligible'});
    await expect(probeLegacyTermContentFrame(source(withDictionaryId), legacy, signal)).resolves.toEqual({kind: 'skip'});
    expect(skipLegacyEligibilitySelector('raw-block-v2:jmdict')).toBe(true);
    expect(skipLegacyEligibilitySelector('raw-block-v2')).toBe(false);
    const collidingId = 'manabitan-zstd-' + 'a'.repeat(64);
    expect(skipLegacyEligibilitySelector(collidingId)).toBe(false);
    expect(skipLegacyEligibilitySelector('raw-block-v2:' + collidingId)).toBe(false);
    await expect(probeLegacyTermContentFrame(source(generic), {
        ...legacy, reference: {...legacy.reference, entryContentDictName: collidingId},
    }, signal)).resolves.toEqual({kind: 'eligible'});
});

test('skips preset and raw references but separately checks the shared artifact extent', async () => {
    const signal = new AbortController().signal;
    for (const name of ['jmdict', 'raw-block-v2:jmdict', 'raw-v4']) {
        const matched = {...legacy, reference: {...legacy.reference, entryContentDictName: name}};
        await expect(probeLegacyTermContentFrame(source(new Uint8Array(0)), matched, signal)).resolves.toEqual({kind: 'skip'});
    }
    const artifact = {kind: /** @type {const} */ ('artifact'),
        artifact: {
            contentOffset: 0, contentLength: generic.length, contentDictName: 'raw-v4', uncompressedLength: 3,
        }};
    await expect(probeLegacyTermContentFrame(source(generic), artifact, signal)).resolves.toEqual({kind: 'eligible'});
    const withTrailingBytes = new Uint8Array([...generic, 255]);
    artifact.artifact.contentLength++;
    await expect(probeLegacyTermContentFrame(source(withTrailingBytes), artifact, signal))
        .rejects.toThrow(/does not fill its referenced extent/);
});

test('limits frame inspection and resumes its exact cursor after restart', async () => {
    const signal = new AbortController().signal;
    const bytes = new Uint8Array(6 + 65 * 4);
    bytes.set([0x28, 0xb5, 0x2f, 0xfd, 0x20, 65]);
    for (let i = 0; i < 65; ++i) { bytes[6 + i * 4] = i === 64 ? 9 : 8; }
    const result = await probeLegacyTermContentFrame(source(bytes), legacy, signal);
    expect(result.kind).toBe('pending');
    if (result.kind !== 'pending') { throw new Error('Missing fixture cursor'); }
    expect(result.cursor.blocks).toBe(64);
    await expect(probeLegacyTermContentFrame(source(bytes), legacy, signal, JSON.parse(JSON.stringify(result.cursor))))
        .resolves.toEqual({kind: 'eligible'});
});
