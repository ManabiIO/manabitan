/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test, vi} from 'vitest';
import {RequestBuilder} from '../ext/js/background/request-builder.js';

/**
 * @param {number[][]} chunks
 * @param {string|null} contentLength
 * @returns {Response}
 */
function createChunkedResponse(chunks, contentLength) {
    const body = new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(new Uint8Array(chunk));
            }
            controller.close();
        },
    });
    const headers = new Headers();
    if (contentLength !== null) {
        headers.set('Content-Length', contentLength);
    }
    return new Response(body, {headers});
}

describe('RequestBuilder streaming response assembly', () => {
    /** @type {[string|null, number[][]][]} */
    const responseCases = [
        ['3', [[1, 2], [3, 4]]],
        ['1', [[1, 2, 3, 4]]],
        ['0', [[1, 2], [3, 4]]],
        ['-1', [[1, 2], [3, 4]]],
        ['1000000000', [[1, 2], [3, 4]]],
        [null, [[1, 2], [3, 4]]],
        ['4', [[1, 2], [3, 4]]],
    ];
    test.each(responseCases)('preserves all chunks with Content-Length %s', async (length, chunks) => {
        const onProgress = vi.fn();
        const response = createChunkedResponse(chunks, length);

        const data = await RequestBuilder.readFetchResponseArrayBuffer(response, onProgress);

        expect([...data]).toStrictEqual([1, 2, 3, 4]);
        expect(onProgress).toHaveBeenCalledWith(true);
        expect(onProgress).toHaveBeenCalledTimes(chunks.length + 1);
    });

    test('joins only the filled portion of partially-used byte buffers', () => {
        const items = [
            {array: new Uint8Array([1, 2, 99, 98, 97, 96]), length: 2},
            {array: new Uint8Array([3, 4]), length: 2},
        ];
        const joined = RequestBuilder._joinUint8Arrays(items, 4);

        expect([...joined]).toStrictEqual([1, 2, 3, 4]);
    });
});
