/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {afterEach, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {log} from '../ext/js/core/log.js';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/**
 * @param {number[]} values
 * @returns {{database: DictionaryDatabase, requests: import('dictionary-database').DrawMediaRequest[], port: MessagePort, postMessage: ReturnType<typeof vi.fn>, close: ReturnType<typeof vi.fn>}}
 */
function setup(values) {
    const database = new DictionaryDatabase();
    const close = vi.fn();
    const postMessage = vi.fn();
    const requests = values.map((_value, canvasIndex) => ({
        dictionary: 'D', path: String(canvasIndex), canvasIndex, canvasWidth: 1, canvasHeight: 1, generation: 1,
    }));
    vi.spyOn(database, 'getMedia').mockResolvedValue(values.map((value, index) => ({
        dictionary: 'D',
        path: String(index),
        index,
        width: 1,
        height: 1,
        mediaType: 'image/png',
        content: new Uint8Array([value]).buffer,
    })));
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('createImageBitmap', vi.fn(async (/** @type {Blob} */ blob) => {
        const [value] = new Uint8Array(await blob.arrayBuffer());
        if (value === 0) { throw new Error('broken image'); }
        return {width: 1, height: 1, close};
    }));
    vi.stubGlobal('OffscreenCanvas', class {
        getContext() {
            return {drawImage() {}, getImageData: () => ({data: new Uint8ClampedArray(4)})};
        }
    });
    const port = /** @type {MessagePort} */ (/** @type {unknown} */ ({postMessage}));
    return {database, requests, port, postMessage, close};
}

test('a failed decode still allows later independent images to render', async () => {
    const {database, requests, port, postMessage, close} = setup([0, 1, 2]);
    await expect(database.drawMedia(requests, port)).rejects.toThrow('broken image');
    expect(postMessage.mock.calls.map(([message]) => message.params.canvasIndexes)).toEqual([[1], [2]]);
    expect(close).toHaveBeenCalledTimes(2);
});

test('multiple failed images are reported after healthy images render', async () => {
    const {database, requests, port, postMessage, close} = setup([0, 1, 0, 2]);
    const failure = await database.drawMedia(requests, port).catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toHaveLength(2);
    expect(postMessage.mock.calls.map(([message]) => message.params.canvasIndexes)).toEqual([[1], [3]]);
    expect(close).toHaveBeenCalledTimes(2);
});

test('a failed transfer releases its image and does not suppress later targets', async () => {
    const {database, requests, port, postMessage, close} = setup([1, 2]);
    postMessage.mockImplementationOnce(() => { throw new Error('transfer failure'); });
    await expect(database.drawMedia(requests, port)).rejects.toThrow('transfer failure');
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
});

test('worker handler observes failures and can service a subsequent request', async () => {
    const {database, requests, port, postMessage} = setup([0, 1]);
    const report = vi.spyOn(log, 'error').mockImplementation(() => {});
    await database._onDrawMedia({requests}, port);
    expect(report).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledTimes(1);
    vi.mocked(database.getMedia).mockResolvedValue([{
        dictionary: 'D',
        path: '1',
        index: 0,
        width: 1,
        height: 1,
        mediaType: 'image/png',
        content: new Uint8Array([1]).buffer,
    }]);
    await database._onDrawMedia({requests: [requests[1]]}, port);
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledTimes(1);
});

test('worker handler observes database read failures', async () => {
    const {database, requests, port} = setup([1]);
    const failure = new Error('media read failure');
    vi.mocked(database.getMedia).mockRejectedValue(failure);
    const report = vi.spyOn(log, 'error').mockImplementation(() => {});
    await database._onDrawMedia({requests}, port);
    expect(report).toHaveBeenCalledWith(failure);
});
