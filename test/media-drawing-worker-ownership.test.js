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

test.each(['success', 'stale', 'draw-error', 'no-context'])(
    'drawing worker closes transferred image on %s',
    async (mode) => {
        vi.stubGlobal('addEventListener', vi.fn());
        const {MediaDrawingWorker} = await import('../ext/js/display/media-drawing-worker.js');
        const worker = new MediaDrawingWorker();
        const close = vi.fn();
        const drawImage = vi.fn(() => {
            if (mode === 'draw-error') { throw new Error('draw failure'); }
        });
        vi.spyOn(log, 'error').mockImplementation(() => {});
        if (mode !== 'stale') {
            const canvas = /** @type {OffscreenCanvas} */ (/** @type {unknown} */ ({
                width: 1, height: 1, getContext: () => (mode === 'no-context' ? null : {drawImage}),
            }));
            worker._canvasesByGeneration.set(1, [canvas]);
        }
        await worker._onDrawDecodedImageToCanvases({
            decodedImage: /** @type {VideoFrame} */ (/** @type {unknown} */ ({close})),
            canvasIndexes: [0],
            generation: 1,
        }, null);
        expect(close).toHaveBeenCalledTimes(1);
        expect(drawImage).toHaveBeenCalledTimes(mode === 'stale' || mode === 'no-context' ? 0 : 1);
    },
);
