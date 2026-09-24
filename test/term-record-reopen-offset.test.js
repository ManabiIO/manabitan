/*
 * Copyright (C) 2026 Manabitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {expect, test} from 'vitest';
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';

test('queued shard retry keeps its original offset when later rows are admitted', async () => {
    const store = new TermRecordOpfsStore();
    let resolveWriteStarted = () => {};
    let rejectFirstWrite = (/** @type {unknown} */ _error) => {};
    const writeStarted = new Promise((resolve) => {
        resolveWriteStarted = resolve;
    });
    let reopenedSeekOffset = -1;
    /** @type {number[][]} */
    const retriedWrites = [];
    const fileHandle = /** @type {FileSystemFileHandle} */ (/** @type {unknown} */ ({
        async createWritable() {
            return {
                async seek(position) {
                    reopenedSeekOffset = position;
                },
                async write(value) {
                    if (!ArrayBuffer.isView(value)) { throw new Error('Expected typed write'); }
                    retriedWrites.push([...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)]);
                },
            };
        },
    }));
    const state = store._createShardState('records.mbt4', fileHandle, 11);
    state.writable = /** @type {FileSystemWritableFileStream} */ (/** @type {unknown} */ ({
        write() {
            resolveWriteStarted();
            return new Promise((_resolve, reject) => {
                rejectFirstWrite = reject;
            });
        },
    }));
    state.queuedWriteChunks = [
        new Uint8Array([1, 2, 3, 4]),
        new Uint8Array([5, 6]),
    ];
    state.queuedWriteBytes = 6;

    const drain = store._drainQueuedWritesForShard(state);
    await writeStarted;

    // A later append is admitted while the first queued write is in flight.
    // Its bytes are a suffix and must not move the retry position of this batch.
    state.pendingWriteChunks = [new Uint8Array([7, 8, 9])];
    state.pendingWriteBytes = 3;
    state.fileLength += 3;
    rejectFirstWrite(new Error('closing writable stream'));

    await expect(drain).resolves.toBeUndefined();
    expect(reopenedSeekOffset).toBe(5);
    expect(retriedWrites).toStrictEqual([[1, 2, 3, 4], [5, 6]]);
    expect(state.pendingWriteBytes).toBe(3);
    expect(state.fileLength).toBe(14);
});
