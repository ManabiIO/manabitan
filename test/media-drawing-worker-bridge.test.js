/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {afterEach, expect, test, vi} from 'vitest';
import {log} from '../ext/js/core/log.js';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/**
 * @returns {MessagePort & {close: ReturnType<typeof vi.fn>}}
 */
function createPort() {
    return /** @type {MessagePort & {close: ReturnType<typeof vi.fn>}} */ (/** @type {unknown} */ (Object.assign(new EventTarget(), {
        close: vi.fn(), start: vi.fn(), postMessage: vi.fn(),
    })));
}

test('replaced database port is closed and cannot disconnect a healthy bridge', async () => {
    vi.stubGlobal('addEventListener', vi.fn());
    const notify = vi.fn();
    vi.stubGlobal('self', {postMessage: notify});
    const report = vi.spyOn(log, 'error').mockImplementation(() => {});
    const {MediaDrawingWorker} = await import('../ext/js/display/media-drawing-worker.js');
    const worker = new MediaDrawingWorker();
    const stale = createPort();
    const current = createPort();
    await worker._onConnectToDatabaseWorker(undefined, [stale]);
    await worker._onConnectToDatabaseWorker(undefined, [current]);
    stale.dispatchEvent(new Event('messageerror'));
    expect(worker._dbPort).toBe(current);
    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    current.dispatchEvent(new Event('messageerror'));
    expect(worker._dbPort).toBeNull();
    expect(current.close).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    current.dispatchEvent(new Event('messageerror'));
    expect(notify).toHaveBeenCalledTimes(1);
});

test('late frames from an obsolete database port are released, not drawn', async () => {
    vi.stubGlobal('addEventListener', vi.fn());
    const {MediaDrawingWorker} = await import('../ext/js/display/media-drawing-worker.js');
    const worker = new MediaDrawingWorker();
    const drawImage = vi.fn();
    const stale = createPort();
    const current = createPort();
    const canvas = /** @type {OffscreenCanvas} */ (/** @type {unknown} */ ({
        width: 1, height: 1, getContext: () => ({drawImage}),
    }));
    worker._canvasesByGeneration.set(1, [canvas]);
    await worker._onConnectToDatabaseWorker(undefined, [stale]);
    await worker._onConnectToDatabaseWorker(undefined, [current]);
    const staleClose = vi.fn();
    stale.dispatchEvent(new MessageEvent('message', {data: {
        action: 'drawDecodedImageToCanvases', params: {decodedImage: {close: staleClose}, canvasIndexes: [0], generation: 1},
    }}));
    expect(drawImage).not.toHaveBeenCalled();
    expect(staleClose).toHaveBeenCalledTimes(1);
    const currentClose = vi.fn();
    current.dispatchEvent(new MessageEvent('message', {data: {
        action: 'drawDecodedImageToCanvases', params: {decodedImage: {close: currentClose}, canvasIndexes: [0], generation: 1},
    }}));
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(currentClose).toHaveBeenCalledTimes(1);
});
