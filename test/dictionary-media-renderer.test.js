/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test, vi} from 'vitest';
import {DictionaryMediaRenderer} from '../ext/js/dictionary/dictionary-media-renderer.js';

function createHarness() {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const render = {pixels: bytes, width: 1, height: 1, free: vi.fn(() => { bytes.fill(0); })};
    const instance = {render: vi.fn(() => render), free: vi.fn()};
    const Resvg = vi.fn(function createResvg(
        /** @type {Uint8Array|string} */ _content,
        /** @type {import('@resvg/resvg-wasm').ResvgRenderOptions} */ _options,
    ) { return instance; });
    const fetch = vi.fn(async (/** @type {RequestInfo|URL} */ _url) => new Response(new Uint8Array([5, 6])));
    const initWasm = vi.fn(async () => {});
    const renderer = new DictionaryMediaRenderer({
        fetch: /** @type {typeof globalThis.fetch} */ (/** @type {unknown} */ (fetch)),
        initWasm,
        Resvg: /** @type {NonNullable<import('../ext/js/dictionary/dictionary-media-renderer.js').RendererDependencies['Resvg']>} */ (/** @type {unknown} */ (Resvg)),
    });
    return {renderer, fetch, initWasm, Resvg, instance, render, bytes};
}

describe('lazy SVG renderer preparation', () => {
    test('construction and raster-only callers do not fetch resources', () => {
        const {fetch, initWasm, Resvg} = createHarness();
        // Raster callers never call ensurePrepared or renderSvg.
        expect(fetch).not.toHaveBeenCalled();
        expect(initWasm).not.toHaveBeenCalled();
        expect(Resvg).not.toHaveBeenCalled();
    });

    test('concurrent preparation and renders share complete wasm and font preparation', async () => {
        const {renderer, fetch, initWasm, Resvg} = createHarness();
        const first = renderer.ensurePrepared();
        expect(renderer.ensurePrepared()).toBe(first);
        await Promise.all([first, renderer.renderSvg('<svg/>', 10), renderer.renderSvg('<svg/>', 20)]);
        await renderer.ensurePrepared();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(initWasm).toHaveBeenCalledTimes(1);
        expect(Resvg).toHaveBeenCalledTimes(2);
        expect(String(fetch.mock.calls[0][0])).toMatch(/\/lib\/resvg\.wasm$/);
        expect(String(fetch.mock.calls[1][0])).toMatch(/\/fonts\/NotoSansJP-Regular\.ttf$/);
        expect(Resvg.mock.calls[0][1]).toEqual({fitTo: {mode: 'width', value: 10}, font: {fontBuffers: [new Uint8Array([5, 6])]}});
    });

    test('wasm failure clears the failed single-flight promise and retries wasm', async () => {
        const {renderer, fetch, initWasm} = createHarness();
        initWasm.mockRejectedValueOnce(new Error('wasm failed'));
        const first = renderer.ensurePrepared();
        expect(renderer.ensurePrepared()).toBe(first);
        await expect(first).rejects.toThrow('wasm failed');
        expect(fetch).toHaveBeenCalledTimes(1);
        await renderer.ensurePrepared();
        expect(initWasm).toHaveBeenCalledTimes(2);
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    test('font loading must finish before readiness and rendering', async () => {
        const {renderer, fetch, initWasm, Resvg} = createHarness();
        const font = Promise.withResolvers();
        fetch.mockResolvedValueOnce(new Response()).mockReturnValueOnce(font.promise);
        const ready = vi.fn();
        const preparation = renderer.ensurePrepared().then(ready);
        const rendering = renderer.renderSvg('<svg/>', 1);
        await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(2); });
        expect(initWasm).toHaveBeenCalledTimes(1);
        expect(ready).not.toHaveBeenCalled();
        expect(Resvg).not.toHaveBeenCalled();
        font.resolve(new Response(new Uint8Array([5, 6])));
        await Promise.all([preparation, rendering]);
        expect(ready).toHaveBeenCalledTimes(1);
        expect(Resvg).toHaveBeenCalledTimes(1);
    });

    test('font fetch failure retries only font and prevents premature rendering', async () => {
        const {renderer, fetch, initWasm, Resvg} = createHarness();
        fetch.mockResolvedValueOnce(new Response()).mockRejectedValueOnce(new Error('font failed'));
        await expect(renderer.renderSvg('<svg/>', 1)).rejects.toThrow('font failed');
        expect(Resvg).not.toHaveBeenCalled();
        await renderer.renderSvg('<svg/>', 1);
        expect(initWasm).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(String(fetch.mock.calls[2][0])).toMatch(/\.ttf$/);
    });

    test('font body failure retries only font', async () => {
        const {renderer, fetch, initWasm} = createHarness();
        const response = new Response();
        vi.spyOn(response, 'arrayBuffer').mockRejectedValueOnce(new Error('body failed'));
        fetch.mockResolvedValueOnce(new Response()).mockResolvedValueOnce(response);
        await expect(renderer.ensurePrepared()).rejects.toThrow('body failed');
        await renderer.ensurePrepared();
        expect(initWasm).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    test('recognizes only the existing wrapper already-initialized error', async () => {
        const {renderer, fetch, initWasm} = createHarness();
        initWasm.mockRejectedValueOnce(new Error('Already initialized. The `initWasm()` function can be used only once.'));
        fetch.mockResolvedValueOnce(new Response()).mockRejectedValueOnce(new Error('font failed'));
        await expect(renderer.ensurePrepared()).rejects.toThrow('font failed');
        await renderer.ensurePrepared();
        expect(initWasm).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    test('does not mistake unrelated initialization errors for success', async () => {
        const {renderer, initWasm} = createHarness();
        initWasm.mockRejectedValueOnce(new Error('Already initialized something unrelated'));
        await expect(renderer.ensurePrepared()).rejects.toThrow('something unrelated');
        await renderer.ensurePrepared();
        expect(initWasm).toHaveBeenCalledTimes(2);
    });

    test.each(['wasm', 'font'])('rejects non-ok %s responses before consuming them, then retries', async (resource) => {
        const {renderer, fetch, initWasm} = createHarness();
        const response = new Response('missing', {status: 404});
        const read = vi.spyOn(response, 'arrayBuffer');
        if (resource === 'font') { fetch.mockResolvedValueOnce(new Response()); }
        fetch.mockResolvedValueOnce(response);
        await expect(renderer.ensurePrepared()).rejects.toThrow(/HTTP 404/);
        expect(read).not.toHaveBeenCalled();
        expect(initWasm).toHaveBeenCalledTimes(resource === 'wasm' ? 0 : 1);
        await renderer.ensurePrepared();
        expect(initWasm).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledTimes(3);
    });
});

describe('SVG native ownership', () => {
    test('copies RGBA bytes before freeing native handles', async () => {
        const {renderer, Resvg, instance, render, bytes} = createHarness();
        const content = new Uint8Array([9, 8]);
        const result = await renderer.renderSvg(content.buffer, 1);
        expect(result).toEqual({pixels: new Uint8Array([1, 2, 3, 4]), width: 1, height: 1});
        expect(result.pixels.buffer).not.toBe(bytes.buffer);
        expect(bytes).toEqual(new Uint8Array(4));
        expect(Resvg.mock.calls[0][0]).toEqual(content);
        expect(render.free).toHaveBeenCalledTimes(1);
        expect(instance.free).toHaveBeenCalledTimes(1);
    });

    test('constructor allocation failure has no returned handle to free and remains retryable', async () => {
        const {renderer, Resvg, instance, render} = createHarness();
        Resvg.mockImplementationOnce(() => { throw new Error('allocation failed'); });
        await expect(renderer.renderSvg('<svg/>', 1)).rejects.toThrow('allocation failed');
        expect(instance.free).not.toHaveBeenCalled();
        expect(render.free).not.toHaveBeenCalled();
        await renderer.renderSvg('<svg/>', 1);
        expect(instance.free).toHaveBeenCalledTimes(1);
    });

    test('render allocation failure frees the owning Resvg handle', async () => {
        const {renderer, instance, render} = createHarness();
        instance.render.mockImplementationOnce(() => { throw new Error('render failed'); });
        await expect(renderer.renderSvg('<svg/>', 1)).rejects.toThrow('render failed');
        expect(instance.free).toHaveBeenCalledTimes(1);
        expect(render.free).not.toHaveBeenCalled();
    });

    test.each(['pixels', 'width', 'height'])('%s getter failure frees both handles', async (property) => {
        const {renderer, instance, render} = createHarness();
        Object.defineProperty(render, property, {get() { throw new Error('getter failed'); }});
        await expect(renderer.renderSvg('<svg/>', 1)).rejects.toThrow('getter failed');
        expect(render.free).toHaveBeenCalledTimes(1);
        expect(instance.free).toHaveBeenCalledTimes(1);
    });

    test('pixel copy failure frees both handles', async () => {
        const {renderer, instance, render} = createHarness();
        Object.defineProperty(render, 'pixels', {get: () => ({[Symbol.iterator]() { throw new Error('copy failed'); }})});
        await expect(renderer.renderSvg('<svg/>', 1)).rejects.toThrow('copy failed');
        expect(render.free).toHaveBeenCalledTimes(1);
        expect(instance.free).toHaveBeenCalledTimes(1);
    });

    test('a render free error still frees the owning Resvg handle', async () => {
        const {renderer, instance, render} = createHarness();
        render.free.mockImplementationOnce(() => { throw new Error('free failed'); });
        await expect(renderer.renderSvg('<svg/>', 1)).rejects.toThrow('free failed');
        expect(render.free).toHaveBeenCalledTimes(1);
        expect(instance.free).toHaveBeenCalledTimes(1);
    });
});
