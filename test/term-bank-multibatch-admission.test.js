/*
 * Copyright (C) 2026 Manabitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test, vi} from 'vitest';
import {TermBankSourcePipeline} from '../ext/js/dictionary/term-bank-source-pipeline.js';

const MiB = 1024 * 1024;

/**
 * These are metadata fixtures; they do not allocate the declared payloads.
 * @param {number[]} sizes
 * @returns {Array<{filename: string, offset: number, compressionMethod: number, compressedSize: number, uncompressedSize: number, signature: number, getData: () => void}>}
 */
function filesFor(sizes) {
    return sizes.map((uncompressedSize, index) => ({
        filename: `term_bank_${index + 1}.json`,
        offset: index * 64,
        compressionMethod: 8,
        compressedSize: 4,
        uncompressedSize,
        signature: index,
        getData() {},
    }));
}

/**
 * @param {ReturnType<typeof filesFor>} files
 * @param {number} [deviceMemory]
 * @returns {{pipeline: TermBankSourcePipeline, read: ReturnType<typeof vi.fn>, readCompressed: ReturnType<typeof vi.fn>}}
 */
function setup(files, deviceMemory = 4) {
    const read = vi.fn(async () => new Uint8Array([91, 93]));
    const readCompressed = vi.fn(async () => new Uint8Array(4));
    return {
        pipeline: new TermBankSourcePipeline({termFiles: files, enabled: true, read, readCompressed, deviceMemory}),
        read,
        readCompressed,
    };
}

