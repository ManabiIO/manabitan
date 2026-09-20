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

import assert from 'node:assert/strict';
import {test} from 'vitest';
import {AbortableZipReadPool, TermBankSourcePipeline} from '../ext/js/dictionary/term-bank-source-pipeline.js';

/** @returns {{promise: Promise<Uint8Array>, resolve: (value: Uint8Array) => void, reject: (reason?: unknown) => void}} */
function deferred() {
    /** @type {(value: Uint8Array) => void} */
    let resolve = () => {};
    /** @type {(reason?: unknown) => void} */
    let reject = () => {};
    /** @type {Promise<Uint8Array>} */
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return {promise, resolve, reject};
}

/** @returns {Promise<void>} */
async function flush() {
    for (let i = 0; i < 8; ++i) { await Promise.resolve(); }
}

/** @returns {{read: (file: import('../ext/js/dictionary/term-bank-source-pipeline.js').TermBankSourceFile, signal: AbortSignal) => Promise<Uint8Array>, calls: ControlledRead[], settleAll: () => void}} */
function makeReads() {
    /** @type {ControlledRead[]} */
    const calls = [];
    /**
     * @param {import('../ext/js/dictionary/term-bank-source-pipeline.js').TermBankSourceFile} file
     * @param {AbortSignal} signal
     * @returns {Promise<Uint8Array>}
     */
    const read = (file, signal) => {
        const completion = deferred();
        calls.push({file, signal, ...completion});
        // Model Blob.arrayBuffer or a decoder that cannot stop immediately.
        // An abort request alone is not proof that its bytes have settled.
        return completion.promise;
    };
    const settleAll = () => {
        for (const call of calls) { call.resolve(new Uint8Array([1, 2, 3])); }
    };
    return {read, calls, settleAll};
}

/** @typedef {{file: import('../ext/js/dictionary/term-bank-source-pipeline.js').TermBankSourceFile, signal: AbortSignal, promise: Promise<Uint8Array>, resolve: (value: Uint8Array) => void, reject: (reason?: unknown) => void}} ControlledRead */

