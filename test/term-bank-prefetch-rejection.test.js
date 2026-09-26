/*
 * Copyright (C) 2026 Manabitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {expect, test} from 'vitest';
import {TermBankSourcePipeline} from '../ext/js/dictionary/term-bank-source-pipeline.js';

/** @returns {Promise<void>} */
function nextTurn() {
    return new Promise((resolve) => { setImmediate(resolve); });
}

test('speculative term-bank prefetch observes rejection without consuming the cached failure', async () => {
    const file = {
        filename: 'term_bank_1.json',
        uncompressedSize: 1024,
        getData() {},
    };
    const failure = new Error('prefetch failed');
    const pipeline = new TermBankSourcePipeline({
        termFiles: [file],
        enabled: true,
        read: async () => { throw failure; },
    });
    /** @type {unknown[]} */
    const unhandled = [];
    /** @param {unknown} reason */
    const onUnhandledRejection = (reason) => {
        if (reason === failure) { unhandled.push(reason); }
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
        expect(pipeline.prefetchNext(0)).toEqual({fileCount: 1, estimatedBytes: 1024});
        await nextTurn();
        expect(unhandled).toEqual([]);
        await expect(pipeline.read(file)).rejects.toBe(failure);
    } finally {
        process.off('unhandledRejection', onUnhandledRejection);
        await pipeline.dispose();
    }
});