describe('compressed transport admission follows the ordinary batch boundary', () => {
    test.each([0.5, 1, 2, 4])('preserves one-pass imports at deviceMemory=%s, including later fallback positions', async (memory) => {
        for (const size of [1, MiB, 16 * MiB]) {
            const files = filesFor(new Array(4).fill(size));
            const {pipeline, read, readCompressed} = setup(files, memory);
            expect(pipeline.getBatch(0)).toEqual(files);
            for (let start = 0; start <= files.length; ++start) {
                expect(pipeline.createCompressedImportRunPlan(start)).toBeNull();
            }
            expect(read).not.toHaveBeenCalled();
            expect(readCompressed).not.toHaveBeenCalled();
            await pipeline.dispose();
        }
    });

    test('does not switch to raw reads halfway through a single-pass import', async () => {
        const files = filesFor(new Array(12).fill(MiB));
        const {pipeline, readCompressed} = setup(files);
        // At index 4 there are still enough banks for compressed parsing. The
        // decision must describe the whole import, not just its first call.
        expect(pipeline.createCompressedImportRunPlan(4)).toBeNull();
        const first = await pipeline.read(files[0]);
        expect(await pipeline.read(files[0])).toBe(first);
        pipeline.releaseBatch(files.slice(0, 4));
        expect(pipeline.createCompressedImportRunPlan(4)).toBeNull();
        expect(readCompressed).not.toHaveBeenCalled();
        await pipeline.dispose();
    });

    test('preserves prefetch ownership and laziness on the ordinary one-pass route', async () => {
        const files = filesFor(new Array(4).fill(16 * MiB));
        const {pipeline, read, readCompressed} = setup(files);
        expect(pipeline.createCompressedImportRunPlan(0)).toBeNull();
        expect(pipeline.prefetchNext(0)).toEqual({fileCount: 1, estimatedBytes: 16 * MiB});
        expect(read).toHaveBeenCalledTimes(1);
        const batch = await pipeline.readBatch(pipeline.getBatch(0));
        if (batch === null || Array.isArray(batch) || batch instanceof Uint8Array) {
            throw new Error('Expected an ordinary lazy decoded batch');
        }
        expect(await Promise.all(batch.promises)).toEqual(new Array(4).fill(new Uint8Array([91, 93])));
        expect(read).toHaveBeenCalledTimes(4);
        expect(readCompressed).not.toHaveBeenCalled();
        pipeline.releaseBatch(files);
        await pipeline.dispose();
    });

    test('admits exactly 64 MiB when one additional byte requires another ordinary batch', async () => {
        const files = filesFor([16 * MiB, 16 * MiB, 16 * MiB, 16 * MiB, 1]);
        const {pipeline, readCompressed} = setup(files);
        const first = pipeline.createCompressedImportRunPlan(0);
        expect(first?.files).toEqual(files.slice(0, 4));
        expect(first?.estimatedByteLengths.reduce((a, b) => a + b, 0)).toBe(64 * MiB);
        expect(pipeline.createCompressedImportRunPlan(4)).toBeNull();
        expect(readCompressed).not.toHaveBeenCalled();
        await pipeline.dispose();
    });

    test('uses the existing 80-file limit even for tiny banks', async () => {
        const files = filesFor(new Array(84).fill(1));
        const onePass = setup(files.slice(0, 80));
        for (const start of [0, 1, 40, 76]) {
            expect(onePass.pipeline.createCompressedImportRunPlan(start)).toBeNull();
        }
        await onePass.pipeline.dispose();
        const {pipeline} = setup(files);
        expect(pipeline.createCompressedImportRunPlan(0)?.files).toEqual(files.slice(0, 80));
        expect(pipeline.createCompressedImportRunPlan(80)?.files).toEqual(files.slice(80));
        await pipeline.dispose();
    });

    test('keeps a small final batch eligible without requiring an earlier successful raw read', async () => {
        const files = filesFor([...new Array(16).fill(4 * MiB), 2, 2, 2, 2]);
        const {pipeline, read, readCompressed} = setup(files);
        const last = pipeline.createCompressedImportRunPlan(16);
        if (last === null) { throw new Error('Expected the final batch of a large import'); }
        expect(last.files).toEqual(files.slice(16));
        expect(readCompressed).not.toHaveBeenCalled();
        const first = await last.loaders[0]();
        expect((await last.loaders[0]()).bytes).toBe(first.bytes);
        expect(readCompressed).toHaveBeenCalledTimes(1);
        pipeline.releaseBatch(last.files);
        expect((await last.loaders[0]()).bytes).not.toBe(first.bytes);
        expect(readCompressed).toHaveBeenCalledTimes(2);
        expect(read).not.toHaveBeenCalled();
        await pipeline.dispose();
    });

    test.each([8, Number.NaN])('leaves small import-wide plans unchanged on larger or unknown memory: %s', async (memory) => {
        const files = filesFor(new Array(4).fill(1));
        const {pipeline, readCompressed} = setup(files, memory);
        expect(pipeline.createCompressedImportRunPlan(0)?.files).toEqual(files);
        expect(readCompressed).not.toHaveBeenCalled();
        await pipeline.dispose();
    });

    test('retains fallback for disabled pipelines, absent raw readers, and malformed metadata', async () => {
        const files = filesFor(new Array(20).fill(4 * MiB));
        for (const enabled of [false, true]) {
            const pipeline = new TermBankSourcePipeline({termFiles: files, enabled, deviceMemory: 4, read: async () => new Uint8Array(2)});
            expect(pipeline.createCompressedImportRunPlan(0)).toBeNull();
            await pipeline.dispose();
        }
        files[17].signature = -1;
        const {pipeline, readCompressed} = setup(files);
        expect(pipeline.createCompressedImportRunPlan(0)?.files).toEqual(files.slice(0, 16));
        expect(pipeline.createCompressedImportRunPlan(16)).toBeNull();
        expect(readCompressed).not.toHaveBeenCalled();
        await pipeline.dispose();
    });

    test('matches an independent admission oracle over 1000 uneven metadata-only archives', async () => {
        let state = 0x281ac71;
        /** @returns {number} */
        const random = () => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            return state;
        };
        for (let trial = 0; trial < 1000; ++trial) {
            const sizes = Array.from({length: random() % 161}, () => 1 + random() % (18 * MiB));
            let bytes = 0;
            let count = 0;
            for (const size of sizes) {
                if (count === 80 || (count > 0 && bytes + size > 64 * MiB)) { break; }
                bytes += size;
                ++count;
            }
            const {pipeline, read, readCompressed} = setup(filesFor(sizes));
            const plan = pipeline.createCompressedImportRunPlan(0);
            const eligible = count >= 4 && count < sizes.length;
            expect(plan !== null).toBe(eligible);
            if (plan !== null) {
                expect(plan.estimatedByteLengths).toEqual(sizes.slice(0, count));
                expect(plan.files.length).toBeLessThanOrEqual(80);
                expect(plan.estimatedByteLengths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(64 * MiB);
            }
            expect(read).not.toHaveBeenCalled();
            expect(readCompressed).not.toHaveBeenCalled();
            await pipeline.dispose();
        }
    });
});
