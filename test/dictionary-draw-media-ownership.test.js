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

beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/**
 * @param {string} mediaType
 * @param {(...args: import('core').SafeAny[]) => void} [postMessage]
 * @returns {Promise<void>}
 */
async function draw(mediaType, postMessage = () => {}) {
    const database = new DictionaryDatabase();
    vi.spyOn(database, 'getMedia').mockResolvedValue([{
        index: 0, dictionary: 'D', path: 'image', mediaType, width: 1, height: 1, content: new ArrayBuffer(4),
    }]);
    await database.drawMedia([
        {dictionary: 'D', path: 'image', canvasIndex: 0, canvasWidth: 1, canvasHeight: 1, generation: 1},
    ], /** @type {MessagePort} */ (/** @type {unknown} */ ({postMessage})));
}

test.each([false, true])('SVG transfers one pixel copy and releases native objects; post fails=%s', async (fail) => {
    const pixels = vi.fn(() => new Uint8Array([1, 2, 3, 4]));
    const free = vi.fn();
    svg.render.mockReturnValue({get pixels() { return pixels(); }, width: 1, height: 1, free});
    const post = vi.fn((message, transfer) => {
        expect(transfer[0]).toBe(message.params.buffer);
        if (fail) { throw new Error('closed port'); }
        const clone = structuredClone(message, {transfer});
        expect([...new Uint8Array(clone.params.buffer)]).toEqual([1, 2, 3, 4]);
        expect(message.params.buffer.byteLength).toBe(0);
    });
    await (fail ? expect(draw('image/svg+xml', post)).rejects.toThrow('closed port') : draw('image/svg+xml', post));
    expect(pixels).toHaveBeenCalledTimes(1);
    expect(free).toHaveBeenCalledTimes(1);
    expect(svg.free).toHaveBeenCalledTimes(1);
});

test('SVG rendering failure still frees its native renderer', async () => {
    svg.render.mockImplementation(() => { throw new Error('bad svg'); });
    await expect(draw('image/svg+xml')).rejects.toThrow('bad svg');
    expect(svg.free).toHaveBeenCalledTimes(1);
});

test.each(['success', 'decode', 'post'])('ImageDecoder releases owned handles on %s', async (mode) => {
    const close = vi.fn();
    const frameClose = vi.fn();
    vi.stubGlobal('navigator', {serviceWorker: {}});
    vi.stubGlobal('ImageDecoder', class {
        close = close;
        async decode() {
            if (mode === 'decode') { throw new Error('decode'); }
            return {image: {close: frameClose}};
        }
    });
    const operation = draw('image/png', () => {
        if (mode === 'post') { throw new Error('post'); }
    });
    await (mode === 'success' ? operation : expect(operation).rejects.toThrow(mode));
    expect(close).toHaveBeenCalledTimes(1);
    expect(frameClose).toHaveBeenCalledTimes(mode === 'decode' ? 0 : 1);
});

test.each(['success', 'no-context', 'draw', 'post'])('ImageBitmap is closed on %s', async (mode) => {
    const close = vi.fn();
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({width: 1, height: 1, close})));
    vi.stubGlobal('OffscreenCanvas', class {
        getContext() {
            return mode === 'no-context' ?
                null :
                {
                    drawImage() { if (mode === 'draw') { throw new Error('draw'); } },
                    getImageData() { return {data: new Uint8ClampedArray(4)}; },
                };
        }
    });
    const operation = draw('image/png', () => {
        if (mode === 'post') { throw new Error('post'); }
    });
    await (mode === 'draw' || mode === 'post' ? expect(operation).rejects.toThrow(mode) : operation);
    expect(close).toHaveBeenCalledTimes(1);
});
