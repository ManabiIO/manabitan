/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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

import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {TermContentOpfsStore} from '../../ext/js/dictionary/term-content-opfs-store.js';
import {TermRecordOpfsStore} from '../../ext/js/dictionary/term-record-opfs-store.js';

/** @type {unknown[]} */
const unhandled = [];
process.on('unhandledRejection', (error) => { unhandled.push(error); });
const injected = new Error('injected queued OPFS failure');
let attempts = 0;
const failWrite = async () => {
    ++attempts;
    throw injected;
};
let wait;
let readFailure;
if (process.argv[2] === 'content') {
    const store = new TermContentOpfsStore();
    store._writePendingChunksCoalesced = failWrite;
    store._queueWriteChunks([Uint8Array.of(1)]);
    wait = async () => { await store._awaitQueuedWrites(); };
    readFailure = () => Reflect.get(store, '_queuedWriteError');
} else if (process.argv[2] === 'record') {
    const store = new TermRecordOpfsStore();
    const state = store._createShardState('probe.bin', /** @type {FileSystemFileHandle} */ ({}), 0);
    store._writeChunksForShard = failWrite;
    store._queueWriteChunksForShard(state, [Uint8Array.of(1)]);
    wait = async () => { await store._awaitQueuedWritesForShard(state); };
    readFailure = () => state.queuedWriteError;
} else {
    throw new Error('Expected content or record');
}
// Give the runtime an event-loop turn to report otherwise unowned rejection.
await delay(0);
assert.equal(attempts, 1);
assert.equal(readFailure(), injected);
await assert.rejects(wait, (error) => error === injected);
console.log(JSON.stringify({unhandled: unhandled.length, propagated: true}));
