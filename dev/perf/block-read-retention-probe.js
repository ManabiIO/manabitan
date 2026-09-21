/*
 * Copyright (C) 2026  Manabitan authors
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

import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {TermContentBlockStore} from '../../ext/js/dictionary/term-content-block-store.js';
import {encodeRawTermContentCompactBlockReference} from '../../ext/js/dictionary/raw-term-content.js';

// Controlled buffer accounting, not real decompression, RSS or import timing.
const count = 32;
const blockBytes = 4 * 1024 * 1024;
const references = Array.from({length: count}, (_, i) => encodeRawTermContentCompactBlockReference(100_000 + i * 100, 20, blockBytes, 0));
const contentStore = {
    /**
     * @param {{offset: number}[]} spans
     * @returns {Promise<Array<{status: 'ok', bytes: Uint8Array}>>}
     */
    async readSlicesDetailed(spans) {
        return spans.map(({offset}) => ({status: 'ok', bytes: references[offset / 20]}));
    },
};
const store = new TermContentBlockStore(
    /** @type {import('../../ext/js/dictionary/term-content-opfs-store.js').TermContentOpfsStore} */ (/** @type {unknown} */ (contentStore)),
);
let active = 0;
let peakActive = 0;
let activeBytes = 0;
let peakBytes = 0;
/** @type {TermContentBlockStore['_cache']} */
const cache = Reflect.get(store, '_cache');
/** @type {TermContentBlockStore['_loadBlock']} */
const loadBlock = async (key, reference) => {
    ++active;
    peakActive = Math.max(peakActive, active);
    activeBytes += reference.blockUncompressedLength;
    peakBytes = Math.max(peakBytes, activeBytes);
    try {
        await nextTurn();
        const block = new Uint8Array(reference.blockUncompressedLength);
        block[0] = (reference.blockOffset - 100_000) / 100;
        cache.set(key, block);
        return block;
    } finally {
        --active;
        activeBytes -= reference.blockUncompressedLength;
    }
};
Reflect.set(store, '_loadBlock', loadBlock);
const results = await store.readDetailedBatch(Array.from({length: count}, (_, i) => ({
    contentOffset: i * 20,
    contentLength: 1,
    contentDictName: 'raw-block-v2',
})));
/** @type {Set<ArrayBufferLike>} */
const buffers = new Set();
let usefulBytes = 0;
let outputCorrect = true;
for (const [i, result] of results.entries()) {
    if (result.status !== 'ok') { throw new Error(result.reason); }
    buffers.add(result.bytes.buffer);
    usefulBytes += result.bytes.byteLength;
    outputCorrect = outputCorrect && result.bytes[0] === i;
}
const fingerprint = createHash('sha256').update(readFileSync(new URL('../../ext/js/dictionary/term-content-block-store.js', import.meta.url))).digest('hex');
console.log(JSON.stringify({
    scope: 'production scheduler and result ownership; controlled storage/decoded-block delivery, not corpus timing',
    nodeVersion: process.version,
    sourceSha256: fingerprint,
    requests: count,
    usefulBytes,
    decodedBlockBytes: blockBytes,
    peakConcurrentBlockLoads: peakActive,
    peakDeclaredInFlightBytes: peakBytes,
    retainedBackingBytes: [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0),
    cacheBytes: store.getDiagnostics().cacheBytes,
    cacheMaxBytes: store.getDiagnostics().cacheMaxBytes,
    outputCorrect,
}, null, 2));
if (!outputCorrect) { throw new Error('Controlled retention probe changed returned bytes'); }
