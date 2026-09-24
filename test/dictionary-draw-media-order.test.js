/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';

const svg = vi.hoisted(() => ({render: vi.fn(), free: vi.fn()}));
vi.mock('../ext/lib/resvg-wasm.js', () => ({
    initWasm: vi.fn(),
    Resvg: class {
        render = svg.render;
        free = svg.free;
    },
}));

beforeEach(() => {
    vi.resetAllMocks();
    svg.render.mockImplementation(() => ({
        pixels: new Uint8Array([1, 2, 3, 4]),
        width: 1,
        height: 1,
        free() {},
    }));
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

test('drawMedia keeps stable order within SVG/raster priority groups', async () => {
    const database = new DictionaryDatabase();
    vi.spyOn(database, 'getMedia').mockResolvedValue([
        {index: 0, dictionary: 'D', path: 'svg-a', mediaType: 'image/svg+xml', width: 1, height: 1, content: new ArrayBuffer(4)},
        {index: 1, dictionary: 'D', path: 'png-a', mediaType: 'image/png', width: 1, height: 1, content: new ArrayBuffer(4)},
        {index: 2, dictionary: 'D', path: 'svg-b', mediaType: 'image/svg+xml', width: 1, height: 1, content: new ArrayBuffer(4)},
        {index: 3, dictionary: 'D', path: 'png-b', mediaType: 'image/png', width: 1, height: 1, content: new ArrayBuffer(4)},
    ]);
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({width: 1, height: 1, close() {}})));
    vi.stubGlobal('OffscreenCanvas', class {
        /** @returns {object} */
        getContext() {
            return {
                drawImage() {},
                getImageData() {
                    return {data: new Uint8ClampedArray(4)};
                },
            };
        }
    });

    /** @type {number[][]} */
    const postedCanvasIndexes = [];
    await database.drawMedia([
        {dictionary: 'D', path: 'svg-a', canvasIndex: 0, canvasWidth: 1, canvasHeight: 1, generation: 1},
        {dictionary: 'D', path: 'png-a', canvasIndex: 1, canvasWidth: 1, canvasHeight: 1, generation: 1},
        {dictionary: 'D', path: 'svg-b', canvasIndex: 2, canvasWidth: 1, canvasHeight: 1, generation: 1},
        {dictionary: 'D', path: 'png-b', canvasIndex: 3, canvasWidth: 1, canvasHeight: 1, generation: 1},
    ], /** @type {MessagePort} */ (/** @type {unknown} */ ({
        postMessage(/** @type {{params: {canvasIndexes: number[]}}} */ message) {
            postedCanvasIndexes.push(message.params.canvasIndexes);
        },
    })));

    expect(postedCanvasIndexes).toStrictEqual([[0], [2], [1], [3]]);
});
