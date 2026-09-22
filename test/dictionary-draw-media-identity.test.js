/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {afterEach, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';

afterEach(() => { vi.unstubAllGlobals(); });

/**
 * @param {import('dictionary-database').DrawMediaRequest[]} requests
 * @returns {Promise<{targets: import('dictionary-database').MediaRequest[], messages: import('core').SafeAny[]}>}
 */
async function draw(requests) {
    const database = new DictionaryDatabase();
    const postMessage = vi.fn();
    const getMedia = vi.spyOn(database, 'getMedia').mockImplementation(async (items) => items.map(({dictionary, path}, index) => ({
        index, dictionary, path, mediaType: 'image/png', width: 1, height: 1, content: new ArrayBuffer(4),
    })));
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('createImageBitmap', vi.fn(async (_blob, options) => ({width: options.resizeWidth, height: options.resizeHeight})));
    vi.stubGlobal('OffscreenCanvas', class {
        /** @returns {object} */
        getContext() {
            return {drawImage() {}, getImageData: (/** @type {number} */ _x, /** @type {number} */ _y, /** @type {number} */ width, /** @type {number} */ height) => ({data: new Uint8ClampedArray(width * height * 4)})};
        }
    });
    await database.drawMedia(requests, /** @type {MessagePort} */ (/** @type {unknown} */ ({postMessage})));
    return {targets: getMedia.mock.calls[0][0], messages: postMessage.mock.calls.map(([message]) => message)};
}

test('drawing keeps delimiter-bearing dictionary/path pairs distinct', async () => {
    const common = {canvasWidth: 2, canvasHeight: 3, generation: 1};
    const {targets, messages} = await draw([
        {...common, dictionary: 'C', path: 'A:::B', canvasIndex: 0},
        {...common, dictionary: 'B:::C', path: 'A', canvasIndex: 1},
    ]);
    expect(targets.map(({dictionary, path}) => [dictionary, path])).toEqual([['C', 'A:::B'], ['B:::C', 'A']]);
    expect(messages.map(({params}) => params.canvasIndexes)).toEqual([[0], [1]]);
});

test('drawing preserves each size and generation while batching identical targets', async () => {
    const common = {dictionary: 'D', path: 'image.png', canvasWidth: 2, canvasHeight: 3, generation: 1};
    const {messages} = await draw([
        {...common, canvasIndex: 0},
        {...common, canvasIndex: 1, canvasWidth: 4},
        {...common, canvasIndex: 2, canvasHeight: 5},
        {...common, canvasIndex: 3, generation: 2},
        {...common, canvasIndex: 4},
    ]);
    expect(messages.map(({params: {width, height, canvasIndexes, generation}}) => ({width, height, canvasIndexes, generation}))).toEqual([
        {width: 2, height: 3, canvasIndexes: [0, 4], generation: 1},
        {width: 4, height: 3, canvasIndexes: [1], generation: 1},
        {width: 2, height: 5, canvasIndexes: [2], generation: 1},
        {width: 2, height: 3, canvasIndexes: [3], generation: 2},
    ]);
});
