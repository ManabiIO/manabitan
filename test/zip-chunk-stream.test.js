/*
 * Copyright (C) 2026  Yomitan Authors
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

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import {describe, expect, test} from 'vitest';
import {ChunkStream} from '../dev/zip-chunk-stream.js';
import {zipChunkStreamPlugin} from '../dev/zip-chunk-stream-plugin.js';

/**
 * @param {Uint8Array[]} inputs
 * @param {number} size
 * @param {boolean} [transfer]
 * @returns {Promise<Uint8Array[]>}
 */
async function split(inputs, size, transfer = false) {
    /** @type {Uint8Array[]} */
    const chunks = [];
    let index = 0;
    await new ReadableStream({
        pull(controller) {
            if (index < inputs.length) {
                controller.enqueue(inputs[index++]);
            } else {
                controller.close();
            }
        },
    }).pipeThrough(new ChunkStream(size)).pipeTo(new WritableStream({
        write(chunk) {
            expect(chunk.byteOffset).toBe(0);
            expect(chunk.buffer.byteLength).toBe(chunk.byteLength);
            chunks.push(transfer ? new Uint8Array(structuredClone(chunk.buffer, {transfer: [chunk.buffer]})) : chunk);
        },
    }));
    return chunks;
}

/**
 * @param {number} length
 * @returns {Uint8Array}
 */
function bytes(length) {
    const result = new Uint8Array(length);
    for (let i = 0; i < length; ++i) { result[i] = (i * 131 + (i >>> 8)) & 255; }
    return result;
}

describe('linear ZIP chunk splitter', () => {
    test.each([1, 2, 31, 64, 127, 65536])('preserves all bytes at chunk size %i', async (size) => {
        const input = bytes(size * 5 + 3);
        const chunks = await split([input], size);
        expect(Buffer.compare(Buffer.concat(chunks), input)).toBe(0);
        expect(chunks.slice(0, -1).every((chunk) => chunk.length === size)).toBe(true);
        expect(chunks.at(-1)?.length).toBeLessThanOrEqual(size);
    });

    test.each([[], [0], [32], [1, 31], [31, 1, 0, 32, 0], [3, 257, 1, 0, 2, 96], new Array(300).fill(1)].map((lengths) => ({lengths})))('handles input lengths $lengths', async ({lengths}) => {
        const inputs = lengths.map(bytes);
        const chunks = await split(inputs, 32, true);
        expect(Buffer.compare(Buffer.concat(chunks), Buffer.concat(inputs))).toBe(0);
        expect(chunks.slice(0, -1).every((chunk) => chunk.length === 32)).toBe(true);
    });

    test.each([0, -1, 1.5, Infinity, Number.NaN])('uses a bounded default for invalid size %s', async (size) => {
        const input = bytes(65537);
        const chunks = await split([input], size);
        expect(chunks.map((chunk) => chunk.length)).toEqual([65536, 1]);
        expect(Buffer.compare(Buffer.concat(chunks), input)).toBe(0);
    });

    test('transferring every output does not detach shared input or later output', async () => {
        const backing = bytes(300);
        const input = backing.subarray(7, 291);
        const expected = new Uint8Array(input);
        const chunks = await split([input], 16, true);
        expect(Buffer.compare(Buffer.concat(chunks), expected)).toBe(0);
        expect(Buffer.compare(input, expected)).toBe(0);
        expect(backing.byteLength).toBe(300);
    });

    test('does not retain a caller-owned partial chunk between writes', async () => {
        const stream = new ChunkStream(8);
        /** @type {Uint8Array[]} */
        const chunks = [];
        const drain = stream.readable.pipeTo(new WritableStream({
            write(chunk) { chunks.push(chunk); },
        }));
        const writer = stream.writable.getWriter();
        const source = new Uint8Array([99, 1, 2, 3, 99]);
        await writer.write(source.subarray(1, 4));
        source.fill(0);
        await writer.write(new Uint8Array([4, 5, 6, 7, 8, 9]));
        await writer.close();
        await drain;
        expect(Buffer.compare(Buffer.concat(chunks), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBe(0);
        expect(chunks.map((chunk) => chunk.length)).toEqual([8, 1]);
    });

    test('never exports Node Buffer slices backed by the original allocation', async () => {
        const input = Buffer.from(bytes(130));
        const expected = Buffer.from(input);
        const chunks = await split([input.subarray(1, 129)], 32, true);
        expect(Buffer.compare(Buffer.concat(chunks), expected.subarray(1, 129))).toBe(0);
        expect(Buffer.compare(input, expected)).toBe(0);
    });

    test('does not expose a shared memory buffer to the transferable worker path', async () => {
        const input = new Uint8Array(new SharedArrayBuffer(300));
        input.set(bytes(300));
        const chunks = await split([input], 32, true);
        expect(Buffer.compare(Buffer.concat(chunks), input)).toBe(0);
        expect(chunks.every((chunk) => chunk.buffer instanceof ArrayBuffer)).toBe(true);
    });

    test('copies only bounded pieces of a large chunk, never a shrinking tail', async () => {
        let visitedBytes = 0;
        class CountedBytes extends Uint8Array {
            /**
             * @param {number} start
             * @param {number} [end]
             * @returns {Uint8Array}
             */
            subarray(start, end = this.length) {
                expect(end - start).toBeLessThanOrEqual(65536);
                visitedBytes += end - start;
                return super.subarray(start, end);
            }

            slice() { throw new Error('Do not copy the shrinking tail'); }
        }
        const input = new CountedBytes(bytes(12 * 1024 * 1024 + 7));
        const chunks = await split([input], 65536);
        expect(visitedBytes).toBe(input.byteLength);
        expect(Buffer.compare(Buffer.concat(chunks), input)).toBe(0);
    });

    test('handles more chunks than the old recursive call stack permitted', async () => {
        const input = bytes(20000);
        expect(Buffer.compare(Buffer.concat(await split([input], 1)), input)).toBe(0);
    });
});

test('build backport replaces the pinned internal splitter and retains its license', async () => {
    const result = await build({
        stdin: {
            contents: "export {ChunkStream} from './node_modules/@zip.js/zip.js/lib/core/streams/codec-stream.js'",
            resolveDir: process.cwd(),
        },
        bundle: true,
        format: 'esm',
        write: false,
        plugins: [zipChunkStreamPlugin],
    });
    expect(result.outputFiles[0].text).toContain('zip-chunk-stream.js');
    expect(result.outputFiles[0].text).toContain('Copyright (c) 2022 Gildas Lormeau');
    expect(result.outputFiles[0].text).not.toContain('transform(chunk.slice(');
});

test('build refuses an unreviewed dependency source rather than silently mispatching', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-backport-test-'));
    try {
        const source = path.join(directory, 'node_modules', '@zip.js', 'zip.js', 'lib', 'core', 'streams', 'codec-stream.js');
        await fs.mkdir(path.dirname(source), {recursive: true});
        await fs.writeFile(source, 'export class ChunkStream {}');
        await expect(build({entryPoints: [source], bundle: true, write: false, logLevel: 'silent', plugins: [zipChunkStreamPlugin]})).rejects.toThrow('review/remove the ChunkStream backport');
    } finally {
        await fs.rm(directory, {recursive: true, force: true});
    }
});
