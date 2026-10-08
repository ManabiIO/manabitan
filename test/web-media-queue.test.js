/* SPDX-License-Identifier: GPL-3.0-or-later */
import {expect, test, vi} from 'vitest';
import {ReaderMedia} from '../ext/web/render.js';

/**
 * @returns {{media: import('../ext/web/client.js').ManabiTanWebClient, resolvers: Array<() => void>, requests: import('vitest').Mock}}
 */
function controlledMedia() {
    /** @type {Array<() => void>} */
    const resolvers = [];
    const requests = vi.fn(() => new Promise((resolve) => {
        resolvers.push(() => resolve({content: new ArrayBuffer(1), mediaType: 'image/png'}));
    }));
    const media = /** @type {import('../ext/web/client.js').ManabiTanWebClient} */ (/** @type {unknown} */ ({media: requests}));
    return {media, resolvers, requests};
}

test('one render bounds concurrent media requests and preserves duplicate coalescing', async () => {
    const {media, resolvers, requests} = controlledMedia();
    const manager = new ReaderMedia(media, () => {});
    let loaded = 0;
    let failed = 0;
    const loadedCallback = () => { loaded++; };
    const failedCallback = () => { failed++; };
    try {
        for (let i = 0; i < 9; ++i) {
            manager.loadMediaUrl(`media-${i}.png`, 'A', loadedCallback, failedCallback);
        }
        manager.loadMediaUrl('media-0.png', 'A', loadedCallback, failedCallback);
        await vi.waitFor(() => { expect(requests).toHaveBeenCalledTimes(4); });
        for (let i = 0; i < 9; ++i) {
            await vi.waitFor(() => { expect(resolvers.length).toBeGreaterThan(i); });
            resolvers[i]();
        }
        await vi.waitFor(() => { expect(loaded).toBe(10); });
        expect(requests).toHaveBeenCalledTimes(9);
        expect(failed).toBe(0);
    } finally {
        manager.dispose();
    }
});

test('media queue refuses excess unique URLs and does not start requests after disposal', async () => {
    const {media, resolvers, requests} = controlledMedia();
    const manager = new ReaderMedia(media, () => {});
    const failed = vi.fn();
    for (let i = 0; i < 128; ++i) {
        manager.loadMediaUrl(`media-${i}.png`, 'A', () => {}, failed);
    }
    manager.loadMediaUrl('overflow.png', 'A', () => {}, failed);
    await vi.waitFor(() => { expect(failed).toHaveBeenCalledTimes(1); });
    expect(requests).toHaveBeenCalledTimes(4);
    manager.dispose();
    for (const resolve of resolvers) { resolve(); }
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toHaveBeenCalledTimes(4);
});