/** @type {[string, () => Promise<void>][]} */
const zipReadPoolLifetimeCases = [
    ['released pending read is aborted and joined by disposal', async () => {
        const reads = makeReads();
        const pool = new AbortableZipReadPool(reads.read);
        const file = {filename: 'term_bank_1.json'};
        pool.read(file);
        pool.release(file);
        let disposed = false;
        const disposal = pool.dispose().then(() => { disposed = true; });
        try {
            assert.equal(reads.calls[0].signal.aborted, true, 'released read lost its abort owner');
            await flush();
            assert.equal(disposed, false, 'disposal completed before released read settled');
        } finally {
            reads.settleAll();
            await disposal;
        }
        assert.equal(disposed, true);
    }],
    ['releasing and rereading one entry retains both pending generations', async () => {
        const reads = makeReads();
        const pool = new AbortableZipReadPool(reads.read);
        const file = {filename: 'term_bank_1.json'};
        const first = pool.read(file);
        pool.release(file);
        const second = pool.read(file);
        assert.notEqual(first, second);
        let disposed = false;
        const disposal = pool.dispose().then(() => { disposed = true; });
        try {
            assert.equal(reads.calls.length, 2);
            assert.ok(reads.calls.every(({signal}) => signal.aborted), 'older generation escaped cancellation');
            reads.calls[1].resolve(new Uint8Array([2]));
            await flush();
            assert.equal(disposed, false, 'older generation escaped the join');
        } finally {
            reads.settleAll();
            await disposal;
        }
    }],
    ['pipeline releaseBatch preserves both plain and compressed read lifetimes', async () => {
        const plain = makeReads();
        const compressed = makeReads();
        const files = Array.from({length: 4}, (_, index) => ({
            filename: `term_bank_${index + 1}.json`,
            getData() {},
            offset: index * 100,
            compressionMethod: 0,
            compressedSize: 3,
            uncompressedSize: 3,
            signature: 0,
        }));
        const pipeline = new TermBankSourcePipeline({
            termFiles: files,
            enabled: true,
            deviceMemory: 8,
            read: plain.read,
            readCompressed: compressed.read,
        });
        pipeline.read(files[0]);
        const plan = pipeline.createCompressedImportRunPlan(0);
        assert.ok(plan);
        const compressedResult = plan.loaders[0]();
        pipeline.releaseBatch([files[0]]);
        let disposed = false;
        const disposal = pipeline.dispose().then(() => { disposed = true; });
        try {
            assert.equal(plain.calls[0].signal.aborted, true, 'plain read escaped pipeline disposal');
            assert.equal(compressed.calls[0].signal.aborted, true, 'compressed read escaped pipeline disposal');
            plain.settleAll();
            await flush();
            assert.equal(disposed, false, 'pipeline failed to join compressed read');
        } finally {
            plain.settleAll();
            compressed.settleAll();
            await Promise.all([disposal, compressedResult]);
        }
    }],
    ['overlapping abort joins include released reads from both generations', async () => {
        const reads = makeReads();
        const pool = new AbortableZipReadPool(reads.read);
        const a = {filename: 'a.json'};
        const b = {filename: 'b.json'};
        pool.read(a);
        pool.release(a);
        let firstJoined = false;
        const firstJoin = pool.abortAndJoin().then(() => { firstJoined = true; });
        pool.read(b);
        pool.release(b);
        let secondJoined = false;
        const secondJoin = pool.abortAndJoin().then(() => { secondJoined = true; });
        try {
            assert.ok(reads.calls.every(({signal}) => signal.aborted), 'an abort pass lost a released read');
            reads.calls[1].resolve(new Uint8Array([2]));
            await flush();
            assert.equal(firstJoined, false);
            assert.equal(secondJoined, false, 'later abort did not join the earlier abort');
        } finally {
            reads.settleAll();
            await Promise.all([firstJoin, secondJoin, pool.dispose()]);
        }
    }],
    ['released rejection is joined without rejecting disposal', async () => {
        const reads = makeReads();
        const pool = new AbortableZipReadPool(reads.read);
        const file = {filename: 'term_bank_1.json'};
        const result = pool.read(file);
        pool.release(file);
        let disposed = false;
        const disposal = pool.dispose().then(() => { disposed = true; });
        try {
            await flush();
            assert.equal(disposed, false, 'released rejection escaped shutdown accounting');
        } finally {
            reads.calls[0].reject(new Error('read failed after release'));
            await assert.rejects(result, /read failed after release/);
            await disposal;
        }
    }],
    ['entry identity, promise sharing, settled release, and closed-pool rejection remain intact', async () => {
        const reads = makeReads();
        const pool = new AbortableZipReadPool(reads.read);
        const a = {filename: 'same.json'};
        const b = {filename: 'same.json'};
        const first = pool.read(a);
        assert.equal(pool.read(a), first);
        assert.notEqual(pool.read(b), first);
        reads.settleAll();
        await first;
        pool.release(a);
        assert.notEqual(pool.read(a), first);
        assert.equal(reads.calls.length, 3);
        reads.settleAll();
        const disposal = pool.dispose();
        assert.equal(pool.dispose(), disposal);
        assert.throws(() => pool.read(a), /disposed/);
        await disposal;
    }],
    ['synchronous reader failure is observed and disposal still settles', async () => {
        const failure = new Error('synchronous read failure');
        const pool = new AbortableZipReadPool(() => { throw failure; });
        const file = {filename: 'term_bank_1.json'};
        const result = pool.read(file);
        pool.release(file);
        await assert.rejects(result, (error) => error === failure);
        await pool.dispose();
    }],
];

for (const [name, run] of zipReadPoolLifetimeCases) {
    test(name, run);
}
