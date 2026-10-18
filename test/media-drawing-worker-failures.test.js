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

test.each(['frame', 'buffer'].flatMap((route) => ['missing', 'context', 'draw'].map((failure) => ({route, failure}))))(
    '$route rendering continues after a $failure canvas failure',
    async ({route, failure}) => {
        vi.stubGlobal('addEventListener', vi.fn());
        vi.stubGlobal('ImageData', class {});
        const {MediaDrawingWorker} = await import('../ext/js/display/media-drawing-worker.js');
        const worker = new MediaDrawingWorker();
        const report = vi.spyOn(log, 'error').mockImplementation(() => {});
        const close = vi.fn();
        const draw = vi.fn();
        const fail = () => { throw new Error('broken canvas'); };
        const healthy = /** @type {OffscreenCanvas} */ (/** @type {unknown} */ ({
            width: 1, height: 1, getContext: () => ({drawImage: draw, putImageData: draw}),
        }));
        const broken = /** @type {OffscreenCanvas} */ (/** @type {unknown} */ ({
            width: 1,
            height: 1,
            getContext: () => {
                if (failure === 'context') { return fail(); }
                return {drawImage: fail, putImageData: fail};
            },
        }));
        worker._canvasesByGeneration.set(1, [broken, healthy]);
        const canvasIndexes = [failure === 'missing' ? 5 : 0, 1];
        if (route === 'frame') {
            await worker._onDrawDecodedImageToCanvases({
                decodedImage: /** @type {VideoFrame} */ (/** @type {unknown} */ ({close})),
                canvasIndexes,
                generation: 1,
            }, null);
            expect(close).toHaveBeenCalledTimes(1);
        } else {
            await worker._onDrawBufferToCanvases({
                buffer: new ArrayBuffer(4), width: 1, height: 1, canvasIndexes, generation: 1,
            }, null);
        }
        expect(report).toHaveBeenCalledTimes(1);
        expect(draw).toHaveBeenCalledTimes(1);
    },
);
