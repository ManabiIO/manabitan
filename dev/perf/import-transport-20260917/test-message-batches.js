

describe('batched compression transport', () => {
    /** @param {Record<string, unknown>} message @returns {Record<string, unknown>} */
    function reply(message) {
        const jobs = message.type === 'compression-batch' ?
            /** @type {Record<string, unknown>[]} */ (message.jobs) : [message];
        const responses = jobs.flatMap((job) => {
            const value = job.source ? Number(job.contentBytes) : (/** @type {Uint8Array} */ (job.content))[0];
            const result = {id: job.id, compressed: Uint8Array.of(value).buffer, envelopeMs: 1};
            return job.source ? [{id: job.id, type: 'source-consumed'}, result] : [result];
        });
        return message.type === 'compression-batch' ? {type: 'compression-batch-results', responses} : responses.at(-1) ?? {};
    }

    test('retains round-robin order and isolates consecutive off/on calls', async () => {
        const workers = Array.from({length: 4}, () => new MockCompressionWorker(reply));
        const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ (workers)));
        try {
            for (const enabled of [false, true, true, false]) {
                for (const worker of workers) { worker.calls.length = 0; }
                const options = {experimentalCompressionBatchMessages: enabled};
                const pending = pool.compressWrapped(Array.from({length: 9}, (_, i) => Uint8Array.of(i + 1)), 'jmdict', options);
                options.experimentalCompressionBatchMessages = !enabled;
                const result = await pending;
                expect(result.chunks.map((bytes) => bytes[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
                expect(result.envelopeMs).toBe(3);
                expect(workers.map((worker) => worker.calls.length)).toEqual(enabled ? [1, 1, 1, 1] : [3, 2, 2, 2]);
            }
        } finally { pool.close(); }
    });

    test('settles every shared-source acknowledgement without transferring the source', async () => {
        const workers = Array.from({length: 4}, () => new MockCompressionWorker(reply));
        const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ (workers)));
        try {
            const source = new Uint8Array(new SharedArrayBuffer(64));
            const lengths = Uint32Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9);
            const operation = pool.beginCompressWrappedSpans(source, new Uint32Array(9), lengths,
                Uint32Array.from({length: 10}, (_, i) => i), lengths, 'jmdict', {experimentalCompressionBatchMessages: true});
            await expect(operation.sourceConsumed).resolves.toBeUndefined();
            expect((await operation.completion).chunks.map((bytes) => bytes[0])).toEqual([...lengths]);
            expect(workers.map((worker) => worker.calls.length)).toEqual([1, 1, 1, 1]);
            for (const worker of workers) { expect(worker.calls[0].transfer).not.toContain(source.buffer); }
        } finally { pool.close(); }
    });

    test('rejects malformed response packets and cleans up every pending job', async () => {
        const worker = new MockCompressionWorker(() => ({type: 'compression-batch-results', responses: [{type: 'compression-batch-results'}]}));
        const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ ([worker])));
        try {
            await expect(pool.compressWrapped([Uint8Array.of(1), Uint8Array.of(2)], null,
                {experimentalCompressionBatchMessages: true})).rejects.toThrow('invalid batch');
            expect(pool.failed).toBe(true);
            expect(pool._pending.size).toBe(0);
            expect(worker.terminateCount).toBe(1);
        } finally { pool.close(); }
    });

    test('a synchronous packet-send failure rejects source and completion promises', async () => {
        const worker = new MockCompressionWorker(() => { throw new Error('packet send failed'); });
        const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ ([worker])));
        try {
            const source = new Uint8Array(new SharedArrayBuffer(8));
            const operation = pool.beginCompressWrappedSpans(source, Uint32Array.of(0, 1), Uint32Array.of(1, 1),
                Uint32Array.of(0, 1, 2), Uint32Array.of(1, 1), 'jmdict', {experimentalCompressionBatchMessages: true});
            await expect(operation.sourceConsumed).rejects.toThrow('packet send failed');
            await expect(operation.completion).rejects.toThrow('packet send failed');
            expect(pool._pending.size).toBe(0);
        } finally { pool.close(); }
    });
});
