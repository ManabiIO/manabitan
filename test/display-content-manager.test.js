/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {DisplayContentManager} from '../ext/js/display/display-content-manager.js';

function setup() {
    const display = {
        application: {api: {getMedia: vi.fn()}},
        onError: vi.fn(),
    };
    const focus = vi.fn();
    const window = {open: vi.fn(() => ({focus}))};
    const manager = new DisplayContentManager(
        /** @type {import('../ext/js/display/display.js').Display} */ (/** @type {unknown} */ (display)),
    );
    const open = () => manager.openMediaInTab('mdict-media/ping.wav', 'Audio', /** @type {Window} */ (/** @type {unknown} */ (window)));
    return {display, window, focus, manager, open};
}

function media() {
    return {dictionary: 'Audio', path: 'mdict-media/ping.wav', mediaType: 'audio/wav', content: 'AAH/', width: 0, height: 0};
}

beforeEach(() => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:dictionary-media');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('dictionary media tab requests', () => {
    test('opens the exact requested bytes and MIME type without an opener', async () => {
        const {display, window, open} = setup();
        display.application.api.getMedia.mockResolvedValue([media()]);
        await expect(open()).resolves.toBeUndefined();
        const blob = /** @type {Blob} */ (vi.mocked(URL.createObjectURL).mock.calls[0][0]);
        expect(blob.type).toBe('audio/wav');
        expect(new Uint8Array(await blob.arrayBuffer())).toEqual(Uint8Array.of(0, 1, 255));
        expect(window.open).toHaveBeenCalledWith('blob:dictionary-media', '_blank', 'noopener,noreferrer');
        expect(display.onError).not.toHaveBeenCalled();
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    });

    test.each([
        [],
        [{...media(), dictionary: 'Other'}],
        [{...media(), path: 'mdict-media/other.wav'}],
        [{...media(), content: 'not base64!'}],
    ])('contains missing, mismatched or malformed responses %#', async (response) => {
        const {display, window, open} = setup();
        display.application.api.getMedia.mockResolvedValue(response);
        await expect(open()).resolves.toBeUndefined();
        expect(window.open).not.toHaveBeenCalled();
        expect(URL.createObjectURL).not.toHaveBeenCalled();
        expect(display.onError).toHaveBeenCalledWith(expect.any(Error));
    });

    test('contains backend failures', async () => {
        const {display, window, open} = setup();
        const failure = new Error('Media storage unavailable');
        display.application.api.getMedia.mockRejectedValue(failure);
        await expect(open()).resolves.toBeUndefined();
        expect(display.onError).toHaveBeenCalledWith(failure);
        expect(window.open).not.toHaveBeenCalled();
    });

    test.each([false, true])('ignores stale responses after unloading (failure=%s)', async (fail) => {
        const {display, window, manager, open} = setup();
        /** @type {(value: unknown) => void} */
        let settle = () => {};
        display.application.api.getMedia.mockReturnValue(new Promise((resolve, reject) => { settle = fail ? reject : resolve; }));
        const request = open();
        manager.unloadAll();
        settle(fail ? new Error('Stale failure') : [media()]);
        await expect(request).resolves.toBeUndefined();
        expect(display.onError).not.toHaveBeenCalled();
        expect(window.open).not.toHaveBeenCalled();
        expect(URL.createObjectURL).not.toHaveBeenCalled();
        display.application.api.getMedia.mockResolvedValue([media()]);
        await open();
        expect(window.open).toHaveBeenCalledOnce();
    });

    test('revokes an unused blob when opening throws', async () => {
        const {display, window, open} = setup();
        const failure = new Error('Window open failed');
        display.application.api.getMedia.mockResolvedValue([media()]);
        window.open.mockImplementation(() => { throw failure; });
        await expect(open()).resolves.toBeUndefined();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:dictionary-media');
        expect(display.onError).toHaveBeenCalledWith(failure);
    });

    test('does not treat a null noopener window handle as an opening failure', async () => {
        const {display, window, open} = setup();
        display.application.api.getMedia.mockResolvedValue([media()]);
        window.open.mockReturnValue(/** @type {ReturnType<typeof window.open>} */ (/** @type {unknown} */ (null)));
        await expect(open()).resolves.toBeUndefined();
        expect(display.onError).not.toHaveBeenCalled();
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    });
});
