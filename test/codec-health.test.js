/*
 * Copyright (C) 2026 Manabitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {TermContentBlockStore, wrapCompressedTermContentBlock} from '../ext/js/dictionary/term-content-block-store.js';
import {TermContentOpfsStore} from '../ext/js/dictionary/term-content-opfs-store.js';
import {encodeRawTermContentBlockReference, encodeRawTermContentSharedGlossaryBinary, RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME} from '../ext/js/dictionary/raw-term-content.js';
import {isZstdResourceError} from '../ext/js/dictionary/zstd-resource-error.js';

const {decode, sharedDecode} = vi.hoisted(() => ({decode: vi.fn(), sharedDecode: vi.fn()}));
vi.mock('../ext/js/dictionary/zstd-term-content.js', async (original) => ({
    ...await original(),
    decompressTermContentZstd: decode,
}));
vi.mock('../ext/lib/zstd-wasm.js', async (original) => ({
    ...await original(),
    decompress: sharedDecode,
}));

const resourceErrors = [
    new Error('Failed to allocate Zstd input buffer'),
    new Error('Failed to allocate Zstd destination buffer'),
    new Error('Failed to allocate Zstd dictionary buffer'),
    new RangeError('Array buffer allocation failed'),
    new RangeError('Failed to allocate ArrayBuffer'),
    ...['WebAssembly.Memory.grow()', 'Memory.grow()'].flatMap((prefix) => (
        ['Out of memory', 'Maximum memory size exceeded', 'Unable to grow instance memory']
            .map((message) => new RangeError(`${prefix}: ${message}`))
    )),
    new WebAssembly.RuntimeError('Aborted(OOM)'),
    new WebAssembly.RuntimeError('memory allocation failed'),
];
const decoderErrors = [
    new Error('Invalid Zstd frame content size: -2'),
    new RangeError('Invalid Zstd output limit: 0'),
    new RangeError('Zstd frame output size 100 exceeds configured output limit 99'),
    new Error('Zstd error: Data corruption detected'),
    new Error('Unknown decoder failure'),
    new RangeError('Invalid typed array length: 100'),
    new RangeError('offset is out of bounds'),
    new WebAssembly.RuntimeError('memory access out of bounds'),
    new Error('Array buffer allocation failed'),
    new Error('Aborted(OOM)'),
    new Error('Failed to allocate Zstd destination buffer: unknown reason'),
];

afterEach(() => {
    vi.restoreAllMocks();
    decode.mockReset();
    sharedDecode.mockReset();
});

async function fixture(/** @type {string} */ path) {
    const content = new TermContentOpfsStore();
    const encoder = new TextEncoder();
    const payload = encoder.encode(path === 'block' ?
        JSON.stringify({glossary: ['definition'], rules: '', definitionTags: '', termTags: ''}) :
        JSON.stringify(['definition']));
    // A valid single-segment Zstd frame with a raw block, inside a valid envelope.
    const frame = new Uint8Array(9 + payload.length);
    frame.set([0x28, 0xb5, 0x2f, 0xfd, 0x20, payload.length]);
    const blockHeader = payload.length * 8 + 1;
    frame[6] = blockHeader & 255;
    frame[7] = (blockHeader >>> 8) & 255;
    frame[8] = (blockHeader >>> 16) & 255;
    frame.set(payload, 9);
    const database = new DictionaryDatabase();
    Reflect.set(database, '_termContentBlockStore', new TermContentBlockStore(content));
    let entry;
    let contentDictName;
    if (path === 'block') {
        const block = wrapCompressedTermContentBlock(frame);
        await content.appendBatch([block]);
        entry = encodeRawTermContentBlockReference(0, block.byteLength, payload.length, 0, payload.length);
        contentDictName = 'raw-block-v1';
    } else {
        const [span] = await content.appendBatch([frame]);
        Reflect.get(database, '_sharedGlossaryArtifactMetaByDictionary').set('Healthy', {
            contentOffset: span.offset,
            contentLength: span.length,
            contentDictName: RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME,
            uncompressedLength: payload.length,
        });
        entry = encodeRawTermContentSharedGlossaryBinary('', '', '', 0, payload.length, encoder);
        contentDictName = RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME;
    }
    const [{offset}] = await content.appendBatch([entry]);
    const mark = vi.spyOn(Reflect.get(database, '_termRecordStore'), 'markDictionaryReimportRequired');
    const row = {
        id: 1,
        dictionary: 'Healthy',
        expression: 'word',
        reading: 'word',
        entryContentOffset: offset,
        entryContentLength: path === 'block' ? payload.length : entry.length,
        entryContentDictName: contentDictName,
    };
    const read = () => Reflect.get(database, '_deserializeTermRow').call(database, row);
    const decoder = path === 'block' ? decode : sharedDecode;
    decoder.mockReturnValue(payload);
    return {database, mark, read, decoder, payload};
}

describe.each(['block', 'shared'])('%s codec health', (path) => {
    test('healthy content does not quarantine', async () => {
        const {read, mark} = await fixture(path);
        await expect(read()).resolves.toMatchObject({glossary: ['definition']});
        expect(mark).not.toHaveBeenCalled();
    });

    test.each(resourceErrors)('retries the same instance after resource failure: %s', async (error) => {
        const {read, mark, decoder, payload} = await fixture(path);
        decoder.mockImplementationOnce(() => { throw error; });
        await expect(read()).rejects.toThrow('temporarily unavailable');
        expect(mark).not.toHaveBeenCalled();
        decoder.mockReturnValue(payload);
        await expect(read()).resolves.toMatchObject({glossary: ['definition']});
        expect(decoder).toHaveBeenCalledTimes(2);
        expect(mark).not.toHaveBeenCalled();
    });

    test.each(decoderErrors)('quarantines decoder corruption, not transient: %s', async (error) => {
        const {read, mark, decoder} = await fixture(path);
        decoder.mockImplementationOnce(() => { throw error; });
        await expect(read()).rejects.toThrow('must be re-imported');
        expect(mark).toHaveBeenCalledOnce();
    });

    test('quarantines decoded length mismatch', async () => {
        const {read, mark, decoder} = await fixture(path);
        decoder.mockReturnValue(new Uint8Array(1));
        await expect(read()).rejects.toThrow('must be re-imported');
        expect(mark).toHaveBeenCalledOnce();
    });
});

test('block output copy allocation failure is retryable on the same instance', async () => {
    const {read, mark} = await fixture('block');
    vi.spyOn(Uint8Array, 'from').mockImplementationOnce(() => { throw new RangeError('Array buffer allocation failed'); });
    await expect(read()).rejects.toThrow('temporarily unavailable');
    expect(mark).not.toHaveBeenCalled();
    await expect(read()).resolves.toMatchObject({glossary: ['definition']});
    expect(mark).not.toHaveBeenCalled();
});

test('resource classification rejects non-errors and vague resource messages', () => {
    for (const error of [null, 'out of memory', {message: 'Failed to allocate Zstd input buffer'}, new Error('out of memory')]) {
        expect(isZstdResourceError(error)).toBe(false);
    }
});
